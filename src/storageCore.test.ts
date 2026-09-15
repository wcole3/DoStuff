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
    await a.close();

    expect(fs.existsSync(path.join(dir, "dostuff.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);

    const b = makeCoreStore(dir);
    await b.init();
    const loaded = b.get("DS-001");
    expect(loaded?.title).toBe("core ticket");
    expect(loaded?.tags).toEqual(["x"]);
    await b.close();
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
    await store.close();
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
    await store.close();
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
    await store.close();

    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe("title B");
    await reader.close();
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
    await store.close();

    // All N mutations landed synchronously in the DB before any export
    // snapshot, so the queue needs at most: the running export + one queued
    // follow-up per completed run. A burst must not produce N exports.
    expect(counters.renames - renamesAfterInit).toBeLessThanOrEqual(3);

    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe(`v${N}`);
    await reader.close();
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
    await hosted.close();
    const hostedBytes = vfs.files.get("/ws/.vscode/dostuff/dostuff.db");
    expect(hostedBytes).toBeDefined();

    // Bare core on node:fs.
    const dir = tempDir();
    const core = makeCoreStore(dir);
    await core.init();
    for (const i of seed) await core.upsert(i, { preserveTimestamps: true });
    await core.close();
    const coreBytes = fs.readFileSync(path.join(dir, "dostuff.db"));

    expect(Buffer.from(hostedBytes!).equals(coreBytes)).toBe(true);
  });
});

describe("list() memo and delta change events", () => {
  test("list() keeps createdAt-desc order (unparsable dates last, ties stable) and stays fresh per call", async () => {
    const dir = tempDir();
    const store = makeCoreStore(dir);
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.upsert(makeIssue({ id: "DS-002", createdAt: "not a date" }));
    await store.upsert(makeIssue({ id: "DS-003", createdAt: "2026-03-01T00:00:00.000Z" }));
    await store.upsert(makeIssue({ id: "DS-004", createdAt: "2026-03-01T00:00:00.000Z" }));
    const a = store.list();
    const b = store.list();
    expect(a).not.toBe(b); // callers may hold the array across awaits
    expect(a.map((i) => i.id).slice(0, 2).sort()).toEqual(["DS-003", "DS-004"]);
    expect(a.map((i) => i.id)[2]).toBe("DS-001");
    expect(a.map((i) => i.id)[3]).toBe("DS-002");
    // In-place mutation must invalidate the memo.
    await store.upsert({ ...store.get("DS-001")!, createdAt: "2026-04-01T00:00:00.000Z" });
    expect(store.list()[0]!.id).toBe("DS-001");
    await store.remove("DS-001");
    expect(store.list().map((i) => i.id)).not.toContain("DS-001");
    await store.close();
  });

  test("list() is cheap to call repeatedly on a large board (memoized sort)", async () => {
    const dir = tempDir();
    const store = makeCoreStore(dir);
    await store.init();
    for (let n = 1; n <= 1000; n++) {
      await store.upsert(makeIssue({ id: `DS-${String(n).padStart(4, "0")}` }), { preserveTimestamps: true });
    }
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) store.list();
    // Pre-memo: 2000 × (copy + sort with two Date allocations per compare) ≈ seconds.
    expect(performance.now() - t0).toBeLessThan(150);
    await store.close();
  });

  test("onChange carries what changed: upsert / remove (with link scrub) / applySync / replaceAll", async () => {
    const dir = tempDir();
    const store = makeCoreStore(dir);
    await store.init();
    const events: Array<{ upserted: string[]; removed: string[]; reset: boolean; size: number }> = [];
    const sub = store.onChange((c) =>
      events.push({ upserted: c.upserted.map((i) => i.id), removed: c.removed, reset: c.reset, size: c.issues.length }),
    );

    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.upsert(makeIssue({ id: "DS-002", links: [{ targetId: "DS-001", kind: "relates-to" }] }));
    expect(events.at(-2)).toEqual({ upserted: ["DS-001"], removed: [], reset: false, size: 1 });
    expect(events.at(-1)).toEqual({ upserted: ["DS-002"], removed: [], reset: false, size: 2 });

    await store.remove("DS-001");
    // DS-002 lost its inbound link → it changed too.
    expect(events.at(-1)).toEqual({ upserted: ["DS-002"], removed: ["DS-001"], reset: false, size: 1 });
    expect(store.get("DS-002")!.links).toEqual([]);

    await store.applySync({
      upserts: [makeIssue({ id: "DS-003" })],
      removals: ["DS-002"],
      tombstoned: [],
    });
    expect(events.at(-1)).toEqual({ upserted: ["DS-003"], removed: ["DS-002"], reset: false, size: 1 });

    await store.replaceAll([makeIssue({ id: "DS-010" })]);
    expect(events.at(-1)).toMatchObject({ reset: true, size: 1 });

    sub.dispose();
    await store.close();
  });
});

describe("write-behind persistence", () => {
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

  test("a burst of sequential upserts persists once, and close() flushes the last state", async () => {
    const dir = tempDir();
    const { fsImpl, counters } = delayedFs([0]);
    const store = makeCoreStore(dir, fsImpl);
    await store.init();
    const renamesAfterInit = counters.renames;
    const base = makeIssue({ id: "DS-001", title: "v0" });
    for (let i = 1; i <= 20; i++) await store.upsert({ ...base, title: `v${i}` });
    // Nothing has hit disk yet — each upsert returned after the in-memory commit.
    expect(counters.renames - renamesAfterInit).toBe(0);
    await store.close();
    expect(counters.renames - renamesAfterInit).toBe(1);
    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe("v20");
    await reader.close();
  });

  test("flush() with nothing pending is a no-op; the timer persists on its own", async () => {
    const dir = tempDir();
    const { fsImpl, counters } = delayedFs([0]);
    const store = new IssueStoreCore({
      storageDir: () => dir,
      wasmBinary: async () => WASM_BINARY,
      fs: fsImpl,
      persistDelayMs: 20,
    });
    await store.init();
    const after = counters.renames;
    await store.flush();
    expect(counters.renames).toBe(after);
    await store.upsert(makeIssue({ id: "DS-001" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(counters.renames).toBe(after + 1);
    await store.flush();
    expect(counters.renames).toBe(after + 1);
    await store.close();
  });

  test("persistDelayMs: 0 keeps the old awaited semantics (dispose without flush is safe)", async () => {
    const dir = tempDir();
    const store = new IssueStoreCore({
      storageDir: () => dir,
      wasmBinary: async () => WASM_BINARY,
      persistDelayMs: 0,
    });
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", title: "immediate" }));
    await store.close();
    const reader = makeCoreStore(dir);
    await reader.init();
    expect(reader.get("DS-001")?.title).toBe("immediate");
    await reader.close();
  });

  test("globalState (KV) fallback is write-behind too and flushes on close()", async () => {
    const writes: unknown[] = [];
    const store = new IssueStoreCore({
      storageDir: () => null,
      wasmBinary: async () => WASM_BINARY,
      kv: { get: () => undefined, update: async (v) => void writes.push(v) },
    });
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.upsert(makeIssue({ id: "DS-002" }));
    expect(writes).toHaveLength(0);
    await store.close();
    expect(writes).toHaveLength(1);
    expect((writes[0] as Issue[]).map((i) => i.id).sort()).toEqual(["DS-001", "DS-002"]);
  });
});
