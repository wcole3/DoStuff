# Ticket Sync — Plan 01: Schema Groundwork (Phase 1)

> Series: [00-overview](00-overview.md) · **01** · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md)

Phase 1 adds the two fields sync needs (`guid`, `updatedAt`), the stamping chokepoint, and the `applySync()` store mutator. It is shippable on its own with zero behavior change for users, and it must satisfy the CLAUDE.md storage backward-compatibility tenet in full (additive-only, defaults in `normalize()`, tenet-proof tests).

## 1. New `Issue` fields (`src/types.ts:133-163`)

```ts
export interface Issue {
  // ... existing fields ...
  /** Canonical cross-writer identity for sync. Server-derived; webview input is ignored. */
  guid: string;
  /** ISO 8601 timestamp of the last mutation. Server-stamped in IssueStore.upsert. */
  updatedAt: string;
}
```

- Document in the `WebviewToHost` union comments that both fields are server-derived (the webview can send them but they are never honored — see §6).
- `id`/`number` (DS-NNN) remain the human/agent handle. `guid` is only for sync identity and link projection on the wire.

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

## 3. `normalize()` defaults (`src/storage.ts:139`)

Add to the returned issue object, following the existing coercer style:

```ts
guid: typeof (issue as any).guid === "string" && (issue as any).guid
  ? (issue as any).guid
  : deriveGuid(String(issue.id ?? ""), String(issue.createdAt ?? "")),
updatedAt: isIsoString((issue as any).updatedAt) ? (issue as any).updatedAt : issue.createdAt,
```

(`isIsoString` = small local helper: `typeof v === "string" && !Number.isNaN(Date.parse(v))`.)

This covers legacy JSON files, `globalState` fallback payloads, and import payloads — every object-shaped input path.

## 4. SQLite columns — guarded ALTERs (additive per tenet)

SQLite has no `ADD COLUMN IF NOT EXISTS`, so in `initSqlite` (`src/storage.ts:503`), immediately after `db.exec(SCHEMA_DDL)`:

```ts
for (const ddl of [
  "ALTER TABLE issues ADD COLUMN guid TEXT",
  "ALTER TABLE issues ADD COLUMN updated_at TEXT",
]) {
  try { db.exec(ddl); } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
}
```

Also add both columns to the `issues` CREATE TABLE in `SCHEMA_DDL` (`src/storage.ts:53-131`) so fresh DBs don't need the ALTER path — the try/catch then only fires for pre-existing DBs (first ALTER succeeds) or current DBs (duplicate-column swallowed).

- `writeIssueRows` INSERT gains `guid`, `updated_at`.
- `hydrateFromDb` (`src/storage.ts:646`) reads with fallbacks: `row.guid ?? deriveGuid(row.id, row.created_at)`, `row.updated_at ?? row.created_at`. (`SELECT *` already returns the new columns when present.)
- **`SCHEMA_VERSION` stays 1** (`src/storage.ts:42`). The backfill is lazy/derived — no data rewrite is *required* at upgrade time, which is exactly the tenet's bar for not bumping. The "newer DB → warn and continue" path (`:558-573`) is untouched.

## 5. Stamping chokepoint: `upsert` options

```ts
async upsert(issue: Issue, opts?: { preserveTimestamps?: boolean }): Promise<void>
```

- Default path: stamp `updatedAt = new Date().toISOString()` and mint `guid = randomUUID()` if absent, *before* writing cache/DB.
- `preserveTimestamps: true`: write the issue exactly as given (sync-applied remote state must keep remote timestamps — merged `updatedAt` is `max(a,b)`, never `now()`).
- Every UI and MCP mutation already funnels through `upsert` (`src/extension.ts:312`, `src/sidebarProvider.ts:321`, `src/mcpServer.ts:493/593/654/726`), so no call site can forget to stamp. The sync controller is the **only** intended `preserveTimestamps` caller.
- `replaceAll`/`mergeAll` (import paths): stamp only-if-missing, so export→import round trips preserve exported timestamps.

## 6. Webview/import hardening

- `mergeIssueUpdate` (`src/extension.ts:102`) already builds `next` from `...prior` + explicit allow-list, so `guid`/`updatedAt` from the webview are ignored by construction. Update its doc comment to list them among server-derived fields, and add a regression test (§8).
- `validateImportList` (`src/extension.ts:184`): accept `guid`/`updatedAt` when well-formed; derive via the §3 rules when missing (it feeds `normalize()`-equivalent coercion already — reuse `normalize()` if practical).

## 7. Creation paths mint real uuids

- `buildCreatedIssue` (`src/sidebarProvider.ts:111`): `guid: randomUUID()`, `updatedAt: now` (same timestamp as `createdAt`).
- `runCreateTicket` (`src/mcpServer.ts:465`): same.
- (`upsert` would mint anyway; setting it at creation keeps the objects complete before first persist and keeps tests simple.)

## 8. New store mutator: `applySync`

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

Also: runs `bumpReserved` over the result; scrubs inbound links pointing at removed ids (same logic as `remove()`, `src/storage.ts:274-284`); `globalState` fallback branch mirrors the cache-only path.

## 9. Tests (tenet proof — non-negotiable per CLAUDE.md)

Extend `src/storage.test.ts`:

- Legacy object with only old required fields through `normalize()` → `guid === deriveGuid(id, createdAt)`, `updatedAt === createdAt`.
- `deriveGuid` is stable (same input → same output) and well-formed uuid shape.
- Hydrate a DB **built with the old DDL** (construct a raw sql.js DB in-test without the new columns, write it through the existing virtual-FS shim, then `init()`): ALTERs apply, fields default correctly, no data loss.
- `upsert` stamps `updatedAt` and mints missing guid; `upsert(..., { preserveTimestamps: true })` changes neither.
- `applySync`: removals delete rows + scrub inbound links; attachment dirs survive unless id is in `tombstoned`; exactly one `onChange` fire (spy on the event).

Extend `src/extension.test.ts`:

- `mergeIssueUpdate` result never takes `guid`/`updatedAt` from the incoming payload.
- `validateImportList` derives missing guids/updatedAt and preserves provided valid ones.
