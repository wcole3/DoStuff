# Ticket Sync — Plan 06: Testing, Verification & Doc Updates (Phase 6)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · **06**

## 1. Full test matrix

Runner: `bun test`; existing patterns to reuse — tsconfig alias `"vscode" → mocks/vscode.ts` (working `EventEmitter`), `makeContext`/`makeMemento` from `storage.test.ts`, the virtual-FS shim (`storage.test.ts:326-423`), and real-process tests (precedent: `mcpServer.test.ts` uses real loopback HTTP; git plumbing tests use real `git` in `fs.mkdtemp` dirs).

| File | New/extend | Coverage |
|---|---|---|
| `src/syncMerge.test.ts` | new | Pure merge: commutativity `merge(a,b) ≡ merge(b,a)`; idempotence `merge(m,a) ≡ m`; LWW + deterministic content-hash tiebreak; tombstone-vs-ticket both directions + tie (ticket wins, tombstone dropped); tombstone-vs-tombstone max; union collections (task order, record/history dedupe, tags LWW); merged `updatedAt` = max, `createdAt` = min; renumber determinism + rename list + link integrity via `targetGuid`; `canonicalJson` stability; `deriveGuid` determinism + uuid shape; `coerceWireTicket` never throws on garbage; lane-overflow passthrough |
| `src/gitPlumbing.test.ts` | new | Real git temp repos: hash-object/mktree/commit-tree/readTree/catFileBatch round trip incl. binary blobs; `updateRefCas` success, mismatch failure, 40-zeros create-only; `ls-remote --exit-code` missing ref → exit 2; fetch/push explicit refspecs vs `git init --bare`; NonFastForward classification; `isAncestor`; timeout kill |
| `src/gitSync.test.ts` | new | Bare origin + two clones, two store+controller pairs: DS collision → byte-identical convergence + deterministic renumber + attachment dir rename; tombstone delete propagates, no resurrect; non-FF push retry (commit injected into bare ref mid-cycle); no-remote local-only mode + later-remote backlog push; `pendingPush` recovery; echo suppression (inbound apply ⇒ no outbound commit); interval=0 = no unrequested network |
| `src/storage.test.ts` | extend | **Tenet proofs**: legacy object (no guid/updatedAt) through `normalize()` → derived guid, `updatedAt === createdAt`; hydrate a DB built with the **old DDL** (raw sql.js DB written through the FS shim) → guarded ALTERs apply, fields default, zero data loss; `upsert` stamps + mints; `preserveTimestamps` preserves; `applySync` removals + link scrub + attachment dirs survive unless tombstoned + exactly one `onChange` |
| `src/extension.test.ts` | extend | `mergeIssueUpdate` never honors `guid`/`updatedAt` from webview payloads; `validateImportList` derives missing guids/updatedAt, keeps valid provided ones |

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
8. MCP: with sync on, point an agent at the workspace's port (from `~/.config/dostuff/instances.json`); `create_ticket` + `update_ticket_progress` still work, land in `Thinking`, propagate to the other clone on next sync; status gating (`AGENT_WRITABLE_STATUSES`, lane caps) unchanged.
9. Backward compat: open a workspace carrying a pre-change `dostuff.db` → loads clean, tickets get derived guids, board unchanged; disable sync → behavior identical to today.
10. Offline: disconnect network, edit tickets → local commits succeed, status `pendingPush`; reconnect + sync → pushed.

## 3. Documentation updates (done alongside the code, this phase closes them out)

### CLAUDE.md

- **Storage tenet section**: add a bullet for the guarded-`ALTER TABLE ADD COLUMN` pattern (catch duplicate-column) as the sanctioned way to add columns to existing tables; note `guid`/`updatedAt` defaults in `normalize()` and the downgrade caveat (old build NULLs `updated_at` → edit can lose LWW; identity safe via `deriveGuid`).
- **New sync section** (short): git-native sync under `refs/dostuff/state`, opt-in, state-level LWW merge, pointer to `docs/plans/ticket-sync/` (or the eventual `docs/sync.md`).
- **Agent write boundaries**: one line — *applying remote merged state is not an agent write; MCP status gating does not apply to it, but every inbound ticket passes shape-coercion + `normalize()`.*
- **Fix stale port claims** (lines ~18 and ~33): the MCP server binds loopback with an **ephemeral port** by default (`dostuff.mcp.port` = 0) discovered via `~/.config/dostuff/instances.json` — not `127.0.0.1:3947`.

### docs/architecture.md

- Same `3947` fix (line ~7).
- New module section: `syncMerge.ts` (pure merge), `gitPlumbing.ts` (CLI wrapper), `gitSync.ts` (controller) — data-flow diagram: `store.onChange → debounce → commitLocal → push` / `poll+interval → fetch → mergeStates → applySync → onChange → broadcast`.

### README.md

- Feature blurb: "Share your ticket board across clones via git — no server. Tickets sync through a hidden git ref (`refs/dostuff/state`); enable `dostuff.sync.enabled`, everyone pushes/pulls as usual." Setup + settings table + clock-skew note (LWW uses timestamps; skew biases winners but never diverges).

### SMOKE-TEST.md — **create** (referenced by CLAUDE.md:58 but missing)

Sections: sidebar CRUD, board drag + lane caps, import/export, MCP endpoint end-to-end (existing coverage promised by CLAUDE.md), plus the §2 sync walkthrough condensed to a checklist.

## 4. Release order

1. Phase 1 lands alone (schema groundwork) — zero behavior change, tenet tests prove old data loads.
2. Phases 2–3 land as inert library code with tests.
3. Phases 4–5 land together or sequentially behind the default-off setting.
4. Phase 6 docs + SMOKE-TEST run before tagging the release; version bump per repo convention.
