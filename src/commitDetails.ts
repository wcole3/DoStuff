// Lazy commit-detail derivation for ticket commit anchors.
//
// Tickets store only `{ sha, at }` (see `TicketCommit` in types.ts); the
// subject line and touched files are derived here, on demand, from the
// workspace's real git repo — never stored, never synced. This module is
// vscode-free (like gitPlumbing/syncMerge) so it stays unit-testable against
// plain temp dirs; the extension host wires the workspace root in via
// `getRoot`.

import * as path from "node:path";
import { findRepoRoot, GitRepo, type GitRepoOptions } from "./gitPlumbing";
import type { CommitDetail } from "./types";

export interface CommitDetailsResult {
  /** Posix relative path from the workspace root to the repo root ("." when
   *  equal). The webview prefixes derived file paths with this so openLink's
   *  `./`/`../` resolution lands on the right file when the workspace folder
   *  is a subdirectory of the repo. */
  pathPrefix: string;
  details: CommitDetail[];
}

const NOT_FOUND = (sha: string): CommitDetail => ({ sha, found: false, subject: "", files: [] });

/** Cap on memoized positive results; oldest evicted first. A sha's subject and
 *  file list are immutable, so positive entries never go stale. */
const CACHE_MAX = 200;

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Build a fetcher that resolves ticket commit shas against the repo containing
 * `getRoot()` (the workspace folder). Independent of `dostuff.sync.enabled` —
 * this reads the user's real repo, not the hidden sync ref. Every failure mode
 * (no workspace, not a repo, git missing, dangling or non-hex sha) degrades to
 * `found: false`; nothing here throws.
 */
export function createCommitDetailsFetcher(
  getRoot: () => string | null,
  opts?: { git?: GitRepoOptions },
): (shas: string[]) => Promise<CommitDetailsResult> {
  let repo: GitRepo | null = null;
  let repoRoot: string | null = null;
  // Positive-only cache: `found: false` is never cached because a later
  // `git fetch` (or switching workspaces) can make the same sha resolvable.
  const cache = new Map<string, CommitDetail>();

  return async (shas: string[]): Promise<CommitDetailsResult> => {
    const wsRoot = getRoot();
    const empty: CommitDetailsResult = { pathPrefix: ".", details: shas.map(NOT_FOUND) };
    if (!wsRoot) return empty;

    let root: string | null;
    try {
      root = await findRepoRoot(wsRoot);
    } catch {
      root = null; // git binary missing
    }
    if (!root) return empty;
    if (root !== repoRoot) {
      repoRoot = root;
      repo = new GitRepo(root, opts?.git ?? {});
      cache.clear(); // sha resolution is repo-relative
    }
    const activeRepo = repo!;
    const rel = toPosix(path.relative(wsRoot, root));
    const pathPrefix = rel || ".";

    const details = await Promise.all(
      shas.map(async (sha): Promise<CommitDetail> => {
        const hit = cache.get(sha);
        if (hit) return hit;
        let subject: string | null = null;
        let files: string[] | null = null;
        try {
          [subject, files] = await Promise.all([
            activeRepo.commitSubject(sha),
            activeRepo.diffTreeNameOnly(sha),
          ]);
        } catch {
          // GitError (timeout, repo vanished mid-call) → not found.
        }
        if (subject === null || files === null) return NOT_FOUND(sha);
        const detail: CommitDetail = { sha, found: true, subject, files };
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(sha, detail);
        return detail;
      }),
    );

    return { pathPrefix, details };
  };
}
