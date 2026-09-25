// The GitHub Pages demo: crypto shim, seed integrity, the in-browser store,
// and the fake host's message handling. The webview itself is the unmodified
// extension bundle, so these cover only what the demo adds.

import { beforeEach, describe, expect, test } from "bun:test";
import { createHash as nodeCreateHash } from "node:crypto";
import { activeLaneOverflow, validateImportList } from "../src/issueRules";
import { toRow, type HostToWebview, type Issue } from "../src/types";
import { createHash, randomUUID, sha1Hex } from "./cryptoShim";
import { DEMO_SETTINGS, DemoHost, type DemoUi, type FrameMode } from "./demoHost";
import { DemoStore, memoryKv } from "./demoStore";
import { buildSeed, SEED_COMMITS } from "./seed";

const NOW = new Date("2026-09-24T12:00:00.000Z");

describe("cryptoShim", () => {
  test("sha1 matches node:crypto, including padding boundaries and non-ASCII", () => {
    const inputs = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "b".repeat(1000), "dostuff-guid:DS-001|📝 日本語"];
    for (const s of inputs) {
      expect(createHash("sha1").update(s).digest("hex")).toBe(nodeCreateHash("sha1").update(s).digest("hex"));
    }
    expect(sha1Hex(new TextEncoder().encode("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("update() chains like node's", () => {
    expect(createHash("sha1").update("ab").update("c").digest("hex")).toBe(
      nodeCreateHash("sha1").update("abc").digest("hex"),
    );
  });

  test("rejects hashes the shared code does not use", () => {
    expect(() => createHash("sha256")).toThrow("unsupported hash");
  });

  test("randomUUID is a v4 uuid", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("seed", () => {
  const seed = buildSeed(NOW);

  test("survives the import normalizer untouched", () => {
    const { valid, skipped } = validateImportList(JSON.parse(JSON.stringify(seed)));
    expect(skipped).toBe(0);
    expect(valid).toEqual(seed);
  });

  test("respects the active-lane cap and has unique ids", () => {
    expect(activeLaneOverflow(seed)).toEqual([]);
    expect(new Set(seed.map((i) => i.id)).size).toBe(seed.length);
  });

  test("every link and commit resolves", () => {
    const ids = new Set(seed.map((i) => i.id));
    for (const issue of seed) {
      for (const l of issue.links) expect(ids.has(l.targetId)).toBe(true);
      for (const c of issue.commits) expect(SEED_COMMITS[c.sha]).toBeDefined();
    }
  });

  test("status and resolvedAt agree with the history", () => {
    for (const issue of seed) {
      expect(issue.statusHistory.at(-1)!.status).toBe(issue.status);
      expect(issue.resolvedAt !== null).toBe(issue.status === "Complete");
    }
  });

  test("ships one pending request of each kind", () => {
    const targets = seed.filter((i) => i.pendingClose).map((i) => i.pendingClose!.target);
    expect(targets.sort()).toEqual(["Closed", "Complete"]);
  });
});

describe("DemoStore", () => {
  test("seeds and persists when storage is empty", () => {
    const kv = memoryKv();
    const store = new DemoStore(kv);
    expect(store.load(() => buildSeed(NOW))).toEqual({ seeded: true });
    expect(JSON.parse(kv.value!).issues).toHaveLength(buildSeed(NOW).length);
  });

  test("reloads saved state instead of reseeding", () => {
    const kv = memoryKv();
    new DemoStore(kv).load(() => buildSeed(NOW));
    const reloaded = new DemoStore(kv);
    expect(reloaded.load(() => [])).toEqual({ seeded: false });
    expect(reloaded.list()).toHaveLength(buildSeed(NOW).length);
  });

  test("an emptied board stays empty; unreadable storage reseeds", () => {
    const empty = new DemoStore(memoryKv(JSON.stringify({ version: 1, issues: [] })));
    expect(empty.load(() => buildSeed(NOW))).toEqual({ seeded: false });
    expect(empty.list()).toEqual([]);
    const garbage = new DemoStore(memoryKv("{not json"));
    expect(garbage.load(() => buildSeed(NOW))).toEqual({ seeded: true });
  });

  test("upsert stamps updatedAt and keeps stamps on unchanged tasks", async () => {
    const store = new DemoStore(memoryKv(), () => "2026-09-25T00:00:00.000Z");
    store.load(() => buildSeed(NOW));
    const prior = store.get("DS-005")!;
    const tasks = prior.tasks.map((t, i) => (i === 2 ? { ...t, done: true } : t));
    await store.upsert({ ...prior, tasks });
    const next = store.get("DS-005")!;
    expect(next.updatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(next.tasks[0]!.updatedAt).toBe(prior.tasks[0]!.updatedAt);
    expect(next.tasks[2]!.updatedAt).toBe("2026-09-25T00:00:00.000Z");
  });

  test("remove scrubs inbound links and reports the scrubbed tickets", async () => {
    const store = new DemoStore(memoryKv());
    store.load(() => buildSeed(NOW));
    let change: { upserted: Issue[]; removed: string[] } | null = null;
    store.onChange((c) => (change = c));
    await store.remove("DS-004");
    expect(change!.removed).toEqual(["DS-004"]);
    expect(change!.upserted.map((i) => i.id).sort()).toEqual(["DS-008", "DS-009"]);
    expect(store.get("DS-008")!.links).toEqual([]);
  });

  test("ticket numbers are never reused", async () => {
    const store = new DemoStore(memoryKv());
    store.load(() => buildSeed(NOW));
    const top = Math.max(...store.list().map((i) => i.number));
    await store.remove(`DS-0${top}`);
    expect(store.nextNumber()).toBe(top + 1);
  });
});

describe("DemoHost", () => {
  let store: DemoStore;
  let host: DemoHost;
  let posts: Array<{ to: FrameMode; msg: HostToWebview }>;
  let notices: Array<{ kind: string; text: string }>;
  let external: string[];
  let importText: string | null;
  let importMode: "merge" | "replace" | null;

  beforeEach(() => {
    store = new DemoStore(memoryKv());
    store.load(() => buildSeed(NOW));
    posts = [];
    notices = [];
    external = [];
    importText = null;
    importMode = null;
    const ui: DemoUi = {
      post: (to, msg) => posts.push({ to, msg }),
      notify: (kind, text) => notices.push({ kind, text }),
      showMain: () => {},
      revealed: () => {},
      openExternal: (url) => external.push(url),
      pickImportFile: async () => importText,
      chooseImportMode: async () => importMode,
      download: () => {},
    };
    host = new DemoHost(store, ui, SEED_COMMITS);
  });

  const sent = (type: HostToWebview["type"]) => posts.filter((p) => p.msg.type === type);

  test("ready answers only the asking frame with rows + demo settings", async () => {
    await host.handle("board", { type: "ready" });
    expect(posts).toHaveLength(1);
    const { to, msg } = posts[0]!;
    expect(to).toBe("board");
    if (msg.type !== "init") throw new Error(msg.type);
    expect(msg.settings).toEqual(DEMO_SETTINGS);
    expect(msg.issues[0]).not.toHaveProperty("record");
  });

  test("createIssue lands in Thinking with the next number and applies inbound links", async () => {
    await host.handle("sidebar", {
      type: "createIssue",
      partial: {
        title: "New thing",
        type: "Feature",
        priority: "High",
        status: "Working",
        description: "",
        verifyCriteria: "",
        tags: ["x"],
        inboundLinks: [{ sourceId: "DS-010", kind: "blocks" }],
      },
    });
    const created = store.get("DS-017")!;
    expect(created.status).toBe("Thinking");
    expect(store.get("DS-010")!.links).toContainEqual({ targetId: "DS-017", kind: "blocks" });
    expect(sent("issuesDelta").map((p) => p.to).sort()).toEqual(["board", "board", "graph", "graph", "sidebar", "sidebar"]);
  });

  test("a move into a full lane is refused: warning + full re-broadcast, store unchanged", async () => {
    const drafts = store.list().filter((i) => i.status === "Thinking");
    // Planned starts at 5/6: the first promotion fits, the second doesn't.
    await host.handle("board", { type: "updateIssue", issue: { ...toRow(drafts[0]!), status: "Planned" } });
    posts = [];
    await host.handle("board", { type: "updateIssue", issue: { ...toRow(drafts[1]!), status: "Planned" } });
    expect(notices.at(-1)!.kind).toBe("warning");
    expect(notices.at(-1)!.text).toContain('Lane "Planned" is full');
    expect(sent("issues")).toHaveLength(3);
    expect(store.get(drafts[1]!.id)!.status).toBe("Thinking");
  });

  test("resolveClose approve honors the request's target", async () => {
    await host.handle("sidebar", { type: "resolveClose", id: "DS-003", verdict: "approve" });
    const done = store.get("DS-003")!;
    expect(done.status).toBe("Complete");
    expect(done.pendingClose).toBeNull();
    expect(done.resolvedAt).not.toBeNull();
    await host.handle("sidebar", { type: "resolveClose", id: "DS-013", verdict: "approve" });
    expect(store.get("DS-013")!.status).toBe("Closed");
  });

  test("fetchCommitDetails resolves seeded shas", async () => {
    await host.handle("sidebar", { type: "fetchCommitDetails", issueId: "DS-005" });
    const msg = sent("commitDetails")[0]!.msg;
    if (msg.type !== "commitDetails") throw new Error(msg.type);
    expect(msg.details.every((d) => d.found && d.subject.length > 0)).toBe(true);
  });

  test("web links open; workspace links and attachments explain themselves", async () => {
    await host.handle("sidebar", { type: "openLink", url: "https://example.com/x" });
    await host.handle("sidebar", { type: "openLink", url: "./docs/x.md" });
    await host.handle("sidebar", { type: "pickAttachment", issueId: "DS-001" });
    expect(external).toEqual(["https://example.com/x"]);
    expect(notices.map((n) => n.text)).toEqual([
      expect.stringContaining("workspace file link"),
      expect.stringContaining("Attachments need the VSCode extension"),
    ]);
  });

  test("import refuses a set that would overflow a lane", async () => {
    const overfull = Array.from({ length: 7 }, (_, i) => ({
      id: `DS-${100 + i}`,
      title: `t${i}`,
      createdAt: NOW.toISOString(),
      status: "Working",
    }));
    importText = JSON.stringify({ issues: overfull });
    importMode = "replace";
    await host.command("importJson");
    expect(notices.at(-1)!.text).toContain("active-lane cap exceeded");
    expect(store.get("DS-100")).toBeUndefined();
  });

  test("import merge-by-id normalizes legacy objects and keeps the rest", async () => {
    importText = JSON.stringify([{ id: "DS-200", title: "Legacy", createdAt: NOW.toISOString() }]);
    importMode = "merge";
    await host.command("importJson");
    const legacy = store.get("DS-200")!;
    expect(legacy.status).toBe("Thinking");
    expect(legacy.tags).toEqual([]);
    expect(store.get("DS-001")).toBeDefined();
    expect(sent("issues")).toHaveLength(3);
  });
});
