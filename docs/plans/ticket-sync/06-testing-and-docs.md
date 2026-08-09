# Ticket Sync — Plan 06: Testing, Verification & Doc Updates (Phase 6)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · **06** · [07-workflow-prompt](07-workflow-prompt.md)

## 1. Full test matrix

Runner: `bun test`; existing patterns to reuse — tsconfig alias `"vscode" → mocks/vscode.ts` (working `EventEmitter`), `makeContext`/`makeMemento` from `storage.test.ts`, the virtual-FS shim (`storage.test.ts:326-423`), and real-process tests (precedent: `mcpServer.test.ts` uses real loopback HTTP; git plumbing tests use real `git` in `fs.mkdtemp` dirs).

| File | New/extend | Coverage |
|---|---|---|
| `src/syncMerge.test.ts` | new | Pure merge: commutativity `merge(a,b) ≡ merge(b,a)`; idempotence `merge(m,a) ≡ m`; LWW + deterministic content-hash tiebreak; tombstone-vs-ticket both directions + tie (ticket wins, tombstone dropped); tombstone-vs-tombstone max; **element delete-vs-edit both directions + tie**; **per-element LWW beats ticket winner**; **draft-reshape vs concurrent done-toggle**; **pendingClose LWW (incl. documented drop case)**; links wholesale-LWW (removal sticks); record/history dedupe; tags LWW; merged `updatedAt` = max, `createdAt` = min; **GC determinism both argument orders**; renumber determinism + rename list + link integrity via `targetGuid`; `canonicalJson` stability; `deriveGuid` determinism + uuid shape; `coerceWireTicket` never throws on garbage; lane-overflow passthrough |
| `src/gitPlumbing.test.ts` | new | Real git temp repos: hash-object/mktree/commit-tree/readTree/catFileBatch round trip incl. binary blobs; `updateRefCas` success, mismatch failure, 40-zeros create-only; `ls-remote --exit-code` missing ref → exit 2; fetch/push explicit refspecs vs `git init --bare`; NonFastForward classification; `isAncestor`; timeout kill |
| `src/gitSync.test.ts` | new | Bare origin + two clones, two store+controller pairs: DS collision → byte-identical convergence + deterministic renumber + attachment dir rename; tombstone delete propagates, no resurrect; **element delete-vs-edit two-clone convergence**; **pendingClose propagation + approve round trip + LWW drop case**; non-FF push retry (commit injected into bare ref mid-cycle); no-remote local-only mode + later-remote backlog push; `pendingPush` recovery; echo suppression (inbound apply ⇒ no outbound commit); interval=0 = no unrequested network |
| `src/storage.test.ts` | extend | **Tenet proofs**: legacy object (no guid/updatedAt) through `normalize()` → derived guid, `updatedAt === createdAt`, legacy tasks unharmed; hydrate a DB built with the **old DDL** (raw sql.js DB written through the FS shim, no new columns, no `sync_tombstones`) → guarded ALTERs apply, table appears, fields default, zero data loss; `upsert` stamps + mints + **per-task diff-stamps** + **records element tombstones**; `preserveTimestamps` preserves + records nothing; `getSyncTombstones` shape + 90-day prune; `applySync` removals + link scrub + attachment dirs survive unless tombstoned + exactly one `onChange` |
| `src/extension.test.ts` | extend | `mergeIssueUpdate` never honors `guid`/`updatedAt`/`tasks[].updatedAt` from webview payloads; `validateImportList` derives missing guids/updatedAt, keeps valid provided ones |
| `src/mcpServer.test.ts` | extend | Phase 0 ([07-workflow-prompt](07-workflow-prompt.md)): initialize result carries instructions (default + custom override); `get_ticket`/`list_issues`/ticket resources embed the one-line `WORKFLOW_POINTER`, not the full prompt; workflow resource + prompt keep full text |

Gate: `bun test` + `bunx tsc --noEmit` green after every phase.

## 2. End-to-end verification (manual, Extension Development Host)

Scriptable setup:

```bash
DIR=$(mktemp -d)
git init --bare "$DIR/origin.git"
git clone "$DIR/origin.git" "$DIR/cloneA" && (cd "$DIR/cloneA" && git commit --allow-empty -m init && git push)
git clone "$DIR/origin.git" "$DIR/cloneB"
```

Walkthrough:

1. Open `cloneA` in an Extension Dev Host (F5); enable `dostuff.sync.enabled`; create tickets DS-001..DS-003, drag one to Working.
2. Second window on `cloneB`; enable sync; **before syncing**, create tickets so numbers collide (DS-001..DS-002).
3. `DoStuff: Sync Tickets Now` in A, then B, then A again → both boards identical; B's colliding tickets renumbered (toast lists `DS-00X → DS-00Y`); status bar idle.
4. Delete a ticket in A → sync both → gone in B (tombstone), stays gone after B re-syncs.
5. Attach a small image in A → sync both → bytes open in B. Attach a >5 MiB file → metadata in B, missing-file UX for bytes.
6. `git status` clean in **both** worktrees; `git for-each-ref 'refs/dostuff/*'` shows `state` (+ `remote` after fetches); no branch/PR noise.
7. Two windows on the *same* clone: edit in both → within ~15s both converge (tip poll); no clobbering.
8. MCP: with sync on, point an agent at the workspace's port (from `~/.config/dostuff/instances.json`); `create_ticket` lands in `Thinking`; the agent **promotes it to Planned and demotes it back** (`update_ticket_status`), edits the description (`update_ticket_description`), and files a close request (`request_ticket_close`); all of it propagates to the other clone on next sync, including the `pendingClose` badge; approving the close in clone B moves it to `Closed` in both. Lane caps and the Complete/Closed human-only boundary still hold.
9. Backward compat: open a workspace carrying a pre-change `dostuff.db` → loads clean, tickets get derived guids, board unchanged; disable sync → behavior identical to today.
10. Offline: disconnect network, edit tickets → local commits succeed, status `pendingPush`; reconnect + sync → pushed.
11. **Element delete-vs-edit**: same ticket with tasks in both clones, synced. In A delete task X (UI); in B, before syncing, toggle X done via MCP `update_ticket_progress`. Sync A→B→A: both converge to the same outcome (later timestamp wins); repeat with timestamps reversed; then run an `update_ticket_draft` wholesale reshape in A concurrent with a done-toggle in B and confirm convergence with no resurrected duplicates.
12. **pendingClose propagation**: agent files `request_ticket_close` in A; sync; B shows the "Awaiting close" state; approve in B; sync; ticket `Closed` in A, hidden from agents in both. Then: request in A concurrent with an edit in B where B wins LWW → flag dropped in both (expected, documented); agent re-request succeeds.
13. **Prompt surfaces** ([07-workflow-prompt](07-workflow-prompt.md)): connect Claude Code to the endpoint; `/mcp` shows the workflow instructions; `get_ticket` response `workflow` field is the one-line pointer; `dostuff://instructions/workflow` and the `workflow` prompt return full text; set `dostuff.mcp.instructions` custom and confirm all three surfaces reflect it without an extension restart.

## 3. Documentation updates (done alongside the code, this phase closes them out)

### CLAUDE.md

- **Storage tenet section**: add a bullet for the guarded-`ALTER TABLE ADD COLUMN` pattern (catch duplicate-column) as the sanctioned way to add columns to existing tables; note `guid`/`updatedAt`/`tasks[].updatedAt` defaults in `normalize()`, the new `sync_tombstones` table (additive, `CREATE TABLE IF NOT EXISTS`), and the downgrade caveat (old build NULLs `updated_at` → edit can lose LWW; identity safe via `deriveGuid`).
- **New sync section** (short): git-native sync under `refs/dostuff/state`, opt-in, state-level LWW merge with per-element LWW + tombstones for tasks/attachments, pointer to `docs/plans/ticket-sync/` (or the eventual `docs/sync.md`). Replace the "fully planned but **not implemented**" paragraph in the single-writer constraint section.
- **Agent write boundaries**: one line — *applying remote merged state is not an agent write; MCP status gating does not apply to it, but every inbound ticket passes shape-coercion + `normalize()`.*
- Remove the "SMOKE-TEST.md does not exist yet" caveat (line ~61) once the file lands.
- (The stale `127.0.0.1:3947` port claims this section originally tracked were already fixed in `d0efe31`.)

### docs/architecture.md

- New module section: `syncMerge.ts` (pure merge), `gitPlumbing.ts` (CLI wrapper), `gitSync.ts` (controller) — data-flow diagram: `store.onChange → debounce → commitLocal → push` / `poll+interval → fetch → mergeStates → applySync → onChange → broadcast`.
- Fix the stale MCP tool count while in there ("six tools" → **eight**: + `update_ticket_description`, `request_ticket_close`).

### README.md

- Feature blurb: "Share your ticket board across clones via git — no server. Tickets sync through a hidden git ref (`refs/dostuff/state`); enable `dostuff.sync.enabled`, everyone pushes/pulls as usual." Setup + settings table + clock-skew note (LWW uses timestamps; skew biases winners but never diverges).
- **Renumbering vs. agents note**: after a first-sync collision merge, `DS-NNN`/`number` handles an agent memorized mid-session can change; agents recover via `list_issues`/`get_ticket` by title. The workflow prompt deliberately gains nothing sync-specific (sync is transparent to agents; `publicView` does not expose `guid` — see [07-workflow-prompt](07-workflow-prompt.md)).

### SMOKE-TEST.md — **create** (referenced by CLAUDE.md but missing)

Sections: sidebar CRUD, board drag + lane caps + pendingClose approve/deny, import/export, MCP endpoint end-to-end (incl. the promote/demote/description/close-request loop), prompt surfaces (§2 step 13), plus the §2 sync walkthrough condensed to a checklist.

## 4. Release order

1. Phase 0 lands first ([07-workflow-prompt](07-workflow-prompt.md)) — independent of sync; later phases' test runs then exercise the final prompt surfaces.
2. Phase 1 lands alone (schema groundwork) — zero behavior change, tenet tests prove old data loads.
3. Phases 2–3 land as inert library code with tests.
4. Phases 4–5 land together or sequentially behind the default-off setting.
5. Phase 6 docs + SMOKE-TEST run before tagging the release; version bump per repo convention.
