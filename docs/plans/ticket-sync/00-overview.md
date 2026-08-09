# Ticket Sync — Plan 00: Overview & Decision Record

> Plan series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md) · [07-workflow-prompt](07-workflow-prompt.md)
>
> Status: **implemented** (phases 0–6 landed 2026-07-22; plan revised the same day against commit `d0efe31`, "Lower restrictions on agents interacting with tickets"). These docs remain the design record — the merge rules, gating language, and accepted risks here are authoritative. Line numbers reference the tree at `d0efe31`; re-verify before editing.

## Problem statement

DoStuff's ticket DB is strictly single-writer:

- sql.js holds the entire DB in memory; every mutation rewrites `dostuff.db` wholesale via `exportDb()` (tmp + rename). Last flush wins.
- There is **no external-change detection** — no file watcher, no reload trigger except a `dostuff.storagePath` config change. Two VSCode windows on the same workspace silently clobber each other today, and neither window ever finds out.
- Ticket ids (`DS-NNN`) are minted from `max(number)+1` over the local in-memory cache, so two independent writers are *guaranteed* to mint colliding ids.
- Contributors on different clones of the same project cannot share tickets at all; the storage folder is deliberately gitignored (`ensureGitignore`, `src/storage.ts:484`).

Goal: let multiple workspaces/clones of the same project share one logical ticket DB so contributors — and their MCP-connected agents — don't step on each other, with the smallest possible footprint.

## Decision: git-native sync under a hidden ref

Ticket state is stored as **git objects under a custom ref** (`refs/dostuff/state`), never as files in the working tree. Contributors sync by fetching/pushing that ref over the remote they already use. This is the [git-bug](https://github.com/git-bug/git-bug) storage model combined with the [beads](https://github.com/gastownhall/beads) insight (local DB as fast cache, git as the sync/collaboration transport for agent-facing trackers).

Key properties:

- **Zero new npm dependencies.** All git interaction shells out to the `git` CLI via `execFile` with argv arrays (no shell, no quoting issues). See [03-git-plumbing](03-git-plumbing.md).
- **Zero infrastructure.** No server, no hosted DB, no accounts. The remote is whatever `origin` already is. Offline-first: local commits to the ref always succeed; push retries later.
- **Clean worktree, no PR noise.** The ref is invisible to `git status`, PRs, and collaborators who never enable sync.
- **Merge is state-level in JS, never git content merge.** Per-ticket last-write-wins on a new `updatedAt` field, id-keyed union merges for collections, tombstones for deletes, deterministic renumbering for `DS-NNN` collisions. See [02-merge-spec](02-merge-spec.md).
- **Opt-in.** `dostuff.sync.enabled` defaults to `false`; off means exactly current behavior.
- **MCP untouched — but the agent contract is broader than when this plan was first written.** Since `d0efe31`, agents promote/demote/shuffle all non-terminal statuses (`AGENT_WRITABLE_STATUSES` includes `Thinking`, `src/types.ts:189`), edit descriptions on any non-terminal ticket (`update_ticket_description`), and file close requests (`request_ticket_close` → the additive `pendingClose` field). Sync stays transparent to agents: they keep talking to the local store through the existing tools and write boundaries, and the store converges with everyone else's. Applying remote state is *not* an agent write (no status gating), but every inbound ticket is shape-checked and normalized. The design must NOT lean on "MCP freezes scope after Thinking" — that lock is now soft (demote → reshape → re-promote, auditable via `statusHistory`).
- **Fixes today's two-window clobbering** as a side effect: both windows commit to the same local ref with compare-and-swap, and a tip poll picks up the other window's changes.

## Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| **Hub over HTTP** (one extension instance or headless node process hosts a sync endpoint, reusing the MCP HTTP infra + `instances.json` registry) | Needs one always-reachable host; LAN-easy but internet requires port forwarding/VPN/tailscale. Real-time is nice but not required; footprint is worse than zero-server. Viable v2 transport if live sync is ever needed. |
| **Remote libSQL/sqld or Turso** (swap sql.js for `@libsql/client` over HTTP) | Hosted service to run and pay attention to, one new npm dep, offline degrades to read-only, all writes round-trip the network. Largest footprint of the options. |
| **cr-sqlite CRDTs** | Runtime-loadable SQLite extensions cannot be loaded into the sql.js WASM build; adopting it means replacing the storage engine (native module pain in VSCode extension hosts). Its CRDT semantics are also more machinery than a ticket board needs. |
| **Sync files in the working tree** (beads-style `issues.jsonl` committed to the repo) | User explicitly preferred hidden refs: clean worktree, no PR noise, no merge-conflict markers corrupting JSONL. |

## Key codebase facts the design rests on

Verified against the current tree; re-verify line numbers before implementing.

- **All writes funnel through 4 `IssueStore` mutators** — `upsert` (`src/storage.ts:270`), `remove` (`:283`), `replaceAll` (`:312`), `mergeAll` (`:328`) — each firing the `onChange` `EventEmitter<Issue[]>` (`:216`) with the full cache. Single tap point for outbound sync; single funnel for stamping `updatedAt` and recording deletion tombstones.
- **`Issue` has no `updatedAt`, no revision field, no stable cross-writer identity** (`src/types.ts:149-183`; it *does* now carry `pendingClose: PendingClose | null` — the wire model must include it). `id`/`number` come from `nextNumber()` = local `max+1` (`src/storage.ts:358`). Task ids and attachment ids already use uuids.
- **Upsert call-site inventory** (all funnel through `store.upsert`): **6 MCP sites** (`src/mcpServer.ts:526/625/685/757/813/878` — create, status, progress, draft, description, close-request), plus `src/extension.ts` (`applyIssueUpdate` :350, `resolveClose` :370, `appendAttachment` :431, attachment onDelete :514) and `src/sidebarProvider.ts:322`.
- **`replaceAll` wipes the attachments root** and `mergeAll` cannot delete → sync needs a new `applySync()` mutator ([01-schema-groundwork](01-schema-groundwork.md)).
- **`normalize()`** (`src/storage.ts:148`) is the migration chokepoint for object-shaped input — new fields get defaults there per the CLAUDE.md backward-compat tenet.
- **`mergeIssueUpdate`** (`src/extension.ts:103`) builds the next issue from `...prior` plus an explicit allow-list — the webview cannot spoof `guid`/`updatedAt`. Lock this in with a test (the `pendingClose`-forgery test at `src/extension.test.ts:275-291` is the exact shape to copy).
- **`issue_pending_close`** (`src/storage.ts:129-134`) is the additive-`CREATE TABLE IF NOT EXISTS` precedent to copy for the new `sync_tombstones` table.
- **No file watching anywhere**; `mocks/vscode.ts` has no `createFileSystemWatcher`, and packed refs make watching loose ref files unreliable → poll `git rev-parse <ref>` on a timer instead.
- **MCP server**: loopback-only raw node HTTP, ephemeral port by default (`dostuff.mcp.port` = 0), discovery via `~/.config/dostuff/instances.json` (`src/mcpRegistry.ts`). (The stale `127.0.0.1:3947` claims in CLAUDE.md / docs/architecture.md were fixed in `d0efe31`.)
- **Single-flight pattern precedent**: `reconcilePromise` (`src/mcpServer.ts:899`) — the sync controller's op chain mirrors it.
- **`SMOKE-TEST.md` is referenced by CLAUDE.md but does not exist** — create it in phase 6.
- **Settings gotcha**: `package.json` declares `dostuff.mcp.enabled` default `false` but code reads default `true` (`src/extension.ts:878/:909`). Do not repeat this mismatch for sync settings — code defaults must match declared defaults.

## Phase roadmap

| Phase | Doc | Deliverable | Shippable alone? |
|---|---|---|---|
| 0 | [07-workflow-prompt](07-workflow-prompt.md) | Slimmer workflow prompt + MCP initialize-`instructions` wiring | Yes — independent of sync; execute first |
| 1 | [01-schema-groundwork](01-schema-groundwork.md) | `guid` + `updatedAt` fields (+ per-task `updatedAt`), deterministic backfill, guarded ALTERs, `sync_tombstones`, `upsert` stamping, `applySync()` | Yes — pure schema prep, no sync behavior |
| 2 | [02-merge-spec](02-merge-spec.md) | `src/syncMerge.ts` pure merge module + tests | Yes — no runtime wiring |
| 3 | [03-git-plumbing](03-git-plumbing.md) | `src/gitPlumbing.ts` (no vscode imports) + tests against real git | Yes — library only |
| 4 | [04-controller-wiring](04-controller-wiring.md) | `src/gitSync.ts` controller, settings, commands, status bar | First user-visible phase |
| 5 | [05-attachments](05-attachments.md) | Attachment bytes as blobs in the ref tree | Optional enhancement to 4 |
| 6 | [06-testing-and-docs](06-testing-and-docs.md) | Full test matrix, e2e verification, CLAUDE.md/architecture/README/SMOKE-TEST updates | Closes the release |

## Accepted risks

- **Downgrade edit-loss window**: an older build rewriting a row NULLs `updated_at` → the value falls back to `createdAt` → that edit loses LWW against any concurrent remote edit. Ticket *identity* stays safe because the guid re-derives deterministically. Low likelihood (requires downgrade + concurrent remote edit); document in the CLAUDE.md tenet.
- **Element delete-vs-edit resolves by LWW** — per-element `updatedAt` on tasks plus persisted element tombstones (the former v2 escape hatch, promoted to v1 because the soft scope lock makes concurrent agent reshaping of triaged tickets likely; see [02-merge-spec §5](02-merge-spec.md)). Residual risk: an edit made by an old build carries no element timestamp, defaults to ticket `createdAt`, and loses to any explicitly-timestamped delete — mirrors the downgrade caveat above.
- **`pendingClose` merges wholesale with the winning ticket** (LWW). A close request set concurrently with a losing-side ticket edit can be dropped; accepted because `request_ticket_close` is idempotent and the agent's poll loop naturally re-requests.
- **Tombstone GC**: ticket and element tombstones older than 90 days (relative to the newest timestamp in the merged state — deterministic, no wall clock) are pruned; a replica offline longer than the TTL can resurrect a deleted ticket. Standard trade; documented.
- **Clock skew** biases LWW between machines; deterministic tiebreak prevents divergence (both sides converge to the *same* winner, even if it's the "wrong" one). Tolerable for a ticket board.
- **Ref history growth**: every debounced edit is a commit. Content addressing dedupes unchanged blobs/trees; history still grows. v2: periodic squash (`commit-tree` with no parents + coordinated reset). `refs/dostuff/*` roots keep objects alive through `git gc` — safe by default.
