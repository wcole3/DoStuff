# Ticket Sync — Plan 04: Controller & Wiring (Phase 4)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · **04** · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md) · [07-workflow-prompt](07-workflow-prompt.md)

Phase 4 is the first user-visible phase: `src/gitSync.ts` (the controller), settings, commands, and the status-bar item. No webview changes at all — merged state flows through the existing `store.onChange → broadcast` pipeline (`src/sidebarProvider.ts:232`, `src/boardProvider.ts:131`, `src/graphProvider.ts:83`).

## 1. Controller API

```ts
// src/gitSync.ts
export type SyncStateName =
  | "disabled" | "noRepo" | "noRemote" | "idle" | "syncing" | "pendingPush" | "error";

export interface SyncStatus { state: SyncStateName; detail?: string; lastSyncAt?: string }

export interface SyncResult {
  applied: number; pushed: boolean;
  renames: Array<{ oldId: string; newId: string }>;
  laneOverflow: string[];      // lanes left over cap by the merge, for the warn-once toast
}

export class GitSyncController implements vscode.Disposable {
  constructor(store: IssueStore, getRoot: () => string | null);
  start(): void;
  stop(): void;
  dispose(): void;
  syncNow(reason: "manual" | "interval" | "startup" | "push-follow-up"): Promise<SyncResult>;
  readonly onStatusChange: vscode.Event<SyncStatus>;
  get status(): SyncStatus;
}
```

## 2. Internals

- **Single-flight op chain**: `private opChain: Promise<void>` — every *state-mutating* operation (commitLocal, tip-apply, the sync cycle's integrate/merge hops) chains onto it (exact `reconcilePromise` pattern, `src/mcpServer.ts:899, 919-925`). No two state operations ever interleave within one window. **Network waits run OFF the chain** (`runSyncCycle` hops back onto it via `chainThrough` for each state mutation, re-reading the local tip inside the hop): a slow or hung remote (`ls-remote`/`fetch`/`push`, up to `NETWORK_TIMEOUT_MS` each) must never block debounced local commits or tip-poll applies. `syncNow` itself is coalesced (one running cycle + at most one queued follow-up shared by every mid-cycle caller), and a failed cycle schedules an exponential-backoff retry (`retryBaseMs`, default 30s, doubling to 10min, cleared on success) so a transient network blip no longer latches the warning until the next interval — or forever with `intervalMinutes: 0`.
- **Outbound**: `store.onChange` → 2s trailing debounce → `commitLocal()` (ref-only; works offline) → if a remote is configured, schedule **one** push-only follow-up 30s later (coalesces bursts into one push). `commitLocal` builds the outbound state as `mergeStates(tipState, localState)`, where `localState`'s ticket tombstones and each ticket's element tombstones come from `store.getSyncTombstones()` ([01-schema-groundwork §6](01-schema-groundwork.md)); merge idempotence makes stale table rows harmless.
- **Inbound / same-machine race detection**: 15s timer runs `git rev-parse refs/dostuff/state` (~5ms process). Tip ≠ lastSeenTip → another window (or a manual ref update) moved it → `applyInbound()` (no network). This is what fixes today's two-window clobbering.
- **Full network sync** (`fetch → merge → apply → push`) on: `start()`, every `intervalMinutes`, and the manual command.
- **Echo suppression**: `applyingRemote` counter incremented around the controller's own `store.applySync()` call; the onChange debouncer skips while > 0. Harmless if it ever leaks: `commitLocal` is a no-op when the new root tree OID equals the old one (canonical JSON guarantees stability).
- **Local ref CAS retry** (×5) with re-merge on each failure handles two same-machine windows committing concurrently ([03-git-plumbing §3a](03-git-plumbing.md)).
- **Sync cycle ancestry short-circuits** — the reason repeated syncs never re-merge:
  1. remote tip is ancestor of local → nothing to apply; push if local is ahead.
  2. local tip is ancestor of remote → fast-forward the local ref (CAS), apply inbound; **no new commit**.
  3. true divergence → state-merge in JS, `commit-tree` with **both tips as parents**, CAS, apply inbound, push. After one successful push+fetch cycle, each side sees the other's tip as an ancestor.

### Apply-inbound order of operations

1. Read merged state; diff against store cache by guid. (Local element tombstones already committed to the tip are *not* re-recorded — `applySync` uses `preserveTimestamps` semantics and records nothing.)
2. Perform attachment-dir renames for renumbered tickets (`attachments/DS-old/ → DS-new/`) **before** any byte restore ([05-attachments](05-attachments.md)).
3. `store.applySync({ upserts, removals, tombstoned })` — one transaction, one `onChange`.
4. Notifications: renames toast (`DS-004 → DS-017`), lane-overflow warning (once per overflow event, not per sync).

## 3. Wiring in `src/extension.ts`

Mirror the MCP block (`src/extension.ts:841-963`):

- `reconcileSync()` reads config, constructs/starts or stops the controller. Hooked to `onDidChangeConfiguration("dostuff.sync")` and `onDidChangeWorkspaceFolders`. Controller pushed to `context.subscriptions`.
- Constructed directly — no lazy `import()` needed (unlike MCP, there are no heavy SDK deps).
- Second status-bar item: `$(sync)` idle · `$(sync~spin)` syncing · `$(warning)` pendingPush/error; tooltip = `status.detail` + last sync time; click → `dostuff.sync.now`. Driven by `onStatusChange`.

## 4. Settings (`package.json` `contributes.configuration`, after the `mcp.*` block)

**Code defaults MUST match declared defaults** — do not repeat the `mcp.enabled` mismatch (declared `false` in package.json, code reads `true` at `src/extension.ts:878/:909`).

| Setting | Type | Default | Scope | Notes |
|---|---|---|---|---|
| `dostuff.sync.enabled` | boolean | `false` | `window` | Off = exactly current behavior |
| `dostuff.sync.remote` | string | `"origin"` | `window` | Remote name for fetch/push |
| `dostuff.sync.ref` | string | `"refs/dostuff/state"` | `window` | Must match `^refs/`; validated at start |
| `dostuff.sync.intervalMinutes` | number | `5` | `window` | min 0 max 120; `0` = manual network sync only (local ref commits still happen) |
| `dostuff.sync.syncAttachments` | boolean | `true` | `window` | See [05-attachments](05-attachments.md) |
| `dostuff.sync.maxAttachmentSyncBytes` | number | `5242880` | `window` | Per file; larger files sync metadata only |

## 5. Commands (`contributes.commands` + `menus.commandPalette`)

| Command | Title | Behavior |
|---|---|---|
| `dostuff.sync.now` | DoStuff: Sync Tickets Now | `controller.syncNow("manual")`; toast summary: `+N new / M updated / K renumbered` |
| `dostuff.sync.toggle` | DoStuff: Toggle Git Ticket Sync | Flip `sync.enabled` at `ConfigurationTarget.Workspace` |

## 6. First-enable UX

Enable setting → `reconcileSync` → `start()` → `syncNow("startup")`:

1. `commitLocal` mints the ref from the current store (guids already derived/minted per [01-schema-groundwork](01-schema-groundwork.md)).
2. `ls-remote` → fetch → merge → push.

Two clones that never shared tickets: no common ancestry needed (state merge is base-free) — both boards union; `DS-NNN` collisions renumber deterministically (older `createdAt` keeps its number); one summary notification lists the renames. The storage dir stays gitignored (`ensureGitignore`, `src/storage.ts:494` — untouched); sync deliberately bypasses the worktree. Collaborators who never enable sync simply never see the ref.

**Caution — `dostuff.clearAll` (`src/extension.ts:722`) now records tombstones for every ticket** ([01-schema-groundwork §6](01-schema-groundwork.md)); with sync on this propagates board-wide deletion to every replica. When `sync.enabled`, extend the clearAll confirmation dialog with one sentence: "This will also delete these tickets for everyone syncing this repo."

## 7. Failure-mode behavior (controller view)

| Failure | Handling |
|---|---|
| git not installed | `noRepo`, log once, status-bar warning, no retry storm |
| Not a git repo / no workspace | `noRepo`; sync inert |
| No remote / bad remote name | `noRemote` local-only mode: ref commits still land (history + same-machine convergence) |
| Push fails (network) | `pendingPush`; retried on next interval/manual sync; local commits never blocked |
| Auth prompt would block | prompts disabled via env; `AuthFailed` → actionable error message |
| Two same-machine windows | CAS retry + 15s tip poll |
| Packed refs | tip detection via `rev-parse`, never loose-file watching |

## 8. Tests — `src/gitSync.test.ts`

Bare origin + two clones (temp dirs), driving two `IssueStore`+controller pairs:

- Two writers create colliding DS numbers → both sync → boards converge byte-identically; loser renumbered per spec; attachment dir renamed.
- Delete on A propagates to B via tombstone; B's re-sync does not resurrect.
- **Element delete-vs-edit**: A deletes task X while B toggles X done → after cross-sync both converge to the LWW outcome, byte-identical states (both timestamp orders).
- **pendingClose round trip**: `request_ticket_close` on A propagates the flag to B; `resolveCloseRequest(approve)` on B propagates `Closed` back to A (A's board hides it; the store still has it). Concurrent losing-side request dropped by LWW → converged, flag null on both (documents the accepted risk).
- Non-FF push retry: inject a commit into the bare ref between A's fetch and push → A recovers within retry budget.
- No-remote mode: commits land on the local ref; status `noRemote`; enabling a remote later pushes the backlog.
- `pendingPush` recovery on next `syncNow`.
- Echo suppression: applying inbound does not trigger an outbound commit (assert tip stable after apply of already-committed state).
- Interval `0`: no network calls except manual; local commits still occur.
