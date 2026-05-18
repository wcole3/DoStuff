// Tests for `IssueStore` and the pure `normalize` helper.
//
// Strategy: by default the mock `vscode.workspace.workspaceFolders` is
// `undefined`, so the store falls back to `globalState`. That lets us exercise
// init/upsert/list/get/remove/replaceAll/onChange/reload without touching disk.
// A small in-memory FS shim is installed (and restored per test) when we need
// to exercise the file-backed branch (corrupt JSON, reload-from-disk).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";
import { GITIGNORE_CONTENT, IssueStore, normalize } from "./storage";
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
    tags: overrides.tags ?? [],
    verifyCriteria: overrides.verifyCriteria ?? "",
    createdAt: at,
    resolvedAt: overrides.resolvedAt ?? null,
    statusHistory:
      overrides.statusHistory ?? [{ status: overrides.status ?? "Planned", at, by: "user" }],
    record: overrides.record ?? [],
    attachments: overrides.attachments ?? [],
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
    expect(issue.tags).toEqual([]);
    expect(issue.resolvedAt).toBeNull();
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
    delete: async (uri: { path: string }, options?: { recursive?: boolean }) => {
      if (options?.recursive) {
        const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
        for (const key of Array.from(fs.keys())) {
          if (key === uri.path || key.startsWith(prefix)) fs.delete(key);
        }
      } else {
        fs.delete(uri.path);
      }
    },
    stat: async (uri: { path: string }) => {
      if (fs.has(uri.path)) {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
      }
      const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
      for (const key of fs.keys()) {
        if (key.startsWith(prefix)) {
          return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }
      }
      throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
    },
    readDirectory: async (uri: { path: string }) => {
      const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
      const seen = new Map<string, number>();
      for (const key of fs.keys()) {
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

  test("writes .gitignore on first upsert when none present", async () => {
    const { fs, handles: h } = installVirtualFs({});
    handles = h;

    const store = new IssueStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));

    const entry = fs.get("/ws/.vscode/dostuff/.gitignore");
    expect(entry).toBeDefined();
    expect(new TextDecoder().decode(entry!.content)).toBe(GITIGNORE_CONTENT);
  });

  test("does not overwrite a user-edited .gitignore", async () => {
    const customBody = "# my custom rules\n!keep-me.json\n";
    const { fs, handles: h } = installVirtualFs({
      "/ws/.vscode/dostuff/.gitignore": customBody,
    });
    handles = h;

    const store = new IssueStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));

    const entry = fs.get("/ws/.vscode/dostuff/.gitignore");
    expect(new TextDecoder().decode(entry!.content)).toBe(customBody);
  });

  test("respects dostuff.writeStorageGitignore=false (no .gitignore written)", async () => {
    const { fs, handles: h } = installVirtualFs({});
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
      const store = new IssueStore(makeContext());
      await store.init();
      await store.upsert(makeIssue({ id: "DS-001", number: 1, title: "first" }));
      expect(fs.has("/ws/.vscode/dostuff/.gitignore")).toBe(false);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.workspace as any).getConfiguration = origGetConfig;
    }
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
    const { fs, handles: h } = installVirtualFs();
    handles = h;
    const store = new IssueStore(makeContext());
    await store.init();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const written = await store.writeAttachment("DS-001", "abc", ".png", bytes);
    expect(written).toBe(true);
    const entry = fs.get("/ws/.vscode/dostuff/attachments/DS-001/abc.png");
    expect(entry).toBeDefined();
    expect(Array.from(entry!.content)).toEqual([1, 2, 3, 4]);
  });

  test("readAttachment round-trips the bytes", async () => {
    const { handles: h } = installVirtualFs();
    handles = h;
    const store = new IssueStore(makeContext());
    await store.init();
    const bytes = new Uint8Array([9, 8, 7]);
    await store.writeAttachment("DS-002", "att2", ".pdf", bytes);
    const out = await store.readAttachment("DS-002", "att2");
    expect(Array.from(out)).toEqual([9, 8, 7]);
  });

  test("readAttachment on a missing file rejects", async () => {
    const { handles: h } = installVirtualFs();
    handles = h;
    const store = new IssueStore(makeContext());
    await store.init();
    await expect(store.readAttachment("DS-001", "missing")).rejects.toThrow();
  });

  test("remove(id) prunes the per-issue attachment folder", async () => {
    const { fs, handles: h } = installVirtualFs();
    handles = h;
    const store = new IssueStore(makeContext());
    await store.init();
    await store.upsert(makeIssue({ id: "DS-001" }));
    await store.writeAttachment("DS-001", "att1", ".png", new Uint8Array([1]));
    await store.writeAttachment("DS-001", "att2", ".pdf", new Uint8Array([2]));
    expect(fs.get("/ws/.vscode/dostuff/attachments/DS-001/att1.png")).toBeDefined();

    await store.remove("DS-001");

    expect(fs.get("/ws/.vscode/dostuff/attachments/DS-001/att1.png")).toBeUndefined();
    expect(fs.get("/ws/.vscode/dostuff/attachments/DS-001/att2.pdf")).toBeUndefined();
  });

  test("deleteAttachmentFile removes a single file without touching siblings", async () => {
    const { fs, handles: h } = installVirtualFs();
    handles = h;
    const store = new IssueStore(makeContext());
    await store.init();
    await store.writeAttachment("DS-001", "keep", ".png", new Uint8Array([1]));
    await store.writeAttachment("DS-001", "drop", ".pdf", new Uint8Array([2]));
    await store.deleteAttachmentFile("DS-001", "drop");
    expect(fs.get("/ws/.vscode/dostuff/attachments/DS-001/keep.png")).toBeDefined();
    expect(fs.get("/ws/.vscode/dostuff/attachments/DS-001/drop.pdf")).toBeUndefined();
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
});
