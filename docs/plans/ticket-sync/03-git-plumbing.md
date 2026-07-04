# Ticket Sync — Plan 03: Git Plumbing (Phase 3)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · **03** · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md)

Phase 3 builds `src/gitPlumbing.ts`: a vscode-free wrapper around the `git` CLI (pure node — unit-testable with real git in temp dirs). Zero npm deps: every invocation is `child_process.execFile("git", [args], { cwd, env })` with **argv arrays, never a shell** — which eliminates Windows/WSL quoting concerns entirely.

## 1. Ref layout

- **`refs/dostuff/state`** — local truth. Configurable via `dostuff.sync.ref` (validated `^refs/`).
- **`refs/dostuff/remote`** — fetch tracking ref. Deliberately *not* under `refs/remotes/` so no porcelain UI (branch pickers, graph views) surfaces it.

Tree at each commit tip:

```
meta.json                       { "formatVersion": 1 }
tickets/<guid>.json             canonical-JSON WireTicket (see 02-merge-spec §1–2)
tombstones/<guid>.json          { "guid", "deletedAt", "lastId" }
attachments/<guid>/<attId>      raw bytes, no extension (name/mime live in ticket metadata; see 05)
```

`meta.json` `formatVersion` guards future wire-format changes: a build seeing a *newer* formatVersion warns and refuses to merge (never corrupts), mirroring the "DB newer than build" posture in `src/storage.ts:558-573`.

## 2. Process invocation policy

- `repoRoot` from `git rev-parse --show-toplevel`, run once at controller start with cwd = `workspaceFolders[0].uri.fsPath`. Failure → `NotARepo` state, logged once, no retry spam.
- Env for every call: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_OPTIONAL_LOCKS=0`. Never touch `GIT_SSH_COMMAND` (respect user agents/config). Commit identity via env — `GIT_AUTHOR_NAME="DoStuff Sync"`, `GIT_AUTHOR_EMAIL="dostuff@localhost"` (+ `GIT_COMMITTER_*`) — so sync works in repos with no `user.name` configured.
- Timeouts: **15s** local plumbing, **120s** network (fetch/push/ls-remote); kill on expiry → `Timeout` error.
- Binary-safe I/O over stdin/stdout only; no temp files, no content ever passed as an argument.

## 3. Command sequences

### (a) Commit current state to the local ref (CAS)

```
git rev-parse --verify --quiet refs/dostuff/state        # → oldTip, or miss (ref not born)
# per file, content piped to stdin:
git hash-object -w --stdin                               # → blob oid
# trees bottom-up; mktree normalizes entry order:
git mktree     # stdin lines: "100644 blob <oid>\t<name>"  /  "040000 tree <oid>\t<dirname>"
               # order: tickets/, tombstones/, each attachments/<guid>/, attachments/, then root
git rev-parse <oldTip>^{tree}                             # == new root tree? → no-op, skip commit
git commit-tree <rootTree> [-p <oldTip>] -m "dostuff: <n> tickets, <m> tombstones"
                                                          # message trailer: DoStuff-Writer: <writerId>
git update-ref refs/dostuff/state <newCommit> <oldTipOr40zeros>
                                                          # CAS; 40 zeros = "ref must not exist yet"
```

- **CAS failure** (another window advanced the ref between rev-parse and update-ref): re-read tip, state-merge the tip's state with our cache ([02-merge-spec](02-merge-spec.md)), retry. Max **5** attempts, then surface `CasFailed`.
- `writerId` = uuid minted once into `context.globalState` — provenance in history, useful for debugging multi-writer traces.
- Perf: reuse blob OIDs from the previous tip's `readTree` for unchanged paths (especially attachments) — never rehash a 10 MB file already in the ref.

### (b) Fetch

```
git ls-remote --exit-code <remote> refs/dostuff/state    # exit 2 → RemoteRefMissing (clean signal;
                                                         # also validates connectivity/auth up front)
git fetch <remote> +refs/dostuff/state:refs/dostuff/remote --no-tags --quiet
```

### (c) Read state for merge (never git content merge)

```
git merge-base --is-ancestor <A> <B>                     # ancestry short-circuits (see 04 §3)
git ls-tree -r -z <tip>                                  # → (mode, type, oid, path) per entry
git cat-file --batch                                     # ONE process: oids on stdin,
                                                         # "<oid> <type> <size>\n<raw>" frames on stdout
```

Implement `catFileBatch(oids: string[]): Promise<Map<oid, Buffer>>` once (~40 lines of frame parsing) instead of N `cat-file` spawns. Attachment blobs restored to disk stream `git cat-file blob <oid>` stdout directly to the file (avoids `maxBuffer`).

Merged tree is then written via the (a) steps and committed with **two parents**:

```
git commit-tree <mergedRoot> -p <localTip> -p <remoteTip> -m "dostuff: merge"
```

### (d) Push with non-fast-forward retry

```
git push <remote> refs/dostuff/state:refs/dostuff/state   # NO force, no '+' — server enforces FF
```

Rejected (someone pushed since our fetch) → fetch → merge → push again; max **3** loops → give up in `pendingPush` state, retried automatically on next interval/manual sync. Local commits are never blocked by push failures.

## 4. Error taxonomy

Classified from exit code + stderr patterns into typed errors:

| Error | Trigger | Controller behavior (see 04) |
|---|---|---|
| `GitNotFound` | ENOENT spawning git | state `noRepo`, log once, no retry storm |
| `NotARepo` | `rev-parse --show-toplevel` fails | state `noRepo`; sync inert |
| `NoRemote` | `git remote get-url <remote>` fails | local-only mode (`noRemote`): ref commits still happen |
| `RemoteRefMissing` | `ls-remote --exit-code` exit 2 | first push creates the ref; not an error |
| `AuthFailed` | stderr auth/credential patterns | actionable message: "run `git fetch` in a terminal once to prime credentials" |
| `NonFastForward` | push rejection | retry loop (d) |
| `CasFailed` | update-ref old-value mismatch after retries | re-queue sync |
| `Timeout` | process killed at deadline | `pendingPush`/`error` per operation |

Notes: shallow clones are fine (merge is base-free; custom-ref fetch/push work; an `--is-ancestor` failure degrades to "treat as diverged" — safe, just re-merges). Repos with zero commits or detached HEAD are irrelevant — the custom ref is independent of HEAD and the worktree. SSH passphrase prompts can't hang forever (120s timeout) and terminal prompts are disabled.

## 5. Module API

```ts
// src/gitPlumbing.ts — NO vscode imports
export async function findRepoRoot(dir: string): Promise<string | null>;

export class GitRepo {
  constructor(readonly root: string);
  revParse(ref: string): Promise<string | null>;
  isAncestor(a: string, b: string): Promise<boolean>;
  lsRemote(remote: string, ref: string): Promise<string | null>;   // null = RemoteRefMissing
  fetchStateRef(remote: string, srcRef: string, dstRef: string): Promise<void>;
  pushStateRef(remote: string, ref: string): Promise<void>;        // throws NonFastForward
  remoteUrl(remote: string): Promise<string | null>;
  hashObjectStdin(content: Buffer): Promise<string>;
  mkTree(entries: TreeEntry[]): Promise<string>;
  commitTree(tree: string, parents: string[], message: string): Promise<string>;
  updateRefCas(ref: string, newOid: string, oldOid: string | null): Promise<void>;
  readTree(tip: string): Promise<TreeEntry[]>;                     // ls-tree -r -z
  catFileBatch(oids: string[]): Promise<Map<string, Buffer>>;
  catBlobToFile(oid: string, destPath: string): Promise<void>;
}
```

## 6. Tests — `src/gitPlumbing.test.ts`

Real `git` in temp dirs (`fs.mkdtemp` + `child_process`; pattern precedent: `mcpServer.test.ts` uses real loopback HTTP, so real-process tests are established in this repo):

- hash-object / mktree / commit-tree round trip: write blobs → tree → commit → `readTree` returns the same entries; `catFileBatch` returns the same bytes.
- `updateRefCas`: success path; expected failure when old OID mismatches; 40-zeros creates-only semantics.
- `ls-remote --exit-code` missing-ref → exit 2 → `null`.
- fetch/push explicit refspecs against `git init --bare` origin; `NonFastForward` classification when the bare ref moved.
- `isAncestor` true/false/unrelated cases.
- `catFileBatch` frame parsing with multiple mixed-size blobs including binary content.
- Timeout kill path (spawn against a command that stalls — e.g., fetch from a non-routable URL with a 1s test timeout).
