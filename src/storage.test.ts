// Tests for `IssueStore` and the pure `normalize` helper.
//
// Strategy: by default the mock `vscode.workspace.workspaceFolders` is
// `undefined`, so the store falls back to `globalState`. That lets us exercise
// init/upsert/list/get/remove/replaceAll/onChange/reload without touching disk.
// A small in-memory FS shim is installed (and restored per test) when we need
// to exercise the file-backed branch (corrupt JSON, reload-from-disk).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";
import { IssueStore, normalize } from "./storage";
import type { Issue, IssueType, Priority, Status } from "./types";

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

let issueCounter = 0;
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  issueCounter += 1;
  const number = overrides.number ?? issueCounter;
  const id = overrides.id ?? `DS-${String(number).padStart(3, "0")}`;
  const at = overrides.createdAt ?? new Date(2025, 0, 1, 0, 0, number).toISOString();
  return {
    id,
    number,
    title: overrides.title ?? `Issue ${number}`,
    type: overrides.type ?? ("Feature" as IssueType),
    priority: overrides.priority ?? ("Regular" as Priority),
    status: overrides.status ?? ("Planned" as Status),
    description: overrides.description ?? "",
    tasks: overrides.tasks ?? [],
    verifyCriteria: overrides.verifyCriteria ?? "",
    createdAt: at,
    resolvedAt: overrides.resolvedAt ?? null,
    statusHistory:
      overrides.statusHistory ?? [{ status: overrides.status ?? "Planned", at, by: "user" }],
    record: overrides.record ?? [],
  };
}

beforeEach(() => {
  issueCounter = 0;
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
    expect(issue.resolvedAt).toBeNull();
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

// ----- list / get / upsert / remove ------------------------------------------

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

// ----- file-backed branch coverage -------------------------------------------
//
// The default `workspace.workspaceFolders` is undefined so the store uses
// globalState. To cover the file-backed code paths (corrupt JSON, reload) we
// install a tiny in-memory FS over `vscode.workspace.fs` and pretend there's
// a workspace folder. Restored after each test.

interface FsEntry { content: Uint8Array }
type VirtualFs = Map<string, FsEntry>;

interface FsHandles {
  origFolders: typeof vscode.workspace.workspaceFolders;
  origFs: typeof vscode.workspace.fs;
}

function installVirtualFs(seed: Record<string, string> = {}): { fs: VirtualFs; handles: FsHandles } {
  const fs: VirtualFs = new Map();
  for (const [path, body] of Object.entries(seed)) {
    fs.set(path, { content: new TextEncoder().encode(body) });
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
      const entry = fs.get(uri.path);
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
      return entry.content;
    },
    writeFile: async (uri: { path: string }, content: Uint8Array) => {
      fs.set(uri.path, { content });
    },
    createDirectory: async () => {},
    delete: async (uri: { path: string }) => {
      fs.delete(uri.path);
    },
    stat: async () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async (uri: { path: string }) => {
      const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
      const entries: Array<[string, number]> = [];
      for (const key of fs.keys()) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length);
        if (tail.includes("/")) continue; // nested — not direct child
        entries.push([tail, vscode.FileType.File]);
      }
      return entries;
    },
  };

  return { fs, handles };
}

function restoreFs(handles: FsHandles) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).workspaceFolders = handles.origFolders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).fs = handles.origFs;
}

describe("IssueStore (file-backed branch)", () => {
  let handles: FsHandles | null = null;

  afterEach(() => {
    if (handles) {
      restoreFs(handles);
      handles = null;
    }
  });

  test("corrupt JSON file is skipped; other issues still load", async () => {
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

    const store = new IssueStore(makeContext());
    await store.init();

    expect(store.list().map((i) => i.id)).toEqual(["DS-001"]);
  });

  test("reload() re-reads from disk after external mutation", async () => {
    const initialIssue = makeIssue({ id: "DS-001", number: 1, title: "first" });
    const { fs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/DS-001.json": JSON.stringify(initialIssue),
    });
    handles = h;

    const store = new IssueStore(makeContext());
    await store.init();
    expect(store.get("DS-001")?.title).toBe("first");

    // Mutate disk directly (simulating an external editor write) and add a
    // second file.
    const renamed: Issue = { ...initialIssue, title: "renamed externally" };
    fs.set("/ws/.vscode/dostuff/DS-001.json", {
      content: new TextEncoder().encode(JSON.stringify(renamed)),
    });
    fs.set("/ws/.vscode/dostuff/DS-002.json", {
      content: new TextEncoder().encode(
        JSON.stringify(makeIssue({ id: "DS-002", number: 2, title: "added externally" })),
      ),
    });

    await store.reload();

    expect(store.get("DS-001")?.title).toBe("renamed externally");
    expect(store.get("DS-002")?.title).toBe("added externally");
    expect(store.list()).toHaveLength(2);
  });
});
