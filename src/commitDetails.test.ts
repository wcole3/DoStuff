// Tests for the lazy commit-detail fetcher: real `git` against temp-dir
// repos, same posture as gitPlumbing.test.ts. No mocks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCommitDetailsFetcher } from "./commitDetails";
import { GitRepo, type TreeEntry } from "./gitPlumbing";

let tmpRoot = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function mkRepo(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  return dir;
}

/** One-file root commit via the plumbing (gitEnv supplies the identity).
 *  `file` must be a single-level path — mkTree rejects slashes. */
async function commitFile(repo: GitRepo, file: string, body: string, parents: string[] = []): Promise<string> {
  const entries: TreeEntry[] = [
    { mode: "100644", type: "blob", oid: await repo.hashObjectStdin(Buffer.from(body, "utf8")), path: file },
  ];
  const tree = await repo.mkTree(entries);
  const commit = await repo.commitTree(tree, parents, `add ${file}`);
  await repo.updateRefCas("refs/dostuff/test", commit, parents[0] ?? null);
  return commit;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-commitdetails-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("createCommitDetailsFetcher", () => {
  test("mixed batch: known sha found with subject+files, unknown degrades", async () => {
    const dir = mkRepo("mixed");
    const c1 = await commitFile(new GitRepo(dir), "a.ts", "one");
    const fetch = createCommitDetailsFetcher(() => dir);

    const { pathPrefix, details } = await fetch([c1, "f".repeat(40)]);
    expect(pathPrefix).toBe(".");
    expect(details).toEqual([
      { sha: c1, found: true, subject: "add a.ts", files: ["a.ts"] },
      { sha: "f".repeat(40), found: false, subject: "", files: [] },
    ]);
  });

  test("workspace as a subdirectory of the repo → posix pathPrefix climbs to the root", async () => {
    const dir = mkRepo("subdir");
    const nested = path.join(dir, "packages", "web");
    fs.mkdirSync(nested, { recursive: true });
    const c1 = await commitFile(new GitRepo(dir), "top.txt", "x");
    const fetch = createCommitDetailsFetcher(() => nested);

    const { pathPrefix, details } = await fetch([c1]);
    expect(pathPrefix).toBe("../..");
    expect(details[0]).toMatchObject({ found: true, files: ["top.txt"] });
  });

  test("no workspace / not a repo → every sha found:false, never throws", async () => {
    const noRoot = createCommitDetailsFetcher(() => null);
    expect(await noRoot(["abcdef0"])).toEqual({
      pathPrefix: ".",
      details: [{ sha: "abcdef0", found: false, subject: "", files: [] }],
    });

    const plain = path.join(tmpRoot, "plain-dir");
    fs.mkdirSync(plain, { recursive: true });
    const notRepo = createCommitDetailsFetcher(() => plain);
    expect((await notRepo(["abcdef0"])).details[0]!.found).toBe(false);
  });

  test("non-hex input degrades to found:false", async () => {
    const dir = mkRepo("nonhex");
    await commitFile(new GitRepo(dir), "a.txt", "x");
    const fetch = createCommitDetailsFetcher(() => dir);
    const { details } = await fetch(["--format", "HEAD"]);
    expect(details.every((d) => !d.found)).toBe(true);
  });

  test("positive results are cached; found:false is not", async () => {
    const dir = mkRepo("cache");
    const repo = new GitRepo(dir);
    const c1 = await commitFile(repo, "a.txt", "x");
    const fetch = createCommitDetailsFetcher(() => dir);

    expect((await fetch([c1])).details[0]!.found).toBe(true);

    // Drop the ref and prune the object: a *fresh* fetcher can no longer
    // resolve the sha, but the warm cache still serves the positive result.
    git(dir, "update-ref", "-d", "refs/dostuff/test");
    git(dir, "gc", "--prune=now", "--quiet");
    expect((await createCommitDetailsFetcher(() => dir)([c1])).details[0]!.found).toBe(false);
    expect((await fetch([c1])).details[0]!.found).toBe(true);
  });
});
