// Tests for the git CLI plumbing (docs/plans/ticket-sync/03 §6): real `git`
// against temp-dir repos — the same real-process posture as mcpServer.test.ts
// (real loopback HTTP). No mocks; every assertion runs the actual binary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findRepoRoot,
  GitError,
  GitRepo,
  __runGitForTests,
  type TreeEntry,
} from "./gitPlumbing";

const STATE_REF = "refs/dostuff/state";
const REMOTE_REF = "refs/dostuff/remote";

let tmpRoot = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function mkRepo(name: string, bare = false): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ...(bare ? ["--bare"] : []));
  return dir;
}

/**
 * Commit a one-file tree onto `ref` via the plumbing under test. `oldTip` is
 * the CAS expectation for the local ref (null = ref must not exist yet) —
 * distinct from `parents`, e.g. when adopting a fetched tip as first parent
 * while the local ref is still unborn.
 */
async function commitState(
  repo: GitRepo,
  ref: string,
  files: Record<string, string>,
  parents: string[],
  oldTip: string | null = parents[0] ?? null,
): Promise<string> {
  const entries: TreeEntry[] = [];
  for (const [p, body] of Object.entries(files)) {
    entries.push({
      mode: "100644",
      type: "blob",
      oid: await repo.hashObjectStdin(Buffer.from(body, "utf8")),
      path: p,
    });
  }
  const tree = await repo.mkTree(entries);
  const commit = await repo.commitTree(tree, parents, `dostuff: ${Object.keys(files).length} files`);
  await repo.updateRefCas(ref, commit, oldTip);
  return commit;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-gitplumbing-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("findRepoRoot", () => {
  test("resolves the toplevel inside a repo; null outside", async () => {
    const repo = mkRepo("findroot");
    const nested = path.join(repo, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(await findRepoRoot(nested)).toBe(fs.realpathSync(repo));

    const plain = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(plain, { recursive: true });
    expect(await findRepoRoot(plain)).toBeNull();
  });
});

describe("object round trip", () => {
  test("hash-object → mktree → commit-tree → readTree → catFileBatch, incl. binary", async () => {
    const dir = mkRepo("roundtrip");
    const repo = new GitRepo(dir);

    const textOid = await repo.hashObjectStdin(Buffer.from('{ "a": 1 }\n', "utf8"));
    const binary = Buffer.from([0, 1, 2, 255, 254, 10, 0, 13, 10, 42]);
    const binOid = await repo.hashObjectStdin(binary);

    const subTree = await repo.mkTree([
      { mode: "100644", type: "blob", oid: textOid, path: "abc.json" },
    ]);
    const rootTree = await repo.mkTree([
      { mode: "100644", type: "blob", oid: binOid, path: "meta.bin" },
      { mode: "040000", type: "tree", oid: subTree, path: "tickets" },
    ]);
    const commit = await repo.commitTree(rootTree, [], "dostuff: test");
    await repo.updateRefCas(STATE_REF, commit, null);

    expect(await repo.revParse(STATE_REF)).toBe(commit);
    const entries = await repo.readTree(commit);
    expect(entries.map((e) => e.path).sort()).toEqual(["meta.bin", "tickets/abc.json"]);

    const blobs = await repo.catFileBatch([textOid, binOid, "0".repeat(40)]);
    expect(blobs.get(textOid)?.toString("utf8")).toBe('{ "a": 1 }\n');
    expect(Buffer.compare(blobs.get(binOid)!, binary)).toBe(0);
    expect(blobs.has("0".repeat(40))).toBe(false); // missing oid → absent, no throw
  });

  test("catBlobToFile streams bytes to disk (and leaves no .part behind)", async () => {
    const dir = mkRepo("blobfile");
    const repo = new GitRepo(dir);
    const payload = Buffer.from([7, 0, 8, 0, 9, 255]);
    const oid = await repo.hashObjectStdin(payload);
    const dest = path.join(dir, "restored.bin");
    await repo.catBlobToFile(oid, dest);
    expect(Buffer.compare(fs.readFileSync(dest), payload)).toBe(0);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  test("catBlobToFile failure leaves neither the destination nor a .part file", async () => {
    const dir = mkRepo("blobfail");
    const repo = new GitRepo(dir);
    const dest = path.join(dir, "never.bin");
    // Unknown oid → git exits non-zero; a truncated/empty file must not
    // survive to be mistaken for a present attachment.
    await expect(repo.catBlobToFile("f".repeat(40), dest)).rejects.toMatchObject({
      code: "GitFailed",
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);

    // Write-stream failure (unwritable destination dir) → same guarantee.
    const badDest = path.join(dir, "no-such-dir", "x.bin");
    const oid = await repo.hashObjectStdin(Buffer.from([1]));
    await expect(repo.catBlobToFile(oid, badDest)).rejects.toMatchObject({ code: "GitFailed" });
    expect(fs.existsSync(badDest)).toBe(false);
    expect(fs.existsSync(`${badDest}.part`)).toBe(false);
  });
});

describe("updateRefCas", () => {
  test("create-only, advance, and mismatch semantics", async () => {
    const dir = mkRepo("cas");
    const repo = new GitRepo(dir);

    const c1 = await commitState(repo, STATE_REF, { "a.txt": "one" }, []);
    // Creating again with 40-zeros old value must fail — ref already exists.
    await expect(repo.updateRefCas(STATE_REF, c1, null)).rejects.toMatchObject({
      code: "CasFailed",
    });

    const c2 = await commitState(repo, STATE_REF, { "a.txt": "two" }, [c1]);
    expect(await repo.revParse(STATE_REF)).toBe(c2);

    // Stale old value (c1) after the ref moved to c2 → CasFailed.
    await expect(repo.updateRefCas(STATE_REF, c1, c1)).rejects.toMatchObject({
      code: "CasFailed",
    });
  });

  test("non-CAS failures classify as GitFailed so the retry loop doesn't spin", async () => {
    const dir = mkRepo("cas-misc");
    const repo = new GitRepo(dir);
    // A garbage new oid is unwinnable — retrying the CAS would never help.
    await expect(repo.updateRefCas(STATE_REF, "not-an-oid", null)).rejects.toMatchObject({
      code: "GitFailed",
    });
  });
});

describe("isAncestor", () => {
  test("true / false / unrelated-histories", async () => {
    const dir = mkRepo("ancestry");
    const repo = new GitRepo(dir);
    const c1 = await commitState(repo, STATE_REF, { "a.txt": "one" }, []);
    const c2 = await commitState(repo, STATE_REF, { "a.txt": "two" }, [c1]);
    // Unrelated root on a scratch ref.
    const u1 = await commitState(repo, "refs/dostuff/scratch", { "b.txt": "x" }, []);

    expect(await repo.isAncestor(c1, c2)).toBe(true);
    expect(await repo.isAncestor(c2, c1)).toBe(false);
    expect(await repo.isAncestor(u1, c2)).toBe(false); // degrades to "diverged"
  });
});

describe("commitSubject / diffTreeNameOnly", () => {
  test("real commit → subject + file list; root commit lists files; child lists only the diff", async () => {
    const dir = mkRepo("commitinfo");
    const repo = new GitRepo(dir);
    // mkTree takes single-level entries, so nested paths go through a subtree.
    const subOid = await repo.mkTree([
      { mode: "100644", type: "blob", oid: await repo.hashObjectStdin(Buffer.from("two", "utf8")), path: "b.txt" },
    ]);
    const rootTree = async (aBody: string) =>
      repo.mkTree([
        { mode: "100644", type: "blob", oid: await repo.hashObjectStdin(Buffer.from(aBody, "utf8")), path: "a.txt" },
        { mode: "040000", type: "tree", oid: subOid, path: "sub" },
      ]);
    const c1 = await repo.commitTree(await rootTree("one"), [], "dostuff: 2 files");
    const c2 = await repo.commitTree(await rootTree("changed"), [c1], "dostuff: 2 files");
    await repo.updateRefCas(STATE_REF, c2, null);

    expect(await repo.commitSubject(c1)).toBe("dostuff: 2 files");
    // --root: the parentless commit still lists its files, recursively (-r).
    expect((await repo.diffTreeNameOnly(c1))?.sort()).toEqual(["a.txt", "sub/b.txt"]);
    // Child commit lists only what changed.
    expect(await repo.diffTreeNameOnly(c2)).toEqual(["a.txt"]);
    // Abbreviated sha resolves too.
    expect(await repo.commitSubject(c1.slice(0, 7))).toBe("dostuff: 2 files");
  });

  test("unknown, non-hex, and option-shaped inputs → null (no throw, no spawn for non-hex)", async () => {
    const dir = mkRepo("commitinfo-bad");
    const repo = new GitRepo(dir);
    expect(await repo.commitSubject("f".repeat(40))).toBeNull();
    expect(await repo.diffTreeNameOnly("f".repeat(40))).toBeNull();
    for (const bad of ["HEAD", "--format", "main..dev", "a1b2", ""]) {
      expect(await repo.commitSubject(bad)).toBeNull();
      expect(await repo.diffTreeNameOnly(bad)).toBeNull();
    }
  });

  test("blob oid → null (^{commit} peel refuses non-commits)", async () => {
    const dir = mkRepo("commitinfo-blob");
    const repo = new GitRepo(dir);
    const blobOid = await repo.hashObjectStdin(Buffer.from("just a blob", "utf8"));
    expect(await repo.commitSubject(blobOid)).toBeNull();
    expect(await repo.diffTreeNameOnly(blobOid)).toBeNull();
  });
});

describe("remote operations against a bare origin", () => {
  test("lsRemote missing ref → null; fetch/push round trip; NonFastForward classified", async () => {
    const bare = mkRepo("origin.git", true);
    const dirA = mkRepo("cloneA");
    const dirB = mkRepo("cloneB");
    git(dirA, "remote", "add", "origin", bare);
    git(dirB, "remote", "add", "origin", bare);
    const a = new GitRepo(dirA);
    const b = new GitRepo(dirB);

    // Remote reachable but the state ref doesn't exist yet → clean null.
    expect(await a.remoteUrl("origin")).toBe(bare);
    expect(await a.remoteUrl("nope")).toBeNull();
    expect(await a.lsRemote("origin", STATE_REF)).toBeNull();

    // A creates and pushes the ref.
    const a1 = await commitState(a, STATE_REF, { "t.json": "from A" }, []);
    await a.pushStateRef("origin", STATE_REF);
    expect(await a.lsRemote("origin", STATE_REF)).toBe(a1);

    // B fetches into the tracking ref and reads the same bytes.
    await b.fetchStateRef("origin", STATE_REF, REMOTE_REF);
    expect(await b.revParse(REMOTE_REF)).toBe(a1);

    // B advances the shared ref (its local state ref is unborn — parent is
    // the fetched tip, CAS expectation is "create")…
    const b1 = await commitState(b, STATE_REF, { "t.json": "from B" }, [a1], null);
    await b.pushStateRef("origin", STATE_REF);
    expect(await b.lsRemote("origin", STATE_REF)).toBe(b1);

    // …so A's next push from its stale tip must reject as NonFastForward.
    await commitState(a, STATE_REF, { "t.json": "stale A edit" }, [a1]);
    let err: unknown;
    try {
      await a.pushStateRef("origin", STATE_REF);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe("NonFastForward");
  });
});

describe("timeout", () => {
  test("a stalled process is killed at the deadline with a typed Timeout error", async () => {
    const dir = mkRepo("stall");
    // `cat-file --batch` with stdin held open blocks forever — deterministic
    // stall, no network flakiness.
    let err: unknown;
    try {
      await __runGitForTests(["cat-file", "--batch"], {
        cwd: dir,
        timeoutMs: 300,
        closeStdin: false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe("Timeout");
  });
});
