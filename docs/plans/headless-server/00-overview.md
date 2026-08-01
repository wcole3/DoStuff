# Headless Server — Plan 00: Overview & Decision Record

> Status: **draft** (written 2026-08-01 against the v2.0.0 branch, after the agent-skill work landed: `skills/dostuff-tickets/`, `src/mcpLimits.ts`, `src/agentSkill.test.ts`). Line numbers reference that tree; re-verify before implementing.

## Problem statement

The agent skill (`skills/dostuff-tickets/`) made the *client* side of the MCP integration portable: any agent with `curl` can drive the ticket queue, no MCP registration needed. But the *server* still only exists inside a running VSCode extension host:

- No VSCode window open ⇒ no loopback server ⇒ the skill can read and write **nothing**. It cannot even file a ticket, because only the extension knows how to create and write `dostuff.db` (sql.js, wholesale rewrites — no external writer can safely touch it).
- The server, storage, and sync logic are all reusable in principle, but they are entangled with `vscode.*` APIs (config, fs, EventEmitter, OutputChannel, ExtensionContext).
- Every future IDE integration (JetBrains, Neovim, a TUI) would have to re-implement storage + write-gating, or require VSCode running in the background.

Goal: **one ticket server, many hosts.** Extract a vscode-free core (storage + MCP HTTP server + sync), add a headless CLI entry point that serves the same loopback HTTP API with the same registry discovery, and reduce the VSCode extension to one host adapter among possible others. The skill then works with VSCode closed, and other IDEs get a process to talk to instead of a codebase to port.

## Decision: extract a vscode-free core + `dostuff-server` headless CLI

A third esbuild bundle, `dist/server.cjs` (Node CJS), ships in the vsix next to `dist/extension.cjs`. Run as:

```
node <ext-install>/dist/server.cjs serve --workspace /path/to/repo
```

It opens (or creates) the same `<workspace>/.vscode/dostuff/dostuff.db`, binds the same stateless MCP streamable-HTTP server on 127.0.0.1, registers in the same `~/.config/dostuff/instances.json`, and honors the same field caps and agent write boundaries. The skill's `dostuff.sh discover` finds it with zero changes.

Why this over the alternatives (from the option analysis that preceded this plan):

| Option | Why not chosen as the end-state |
|---|---|
| **Inbox drop-folder** (skill writes ticket JSON to `.vscode/dostuff/inbox/`, extension imports via `normalize()`) | Create-only; no reads, no updates, no queue semantics offline. Cheap and safe — still worth considering as an interim, but it doesn't advance multi-IDE support at all. |
| **Bundled DB CLI in the skill** (second implementation of storage against the same file) | Two writers of a wholesale-rewrite file = clobber class; sql.js WASM weight inside the skill; a whole second schema/normalize surface to keep drift-tested. Headless server supersedes it completely. |
| **Git-native authoring via `refs/dostuff/state`** | Elegant for sync users (merge layer is the designed reconciliation; git-bug precedent), but requires sync enabled + a git repo, and doesn't help non-git or sync-off users. The headless server *includes* sync (phase 3), so this falls out for free. |
| **Status quo** ("open VSCode") | The error message the skill ships today. Baseline. |

The decisive argument for headless: it is the only option where **every client — skill, extension, future IDE plugin — goes through the same write path**, so the agent write boundaries (CLAUDE.md "Agent write boundaries") stay enforced in exactly one place.

## Key codebase facts the design rests on

Verified against the current tree.

**Already vscode-free** (no work needed, just reuse): `types.ts`, `syncMerge.ts`, `gitPlumbing.ts`, `mcpRegistry.ts`, `mcpLimits.ts`, `workflowPrompt.ts`, `skillInstall.ts`. The test harness (`testSupport.ts`) already boots the real HTTP server against a mocked config.

**`src/mcpServer.ts` coupling** (moderate — mostly config reads):
- `readMcpViewOptions` (`:515`), `readWorkflowPrompt` (`:524`), `readPreferredPort` (`:536` — takes a `vscode.WorkspaceConfiguration` param), live lane-cap reads (`:887`, `:1756`), `mcp.enabled` (`:1276`).
- `getWorkspaceContext` (`:555`) reads `vscode.workspace.workspaceFolders` directly even though `DoStuffMcpServer` already receives a `workspaceId` callback — unify on the callback.
- `vscode.Disposable` interface, `OutputChannel` (`:1242-1252`), one `showErrorMessage` (`:1319`).
- Imports `validateLinks` from `./extension` (`extension.ts:90`) — a pure function that lives in the wrong module; move it.

**`src/storage.ts` coupling** (the bulk of the work):
- `ExtensionContext` for the `globalState` fallback (`:295`), `vscode.EventEmitter` (`:290`), `OutputChannel` (`:298`), `dostuff.storagePath` config read (`:620`).
- All file IO via `vscode.workspace.fs` + `vscode.Uri`: DB read/write, attachments CRUD, gitignore write, and **sql.js WASM loading** (`:769`). Note: the extension host always runs where the files are (WSL/SSH remotes run the host remotely), so `node:fs` is semantically equivalent for real workspaces; virtual workspaces (github.dev) never worked with sql.js file storage anyway.

**`src/gitSync.ts` coupling** (light): `vscode.Disposable`/`EventEmitter`, toasts at `:251` — but the notification sink is already injectable (`:97`). Config reads live at the extension wiring layer.

**Two-writer reality check**: the DB is wholesale-rewrite, last-flush-wins ([ticket-sync 00-overview](../ticket-sync/00-overview.md), Problem statement). Running the extension *and* a headless server on the same workspace is the same clobber class as two VSCode windows today. Sync's 15s tip poll fixes it when enabled; when disabled we must gate (below).

## Architecture

```
                ┌───────────────────────────── hosts ─────────────────────────────┐
                │  VSCode extension (extension.cjs)   headless CLI (server.cjs)   │
                │  - settings/config bridge           - flags/env/settings parse  │
                │  - status bar, toasts, webviews     - stdout logger, signals    │
                │  - globalState KV fallback          - (no KV: workspace req'd)  │
                └───────────────┬──────────────────────────────┬──────────────────┘
                                ▼                              ▼
                ┌──────────────────────── core (vscode-free) ─────────────────────┐
                │ IssueStore core (sql.js + DDL + normalize + mutators/tombstones)│
                │ MCP HTTP server (tools/resources/prompt, caps, gates)           │
                │ GitSyncController (merge, plumbing, poll)                       │
                │ registry, workflowPrompt, mcpLimits, types, syncMerge           │
                └──────────────────────────────────────────────────────────────────┘
```

Host-facing seams (small interfaces, defined in core, implemented per host):

- **`HostConfig`** — `{ mcpEnabled, port, recordLimit, instructions, activeLaneCap, workspaceOverride, storagePath, sync: {...} }` behind a `getConfig(): ServerConfig` provider + change notification. VSCode adapter wraps `workspace.getConfiguration`; CLI adapter resolves **flags > `DOSTUFF_*` env > best-effort JSONC parse of `<workspace>/.vscode/settings.json` `dostuff.*` keys > defaults**. The settings-file parse is what keeps one workspace behaving identically under both hosts (same lane cap, same record limit) without a second config file.
- **`Logger`** — replaces `OutputChannel` (`info/warn/error`). VSCode: OutputChannel. CLI: stderr with timestamps.
- **`KV`** (optional) — the `globalState` fallback. Only the VSCode adapter provides one; the CLI requires `--workspace` and exits with a clear error otherwise.
- **Events** — replace `vscode.EventEmitter` with a ~15-line typed emitter in core; the VSCode adapter re-wraps for its own subscribers.
- **File IO** — core uses `node:fs` directly (see reality check above). No adapter interface; not worth the indirection.

**Storage backward compatibility is non-negotiable and untouched**: this is a *pure host refactor*. No schema change, no DDL change, no normalize change. The tenet tests (legacy object through `normalize()`, main-era DB hydration) must pass unchanged, plus a new byte-identity test: same seed issues saved through the extension-hosted store and the core store produce identical `dostuff.db` bytes.

### Singleton gate (per-workspace)

`serve` refuses to start when `instances.json` has a live-pid entry whose normalized `workspacePath` equals the requested workspace: exit 3, message naming the pid/port and suggesting the skill just use the running instance. `--takeover` overrides (for a stale-but-alive zombie). The extension side stays as-is in this plan (two windows already coexist today; sync is the real fix) — revisit only if field reports demand it.

### Concurrency model

The skill surfaced a class of races the MCP-registered path never hit: Claude Code serializes non-`readOnlyHint` MCP tool calls, but **skill calls are plain `curl` from Bash — parallel subagents fan out concurrent HTTP mutations with no client-side serialization at all**. The headless server multiplies exposure (more clients, longer-lived processes), so concurrency is a first-class part of this effort. Four layers, each with its own fix:

**L1 — in-process cache vs. disk.** `IssueStore.upsert` mutates the cache *synchronously* before its first await (`storage.ts:353-379`), and the agent-write handlers do read → build → upsert with no intervening await — so cache-level lost updates cannot happen in-process **today, by accident**. The disk is weaker: two overlapping `exportDb()` calls can rename in the wrong order, persisting stale bytes until the next write (data loss only if the process dies in that window). Fix in the storage-core split: a serialized, coalescing export queue (at most one write in flight; a dirty flag re-exports the latest cache once the current write lands — latest-state-wins, like the sync debounce).

**L2 — concurrent HTTP mutations.** The no-await-between-read-and-write property is load-bearing and unenforced — any future `await` inside a write handler silently opens a lost-update window. Make it structural: the server wraps every mutating tool dispatch in a per-store async mutex (reads stay concurrent; writes are a few ms, so serialization is free at this scale). Pinned by a test that fans N concurrent `update_ticket_progress` calls at one ticket over live HTTP and asserts all N record entries land.

**L3 — agent-semantic races (the observed failure).** Even a perfectly serialized server loses updates when the *tool semantics* are replace-shaped: `update_ticket_draft` replaces `tags`/`links`/`tasks` wholesale, so two subagents that each read the draft and write back their edited list erase each other — last writer wins, first writer's edit gone. The delta-shaped tools (`update_ticket_progress` task toggles by id, append-only records/commits, validated status transitions) are already safe under interleaving. Fixes:
- Additive optional `expectedUpdatedAt` on the two replace-shaped writes (`update_ticket_draft`, `update_ticket_description`): when supplied and stale, reject with the fresh ticket state so the agent re-applies its edit — opt-in CAS, fully backward compatible (schema-additive; old callers unchanged).
- Skill guidance (lands now, independent of this plan): parallel subagents partition tickets — one writer per ticket; concurrent work on one ticket goes through the delta tools, never a draft rewrite.

**L4 — cross-process.** Two processes on one DB (extension + headless, two windows) is the wholesale-rewrite clobber class: singleton gate blocks the common case, sync's per-element LWW merge reconciles the rest (tasks and attachments merge element-wise, records union — concurrent process edits interleave instead of erasing). Already covered above; nothing new.

Also noted, low priority: `instances.json` register is load→modify→rename without a lock — two processes registering in the same instant can drop one entry (`mcpRegistry.ts:84-94`). Self-heals on the next register/prune; a verify-after-write retry is a one-liner if it ever bites. Curl-retry idempotency (a timed-out-then-retried `update_ticket_progress` double-appends its record entry) is documented, not engineered — record entries are append-only audit lines, and commit shas already dedupe.

### What stays VSCode-only

Webview UI (sidebar/board/graph), attachments *picking* UX, close-request approval UI, status bar. **Approval consequence**: with no VSCode attached, `request_ticket_close`/`request_ticket_complete` requests park in `pendingClose` until a human opens the board — same as an unattended window today. A future `dostuff-server approve DS-042` human-CLI command is deliberately out of scope (it would need its own auth story to stay a *human* action; the MCP API must never expose it).

## Phases

### Phase 0 — decouple `mcpServer.ts` (no behavior change)
- Move `validateLinks` from `extension.ts:90` to `types.ts` (it is pure; extension re-exports for compat).
- Introduce `HostConfig` provider; `DoStuffMcpServer` constructor takes `(store, workspaceId, config, logger)`. All `vscode.workspace.getConfiguration` reads inside `mcpServer.ts` (`:515/:524/:536/:887/:1276/:1756`) go through it; `getWorkspaceContext` uses the `workspaceId` callback only.
- `vscode.Disposable` → structural `{ dispose(): void }` (identical shape).
- **Write mutex (L2)**: wrap mutating tool dispatch in a per-store async mutex; reads (`get_ticket`, `list_issues`, resources) stay concurrent.
- Tests: existing `mcpServer.test.ts` + `agentSkill.test.ts` suites stay green with `setMcpConfig` reimplemented as a `HostConfig` stub (harness change isolated in `testSupport.ts`); new fan-out test — N parallel `update_ticket_progress` over live HTTP at one ticket, all N record entries present, task done-counts consistent.

### Phase 1 — split `IssueStore`
- `src/storageCore.ts`: sql.js open/create (DDL on every open, guarded ALTERs), `normalize()`, the four mutators + `applySync`, tombstones, attachments IO, tmp+rename saves — on `node:fs`, `Logger`, core emitter. Constructor takes `{ storageDir, wasmPath, kv?: KV }`.
- `src/storage.ts` becomes the VSCode adapter: config resolution, `globalState` KV, `workspace.fs`-specific leftovers deleted, public API unchanged for `extension.ts`/providers.
- **Export queue (L1)**: serialize + coalesce `exportDb` (one write in flight, dirty-flag re-export of the latest cache) so overlapping upserts can never rename stale bytes last.
- Tests: storage suite runs against the core directly (drops the `ExtensionContext` fixture); new byte-identity test; tenet tests unchanged; overlapping-upsert test asserting the final on-disk DB reflects the last cache state. **Build is the vscode-free guard**: phase 2's `server.cjs` esbuild target has no `vscode` alias/external — any core file importing `vscode` fails the build loudly.

### Phase 2 — headless entry point
- `src/serverMain.ts` → `dist/server.cjs` (third esbuild target, platform=node; `sql-wasm.wasm` already ships in `dist/`).
- CLI: `serve [--workspace PATH] [--port N] [--storage-dir PATH] [--takeover] [--no-sync]`, `status` (print registry entries), `--print-config` (show resolved config + provenance). Registry register/unregister, SIGINT/SIGTERM cleanup, singleton gate.
- Tests: e2e in `bun test` — spawn `dist/server.cjs` against a temp workspace + temp `DOSTUFF_REGISTRY_PATH`, drive it with `skills/dostuff-tickets/scripts/dostuff.sh` (the agentSkill harness already does exactly this against the in-process server); parity test asserting `tools/list` and `initialize.instructions` are byte-identical between hosts; singleton-gate test.

### Phase 3 — sync under headless
- `GitSyncController` to core: emitter/Disposable swap, notifications through `Logger` (sink already injectable, `gitSync.ts:97`). CLI honors `dostuff.sync.*` from the settings parse; `--no-sync` opts out.
- This is what makes "extension and headless both open" safe for sync users — the existing 15s tip poll reconciles them like two windows.
- Tests: reuse the gitSync suite against core; one e2e where headless commits to the ref and a second store instance converges.

### Phase 4 — agent-facing concurrency semantics (L3)
- Optional `expectedUpdatedAt` param on `update_ticket_draft` and `update_ticket_description` (the two replace-shaped writes). Stale value → rejection that embeds the fresh ticket so the agent re-applies without a second read. Schema-additive; `FIELD_LIMITS` untouched; skill `references/tools.md` + `agentSkill.test.ts` keyword pins updated (the drift tests will force this anyway).
- SKILL.md gains the parallel-subagent rule (partition tickets; delta tools for shared tickets). *Can land immediately, ahead of every other phase — it needs no server change.*
- Explicitly rejected: server-side per-ticket queuing of *agent intent* (hold-and-merge). The delta tools + CAS cover it with far less machinery.

### Phase 5 — distribution, skill, docs
- `.vscodeignore`: `dist/server.cjs` already matched by `!dist/*.cjs`. Verify vsix.
- SKILL.md: on discover-miss, offer to start the server (`node <ext-install>/dist/server.cjs serve`) — locating `<ext-install>`: newest `~/.vscode/extensions/*dostuff*/` as the documented heuristic, `DOSTUFF_SERVER_JS` env as the override. The skill *suggests* the command; the agent/user runs it (a skill silently daemonizing a server is a permission smell).
- Optional (decide at the time): publish `dostuff-server` to npm so `bunx dostuff-server serve` works without a vsix install — this is the natural hook for *other IDEs*: a JetBrains/Neovim plugin spawns or discovers the server and speaks MCP HTTP; none of them need the storage code.
- README ("Headless server" section + multi-IDE positioning), CLAUDE.md (host/core boundary + the "no vscode imports in core" build guard), SMOKE-TEST (serve → skill round-trip with VSCode closed; extension-open gate message).

## Risks & accepted tradeoffs

- **Dual-writer, sync off**: gate blocks the common case (start headless while VSCode open); the inverse (open VSCode while headless runs) still clobbers exactly like a second window today. Accepted — same class, and phase 3 + enabling sync dissolves it. Document in README.
- **Settings parity drift**: two config resolvers (VSCode live config vs JSONC parse). Mitigate with one shared `CONFIG_KEYS` table in core + a test that both resolvers cover every key.
- **JSONC parse of `.vscode/settings.json`**: comments/trailing commas — use a tolerant stripper, treat parse failure as "defaults + warn", never crash.
- **WASM pathing**: `server.cjs` must find `sql-wasm.wasm` relative to its own dirname, not cwd. One test.
- **Extension bundle regressions**: keep the lazy `import("./mcpServer")` pattern (`extension.ts:938` rationale) intact through the refactor; watch `dist/extension.cjs` size in the build output.
- **Zombie registry entries from crashed headless servers**: pid-alive filtering already handles it (`mcpRegistry.ts:67-91`); `--takeover` covers the EPERM edge.
- **Load-bearing accidental invariants**: the no-await-between-read-and-write handler property (L1/L2) is invisible in review and easy to break with one innocent `await`. The phase-0 mutex makes it structural; until that lands, treat any new `await` inside a write handler as a correctness review flag.
- **Registry register race**: two processes registering simultaneously can drop an entry (load→rename, no lock). Self-healing; verify-after-write retry if reports appear.
- **Scope creep toward a daemon manager**: explicitly out — no auto-start, no service files, no supervision. The server is a foreground process you (or an agent, with permission) run.

## Non-goals (this plan)

- Web UI for headless browsing (git-bug's `webui` is the precedent if ever wanted).
- Human approval actions over any non-VSCode surface (see "What stays VSCode-only").
- Windows service / launchd integration.
- Changing the storage format, schema, or sync semantics in any way.
