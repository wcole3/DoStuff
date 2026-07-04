# Ticket Sync — Plan 02: Merge Specification (Phase 2)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · **02** · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md)

Phase 2 completes `src/syncMerge.ts` as a **pure module**: no `vscode` imports, no git, no I/O. Everything here must be a deterministic function of its inputs so that two machines merging the same pair of states produce byte-identical results. The merge is a join in a semilattice — commutative, associative, idempotent — which is what lets the sync protocol skip merge-base computation entirely (see [03-git-plumbing](03-git-plumbing.md)).

## 1. Wire model

```ts
export interface WireLink { targetGuid: string; kind: LinkKind }   // NOT targetId

export interface WireTicket {
  guid: string;
  id: string;            // DS-NNN at time of writing; renumber pass may re-project
  number: number;
  title: string; description: string; verifyCriteria: string;
  type: IssueType; priority: Priority; status: Status;
  createdAt: string; updatedAt: string; resolvedAt: string | null;
  tags: string[];
  tasks: Task[];                       // ids already t-<uuid>
  attachments: AttachmentMeta[];       // metadata only; bytes live in the ref tree (05)
  links: WireLink[];
  statusHistory: StatusEvent[];
  record: RecordEntry[];
}

export interface Tombstone { guid: string; deletedAt: string; lastId: string }

export interface SyncState {
  tickets: Map<string, WireTicket>;    // keyed by guid
  tombstones: Map<string, Tombstone>;  // keyed by guid
}
```

**Links carry `targetGuid`, not `targetId`.** Converters `toWire(issue, idToGuid)` / `fromWire(wire, guidToId)` translate at the boundary. This makes renumbering free at the wire level — the local `targetId` is just a re-projection after numbers settle.

## 2. Canonical JSON

`canonicalJson(value): string` — recursively key-sorted objects, arrays in given order, 2-space indent, trailing newline. Used for every blob written to the ref tree.

Consequences: identical logical state → identical blob bytes → identical git OIDs → (a) free no-op detection when committing (tree OID unchanged), (b) cross-commit blob dedup for unchanged tickets, (c) a stable input for the LWW tiebreak hash (§4).

## 3. Inbound hardening: `coerceWireTicket(raw: unknown): WireTicket | null`

Every ticket read from a fetched tree passes this before merging, and the merged result passes `normalize()` before touching the store:

- Required: `guid` (string, non-empty), `id`, `title` (strings), `createdAt` (ISO-parsable). Missing/invalid → return `null` (skip the entry, log to output channel — same spirit as `validateImportList`, `src/extension.ts:184`).
- Enums coerced to safe defaults via the existing guards (`isStatus`/`isPriority`/`isType` → `Thinking`/`Regular`/`Chore`).
- Collections through the existing coercers (`coerceTags`, `coerceAttachments`, task/record/history shape checks); bad ISO strings in `updatedAt` fall back to `createdAt`.
- Applying remote state is **not an agent write** — MCP status gating does not apply (a remote human may legitimately have moved a ticket to `Complete`) — but nothing malformed may enter the cache.

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
| `number`, `id` | From `W` provisionally; the renumber pass (§6) may override. |
| `createdAt` | `min(a, b)`. |
| `updatedAt` | **`max(a, b)` — never `now()`.** The merge must not look newer than its inputs, or echoes would win future LWW rounds. |
| `tasks` | Id-keyed union. Common id → `W`'s `text` and `W`'s `done`. Order: `W`'s order, then `L`-only tasks appended in `L`'s relative order. |
| `attachments` (metadata) | Union by id; `W`'s fields for common ids. |
| `links` | Union by `(targetGuid, kind)`. At `fromWire` time, links whose target resolves to a tombstoned/unknown guid are dropped (mirrors `remove()`'s inbound-link scrub, `src/storage.ts:274-284`). |
| `statusHistory` | Union keyed `(status, at, by)`, sorted ascending by `at` (tiebreak: status, then by). |
| `record` | Union keyed `(at, author, text)`, sorted ascending by `at`. |

Known v1 semantic (accepted): an element (task/attachment) deleted on one side concurrent with any edit on the other side resurrects, because union can't distinguish "deleted on W" from "added on L". Documented trade — MCP freezes ticket scope after `Thinking`, and silently losing a teammate's added task is worse than a rare resurrect. v2 escape hatch: per-element `updatedAt` (additive field).

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

A merge may leave an active lane (Planned/Working/Verification) with more than the cap (default 6). **Do not auto-demote.** Each side would demote *different* tickets with fresh `updatedAt` stamps, creating a divergence ping-pong that never converges. Overflow is self-limiting: `canMoveToActiveLane` (`src/types.ts:348`) uses `count >= cap`, so an overfull lane already rejects *new* moves until drained. The controller surfaces one `showWarningMessage` + status-bar tooltip (mirroring `activeLaneOverflow`, `src/extension.ts:244`).

## 8. Module exports (final)

```ts
// pure, no vscode, no git, no Date.now() outside explicit parameters
export { deriveGuid, canonicalJson }                    // from phase 1
export { toWire, fromWire, coerceWireTicket }
export { mergeStates, renumber }
export type { WireTicket, WireLink, Tombstone, SyncState }
```

## 9. Tests — `src/syncMerge.test.ts`

Property-style (hand-rolled cases; no new deps):

- **Commutativity**: `mergeStates(a, b)` ≡ `mergeStates(b, a)` (compare via `canonicalJson`).
- **Idempotence**: `mergeStates(m, a)` ≡ `m` where `m = mergeStates(a, b)`.
- LWW winner selection incl. exact-timestamp tie broken by content hash — same winner regardless of argument order.
- Tombstone beats older ticket; newer ticket beats tombstone *and drops it*; tombstone-vs-tombstone keeps max; tie → ticket survives.
- Union collections: task union preserves W's order + L-only appendix; record/statusHistory dedupe by composite key; tags LWW (removal sticks).
- `updatedAt` of merged ticket = max of inputs; `createdAt` = min.
- Renumber: determinism across argument orders; oldest-createdAt keeps number; losers sequential past max; link integrity via `targetGuid` re-projection; rename list correctness.
- `canonicalJson`: key order independence, stable output.
- `deriveGuid`: stable, uuid-shaped.
- `coerceWireTicket`: garbage in → null, partial garbage → coerced defaults, never throws.
- Lane-overflow passthrough: merged state may exceed cap; module does not mutate statuses.
