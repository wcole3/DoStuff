# Ticket Sync — Plan 02: Merge Specification (Phase 2)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · **02** · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md) · [07-workflow-prompt](07-workflow-prompt.md)

Phase 2 completes `src/syncMerge.ts` as a **pure module**: no `vscode` imports, no git, no I/O. Everything here must be a deterministic function of its inputs so that two machines merging the same pair of states produce byte-identical results. The merge is a join in a semilattice — commutative, associative, idempotent — which is what lets the sync protocol skip merge-base computation entirely (see [03-git-plumbing](03-git-plumbing.md)).

## 1. Wire model

```ts
export interface WireLink { targetGuid: string; kind: LinkKind }   // NOT targetId

export interface WireTask { id: string; text: string; done: boolean; updatedAt: string }
// updatedAt REQUIRED on wire — toWire fills missing (legacy) with ticket createdAt.

export interface ElementTombstone { id: string; deletedAt: string }

export interface WireTicket {
  guid: string;
  id: string;            // DS-NNN at time of writing; renumber pass may re-project
  number: number;
  title: string; description: string; verifyCriteria: string;
  type: IssueType; priority: Priority; status: Status;
  createdAt: string; updatedAt: string; resolvedAt: string | null;
  tags: string[];
  tasks: WireTask[];                   // ids already t-<uuid>
  attachments: AttachmentMeta[];       // metadata only; bytes live in the ref tree (05)
  links: WireLink[];
  statusHistory: StatusEvent[];
  record: RecordEntry[];
  pendingClose: PendingClose | null;   // agent close request — must survive the wire
  deletedTasks: ElementTombstone[];        // element deletion witnesses for this ticket
  deletedAttachments: ElementTombstone[];  // (see 01-schema-groundwork §6)
}

export interface Tombstone { guid: string; deletedAt: string; lastId: string }

export interface SyncState {
  tickets: Map<string, WireTicket>;    // keyed by guid
  tombstones: Map<string, Tombstone>;  // keyed by guid
}
```

**Links carry `targetGuid`, not `targetId`.** Converters `toWire(issue, idToGuid, elementTombstones?)` / `fromWire(wire, guidToId)` translate at the boundary. `elementTombstones` (`{ tasks: ElementTombstone[]; attachments: ElementTombstone[] }`) comes from `store.getSyncTombstones()` — the *controller* fetches and passes it so this module stays pure. This makes renumbering free at the wire level — the local `targetId` is just a re-projection after numbers settle.

## 2. Canonical JSON

`canonicalJson(value): string` — recursively key-sorted objects, arrays in given order, 2-space indent, trailing newline. Used for every blob written to the ref tree.

Consequences: identical logical state → identical blob bytes → identical git OIDs → (a) free no-op detection when committing (tree OID unchanged), (b) cross-commit blob dedup for unchanged tickets, (c) a stable input for the LWW tiebreak hash (§4).

## 3. Inbound hardening: `coerceWireTicket(raw: unknown): WireTicket | null`

Every ticket read from a fetched tree passes this before merging, and the merged result passes `normalize()` before touching the store:

- Required: `guid` (string, non-empty), `id`, `title` (strings), `createdAt` (ISO-parsable). Missing/invalid → return `null` (skip the entry, log to output channel — same spirit as `validateImportList`, `src/extension.ts:220`).
- Enums coerced to safe defaults via the existing guards (`isStatus`/`isPriority`/`isType` → `Thinking`/`Regular`/`Chore`).
- Collections through the existing coercers (`coerceTags`, `coerceAttachments`, task/record/history shape checks); bad ISO strings in `updatedAt` fall back to `createdAt`; per-task `updatedAt` bad/missing → ticket `createdAt`.
- `pendingClose` through the existing `coercePendingClose` (`src/types.ts:381`) — bad shape → `null`, never throws.
- `deletedTasks`/`deletedAttachments` coerced entry-wise: non-string `id` or non-ISO `deletedAt` → entry dropped.
- Applying remote state is **not an agent write** — MCP status gating does not apply (a remote human may legitimately have moved a ticket to `Complete`, and a remote *agent* may legitimately have promoted/demoted within the non-terminal set) — but nothing malformed may enter the cache.

## 4. `mergeStates(a: SyncState, b: SyncState): SyncState`

For each guid in the union of both sides:

| Case | Rule |
|---|---|
| Ticket on one side only, no tombstone anywhere | Keep it. (Unambiguous *because* deletes always leave a tombstone — one-sided presence means "created on that side", never "deleted on the other".) |
| Tombstone vs tombstone | Keep the one with max `deletedAt`. |
| Tombstone vs ticket | Tombstone wins iff `deletedAt > ticket.updatedAt`. Otherwise the ticket survives **and the tombstone is dropped** (else it would re-kill the ticket on a later merge). Tie → ticket wins (prefer not losing data). |
| Ticket vs ticket | Field merge, §5. |

## 5. Ticket-vs-ticket field merge

Winner `W` (loser `L`) = side with the larger tuple:

```
(updatedAt, sha1(canonicalJson(ticket)))
```

String-compare the ISO timestamps (they sort chronologically); the content hash breaks exact-timestamp ties deterministically on both machines. No wall clock is ever consulted.

| Field group | Rule |
|---|---|
| `title`, `description`, `verifyCriteria`, `type`, `priority`, `status`, `resolvedAt` | From `W`. |
| `tags` | From `W` wholesale — the UI edits tags as a set, and LWW lets removals stick (union would resurrect every removed tag). |
| `pendingClose` | From `W` wholesale. Accepted risk ([00-overview §risks](00-overview.md)): a close request set concurrently with a losing-side edit is dropped; `request_ticket_close` is idempotent, the agent's poll loop re-requests. Note the approve path (`resolveCloseRequest` → `Closed` + flag cleared) rides the same LWW: the approving side's ticket is newer, so `Closed` + `null` flag win together. |
| `number`, `id` | From `W` provisionally; the renumber pass (§6) may override. |
| `createdAt` | `min(a, b)`. |
| `updatedAt` | **`max(a, b)` — never `now()`.** The merge must not look newer than its inputs, or echoes would win future LWW rounds. |
| `tasks` | **Per-element merge with tombstones** — see below. |
| `attachments` (metadata) | Per-element with tombstones; `addedAt` is the element timestamp (no new field — metadata is immutable per id, so a tombstone always wins: `addedAt < deletedAt` by construction, and re-adds mint fresh ids). |
| `links` | From `W` wholesale — **revised from union-by-key.** The UI and `update_ticket_draft` both edit links as a whole set exactly like tags; wholesale LWW makes link removals stick, which matters now that agents reshape triaged tickets via the demote→reshape→re-promote loop. A concurrently-added link lost to LWW is trivially re-added; a resurrected deleted link is silently wrong. Zero new schema. At `fromWire` time, links whose target resolves to a tombstoned/unknown guid are dropped (mirrors `remove()`'s inbound-link scrub, `src/storage.ts:284-301`). |
| `statusHistory` | Union keyed `(status, at, by)`, sorted ascending by `at` (tiebreak: status, then by). Verified append-only across the codebase — no delete path exists, so pure union is exact. |
| `record` | Union keyed `(at, author, text)`, sorted ascending by `at`. Same append-only argument. |

**Per-element merge (tasks, attachments).** For each element id in the union of both sides:

1. Gather the newest tombstone for the id: max `deletedAt` across both tickets' `deletedTasks`/`deletedAttachments`.
2. The element **survives iff** no tombstone exists or `element.updatedAt >= tombstone.deletedAt` (tie → element survives, mirroring the ticket-vs-tombstone rule). A beaten tombstone is **dropped** from the merged ticket so it cannot re-kill the element on a later merge.
3. Ids surviving on **both** sides resolve per-element LWW on `(updatedAt, sha1(canonicalJson(element)))` — the same tuple comparison as tickets, no wall clock.
4. Order: `W`'s order first, then `L`-only survivors in `L`'s relative order.
5. Missing `updatedAt` (legacy data) defaults to ticket `createdAt` — chosen over ticket `updatedAt` because (a) any explicitly-timestamped delete or edit then beats un-timestamped legacy data, matching the ticket-level default's rationale, and (b) a ticket-`updatedAt` default would let an *unrelated* ticket edit resurrect concurrently-deleted legacy tasks.
6. Merged `deletedTasks`/`deletedAttachments` = union by id keeping max `deletedAt`, minus tombstones beaten by a surviving element, then the GC pass below.

This replaces the old "union-resurrect accepted risk": that trade leaned on "MCP freezes ticket scope after `Thinking`", which stopped being true when the scope lock went soft (`d0efe31` — agents demote → `update_ticket_draft` → re-promote).

**Deterministic tombstone GC.** After the merge, drop any ticket or element tombstone with `deletedAt < maxTs − 90d`, where `maxTs` = max over every `updatedAt`/`deletedAt` in the merged state. Pure function of the inputs → both machines prune identically. Exported as `TOMBSTONE_TTL_MS`.

## 6. Renumbering (deterministic)

After merging all tickets:

1. Group survivors by `number`.
2. Where more than one guid claims a number: the ticket with the **oldest `createdAt`** keeps it (tiebreak: lexicographically smaller guid).
3. Losers, sorted by `(createdAt, guid)`, receive sequential numbers starting at `max(number over all survivors before reassignment) + 1`.
4. `id` regenerated as `DS-${String(number).padStart(3, "0")}`.

Deterministic inputs → both machines assign identical numbers independently. Return the rename list `{ guid, oldId, newId }[]` so the controller can surface it and fix local state.

Local-only consequences, handled by the controller at apply time (not in this module):

1. `links[].targetId` re-projected from guids — free, by construction of the wire model.
2. **Attachment directory rename** `attachments/DS-old/ → attachments/DS-new/` — bytes are keyed by issueId on disk (`src/storage.ts:403`); easy to miss.
3. Old-id row removed + new-id row inserted via `applySync` (`removals` without `tombstoned`).

## 7. Lane-cap policy on merge: allow overflow, warn once

A merge may leave an active lane (Planned/Working/Verification) with more than the cap (default 6). **Do not auto-demote.** Each side would demote *different* tickets with fresh `updatedAt` stamps, creating a divergence ping-pong that never converges. Overflow is self-limiting: `canMoveToActiveLane` (`src/types.ts:391`) uses `count >= cap`, so an overfull lane already rejects *new* moves until drained — including agent promotions out of Thinking over MCP. The controller surfaces one `showWarningMessage` + status-bar tooltip (mirroring `activeLaneOverflow`, `src/extension.ts:281`).

## 8. Module exports (final)

```ts
// pure, no vscode, no git, no Date.now() outside explicit parameters
export { deriveGuid, canonicalJson }                    // from phase 1
export { toWire, fromWire, coerceWireTicket }           // toWire takes elementTombstones? (§1)
export { mergeStates, renumber }                        // mergeStates includes the GC pass
export { TOMBSTONE_TTL_MS }
export type { WireTicket, WireTask, WireLink, Tombstone, ElementTombstone, SyncState }
```

## 9. Tests — `src/syncMerge.test.ts`

Property-style (hand-rolled cases; no new deps):

- **Commutativity**: `mergeStates(a, b)` ≡ `mergeStates(b, a)` (compare via `canonicalJson`) — including states carrying element tombstones and `pendingClose`.
- **Idempotence**: `mergeStates(m, a)` ≡ `m` where `m = mergeStates(a, b)`.
- LWW winner selection incl. exact-timestamp tie broken by content hash — same winner regardless of argument order.
- Tombstone beats older ticket; newer ticket beats tombstone *and drops it*; tombstone-vs-tombstone keeps max; tie → ticket survives.
- **Element delete-vs-edit, both directions**: task deleted at t2 vs edited at t3 → survives with the edit (both argument orders); edited at t1 vs deleted at t2 → gone; exact tie → survives, tombstone dropped from the merged ticket.
- **Per-element LWW beats ticket winner**: ticket `W` newer overall but `L`'s copy of task X newer → merged ticket carries `L`'s task X.
- **Draft-reshape simulation**: side A wholesale-replaced tasks (`update_ticket_draft` semantics — all-new ids + tombstones for the old ones) concurrent with side B toggling `done` on an old id → B's toggle survives iff its stamp beats A's tombstone; deterministic either way.
- Attachment tombstone always beats its own `addedAt`.
- `links` from `W` wholesale: removal sticks; `L`-only concurrent add is lost (asserted intentionally — documented trade).
- `pendingClose`: from `W`; `W` null + `L` request → dropped (documented-risk test); commutativity/idempotence hold with the field present.
- Record/statusHistory dedupe by composite key; tags LWW (removal sticks).
- `updatedAt` of merged ticket = max of inputs; `createdAt` = min.
- **GC determinism**: tombstone older than `maxTs − TOMBSTONE_TTL_MS` pruned identically for both argument orders; fresh tombstone kept.
- Renumber: determinism across argument orders; oldest-createdAt keeps number; losers sequential past max; link integrity via `targetGuid` re-projection; rename list correctness.
- `canonicalJson`: key order independence, stable output.
- `deriveGuid`: stable, uuid-shaped.
- `coerceWireTicket`: garbage in → null, partial garbage → coerced defaults (incl. bad `pendingClose`/tombstone entries), never throws.
- Lane-overflow passthrough: merged state may exceed cap; module does not mutate statuses.
