# Ticket Sync — Plan 01: Schema Groundwork (Phase 1)

> Series: [00-overview](00-overview.md) · **01** · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md) · [07-workflow-prompt](07-workflow-prompt.md)

Phase 1 adds the fields sync needs (`guid`, `updatedAt`, per-task `updatedAt`), the stamping chokepoint, the `sync_tombstones` deletion-witness table, and the `applySync()` store mutator. It is shippable on its own with zero behavior change for users, and it must satisfy the CLAUDE.md storage backward-compatibility tenet in full (additive-only, defaults in `normalize()`, tenet-proof tests).

## 1. New `Issue` and `Task` fields (`src/types.ts:149-183`, `:28-32`)

```ts
export interface Issue {
  // ... existing fields ...
  /** Canonical cross-writer identity for sync. Server-derived; webview input is ignored. */
  guid: string;
  /** ISO 8601 timestamp of the last mutation. Server-stamped in IssueStore.upsert. */
  updatedAt: string;
}

export interface Task {
  // ... existing fields ...
  /** ISO 8601 timestamp of the last edit to this task (text/done). Server-stamped in
   *  IssueStore.upsert by diffing against the prior ticket; optional so untouched
   *  webview payloads stay type-valid. Missing → wire boundary defaults to ticket createdAt. */
  updatedAt?: string;
}
```

- Document in the `WebviewToHost` union comments that these fields are server-derived (the webview can send them but they are never honored — see §7).
- `id`/`number` (DS-NNN) remain the human/agent handle. `guid` is only for sync identity and link projection on the wire.
- Per-task `updatedAt` exists so concurrent delete-vs-edit resolves by LWW instead of union-resurrect ([02-merge-spec §5](02-merge-spec.md)) — necessary now that the MCP scope lock is soft (agents can demote → reshape → re-promote).

## 2. Deterministic guid backfill: `deriveGuid`

Location: `src/syncMerge.ts` (created in this phase with just `deriveGuid` + `canonicalJson`; `src/storage.ts` imports from it — this direction avoids an import cycle since syncMerge must stay vscode-free).

```ts
import { createHash } from "node:crypto";

/** Deterministic guid for tickets that predate the field. uuid-v5-style formatting of
 *  sha1("dostuff-guid:" + id + "|" + createdAt). */
export function deriveGuid(id: string, createdAt: string): string {
  const h = createHash("sha1").update(`dostuff-guid:${id}|${createdAt}`).digest("hex");
  // Format as 8-4-4-4-12; stamp version nibble 5 and variant bits 10xx for a well-formed uuid.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "5" + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}
```

Why deterministic instead of `randomUUID()` at load:

1. **Pre-shared exports dedupe.** Tickets previously copied between clones via JSON export/import derive the *same* guid on both sides, so the first sync merges them instead of doubling the board.
2. **Downgrade-safe.** An older build rewriting a row NULLs the `guid` column (its INSERT doesn't list it). Re-derivation restores the identical identity, so no split-brain after an upgrade→downgrade→upgrade round trip.

New tickets minted at creation time get `randomUUID()` (see §7). Missing `updatedAt` defaults to `createdAt` — preserves ordering, and any real edit beats legacy data.

## 3. `normalize()` defaults (`src/storage.ts:148`)

Add to the returned issue object, following the existing coercer style:

```ts
guid: typeof (issue as any).guid === "string" && (issue as any).guid
  ? (issue as any).guid
  : deriveGuid(String(issue.id ?? ""), String(issue.createdAt ?? "")),
updatedAt: isIsoString((issue as any).updatedAt) ? (issue as any).updatedAt : issue.createdAt,
```

(`isIsoString` = small local helper: `typeof v === "string" && !Number.isNaN(Date.parse(v))`.)

Tasks: keep `task.updatedAt` only when ISO-valid, else strip it (coercers never throw; missing is fine — the wire boundary defaults it to ticket `createdAt`).

This covers legacy JSON files, `globalState` fallback payloads, and import payloads — every object-shaped input path.

## 4. SQLite columns — guarded ALTERs (additive per tenet)

SQLite has no `ADD COLUMN IF NOT EXISTS`, so in `initSqlite` (`src/storage.ts:513`), immediately after `db.exec(SCHEMA_DDL)`:

```ts
for (const ddl of [
  "ALTER TABLE issues ADD COLUMN guid TEXT",
  "ALTER TABLE issues ADD COLUMN updated_at TEXT",
  "ALTER TABLE issue_tasks ADD COLUMN updated_at TEXT",
]) {
  try { db.exec(ddl); } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
}
```

Also add the columns to the corresponding CREATE TABLEs in `SCHEMA_DDL` (`src/storage.ts:55-140`) so fresh DBs don't need the ALTER path — the try/catch then only fires for pre-existing DBs (first ALTER succeeds) or current DBs (duplicate-column swallowed).

New table, copying the `issue_pending_close` additive precedent (`src/storage.ts:129-134`):

```sql
CREATE TABLE IF NOT EXISTS sync_tombstones (
  scope       TEXT NOT NULL,             -- 'ticket' | 'task' | 'attachment'
  ticket_guid TEXT NOT NULL,
  element_id  TEXT NOT NULL,             -- = ticket_guid when scope='ticket'
  deleted_at  TEXT NOT NULL,
  last_id     TEXT NOT NULL DEFAULT '',  -- DS-NNN at deletion (ticket scope only)
  PRIMARY KEY (scope, ticket_guid, element_id)
);
```

- `writeIssueRows` (`src/storage.ts:801`) INSERT gains `guid`, `updated_at` on issues and `updated_at` on `issue_tasks` (`t.updatedAt ?? null`).
- `hydrateFromDb` (`src/storage.ts:656`) reads with fallbacks: `row.guid ?? deriveGuid(row.id, row.created_at)`, `row.updated_at ?? row.created_at`; tasks get `...(t.updated_at ? { updatedAt: t.updated_at } : {})` — no eager default, the wire boundary handles missing.
- **`SCHEMA_VERSION` stays 1** (`src/storage.ts:44`). The backfill is lazy/derived — no data rewrite is *required* at upgrade time, which is exactly the tenet's bar for not bumping. The "newer DB → warn and continue" path (`:580`) is untouched.

## 5. Stamping chokepoint: `upsert` options

```ts
async upsert(issue: Issue, opts?: { preserveTimestamps?: boolean }): Promise<void>
```

- Default path, before writing cache/DB:
  1. Stamp `updatedAt = new Date().toISOString()` and mint `guid = randomUUID()` if absent (carry the prior ticket's guid when the incoming copy lacks one).
  2. **Per-task diff-stamping** against the prior cached ticket: a task id absent from prior → `updatedAt: now`; present with identical `text` + `done` → carry the *prior* task's `updatedAt` forward (the webview strips the field, so reconciliation must happen here, not upstream); changed → `now`.
  3. **Element-tombstone recording**: task/attachment ids present on prior but absent on the incoming ticket → `INSERT OR REPLACE` a `sync_tombstones` row (`scope='task'|'attachment'`, `deleted_at = now`). This catches every deletion path, including `update_ticket_draft`'s wholesale task replacement (`src/mcpServer.ts:714` — fresh ids ⇒ all prior ids implicitly deleted).
- `preserveTimestamps: true`: write the issue exactly as given AND record no tombstones (sync-applied remote state must keep remote timestamps — merged `updatedAt` is `max(a,b)`, never `now()` — and inbound state already carries its own tombstones).
- Every UI and MCP mutation already funnels through `upsert` — 6 MCP sites (`src/mcpServer.ts:526/625/685/757/813/878`), `src/extension.ts:350/370/431/514`, `src/sidebarProvider.ts:322` — so no call site can forget to stamp. The sync controller is the **only** intended `preserveTimestamps` caller.
- `replaceAll`/`mergeAll` (import paths): stamp only-if-missing, so export→import round trips preserve exported timestamps.

## 6. Deletion witnesses (`sync_tombstones`)

Deletes must leave a persisted witness or the merge cannot distinguish "deleted here" from "created there" ([02-merge-spec §4–5](02-merge-spec.md)):

- `remove()` (`src/storage.ts:283`): before deleting, record a `scope='ticket'` tombstone (`ticket_guid = issue.guid`, `deleted_at = now`, `last_id = issue.id`).
- `replaceAll()`: tombstone every ticket it drops; per surviving id, element-diff against the prior cache.
- `mergeAll()`: element-diff per upserted id (it cannot delete tickets).
- `applySync()` records **nothing** — inbound state already carries tombstones.
- Rows are written even while sync is disabled (cheap; enables correct history when sync is enabled later). The `globalState` fallback branch skips tombstones entirely — no workspace ⇒ sync inert.
- New read API: `getSyncTombstones(): { tickets: Array<{guid; deletedAt; lastId}>, elements: Array<{ticketGuid; scope: "task"|"attachment"; elementId; deletedAt}> }` — the controller feeds these into `toWire`/`SyncState`.
- Local hygiene: prune rows older than 90 days at `init()` (matches the merge-level GC TTL, [02-merge-spec §5](02-merge-spec.md)).

## 7. Webview/import hardening

- `mergeIssueUpdate` (`src/extension.ts:103`) already builds `next` from `...prior` + explicit allow-list, so `guid`/`updatedAt`/`tasks[].updatedAt` from the webview are ignored by construction. Update its doc comment to list them among server-derived fields, and add a regression test (§10) — copy the `pendingClose`-forgery test shape at `src/extension.test.ts:275-291`.
- `validateImportList` (`src/extension.ts:220`): accept `guid`/`updatedAt`/`tasks[].updatedAt` when well-formed; derive via the §3 rules when missing (it feeds `normalize()`-equivalent coercion already — reuse `normalize()` if practical).

## 8. Creation paths mint real uuids

- `buildCreatedIssue` (`src/sidebarProvider.ts:111`): `guid: randomUUID()`, `updatedAt: now` (same timestamp as `createdAt`), tasks stamped `updatedAt: now`.
- `runCreateTicket` (`src/mcpServer.ts:472`): same.
- (`upsert` would mint anyway; setting it at creation keeps the objects complete before first persist and keeps tests simple.)

## 9. New store mutator: `applySync`

```ts
async applySync(args: {
  upserts: Issue[];      // fully-merged issues; guids present; preserveTimestamps semantics
  removals: string[];    // ticket ids to delete: tombstoned tickets + old ids of renumbered tickets
  /** ids whose removal is a tombstone (delete attachment dir) vs a renumber (dir already renamed by caller) */
  tombstoned?: string[];
}): Promise<void>
```

Behavior (contrast with existing mutators and why they don't fit):

| Requirement | `replaceAll` | `mergeAll` | `applySync` |
|---|---|---|---|
| Delete specific tickets | ✗ (all-or-nothing) | ✗ (upsert-only) | ✓ (`removals`) |
| Preserve attachment bytes | ✗ (wipes attachments root, `src/storage.ts:311`) | ✓ | ✓ (deletes dirs only for `tombstoned` ids) |
| One flush / one event | ✓ | ✓ | ✓ (one transaction, one `exportDb()`, **one** `onChange` fire) |

Also: runs `bumpReserved` over the result; scrubs inbound links pointing at removed ids (same logic as `remove()`, `src/storage.ts:284-301`); writes `issue_tasks.updated_at` via `writeIssueRows`; never touches `sync_tombstones`; `globalState` fallback branch mirrors the cache-only path.

## 10. Tests (tenet proof — non-negotiable per CLAUDE.md)

Extend `src/storage.test.ts`:

- Legacy object with only old required fields through `normalize()` → `guid === deriveGuid(id, createdAt)`, `updatedAt === createdAt`; legacy task without `updatedAt` → field absent, no throw; garbage task `updatedAt` stripped.
- `deriveGuid` is stable (same input → same output) and well-formed uuid shape.
- Hydrate a DB **built with the old DDL** (construct a raw sql.js DB in-test without the new columns and without `sync_tombstones`, write it through the existing virtual-FS shim, then `init()`): ALTERs apply, table appears, fields default correctly, no data loss.
- `upsert` stamps `updatedAt` and mints missing guid; unchanged task keeps its prior `updatedAt` even when the incoming copy lacks the field (webview round trip); changed `text` restamps; toggled `done` restamps; `upsert(..., { preserveTimestamps: true })` changes nothing.
- Tombstone recording: upsert with a task removed → `scope='task'` row; attachment delete → `scope='attachment'` row; `remove()` → ticket row carrying `last_id`; `replaceAll([])` tombstones every prior ticket; `preserveTimestamps` records nothing; `getSyncTombstones()` shape; 90-day prune at `init()`.
- `applySync`: removals delete rows + scrub inbound links; attachment dirs survive unless id is in `tombstoned`; exactly one `onChange` fire (spy on the event); no `sync_tombstones` rows recorded.

Extend `src/extension.test.ts`:

- `mergeIssueUpdate` result never takes `guid`/`updatedAt`/`tasks[].updatedAt` from the incoming payload (copy the `pendingClose` shape at `:275-291`).
- `validateImportList` derives missing guids/updatedAt and preserves provided valid ones.
