// Tests for the vscode-free storage core: the node:fs path the headless
// server uses, the export queue (concurrency L1), and byte-identity between
// the extension-hosted store and the bare core — the guard that the phase-1
// host split changed no persisted byte.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { IssueStoreCore, nodeStorageFs, type StorageFs } from "./storageCore";
import { makeIssueFactory } from "./testSupport";
import type { Issue } from "./types";

const WASM_BINARY = fs.readFileSync(
  path.join(import.meta.dir, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
);

const makeIssue = makeIssueFactory();

let tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-core-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCoreStore(dir: string, fsImpl: StorageFs = nodeStorageFs): IssueStoreCore {
  return new IssueStoreCore({
    storageDir: () => dir,
    wasmBinary: async () => WASM_BINARY,
    fs: fsImpl,
  });
}

beforeEach(() => {
  makeIssue.reset();
});

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("IssueStoreCore on node:fs (headless path)", () => {
  test("init creates dostuff.db + .gitignore; upserts round-trip across instances", async () => {
    const dir = tempDir();
    const a = makeCoreStore(dir);
    await a.init();
    const issue = makeIssue({ id: "DS-001", title: "core ticket", tags: ["x"] });
    await a.upsert(issue);
    a.dispose();

    expect(fs.existsSync(path.join(dir, "dostuff.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);

    const b = makeCoreStore(dir);
    await b.init();
    const loaded = b.get("DS-001");
    expect(loaded?.title).toBe("core ticket");
    expect(loaded?.tags).toEqual(["x"]);
    b.dispose();
  });

  test("attachments write/find/read/delete on node:fs", async () => {
    const dir = tempDir();
    const store = makeCoreStore(dir);
    await store.init();

    const bytes = new TextEncoder().encode("payload");
    expect(await store.writeAttachment("DS-001", "att1", ".txt", bytes)).toBe(true);
    const found = await store.findAttachmentPath("DS-001", "att1");
    expect(found).toBe(path.join(dir, "attachments", "DS-001", "att1.txt"));
    expect(new TextDecoder().decode(await store.readAttachment("DS-001", "att1"))).toBe("payload");

    // Traversal attempts stay logged no-ops, same as the extension path.
    expect(await store.writeAttachment("../evil", "att1", ".txt", bytes)).toBe(false);

    await store.deleteAttachmentFile("DS-001", "att1");
    expect(await store.findAttachmentPath("DS-001", "att1")).toBeNull();
    store.dispose();
  });

  test("no storageDir and no KV: init yields an empty in-memory store", async () => {
    const store = new IssueStoreCore({
      storageDir: () => null,
      wasmBinary: async () => WASM_BINARY,
    });
    await store.init();
    expect(store.list()).toEqual([]);
    await store.upsert(makeIssue({ id: "DS-001" }));
    expect(store.get("DS-001")).toBeDefined();
    store.dispose();
  });
});

describe("export queue (concurrency L1)", () => {
  /** Wrap nodeStorageFs with a per-call writeFile delay schedule. */
  function delayedFs(delays: number[]): { fsImpl: StorageFs; counters: { writes: number; renames: number } } {
    const counters = { writes: 0, renames: 0 };
    const fsImpl: StorageFs = {
      ...nodeStorageFs,
      writeFile: async (p, content) => {
        const delay = delays[Math.min(counters.writes, delays.length - 1)] ?? 0;
        counters.writes += 1;
        await new Promise((r) => setTimeout(r, delay));
        return nodeStorageFs.writeFile(p, content);
      },
      rename: async (from, to) => {
        counters.renames += 1;
        return nodeStorageFs.rename(from, to);
      },
    };
    return { fsImpl, counters };
  }

  test("overlapping upserts can never persist stale bytes (slow first export)", async () => {
    const dir = tempDir();
    // First post-init writeFile is slow, later ones fast. Without the export
    // queue, the second upsert's export would rename first and the slow
    // stale export would rename last — the disk would show title A.
    // Init itself performs one export (schema stamp), so pad the schedule.
    const { fsImpl } = delayedFs([0, 0, 40, 0, 0, 0]);
    const store = makeCoreStore(dir, fsImpl);
    await store.init();

    const base = makeIssue({ id: "DS-001", title: "title A" });
    const p1 = store.upsert(base);
    const p2 = store.upsert({ ...base, title: "title B" });
    await Promise.all([p1, p2]);
    store.dispose();

    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe("title B");
    reader.dispose();
  });

  test("a burst of upserts coalesces into few exports and the last state wins", async () => {
    const dir = tempDir();
    const { fsImpl, counters } = delayedFs([0, 0, 10]);
    const store = makeCoreStore(dir, fsImpl);
    await store.init();
    const renamesAfterInit = counters.renames;

    const base = makeIssue({ id: "DS-001", title: "v0" });
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) => store.upsert({ ...base, title: `v${i + 1}` })),
    );
    store.dispose();

    // All N mutations landed synchronously in the DB before any export
    // snapshot, so the queue needs at most: the running export + one queued
    // follow-up per completed run. A burst must not produce N exports.
    expect(counters.renames - renamesAfterInit).toBeLessThanOrEqual(3);

    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe(`v${N}`);
    reader.dispose();
  });
});

// ─── byte identity across hosts ───────────────────────────────────────────
// The phase-1 split is a pure host refactor: the same seed saved through the
// extension-hosted IssueStore (vscode.workspace.fs facade) and through the
// bare core on node:fs must produce byte-identical dostuff.db files.

interface FsHandles {
  origFolders: typeof vscode.workspace.workspaceFolders;
  origFs: typeof vscode.workspace.fs;
}

function installVirtualFs(): { files: Map<string, Uint8Array>; handles: FsHandles } {
  const files = new Map<string, Uint8Array>();
  const handles: FsHandles = {
    origFolders: vscode.workspace.workspaceFolders,
    origFs: vscode.workspace.fs,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).workspaceFolders = [
    { uri: vscode.Uri.file("/ws"), name: "ws", index: 0 },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).fs = {
    readFile: async (uri: { path: string }) => {
      const entry = files.get(uri.path);
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      return entry;
    },
    writeFile: async (uri: { path: string }, content: Uint8Array) => {
      files.set(uri.path, content);
    },
    createDirectory: async () => {},
    delete: async (uri: { path: string }, options?: { recursive?: boolean }) => {
      if (options?.recursive) {
        const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
        for (const key of Array.from(files.keys())) {
          if (key === uri.path || key.startsWith(prefix)) files.delete(key);
        }
      } else {
        files.delete(uri.path);
      }
    },
    stat: async (uri: { path: string }) => {
      if (!files.has(uri.path)) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
    },
    readDirectory: async () => [],
    rename: async (source: { path: string }, target: { path: string }) => {
      const entry = files.get(source.path);
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      files.set(target.path, entry);
      files.delete(source.path);
    },
  };
  return { files, handles };
}

describe("byte identity: extension-hosted store vs bare core", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.workspace as any).workspaceFolders = handles.origFolders;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.workspace as any).fs = handles.origFs;
      handles = null;
    }
  });

  test("same seed → identical dostuff.db bytes", async () => {
    // Deterministic seed: fixed guids/timestamps, written with
    // preserveTimestamps so neither store stamps wall-clock values.
    const seed: Issue[] = [
      makeIssue({
        id: "DS-001",
        title: "alpha",
        tags: ["a", "b"],
        tasks: [{ id: "t1", text: "step", done: false, updatedAt: "2025-01-01T00:00:00.000Z" }],
      }),
      makeIssue({
        id: "DS-002",
        title: "beta",
        links: [{ targetId: "DS-001", kind: "relates-to" }],
        record: [{ at: "2025-01-02T00:00:00.000Z", author: "agent", text: "note" }],
      }),
    ];

    // Extension-hosted: IssueStore over the virtual vscode FS.
    const vfs = installVirtualFs();
    handles = vfs.handles;
    const ctxStub = {
      globalState: { get: () => [], update: async () => {}, keys: () => [] },
      extensionUri: vscode.Uri.file("/ext"),
    } as unknown as vscode.ExtensionContext;
    const hosted = new IssueStore(ctxStub, { wasmBinary: WASM_BINARY });
    await hosted.init();
    for (const i of seed) await hosted.upsert(i, { preserveTimestamps: true });
    hosted.dispose();
    const hostedBytes = vfs.files.get("/ws/.vscode/dostuff/dostuff.db");
    expect(hostedBytes).toBeDefined();

    // Bare core on node:fs.
    const dir = tempDir();
    const core = makeCoreStore(dir);
    await core.init();
    for (const i of seed) await core.upsert(i, { preserveTimestamps: true });
    core.dispose();
    const coreBytes = fs.readFileSync(path.join(dir, "dostuff.db"));

    expect(Buffer.from(hostedBytes!).equals(coreBytes)).toBe(true);
  });
});
