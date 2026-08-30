// Git CLI plumbing for git-native ticket sync
// (docs/plans/ticket-sync/03-git-plumbing.md).
//
// HARD CONSTRAINTS: no `vscode` imports (pure node — unit-testable with real
// git in temp dirs), zero npm deps, and every invocation is
// `spawn("git", [argv])` with argv arrays — never a shell, never content
// passed as an argument (binary-safe I/O goes over stdin/stdout only).

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { once } from "node:events";

// ─── error taxonomy ───────────────────────────────────────────────────────

export type GitErrorCode =
  | "GitNotFound" // ENOENT spawning git
  | "NotARepo" // rev-parse --show-toplevel failed
  | "NoRemote" // remote get-url failed
  | "RemoteRefMissing" // ls-remote --exit-code exit 2 (not really an error)
  | "AuthFailed" // credential/auth stderr patterns
  | "NonFastForward" // push rejected
  | "CasFailed" // update-ref old-value mismatch
  | "Timeout" // process killed at deadline
  | "GitFailed"; // anything else

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /permission denied \(publickey/i,
  /terminal prompts disabled/i,
  /invalid credentials/i,
  /403 forbidden/i,
];

// Deliberately narrow: git's generic "failed to push some refs" line appears
// on ANY push failure (hook declines, disk-full remotes), where a fetch+merge
// retry can never help. Only genuine stale-tip signals belong here.
const NON_FF_PATTERNS = [/non-fast-forward/i, /\[rejected\]/i, /fetch first/i];

function classify(args: string[], stderr: string): GitErrorCode {
  if (AUTH_PATTERNS.some((re) => re.test(stderr))) return "AuthFailed";
  if (args[0] === "push" && NON_FF_PATTERNS.some((re) => re.test(stderr))) return "NonFastForward";
  // update-ref never routes through here — `updateRefCas` owns CAS
  // classification with its own stderr patterns.
  return "GitFailed";
}

// ─── process invocation ───────────────────────────────────────────────────

/** 15s for local plumbing, 120s for network (fetch/push/ls-remote). */
export const LOCAL_TIMEOUT_MS = 15_000;
export const NETWORK_TIMEOUT_MS = 120_000;

interface RunOpts {
  cwd: string;
  stdin?: Buffer;
  timeoutMs: number;
  /** Test hook only: leave stdin open so the timeout path is exercisable
   *  deterministically (a `cat-file --batch` with open stdin blocks forever). */
  closeStdin?: boolean;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Spawn one git process. Env policy (03 §2): terminal prompts disabled,
 * optional locks off, sync identity injected so commits work in repos with no
 * user.name; `GIT_SSH_COMMAND` and credential helpers are left untouched.
 * Never rejects for a non-zero exit — callers inspect `code` (spawn errors
 * and timeouts DO reject with typed GitError).
 */
/**
 * The one place the git process environment is defined (03 §2): prompts
 * disabled, optional locks off, sync identity injected so commits work in
 * repos with no user.name. Both spawn paths (`runGit` and the streaming
 * `catBlobToFile`) use this — a policy change must not miss one of them.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "DoStuff Sync",
    GIT_AUTHOR_EMAIL: "dostuff@localhost",
    GIT_COMMITTER_NAME: "DoStuff Sync",
    GIT_COMMITTER_EMAIL: "dostuff@localhost",
  };
}

function runGit(args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(new GitError("GitNotFound", "git executable not found"));
      } else {
        reject(new GitError("GitFailed", `git spawn failed: ${e.message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new GitError("Timeout", `git ${args[0]} timed out after ${opts.timeoutMs}ms`),
        );
        return;
      }
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    if (opts.closeStdin !== false) child.stdin.end();
    child.stdin.on("error", () => {
      // EPIPE when git exits before consuming stdin — the close handler
      // carries the real outcome.
    });
  });
}

/** Exported for the deterministic timeout test only. */
export const __runGitForTests = runGit;

// ─── module API ───────────────────────────────────────────────────────────

export interface TreeEntry {
  mode: string; // "100644" | "040000" | ...
  type: "blob" | "tree" | "commit";
  oid: string;
  path: string;
}

/** Resolve the repo root for `dir`, or null when git is absent / not a repo. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  try {
    const r = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: dir,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (r.code !== 0) return null;
    return r.stdout.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

export interface GitRepoOptions {
  /** Timeout overrides — tests shrink these. */
  localTimeoutMs?: number;
  networkTimeoutMs?: number;
}

export class GitRepo {
  private readonly localMs: number;
  private readonly networkMs: number;

  constructor(
    readonly root: string,
    opts: GitRepoOptions = {},
  ) {
    this.localMs = opts.localTimeoutMs ?? LOCAL_TIMEOUT_MS;
    this.networkMs = opts.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
  }

  private local(args: string[], stdin?: Buffer): Promise<RunResult> {
    return runGit(args, { cwd: this.root, timeoutMs: this.localMs, stdin });
  }

  private network(args: string[]): Promise<RunResult> {
    return runGit(args, { cwd: this.root, timeoutMs: this.networkMs });
  }

  private static fail(args: string[], r: RunResult): never {
    throw new GitError(
      classify(args, r.stderr),
      `git ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`,
      r.stderr,
    );
  }

  /** OID at `ref`, or null when the ref doesn't exist. */
  async revParse(ref: string): Promise<string | null> {
    const args = ["rev-parse", "--verify", "--quiet", ref];
    const r = await this.local(args);
    if (r.code !== 0) return null; // unborn ref — the only expected failure
    return r.stdout.toString("utf8").trim();
  }

  /**
   * Is `a` an ancestor of `b`? Any failure beyond a clean "no" (e.g. unrelated
   * histories, shallow-clone gaps) degrades to false — "treat as diverged" is
   * always safe, it just re-merges (03 §4 notes).
   */
  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.local(["merge-base", "--is-ancestor", a, b]);
    return r.code === 0;
  }

  /**
   * OID of `ref` on `remote`, or null when the remote exists but the ref does
   * not (`--exit-code` exit 2 — the clean RemoteRefMissing signal, which also
   * validates connectivity/auth up front). Other failures throw.
   */
  async lsRemote(remote: string, ref: string): Promise<string | null> {
    const args = ["ls-remote", "--exit-code", remote, ref];
    const r = await this.network(args);
    if (r.code === 2) return null;
    if (r.code !== 0) GitRepo.fail(args, r);
    const line = r.stdout.toString("utf8").split("\n")[0] ?? "";
    return line.split("\t")[0] || null;
  }

  /** `git fetch <remote> +<srcRef>:<dstRef> --no-tags --quiet`. */
  async fetchStateRef(remote: string, srcRef: string, dstRef: string): Promise<void> {
    const args = ["fetch", remote, `+${srcRef}:${dstRef}`, "--no-tags", "--quiet"];
    const r = await this.network(args);
    if (r.code !== 0) GitRepo.fail(args, r);
  }

  /** `git push <remote> <ref>:<ref>` — NO force; the server enforces FF. */
  async pushStateRef(remote: string, ref: string): Promise<void> {
    const args = ["push", remote, `${ref}:${ref}`];
    const r = await this.network(args);
    if (r.code !== 0) GitRepo.fail(args, r);
  }

  /** URL of `remote`, or null when it isn't configured. */
  async remoteUrl(remote: string): Promise<string | null> {
    const r = await this.local(["remote", "get-url", remote]);
    if (r.code !== 0) return null;
    return r.stdout.toString("utf8").trim() || null;
  }

  /**
   * First line of a commit's message, or null when `sha` doesn't resolve to a
   * commit here (rebased away, not fetched, garbage input). Hex-validated
   * defensively even though callers already validate — a sha can then never
   * start with `-`, so argv option injection is structurally impossible. The
   * `^{commit}` peel makes a blob/tree oid fail instead of dumping content.
   */
  async commitSubject(sha: string): Promise<string | null> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    const r = await this.local(["show", "-s", "--format=%s", `${sha}^{commit}`]);
    if (r.code !== 0) return null;
    return (r.stdout.toString("utf8").split("\n")[0] ?? "").trim();
  }

  /**
   * Repo-relative paths touched by a commit, or null when it doesn't resolve.
   * `--root` so the initial commit lists its files; merge commits yield []
   * (diff-tree prints nothing for them without -c — accepted, the subject
   * still renders). Same hex guard as `commitSubject`.
   */
  async diffTreeNameOnly(sha: string): Promise<string[] | null> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    const args = ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", `${sha}^{commit}`];
    const r = await this.local(args);
    if (r.code !== 0) return null;
    return r.stdout.toString("utf8").split("\n").filter(Boolean);
  }

  /** `git hash-object -w --stdin` — content over stdin, never argv. */
  async hashObjectStdin(content: Buffer): Promise<string> {
    const args = ["hash-object", "-w", "--stdin"];
    const r = await this.local(args, content);
    if (r.code !== 0) GitRepo.fail(args, r);
    return r.stdout.toString("utf8").trim();
  }

  /** `git mktree` from entry lines; mktree normalizes entry order itself. */
  async mkTree(entries: TreeEntry[]): Promise<string> {
    const lines = entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`).join("\n");
    const args = ["mktree"];
    const r = await this.local(args, Buffer.from(lines.length ? lines + "\n" : "", "utf8"));
    if (r.code !== 0) GitRepo.fail(args, r);
    return r.stdout.toString("utf8").trim();
  }

  /** `git commit-tree <tree> [-p parent]... -m <message>`. */
  async commitTree(tree: string, parents: string[], message: string): Promise<string> {
    const args = ["commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message);
    const r = await this.local(args);
    if (r.code !== 0) GitRepo.fail(args, r);
    return r.stdout.toString("utf8").trim();
  }

  /**
   * Compare-and-swap ref update. `oldOid: null` means "the ref must not exist
   * yet" (40 zeros). A mismatch (another writer advanced the ref) throws
   * `CasFailed` — the caller re-reads, re-merges, retries. Failures that are
   * NOT a lost race (bad oid, fs permissions) throw `GitFailed` so the
   * caller's CAS retry loop doesn't spin on an unwinnable error.
   */
  async updateRefCas(ref: string, newOid: string, oldOid: string | null): Promise<void> {
    const args = ["update-ref", ref, newOid, oldOid ?? "0".repeat(40)];
    const r = await this.local(args);
    if (r.code !== 0) {
      const isCas = /cannot lock ref|but expected|ref .* is at|reference already exists/i.test(
        r.stderr,
      );
      throw new GitError(
        isCas ? "CasFailed" : "GitFailed",
        `git update-ref CAS on ${ref} failed: ${r.stderr.trim()}`,
        r.stderr,
      );
    }
  }

  /** Recursive listing of the tree at `tip` (`ls-tree -r -z`). */
  async readTree(tip: string): Promise<TreeEntry[]> {
    const args = ["ls-tree", "-r", "-z", tip];
    const r = await this.local(args);
    if (r.code !== 0) GitRepo.fail(args, r);
    const out: TreeEntry[] = [];
    for (const record of r.stdout.toString("utf8").split("\0")) {
      if (!record) continue;
      // "<mode> <type> <oid>\t<path>"
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (!mode || !type || !oid) continue;
      out.push({ mode, type: type as TreeEntry["type"], oid, path: record.slice(tab + 1) });
    }
    return out;
  }

  /**
   * Read many blobs through ONE `cat-file --batch` process. Frames on stdout:
   * `<oid> <type> <size>\n<raw bytes>\n`; missing oids answer
   * `<oid> missing\n` and are simply absent from the result map.
   */
  async catFileBatch(oids: string[]): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    if (oids.length === 0) return result;
    const args = ["cat-file", "--batch"];
    const r = await this.local(args, Buffer.from(oids.join("\n") + "\n", "utf8"));
    if (r.code !== 0) GitRepo.fail(args, r);

    let buf = r.stdout;
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const header = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      const parts = header.split(" ");
      if (parts.length >= 2 && parts[1] === "missing") continue;
      if (parts.length < 3) continue;
      const size = Number.parseInt(parts[2]!, 10);
      if (!Number.isFinite(size) || size < 0) continue;
      result.set(parts[0]!, Buffer.from(buf.subarray(0, size)));
      buf = buf.subarray(size + 1); // skip the trailing \n after the payload
    }
    return result;
  }

  /**
   * Stream one blob's bytes to `destPath` (avoids `maxBuffer` concerns on
   * large attachments). Writes to `<destPath>.part` and renames into place on
   * success, so a timeout or failure mid-stream never leaves a truncated file
   * that would read as a present-but-corrupt attachment forever.
   */
  async catBlobToFile(oid: string, destPath: string): Promise<void> {
    const partPath = `${destPath}.part`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["cat-file", "blob", oid], {
        cwd: this.root,
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.localMs);
      const stderr: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => stderr.push(c));

      const out = createWriteStream(partPath);
      child.stdout.pipe(out);

      const discardPart = async () => {
        try {
          await fsp.unlink(partPath);
        } catch {
          // best effort — nothing to discard when the stream never opened
        }
      };

      let failed: Error | null = null;
      out.on("error", (e) => {
        failed = e;
        child.kill("SIGKILL");
      });
      child.on("error", async (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        await discardPart();
        reject(
          e.code === "ENOENT"
            ? new GitError("GitNotFound", "git executable not found")
            : new GitError("GitFailed", `git spawn failed: ${e.message}`),
        );
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        try {
          if (!out.closed) {
            out.end();
            await once(out, "close");
          }
        } catch {
          // fall through to the failure checks below
        }
        if (failed) {
          await discardPart();
          return reject(new GitError("GitFailed", `write failed: ${failed.message}`));
        }
        if (timedOut) {
          await discardPart();
          return reject(
            new GitError("Timeout", `git cat-file blob ${oid} timed out after ${this.localMs}ms`),
          );
        }
        if (code !== 0) {
          await discardPart();
          return reject(
            new GitError(
              "GitFailed",
              `git cat-file blob ${oid} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
        }
        try {
          await fsp.rename(partPath, destPath);
        } catch (e) {
          await discardPart();
          return reject(
            new GitError("GitFailed", `finalizing ${destPath} failed: ${(e as Error).message}`),
          );
        }
        resolve();
      });
    });
  }
}
