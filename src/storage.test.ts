// Tests for `IssueStore` and the pure `normalize` helper.
//
// Strategy: by default the mock `vscode.workspace.workspaceFolders` is
// `undefined`, so the store falls back to `globalState`. That lets us exercise
// init/upsert/list/get/remove/replaceAll/onChange/reload without any SQLite or
// disk work. A small in-memory FS shim is installed (and restored per test)
// when we need to exercise the SQLite-backed branch — those tests pass the
// real `sql-wasm.wasm` bytes from node_modules into the store so it runs the
// actual SQL engine end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import initSqlJs from "sql.js";
import { GITIGNORE_CONTENT, IssueStore, normalize } from "./storage";
import { deriveGuid, TOMBSTONE_TTL_MS } from "./syncMerge";
import type { Issue, IssueType, Priority, Status } from "./types";
import { makeIssueFactory } from "./testSupport";

// Real sql.js WASM bytes for the SQLite-backed branch. Loaded once.
const WASM_BINARY = fs.readFileSync(
  path.join(import.meta.dir, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
);

// ----- Test helpers ----------------------------------------------------------

function makeMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : (defaultValue as T | undefined);
    },
    update(key: string, value: unknown): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return Array.from(map.keys());
    },
  } as unknown as vscode.Memento;
}

function makeContext(globalStateSeed: Record<string, unknown> = {}): vscode.ExtensionContext {
  const fakeUri = vscode.Uri.file("/tmp/dostuff-test");
  return {
    subscriptions: [],
    globalState: makeMemento(globalStateSeed),
    workspaceState: makeMemento(),
    extensionUri: fakeUri,
    globalStorageUri: fakeUri,
    extensionPath: "/tmp/dostuff-test",
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    asAbsolutePath: (p: string) => `/tmp/dostuff-test/${p}`,
  } as unknown as vscode.ExtensionContext;
}

function makeSqlStore(ctx: vscode.ExtensionContext): IssueStore {
  return new IssueStore(ctx, { wasmBinary: WASM_BINARY });
}

const makeIssue = makeIssueFactory();

beforeEach(() => {
  makeIssue.reset();
});

// ----- normalize -------------------------------------------------------------

describe("normalize", () => {
  test("fills defaults for missing number / record / statusHistory / tasks / resolvedAt", () => {
    const partial = {
      id: "DS-042",
      title: "legacy",
      type: "Bug",
      priority: "High",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      createdAt: "2025-01-01T00:00:00.000Z",
    } as unknown as Issue;

    const { issue, coerced } = normalize(partial);

    expect(coerced).toEqual([]);
    expect(issue.number).toBe(42);
    expect(issue.record).toEqual([]);
    expect(issue.statusHistory).toEqual([]);
    expect(issue.tasks).toEqual([]);
    expect(issue.tags).toEqual([]);
    expect(issue.resolvedAt).toBeNull();
    expect(issue.pendingClose).toBeNull();
  });

  test("defaults a missing pendingClose to null and coerces a malformed one to null", () => {
    const missing = {
      id: "DS-050",
      title: "legacy",
      type: "Bug",
      priority: "High",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      createdAt: "2025-01-01T00:00:00.000Z",
    } as unknown as Issue;
    expect(normalize(missing).issue.pendingClose).toBeNull();

    const malformed = {
      ...missing,
      pendingClose: { by: "user", at: "not-iso" },
    } as unknown as Issue;
    expect(normalize(malformed).issue.pendingClose).toBeNull();
  });

  test("tags are normalized: trimmed, deduplicated, non-string entries dropped", () => {
    const partial = {
      id: "DS-099",
      title: "tag-haver",
      type: "Bug",
      priority: "High",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      tags: ["  alpha ", "alpha", "Alpha", "beta", 42, "", "  "],
    } as unknown as Issue;
    const { issue } = normalize(partial);
    expect(issue.tags).toEqual(["alpha", "beta"]);
  });

  test("invalid status is coerced to 'Thinking' and logged in coerced[]", () => {
    const partial = {
      id: "DS-001",
      number: 1,
      title: "x",
      type: "Bug",
      priority: "High",
      status: "Done",
      description: "",
      verifyCriteria: "",
      tasks: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      resolvedAt: null,
      statusHistory: [],
      record: [],
    } as unknown as Issue;

    const { issue, coerced } = normalize(partial);
    expect(issue.status).toBe("Thinking");
    expect(coerced.some((s) => s.includes("Done") && s.includes("Thinking"))).toBe(true);
  });

  test("invalid priority is coerced to 'Regular'", () => {
    const partial = {
      id: "DS-001",
      number: 1,
      title: "x",
      type: "Bug",
      priority: "Urgent",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      tasks: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      resolvedAt: null,
      statusHistory: [],
      record: [],
    } as unknown as Issue;

    const { issue, coerced } = normalize(partial);
    expect(issue.priority).toBe("Regular");
    expect(coerced.some((s) => s.includes("Urgent") && s.includes("Regular"))).toBe(true);
  });

  test("invalid type is coerced to 'Chore'", () => {
    const partial = {
      id: "DS-001",
      number: 1,
      title: "x",
      type: "Epic",
      priority: "Regular",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      tasks: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      resolvedAt: null,
      statusHistory: [],
      record: [],
    } as unknown as Issue;

    const { issue, coerced } = normalize(partial);
    expect(issue.type).toBe("Chore");
    expect(coerced.some((s) => s.includes("Epic") && s.includes("Chore"))).toBe(true);
  });
});

// ----- nextNumber atomicity --------------------------------------------------

describe("nextNumber", () => {
  test("two consecutive calls without upsert return distinct increasing numbers", async () => {
    const store = new IssueStore(makeContext());
    await store.init();

    const a = store.nextNumber();
    const b = store.nextNumber();
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBe(1);
  });

  test("after init reflects the max persisted number", async () => {
    // Seed globalState directly with a single issue at number 7.
    const seeded = makeIssue({ number: 7, id: "DS-007" });
    const ctx = makeContext({ "dostuff.issues.v1": [seeded] });
    const store = new IssueStore(ctx);
    await store.init();

    expect(store.nextNumber()).toBe(8);
  });
});

// ----- list / get / upsert / remove (globalState fallback) -------------------

describe("IssueStore CRUD (globalState backed)", () => {
  test("upsert then list — sorted by createdAt desc", async () => {
    const store = new IssueStore(makeContext());
    await store.init();

    const oldIssue = makeIssue({
      id: "DS-001",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const newIssue = makeIssue({
      id: "DS-002",
      createdAt: "2025-03-01T00:00:00.000Z",
    });
    await store.upsert(oldIssue);
    await store.upsert(newIssue);

    const list = store.list();
    expect(list.map((i) => i.id)).toEqual(["DS-002", "DS-001"]);
  });

  test("get(id) returns issue after upsert; get('missing') is undefined", async () => {
    const store = new IssueStore(makeContext());
    await store.init();
    const i = makeIssue({ id: "DS-010" });
    await store.upsert(i);

    expect(store.get("DS-010")?.id).toBe("DS-010");
    expect(store.get("DS-999")).toBeUndefined();
  });

  test("remove(id) drops the issue from list and get", async () => {
    const store = new IssueStore(makeContext());
    await store.init();
    const i = makeIssue({ id: "DS-005" });
    await store.upsert(i);
    expect(store.get("DS-005")).toBeDefined();

    await store.remove("DS-005");
    expect(store.get("DS-005")).toBeUndefined();
    expect(store.list().some((x) => x.id === "DS-005")).toBe(false);
  });

  test("globalState fallback round-trip — upsert, then re-init from same context preserves data", async () => {
    const ctx = makeContext();
    const a = new IssueStore(ctx);
    await a.init();
    const issue = makeIssue({ id: "DS-077", number: 77, title: "persist me" });
    await a.upsert(issue);

    // Spin up a brand-new store against the same context (same globalState
    // memento). Init should rehydrate the previously-upserted issue.
    const b = new IssueStore(ctx);
    await b.init();
    expect(b.get("DS-077")?.title).toBe("persist me");
    expect(b.list()).toHaveLength(1);
  });

  test("replaceAll([]) clears the store and fires onChange", async () => {
    const store = new IssueStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.upsert(makeIssue({ id: "DS-002" }));
    expect(store.list()).toHaveLength(2);

    let fired = false;
    let lastPayload: Issue[] | null = null;
    const sub = store.onChange((issues) => {
      fired = true;
      lastPayload = issues;
    });

    await store.replaceAll([]);
    sub.dispose();

    expect(store.list()).toEqual([]);
    expect(fired).toBe(true);
    expect(lastPayload as Issue[] | null).toEqual([]);
  });

  test("onChange fires on upsert and remove", async () => {
    const store = new IssueStore(makeContext());
    await store.init();
    const events: number[] = [];
    const sub = store.onChange((issues) => events.push(issues.length));

    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.upsert(makeIssue({ id: "DS-002" }));
    await store.remove("DS-001");

    sub.dispose();
    expect(events).toEqual([1, 2, 1]);
  });
});

// ----- SQLite-backed branch coverage -----------------------------------------
//
// To exercise the SQLite-backed code paths we install a tiny in-memory FS over
// `vscode.workspace.fs` and pretend there's a workspace folder. The store gets
// the real sql.js WASM bytes so it runs the actual SQL engine end-to-end
// against the virtual FS. Restored after each test.

interface FsEntry { content: Uint8Array }
type VirtualFs = Map<string, FsEntry>;

interface FsHandles {
  origFolders: typeof vscode.workspace.workspaceFolders;
  origFs: typeof vscode.workspace.fs;
}

function installVirtualFs(seed: Record<string, string | Uint8Array> = {}): { fs: VirtualFs; handles: FsHandles } {
  const virtualFs: VirtualFs = new Map();
  for (const [p, body] of Object.entries(seed)) {
    const content = typeof body === "string" ? new TextEncoder().encode(body) : body;
    virtualFs.set(p, { content });
  }

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
      const entry = virtualFs.get(uri.path);
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      return entry.content;
    },
    writeFile: async (uri: { path: string }, content: Uint8Array) => {
      virtualFs.set(uri.path, { content });
    },
    createDirectory: async () => {},
    delete: async (uri: { path: string }, options?: { recursive?: boolean }) => {
      if (options?.recursive) {
        const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
        for (const key of Array.from(virtualFs.keys())) {
          if (key === uri.path || key.startsWith(prefix)) virtualFs.delete(key);
        }
      } else {
        virtualFs.delete(uri.path);
      }
    },
    stat: async (uri: { path: string }) => {
      if (virtualFs.has(uri.path)) {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
      }
      const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
      for (const key of virtualFs.keys()) {
        if (key.startsWith(prefix)) {
          return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }
      }
      throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
    },
    readDirectory: async (uri: { path: string }) => {
      const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
      const seen = new Map<string, number>();
      for (const key of virtualFs.keys()) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length);
        const slash = tail.indexOf("/");
        if (slash < 0) {
          seen.set(tail, vscode.FileType.File);
        } else {
          const segment = tail.slice(0, slash);
          if (!seen.has(segment)) seen.set(segment, vscode.FileType.Directory);
        }
      }
      return Array.from(seen.entries());
    },
    rename: async (
      source: { path: string },
      target: { path: string },
      _options?: { overwrite?: boolean },
    ) => {
      const entry = virtualFs.get(source.path);
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      virtualFs.set(target.path, entry);
      virtualFs.delete(source.path);
    },
  };

  return { fs: virtualFs, handles };
}

function restoreFs(handles: FsHandles) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).workspaceFolders = handles.origFolders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).fs = handles.origFs;
}

describe("IssueStore (SQLite-backed branch)", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      restoreFs(handles);
      handles = null;
    }
  });

  test("first init creates dostuff.db; round-trips upsert across store instances", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    const issue = makeIssue({
      id: "DS-077",
      number: 77,
      title: "persist me",
      tags: ["alpha", "beta"],
      tasks: [{ id: "t1", text: "first", done: false }],
    });
    await a.upsert(issue);
    a.dispose();

    expect(vfs.get("/ws/.vscode/dostuff/dostuff.db")).toBeDefined();

    const b = makeSqlStore(ctx);
    await b.init();
    const loaded = b.get("DS-077");
    expect(loaded?.title).toBe("persist me");
    expect(loaded?.tags).toEqual(["alpha", "beta"]);
    // upsert diff-stamps the (new) task, and the stamp round-trips.
    expect(loaded?.tasks).toEqual([
      { id: "t1", text: "first", done: false, updatedAt: expect.any(String) },
    ]);
    b.dispose();
  });

  test("pendingClose round-trips across store instances and clears on delete-then-insert", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(
      makeIssue({
        id: "DS-088",
        number: 88,
        status: "Working",
        pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", note: "wrap up" },
      }),
    );
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-088")?.pendingClose).toEqual({
      by: "agent",
      at: "2026-05-18T00:00:00.000Z",
      note: "wrap up",
    });
    // Clear it — the child row should be deleted (delete-then-insert), not orphaned.
    await b.upsert({ ...b.get("DS-088")!, pendingClose: null });
    b.dispose();

    const c = makeSqlStore(ctx);
    await c.init();
    expect(c.get("DS-088")?.pendingClose).toBeNull();
    c.dispose();
  });

  test("pendingClose.target round-trips; a pre-target row loads with target absent (Closed meaning)", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(
      makeIssue({
        id: "DS-090",
        number: 90,
        status: "Verification",
        pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
      }),
    );
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-090")?.pendingClose).toEqual({
      by: "agent",
      at: "2026-05-18T00:00:00.000Z",
      target: "Complete",
    });
    // Simulate a pre-target build's row: NULL the column directly, re-open.
    // Loader must degrade to the legacy meaning — target absent, not lost row.
    // (Direct SQL through a fresh store's db is not exposed; emulate by
    // writing a target-less pendingClose, which persists NULL.)
    await b.upsert({
      ...b.get("DS-090")!,
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z" },
    });
    b.dispose();

    const c = makeSqlStore(ctx);
    await c.init();
    const pc = c.get("DS-090")?.pendingClose;
    expect(pc).toEqual({ by: "agent", at: "2026-05-18T00:00:00.000Z" });
    expect(pc && "target" in pc).toBe(false);
    c.dispose();
  });

  test("migrates pre-existing JSON tickets into the DB and moves them to legacy-json-backup/", async () => {
    const goodIssue = makeIssue({
      id: "DS-001",
      number: 1,
      title: "good",
      status: "Planned",
    });
    const legacyIssue = makeIssue({
      id: "DS-002",
      number: 2,
      title: "legacy",
      status: "Planned",
    });
    const { fs: vfs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(goodIssue),
      "/ws/.vscode/dostuff/DS-002.json": JSON.stringify(legacyIssue),
    });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();

    expect(store.list().map((i) => i.id).sort()).toEqual(["DS-001", "DS-002"]);
    expect(vfs.get("/ws/.vscode/dostuff/dostuff.db")).toBeDefined();
    expect(vfs.get("/ws/.vscode/dostuff/legacy-json-backup/DS-001.json")).toBeDefined();
    expect(vfs.get("/ws/.vscode/dostuff/legacy-json-backup/DS-002.json")).toBeDefined();
    expect(vfs.get("/ws/.vscode/dostuff/DS-001.json")).toBeUndefined();
    expect(vfs.get("/ws/.vscode/dostuff/DS-002.json")).toBeUndefined();
    store.dispose();
  });

  test("corrupt JSON file is logged and skipped during migration; valid files still imported", async () => {
    const goodIssue = makeIssue({
      id: "DS-001",
      number: 1,
      title: "good",
      status: "Planned",
    });
    const { handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(goodIssue),
      "/ws/.vscode/dostuff/DS-002.json": "{not json,,,,",
    });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();

    expect(store.list().map((i) => i.id)).toEqual(["DS-001"]);
    store.dispose();
  });

  test("idempotent: second init against an existing dostuff.db doesn't re-migrate", async () => {
    const goodIssue = makeIssue({ id: "DS-001", number: 1, title: "first" });
    const { fs: vfs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(goodIssue),
    });
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    a.dispose();

    // After first init: db exists, json file moved to backup.
    expect(vfs.get("/ws/.vscode/dostuff/legacy-json-backup/DS-001.json")).toBeDefined();
    expect(vfs.get("/ws/.vscode/dostuff/DS-001.json")).toBeUndefined();

    // Plant a sentinel into the backup folder — if migration ran a second time
    // it would overwrite the json on disk (or fail to find it). Track count.
    const backupBefore = Array.from(vfs.keys()).filter((k) =>
      k.startsWith("/ws/.vscode/dostuff/legacy-json-backup/")
    ).length;

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.list().map((i) => i.id)).toEqual(["DS-001"]);
    b.dispose();

    const backupAfter = Array.from(vfs.keys()).filter((k) =>
      k.startsWith("/ws/.vscode/dostuff/legacy-json-backup/")
    ).length;
    expect(backupAfter).toBe(backupBefore);
  });

  test("remove(id) cascades and clears all child rows for that issue", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();

    const richIssue = makeIssue({
      id: "DS-001",
      number: 1,
      title: "rich",
      tasks: [
        { id: "t1", text: "first", done: false },
        { id: "t2", text: "second", done: true },
      ],
      tags: ["alpha", "beta"],
      statusHistory: [
        { status: "Thinking", at: "2025-01-01T00:00:00.000Z", by: "user" },
        { status: "Planned", at: "2025-01-02T00:00:00.000Z", by: "user" },
      ],
      record: [{ at: "2025-01-01T00:00:00.000Z", author: "user", text: "first note" }],
    });
    await a.upsert(richIssue);

    const other = makeIssue({ id: "DS-002", number: 2, title: "other", tags: ["alpha"] });
    await a.upsert(other);

    await a.remove("DS-001");
    a.dispose();

    // Re-open and confirm DS-001 is fully gone but DS-002's "alpha" tag survives.
    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-001")).toBeUndefined();
    expect(b.get("DS-002")?.tags).toEqual(["alpha"]);
    b.dispose();
  });

  test("writes .gitignore on init when none present", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));

    const entry = vfs.get("/ws/.vscode/dostuff/.gitignore");
    expect(entry).toBeDefined();
    expect(new TextDecoder().decode(entry!.content)).toBe(GITIGNORE_CONTENT);
    store.dispose();
  });

  test("does not overwrite a user-edited .gitignore", async () => {
    const customBody = "# my custom rules\n!keep-me.json\n";
    const { fs: vfs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/.gitignore": customBody,
    });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));

    const entry = vfs.get("/ws/.vscode/dostuff/.gitignore");
    expect(new TextDecoder().decode(entry!.content)).toBe(customBody);
    store.dispose();
  });

  test("respects dostuff.writeStorageGitignore=false (no .gitignore written)", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;

    const origGetConfig = vscode.workspace.getConfiguration;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.workspace as any).getConfiguration = (_section?: string) => ({
      get: <T>(key: string, defaultValue?: T) =>
        key === "writeStorageGitignore" ? (false as unknown as T) : (defaultValue as T),
      update: () => Promise.resolve(),
      inspect: () => undefined,
      has: () => false,
    });
    try {
      const store = makeSqlStore(makeContext());
      await store.init();
      await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));
      expect(vfs.has("/ws/.vscode/dostuff/.gitignore")).toBe(false);
      store.dispose();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.workspace as any).getConfiguration = origGetConfig;
    }
  });

  test("tag insertion order is preserved across DB round-trip", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    // Tag values chosen so PK ordering (lexical) would re-sort them: zebra, alpha, mango.
    const issue = makeIssue({
      id: "DS-300",
      tags: ["zebra", "alpha", "mango"],
    });
    await a.upsert(issue);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-300")?.tags).toEqual(["zebra", "alpha", "mango"]);
    b.dispose();
  });

  test("statusHistory and record entries are returned in insertion order", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    const issue = makeIssue({
      id: "DS-400",
      statusHistory: [
        { status: "Thinking", at: "2025-01-01T00:00:00.000Z", by: "user" },
        { status: "Planned", at: "2025-01-02T00:00:00.000Z", by: "user" },
        { status: "Working", at: "2025-01-03T00:00:00.000Z", by: "agent" },
      ],
      record: [
        { at: "2025-01-01T00:00:00.000Z", author: "user", text: "first" },
        { at: "2025-01-02T00:00:00.000Z", author: "agent", source: "mcp", text: "second" },
        { at: "2025-01-03T00:00:00.000Z", author: "user", text: "third" },
      ],
    });
    await a.upsert(issue);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    const loaded = b.get("DS-400");
    expect(loaded?.statusHistory.map((h) => h.status)).toEqual(["Thinking", "Planned", "Working"]);
    expect(loaded?.statusHistory[2]?.by).toBe("agent");
    expect(loaded?.record.map((r) => r.text)).toEqual(["first", "second", "third"]);
    expect(loaded?.record[1]?.source).toBe("mcp");
    expect(loaded?.record[0]?.source).toBeUndefined();
    b.dispose();
  });

  test("migration normalises legacy JSON missing optional fields", async () => {
    const legacy = {
      id: "DS-001",
      title: "legacy",
      type: "Bug",
      priority: "High",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      // missing: number, tasks, tags, attachments, statusHistory, record, resolvedAt
    };
    const { handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(legacy),
    });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();
    const loaded = store.get("DS-001");
    expect(loaded).toBeDefined();
    expect(loaded?.number).toBe(1); // derived from "DS-001"
    expect(loaded?.tasks).toEqual([]);
    expect(loaded?.tags).toEqual([]);
    expect(loaded?.attachments).toEqual([]);
    expect(loaded?.statusHistory).toEqual([]);
    expect(loaded?.record).toEqual([]);
    expect(loaded?.resolvedAt).toBeNull();
    store.dispose();
  });

  test("init on an empty storage folder creates the DB and yields empty list", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();
    expect(store.list()).toEqual([]);
    expect(vfs.get("/ws/.vscode/dostuff/dostuff.db")).toBeDefined();
    // No legacy-json-backup created when there are no .json files to move.
    const hasBackup = Array.from(vfs.keys()).some((k) =>
      k.startsWith("/ws/.vscode/dostuff/legacy-json-backup/"),
    );
    expect(hasBackup).toBe(false);
    store.dispose();
  });

  test("replaceAll wipes prior issues and persists the new set", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(makeIssue({ id: "DS-001", number: 1 }));
    await a.upsert(makeIssue({ id: "DS-002", number: 2 }));
    await a.replaceAll([makeIssue({ id: "DS-099", number: 99, title: "fresh" })]);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.list().map((i) => i.id)).toEqual(["DS-099"]);
    expect(b.get("DS-099")?.title).toBe("fresh");
    b.dispose();
  });

  test("mergeAll combines prior + incoming and persists both", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(makeIssue({ id: "DS-001", number: 1, title: "original" }));
    await a.mergeAll([
      makeIssue({ id: "DS-001", number: 1, title: "overwritten" }),
      makeIssue({ id: "DS-002", number: 2, title: "added" }),
    ]);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-001")?.title).toBe("overwritten");
    expect(b.get("DS-002")?.title).toBe("added");
    expect(b.list()).toHaveLength(2);
    b.dispose();
  });

  test("forward-compat: a DB with schema_meta.version newer than this build is not stamped down", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;

    // First init creates v1 DB.
    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(makeIssue({ id: "DS-001", number: 1 }));
    a.dispose();

    // Tamper with the on-disk DB: bump schema_meta.version to "999".
    const dbBytes = vfs.get("/ws/.vscode/dostuff/dostuff.db")?.content;
    expect(dbBytes).toBeDefined();
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs({ wasmBinary: WASM_BINARY.buffer.slice(0) });
    const tampered = new SQL.Database(dbBytes!);
    tampered.run("UPDATE schema_meta SET value = '999' WHERE key = 'version'");
    const tamperedBytes = tampered.export();
    tampered.close();
    vfs.set("/ws/.vscode/dostuff/dostuff.db", { content: tamperedBytes });

    // Reopen — should NOT downgrade.
    const b = makeSqlStore(ctx);
    await b.init();
    b.dispose();

    const post = vfs.get("/ws/.vscode/dostuff/dostuff.db")?.content;
    const SQL2 = await initSqlJs({ wasmBinary: WASM_BINARY.buffer.slice(0) });
    const check = new SQL2.Database(post!);
    const res = check.exec("SELECT value FROM schema_meta WHERE key = 'version'");
    check.close();
    expect(res[0]?.values[0]?.[0]).toBe("999");
  });

  test("data-loss-safe migration: rename phase failure leaves DB intact AND legacy files in place", async () => {
    const goodIssue = makeIssue({
      id: "DS-001",
      number: 1,
      title: "good",
      status: "Planned",
    });
    const { fs: vfs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(goodIssue),
    });
    handles = h;

    // Wrap rename to throw exactly for the migration's move-to-backup phase.
    const origRename = (vscode.workspace.fs as any).rename;
    (vscode.workspace.fs as any).rename = async (
      source: { path: string },
      target: { path: string },
      opts?: { overwrite?: boolean },
    ) => {
      if (target.path.includes("/legacy-json-backup/")) {
        throw new Error("simulated rename failure");
      }
      return origRename(source, target, opts);
    };

    try {
      const store = makeSqlStore(makeContext());
      await store.init();
      // Despite the rename failure, the DB must contain the migrated issue and
      // the original .json file must still be on disk (so a future activation
      // could retry migration if dostuff.db were lost). exportDb ran BEFORE
      // rename, so dostuff.db is on disk too.
      expect(store.get("DS-001")?.title).toBe("good");
      expect(vfs.get("/ws/.vscode/dostuff/dostuff.db")).toBeDefined();
      expect(vfs.get("/ws/.vscode/dostuff/DS-001.json")).toBeDefined();
      expect(vfs.get("/ws/.vscode/dostuff/legacy-json-backup/DS-001.json")).toBeUndefined();
      store.dispose();
    } finally {
      (vscode.workspace.fs as any).rename = origRename;
    }
  });

  test("reload() re-hydrates from disk (covers external writes via a second store)", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const writer = makeSqlStore(ctx);
    await writer.init();
    await writer.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));

    // A second store opens the same workspace, writes another issue, and
    // exports — simulating an external editor writing to dostuff.db.
    const sideWriter = makeSqlStore(ctx);
    await sideWriter.init();
    await sideWriter.upsert(makeIssue({ id: "DS-002", number: 2, title: "second" }));
    sideWriter.dispose();

    await writer.reload();
    expect(writer.list().map((i) => i.id).sort()).toEqual(["DS-001", "DS-002"]);
    writer.dispose();
  });
});

// ----- attachments ----------------------------------------------------------

describe("IssueStore attachments", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      restoreFs(handles);
      handles = null;
    }
  });

  test("writeAttachment puts bytes at <storagePath>/attachments/<issueId>/<attId><ext>", async () => {
    const { fs: vfs, handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const written = await store.writeAttachment("DS-001", "abc", ".png", bytes);
    expect(written).toBe(true);
    const entry = vfs.get("/ws/.vscode/dostuff/attachments/DS-001/abc.png");
    expect(entry).toBeDefined();
    expect(Array.from(entry!.content)).toEqual([1, 2, 3, 4]);
    store.dispose();
  });

  test("readAttachment round-trips the bytes", async () => {
    const { handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    const bytes = new Uint8Array([9, 8, 7]);
    await store.writeAttachment("DS-002", "att2", ".pdf", bytes);
    const out = await store.readAttachment("DS-002", "att2");
    expect(Array.from(out)).toEqual([9, 8, 7]);
    store.dispose();
  });

  test("readAttachment on a missing file rejects", async () => {
    const { handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    await expect(store.readAttachment("DS-001", "missing")).rejects.toThrow();
    store.dispose();
  });

  test("remove(id) prunes the per-issue attachment folder", async () => {
    const { fs: vfs, handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.writeAttachment("DS-001", "att1", ".png", new Uint8Array([1]));
    await store.writeAttachment("DS-001", "att2", ".pdf", new Uint8Array([2]));
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/att1.png")).toBeDefined();

    await store.remove("DS-001");

    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/att1.png")).toBeUndefined();
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/att2.pdf")).toBeUndefined();
    store.dispose();
  });

  test("path traversal ids are refused by every attachment helper (logged no-op)", async () => {
    const { fs: vfs, handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    await store.writeAttachment("DS-001", "legit", ".png", new Uint8Array([1]));
    const sizeBefore = vfs.size;

    // write: hostile issue id, attachment id, and extension each refuse.
    expect(await store.writeAttachment("../../escape", "a", ".png", new Uint8Array([9]))).toBe(false);
    expect(await store.writeAttachment("DS-001", "../up", ".png", new Uint8Array([9]))).toBe(false);
    expect(await store.writeAttachment("DS-001", "a", "/../evil", new Uint8Array([9]))).toBe(false);
    expect(vfs.size).toBe(sizeBefore); // nothing new anywhere in the FS

    // lookup/read: hostile ids resolve to null / missing rather than probing.
    expect(await store.findAttachmentUri("..", "legit")).toBeNull();
    expect(await store.findAttachmentUri("DS-001", "../legit")).toBeNull();
    await expect(store.readAttachment("../..", "x")).rejects.toThrow();

    // delete: hostile ids are no-ops; the legit file survives untouched.
    await store.deleteAttachmentFile("..", "legit");
    await store.remove("../../etc"); // routes into deleteIssueAttachments
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/legit.png")).toBeDefined();
    store.dispose();
  });

  test("deleteAttachmentFile removes a single file without touching siblings", async () => {
    const { fs: vfs, handles: h } = installVirtualFs();
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    await store.writeAttachment("DS-001", "keep", ".png", new Uint8Array([1]));
    await store.writeAttachment("DS-001", "drop", ".pdf", new Uint8Array([2]));
    await store.deleteAttachmentFile("DS-001", "drop");
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/keep.png")).toBeDefined();
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/drop.pdf")).toBeUndefined();
    store.dispose();
  });

  test("normalize() on a legacy issue without `attachments` returns []", () => {
    // Cast through unknown to drop the field from the literal.
    const legacy = makeIssue({ id: "DS-001" }) as unknown as Record<string, unknown>;
    delete legacy.attachments;
    const { issue } = normalize(legacy as unknown as Issue);
    expect(issue.attachments).toEqual([]);
  });

  test("normalize() on an issue whose attachments reference missing files still loads", () => {
    const stale = makeIssue({
      id: "DS-001",
      attachments: [
        {
          id: "gone",
          name: "ghost.png",
          mimeType: "image/png",
          sizeBytes: 42,
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    const { issue } = normalize(stale);
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0]!.id).toBe("gone");
  });

  test("attachment insertion order is preserved across DB round-trip", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    // IDs chosen so PK ordering (lexical) would re-sort them: z, a, m.
    const issue = makeIssue({
      id: "DS-200",
      attachments: [
        { id: "z1", name: "z.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2026-05-18T00:00:00.000Z" },
        { id: "a1", name: "a.png", mimeType: "image/png", sizeBytes: 2, addedAt: "2026-05-18T00:00:01.000Z" },
        { id: "m1", name: "m.png", mimeType: "image/png", sizeBytes: 3, addedAt: "2026-05-18T00:00:02.000Z" },
      ],
    });
    await a.upsert(issue);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-200")?.attachments.map((x) => x.id)).toEqual(["z1", "a1", "m1"]);
    b.dispose();
  });

  test("attachment metadata round-trips through the DB", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;

    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    const issue = makeIssue({
      id: "DS-100",
      number: 100,
      attachments: [
        {
          id: "att1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          addedAt: "2026-05-18T12:00:00.000Z",
        },
      ],
    });
    await a.upsert(issue);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    expect(b.get("DS-100")?.attachments).toEqual(issue.attachments);
    b.dispose();
  });
});

describe("IssueStore links (SQLite-backed)", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      restoreFs(handles);
      handles = null;
    }
  });

  test("round-trips a ticket with multiple links across kinds", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const ctx = makeContext();
    const a = makeSqlStore(ctx);
    await a.init();
    await a.upsert(makeIssue({ id: "DS-001", title: "parent" }));
    await a.upsert(makeIssue({ id: "DS-002", title: "child" }));
    await a.upsert(makeIssue({ id: "DS-003", title: "blocker" }));
    const source = makeIssue({
      id: "DS-004",
      title: "with links",
      links: [
        { targetId: "DS-001", kind: "child-of" },
        { targetId: "DS-002", kind: "relates-to" },
        { targetId: "DS-003", kind: "blocks" },
      ],
    });
    await a.upsert(source);
    a.dispose();

    const b = makeSqlStore(ctx);
    await b.init();
    const loaded = b.get("DS-004");
    expect(loaded?.links).toEqual(source.links);
    b.dispose();
  });

  test("deleting the source ticket cascades-removes its outbound link rows", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const ctx = makeContext();
    const store = makeSqlStore(ctx);
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.upsert(
      makeIssue({
        id: "DS-002",
        links: [{ targetId: "DS-001", kind: "blocks" }],
      }),
    );
    await store.remove("DS-002");
    // Verify by reopening: DS-001 still present, DS-002 gone, no dangling rows
    // (next upsert of DS-002 must not re-surface a phantom link).
    store.dispose();
    const reopened = makeSqlStore(ctx);
    await reopened.init();
    expect(reopened.get("DS-002")).toBeUndefined();
    // A fresh DS-002 with no links should be exactly that.
    await reopened.upsert(makeIssue({ id: "DS-002", links: [] }));
    expect(reopened.get("DS-002")?.links).toEqual([]);
    reopened.dispose();
  });

  test("deleting the TARGET ticket cascades-removes inbound link rows", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const ctx = makeContext();
    const store = makeSqlStore(ctx);
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", title: "target" }));
    await store.upsert(
      makeIssue({
        id: "DS-002",
        title: "source",
        links: [{ targetId: "DS-001", kind: "blocks" }],
      }),
    );

    await store.remove("DS-001");
    // DS-002 must no longer carry a link to the deleted DS-001.
    expect(store.get("DS-002")?.links).toEqual([]);

    // Confirmed across a reopen as well — exercises the hydrator path.
    store.dispose();
    const reopened = makeSqlStore(ctx);
    await reopened.init();
    expect(reopened.get("DS-002")?.links).toEqual([]);
    reopened.dispose();
  });

  test("legacy JSON without links field migrates to an empty array", async () => {
    const legacy = {
      id: "DS-001",
      number: 1,
      title: "old",
      type: "Feature",
      priority: "Regular",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      tasks: [],
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      resolvedAt: null,
      statusHistory: [{ status: "Planned", at: "2025-01-01T00:00:00.000Z", by: "user" }],
      record: [],
      attachments: [],
      // NO links field — simulating older tickets.
    };
    const { handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(legacy),
    });
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();
    expect(store.get("DS-001")?.links).toEqual([]);
    store.dispose();
  });
});

// ----- Sync schema groundwork (guid / updatedAt / sync_tombstones) -----------
//
// Tenet proofs for docs/plans/ticket-sync/01-schema-groundwork.md: legacy data
// written by any prior build must load with correct defaults, and the new
// stamping/tombstone behavior must be confined to the store chokepoint.

// The `issues`/`issue_tasks` DDL exactly as it stood before the sync columns
// (commit d0efe31) — used to fabricate a pre-sync dostuff.db on disk.
const PRE_SYNC_DDL = `
CREATE TABLE issues (
  id              TEXT PRIMARY KEY,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  verify_criteria TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL,
  priority        TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE TABLE issue_tasks (
  issue_id  TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  text      TEXT NOT NULL,
  done      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, task_id)
);
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

async function buildRawDb(build: (db: import("sql.js").Database) => void): Promise<Uint8Array> {
  const copy = new Uint8Array(WASM_BINARY.byteLength);
  copy.set(WASM_BINARY);
  const SQL = await initSqlJs({ wasmBinary: copy.buffer as ArrayBuffer });
  const db = new SQL.Database();
  build(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

describe("sync schema groundwork", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      restoreFs(handles);
      handles = null;
    }
  });

  test("normalize: legacy object without guid/updatedAt gets deterministic defaults", () => {
    const legacy = {
      id: "DS-009",
      number: 9,
      title: "old ticket",
      type: "Feature",
      priority: "Regular",
      status: "Planned",
      description: "",
      verifyCriteria: "",
      createdAt: "2025-03-01T00:00:00.000Z",
      resolvedAt: null,
      tasks: [{ id: "t1", text: "legacy task", done: false }],
      tags: [],
      attachments: [],
      links: [],
      statusHistory: [],
      record: [],
    } as unknown as Issue;

    const { issue } = normalize(legacy);
    expect(issue.guid).toBe(deriveGuid("DS-009", "2025-03-01T00:00:00.000Z"));
    expect(issue.updatedAt).toBe("2025-03-01T00:00:00.000Z");
    // Legacy task stays untouched — no eager stamp.
    expect(issue.tasks[0]).toEqual({ id: "t1", text: "legacy task", done: false });
  });

  test("normalize: garbage task updatedAt is stripped, valid one kept", () => {
    const input = makeIssue({
      tasks: [
        { id: "t1", text: "bad", done: false, updatedAt: "not-a-date" },
        { id: "t2", text: "good", done: false, updatedAt: "2025-05-01T00:00:00.000Z" },
      ],
    });
    const { issue } = normalize(input);
    expect(issue.tasks[0]).toEqual({ id: "t1", text: "bad", done: false });
    expect(issue.tasks[1]?.updatedAt).toBe("2025-05-01T00:00:00.000Z");
  });

  test("deriveGuid: stable and uuid-shaped", () => {
    const a = deriveGuid("DS-001", "2025-01-01T00:00:00.000Z");
    const b = deriveGuid("DS-001", "2025-01-01T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveGuid("DS-002", "2025-01-01T00:00:00.000Z")).not.toBe(a);
  });

  test("hydrates a pre-sync DDL DB: guarded ALTERs apply, defaults derive, zero loss", async () => {
    const bytes = await buildRawDb((db) => {
      db.run(PRE_SYNC_DDL);
      db.run(
        "INSERT INTO issues (id, number, title, type, priority, status, created_at, resolved_at) VALUES ('DS-001', 1, 'pre-sync', 'Bug', 'High', 'Working', '2025-02-01T00:00:00.000Z', NULL)",
      );
      db.run(
        "INSERT INTO issue_tasks (issue_id, task_id, position, text, done) VALUES ('DS-001', 't1', 0, 'old task', 1)",
      );
      // Pre-target shape of issue_pending_close (as it stood at d0efe31) —
      // the guarded ALTER must add `target` and the row must load with the
      // legacy Closed meaning.
      db.run(`CREATE TABLE issue_pending_close (
        issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
        by       TEXT NOT NULL,
        note     TEXT,
        at       TEXT NOT NULL
      )`);
      db.run(
        "INSERT INTO issue_pending_close (issue_id, by, note, at) VALUES ('DS-001', 'agent', NULL, '2025-02-02T00:00:00.000Z')",
      );
      db.run("INSERT INTO schema_meta (key, value) VALUES ('version', '1')");
    });
    const { handles: h } = installVirtualFs({ "/ws/.vscode/dostuff/dostuff.db": bytes });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();

    const loaded = store.get("DS-001");
    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe("pre-sync");
    expect(loaded?.guid).toBe(deriveGuid("DS-001", "2025-02-01T00:00:00.000Z"));
    expect(loaded?.updatedAt).toBe("2025-02-01T00:00:00.000Z");
    expect(loaded?.tasks).toEqual([{ id: "t1", text: "old task", done: true }]);
    // Pre-target pendingClose row: loads, target absent (= legacy Closed).
    expect(loaded?.pendingClose).toEqual({ by: "agent", at: "2025-02-02T00:00:00.000Z" });
    expect(loaded?.pendingClose && "target" in loaded.pendingClose).toBe(false);
    // sync_tombstones was created by SCHEMA_DDL — readable and empty.
    expect(store.getSyncTombstones()).toEqual({ tickets: [], elements: [] });
    store.dispose();
  });

  test("upsert stamps updatedAt, mints guid, and diff-stamps tasks", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();

    const before = Date.now();
    const issue = {
      ...makeIssue({
        id: "DS-001",
        number: 1,
        tasks: [{ id: "t1", text: "one", done: false }],
      }),
      guid: "",
      updatedAt: "1999-01-01T00:00:00.000Z",
    };
    await store.upsert(issue);
    const v1 = store.get("DS-001")!;
    expect(v1.guid).not.toBe("");
    expect(Date.parse(v1.updatedAt)).toBeGreaterThanOrEqual(before);
    const t1Stamp = v1.tasks[0]?.updatedAt;
    expect(t1Stamp).toBeDefined();

    // Round-trip the ticket unchanged (webview strips task stamps): the task
    // keeps its prior stamp, the ticket restamps, the guid is carried.
    await store.upsert({
      ...v1,
      tasks: v1.tasks.map(({ updatedAt: _s, ...rest }) => rest),
    });
    const v2 = store.get("DS-001")!;
    expect(v2.guid).toBe(v1.guid);
    expect(v2.tasks[0]?.updatedAt).toBe(t1Stamp!);

    // Toggling done restamps the task.
    await store.upsert({
      ...v2,
      tasks: [{ id: "t1", text: "one", done: true }],
    });
    const v3 = store.get("DS-001")!;
    expect(v3.tasks[0]?.updatedAt).not.toBe(t1Stamp);
    expect(Date.parse(v3.tasks[0]!.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(t1Stamp!));

    // Editing text restamps too; a smuggled incoming stamp is discarded.
    await store.upsert({
      ...v3,
      tasks: [{ id: "t1", text: "one edited", done: true, updatedAt: "1990-01-01T00:00:00.000Z" }],
    });
    const v4 = store.get("DS-001")!;
    expect(v4.tasks[0]?.updatedAt).not.toBe("1990-01-01T00:00:00.000Z");
    store.dispose();
  });

  test("upsert with preserveTimestamps writes exactly as given and records nothing", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();

    const remote = makeIssue({
      id: "DS-001",
      number: 1,
      guid: "remote-guid",
      updatedAt: "2025-06-01T12:00:00.000Z",
      tasks: [{ id: "t1", text: "remote task", done: false, updatedAt: "2025-06-01T11:00:00.000Z" }],
    });
    await store.upsert(remote, { preserveTimestamps: true });
    const loaded = store.get("DS-001")!;
    expect(loaded.guid).toBe("remote-guid");
    expect(loaded.updatedAt).toBe("2025-06-01T12:00:00.000Z");
    expect(loaded.tasks[0]?.updatedAt).toBe("2025-06-01T11:00:00.000Z");
    expect(store.getSyncTombstones()).toEqual({ tickets: [], elements: [] });
    store.dispose();
  });

  test("deletion witnesses: upsert task-drop, remove(), replaceAll([]) all record tombstones", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();

    const withTask = makeIssue({
      id: "DS-001",
      number: 1,
      tasks: [{ id: "t1", text: "doomed", done: false }],
      attachments: [
        { id: "att1", name: "a.png", mimeType: "image/png", sizeBytes: 10, addedAt: "2025-01-01T00:00:00.000Z" },
      ],
    });
    await store.upsert(withTask);
    const g1 = store.get("DS-001")!.guid;

    // Drop the task and the attachment in one edit → two element tombstones.
    await store.upsert({ ...store.get("DS-001")!, tasks: [], attachments: [] });
    let tombs = store.getSyncTombstones();
    expect(tombs.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticketGuid: g1, scope: "task", elementId: "t1" }),
        expect.objectContaining({ ticketGuid: g1, scope: "attachment", elementId: "att1" }),
      ]),
    );

    // remove() records a ticket tombstone carrying the DS id.
    const other = makeIssue({ id: "DS-002", number: 2 });
    await store.upsert(other);
    const g2 = store.get("DS-002")!.guid;
    await store.remove("DS-002");
    tombs = store.getSyncTombstones();
    expect(tombs.tickets).toEqual(
      expect.arrayContaining([expect.objectContaining({ guid: g2, lastId: "DS-002" })]),
    );

    // replaceAll([]) tombstones every remaining ticket.
    await store.replaceAll([]);
    tombs = store.getSyncTombstones();
    expect(tombs.tickets.map((t) => t.guid)).toEqual(expect.arrayContaining([g1, g2]));
    store.dispose();
  });

  test("replaceAll import keeps provided guids/timestamps, derives missing ones", async () => {
    const { handles: h } = installVirtualFs({});
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();

    const provided = makeIssue({
      id: "DS-001",
      number: 1,
      guid: "kept-guid",
      updatedAt: "2025-04-01T00:00:00.000Z",
    });
    const missing = {
      ...makeIssue({ id: "DS-002", number: 2, createdAt: "2025-03-15T00:00:00.000Z" }),
      guid: "",
      updatedAt: "",
    };
    await store.replaceAll([provided, missing]);
    expect(store.get("DS-001")?.guid).toBe("kept-guid");
    expect(store.get("DS-001")?.updatedAt).toBe("2025-04-01T00:00:00.000Z");
    expect(store.get("DS-002")?.guid).toBe(deriveGuid("DS-002", "2025-03-15T00:00:00.000Z"));
    expect(store.get("DS-002")?.updatedAt).toBe("2025-03-15T00:00:00.000Z");
    store.dispose();
  });

  test("applySync: targeted removals + link scrub + one onChange + no tombstones", async () => {
    const { fs: vfs, handles: h } = installVirtualFs({});
    handles = h;
    const store = makeSqlStore(makeContext());
    await store.init();

    await store.upsert(makeIssue({ id: "DS-001", number: 1 }));
    await store.upsert(makeIssue({ id: "DS-002", number: 2, links: [{ targetId: "DS-001", kind: "blocks" }] }));
    await store.upsert(makeIssue({ id: "DS-003", number: 3 }));
    // Attachment dirs on disk for both the tombstoned and surviving ticket.
    vfs.set("/ws/.vscode/dostuff/attachments/DS-001/att.png", { content: new Uint8Array([1]) } as never);
    vfs.set("/ws/.vscode/dostuff/attachments/DS-003/att.png", { content: new Uint8Array([2]) } as never);

    const events: number[] = [];
    const sub = store.onChange((issues) => events.push(issues.length));

    const merged = makeIssue({
      id: "DS-004",
      number: 4,
      guid: "remote-guid-4",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });
    await store.applySync({
      upserts: [merged],
      removals: ["DS-001", "DS-003"],
      tombstoned: ["DS-001"],
    });
    sub.dispose();

    expect(events).toEqual([2]); // exactly one fire, post-apply cache size (3 − 2 removals + 1 upsert)
    expect(store.get("DS-001")).toBeUndefined();
    expect(store.get("DS-003")).toBeUndefined();
    expect(store.get("DS-004")?.guid).toBe("remote-guid-4");
    expect(store.get("DS-004")?.updatedAt).toBe("2025-06-01T00:00:00.000Z"); // preserveTimestamps semantics
    expect(store.get("DS-002")?.links).toEqual([]); // scrubbed
    // Tombstoned dir deleted; renumber-style removal keeps its dir.
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-001/att.png")).toBeUndefined();
    expect(vfs.get("/ws/.vscode/dostuff/attachments/DS-003/att.png")).toBeDefined();
    // applySync never records witnesses.
    expect(store.getSyncTombstones().tickets).toEqual([]);
    store.dispose();
  });

  test("init() prunes tombstones older than the TTL", async () => {
    const ancient = new Date(Date.now() - TOMBSTONE_TTL_MS - 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const bytes = await buildRawDb((db) => {
      db.run(PRE_SYNC_DDL);
      db.run(`CREATE TABLE sync_tombstones (
        scope TEXT NOT NULL, ticket_guid TEXT NOT NULL, element_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL, last_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope, ticket_guid, element_id))`);
      db.run(
        "INSERT INTO sync_tombstones (scope, ticket_guid, element_id, deleted_at, last_id) VALUES ('ticket', 'old-guid', 'old-guid', ?, 'DS-001')",
        [ancient],
      );
      db.run(
        "INSERT INTO sync_tombstones (scope, ticket_guid, element_id, deleted_at, last_id) VALUES ('ticket', 'new-guid', 'new-guid', ?, 'DS-002')",
        [fresh],
      );
      db.run("INSERT INTO schema_meta (key, value) VALUES ('version', '1')");
    });
    const { handles: h } = installVirtualFs({ "/ws/.vscode/dostuff/dostuff.db": bytes });
    handles = h;

    const store = makeSqlStore(makeContext());
    await store.init();
    const tombs = store.getSyncTombstones();
    expect(tombs.tickets.map((t) => t.guid)).toEqual(["new-guid"]);
    store.dispose();
  });
});
