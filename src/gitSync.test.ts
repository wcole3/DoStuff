// Tests for the sync controller (docs/plans/ticket-sync/04 §8): a bare
// origin + two clones, each driving its own store+controller pair through
// real git. Stores are lightweight in-memory fakes implementing the
// SyncStoreLike slice — storage-level stamping/tombstone behavior is already
// proven in storage.test.ts; these tests exercise the controller's
// commit/fetch/merge/apply/push cycle and convergence guarantees.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitSyncController, type SyncStoreLike } from "./gitSync";
import { canonicalJson } from "./syncMerge";
import type { Issue } from "./types";

const REF = "refs/dostuff/state";
const T = (h: number, m = 0) =>
  `2025-06-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

let tmpRoot = "";
let repoCounter = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function mkRepo(name: string, bare = false): string {
  const dir = path.join(tmpRoot, `${name}-${++repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ...(bare ? ["--bare"] : []));
  return dir;
}

// ----- FakeStore -------------------------------------------------------------

interface TombRow {
  scope: "ticket" | "task" | "attachment";
  ticketGuid: string;
  elementId: string;
  deletedAt: string;
  lastId: string;
}

class FakeStore {
  cache: Issue[] = [];
  tombs: TombRow[] = [];
  private readonly emitter = new vscode.EventEmitter<Issue[]>();
  readonly onChange = this.emitter.event;
  applySyncCalls = 0;

  list(): Issue[] {
    return [...this.cache];
  }
  get(id: string): Issue | undefined {
    return this.cache.find((i) => i.id === id);
  }
  appendLog(_line: string): void {}
  attachmentsDir(): vscode.Uri | null {
    return null;
  }
  getSyncTombstones() {
    return {
      tickets: this.tombs
        .filter((t) => t.scope === "ticket")
        .map((t) => ({ guid: t.ticketGuid, deletedAt: t.deletedAt, lastId: t.lastId })),
      elements: this.tombs
        .filter((t): t is TombRow & { scope: "task" | "attachment" } => t.scope !== "ticket")
        .map((t) => ({
          ticketGuid: t.ticketGuid,
          scope: t.scope,
          elementId: t.elementId,
          deletedAt: t.deletedAt,
        })),
    };
  }
  async applySync(args: {
    upserts: Issue[];
    removals: string[];
    tombstoned?: string[];
  }): Promise<void> {
    this.applySyncCalls += 1;
    const removalSet = new Set(args.removals);
    const upsertById = new Map(args.upserts.map((i) => [i.id, i]));
    const survivors = this.cache
      .filter((i) => !removalSet.has(i.id))
      .map((i) => upsertById.get(i.id) ?? i);
    const present = new Set(survivors.map((i) => i.id));
    for (const u of args.upserts) if (!present.has(u.id)) survivors.push(u);
    this.cache = survivors;
    this.emitter.fire(this.cache);
  }

  /** Test mutators — explicit timestamps, no wall clock. */
  put(issue: Issue): void {
    const idx = this.cache.findIndex((i) => i.id === issue.id);
    if (idx >= 0) this.cache[idx] = issue;
    else this.cache.push(issue);
    this.emitter.fire(this.cache);
  }
  delete(id: string, deletedAt: string): void {
    const issue = this.get(id);
    if (!issue) return;
    this.cache = this.cache.filter((i) => i.id !== id);
    this.tombs.push({
      scope: "ticket",
      ticketGuid: issue.guid,
      elementId: issue.guid,
      deletedAt,
      lastId: issue.id,
    });
    this.emitter.fire(this.cache);
  }
  dropTask(id: string, taskId: string, deletedAt: string): void {
    const issue = this.get(id);
    if (!issue) return;
    this.put({
      ...issue,
      updatedAt: deletedAt,
      tasks: issue.tasks.filter((t) => t.id !== taskId),
    });
    this.tombs.push({ scope: "task", ticketGuid: issue.guid, elementId: taskId, deletedAt, lastId: "" });
  }
}

function makeIssue(overrides: Partial<Issue> & { guid: string }): Issue {
  const number = overrides.number ?? 1;
  const id = overrides.id ?? `DS-${String(number).padStart(3, "0")}`;
  const at = overrides.createdAt ?? T(1);
  return {
    id,
    number,
    title: overrides.title ?? `Ticket ${id}`,
    type: overrides.type ?? "Feature",
    priority: overrides.priority ?? "Regular",
    status: overrides.status ?? "Planned",
    description: overrides.description ?? "",
    verifyCriteria: overrides.verifyCriteria ?? "",
    createdAt: at,
    resolvedAt: overrides.resolvedAt ?? null,
    tasks: overrides.tasks ?? [],
    tags: overrides.tags ?? [],
    attachments: overrides.attachments ?? [],
    links: overrides.links ?? [],
    statusHistory: overrides.statusHistory ?? [],
    record: overrides.record ?? [],
    pendingClose: overrides.pendingClose ?? null,
    guid: overrides.guid,
    updatedAt: overrides.updatedAt ?? at,
  };
}

// ----- harness ---------------------------------------------------------------

interface Clone {
  dir: string;
  store: FakeStore;
  controller: GitSyncController;
  notifications: Array<{ kind: string; message: string }>;
}

function mkClone(name: string, bare: string): Clone {
  const dir = mkRepo(name);
  git(dir, "remote", "add", "origin", bare);
  const store = new FakeStore();
  const notifications: Array<{ kind: string; message: string }> = [];
  const controller = new GitSyncController(store as unknown as SyncStoreLike, () => dir, {
    remote: "origin",
    ref: REF,
    intervalMinutes: 0, // manual network sync only
    activeLaneCap: 6,
    debounceMs: 5,
    tipPollMs: 3_600_000, // effectively off — tests drive syncNow directly
    pushFollowUpMs: 3_600_000,
    startupSync: false,
    notify: (kind, message) => notifications.push({ kind, message }),
  });
  return { dir, store, controller, notifications };
}

function boardJson(store: FakeStore): string {
  return canonicalJson(
    [...store.cache].sort((a, b) => (a.guid < b.guid ? -1 : 1)),
  );
}

const clones: Clone[] = [];
function track(c: Clone): Clone {
  clones.push(c);
  return c;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-gitsync-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

afterEach(() => {
  for (const c of clones.splice(0)) c.controller.dispose();
});

// ----- tests -----------------------------------------------------------------

describe("GitSyncController: two-clone convergence", () => {
  test("colliding DS numbers converge byte-identically with deterministic renumber", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    const b = track(mkClone("cloneB", bare));

    a.store.put(makeIssue({ guid: "g-a", number: 1, id: "DS-001", createdAt: T(1), title: "from A" }));
    b.store.put(makeIssue({ guid: "g-b", number: 1, id: "DS-001", createdAt: T(2), title: "from B" }));

    a.controller.start();
    b.controller.start();
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");

    // Both boards identical, byte for byte.
    expect(boardJson(a.store)).toBe(boardJson(b.store));
    expect(a.store.cache).toHaveLength(2);
    // Older createdAt (A's) keeps DS-001; B's is renumbered past max.
    expect(a.store.cache.find((i) => i.guid === "g-a")?.id).toBe("DS-001");
    expect(a.store.cache.find((i) => i.guid === "g-b")?.id).toBe("DS-002");
    // The renumbering clone surfaced a toast.
    expect(b.notifications.some((n) => n.message.includes("DS-001 → DS-002"))).toBe(true);
  });

  test("delete propagates via tombstone and does not resurrect on re-sync", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    const b = track(mkClone("cloneB", bare));
    a.store.put(makeIssue({ guid: "g-1", number: 1, createdAt: T(1), updatedAt: T(1) }));
    a.controller.start();
    b.controller.start();
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    expect(b.store.get("DS-001")).toBeDefined();

    a.store.delete("DS-001", T(3));
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    expect(b.store.get("DS-001")).toBeUndefined();

    // Re-sync from B (whose ref already carried the ticket once): stays gone.
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");
    expect(a.store.get("DS-001")).toBeUndefined();
    expect(b.store.get("DS-001")).toBeUndefined();
  });

  test("element delete-vs-edit converges to the newer stamp (both directions)", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    const b = track(mkClone("cloneB", bare));
    const shared = makeIssue({
      guid: "g-1",
      number: 1,
      createdAt: T(1),
      updatedAt: T(1),
      tasks: [
        { id: "tX", text: "contested", done: false, updatedAt: T(1) },
        { id: "tY", text: "bystander", done: false, updatedAt: T(1) },
      ],
    });
    a.store.put(shared);
    a.controller.start();
    b.controller.start();
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");

    // A deletes tX at T3; B toggles tX done at T4 (> T3) → toggle wins.
    a.store.dropTask("DS-001", "tX", T(3));
    const bTicket = b.store.get("DS-001")!;
    b.store.put({
      ...bTicket,
      updatedAt: T(4),
      tasks: bTicket.tasks.map((t) => (t.id === "tX" ? { ...t, done: true, updatedAt: T(4) } : t)),
    });

    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");

    expect(boardJson(a.store)).toBe(boardJson(b.store));
    const tasks = a.store.get("DS-001")!.tasks;
    expect(tasks.find((t) => t.id === "tX")).toMatchObject({ done: true, updatedAt: T(4) });

    // Reverse direction: delete at T6 beats an edit at T5.
    const bT = b.store.get("DS-001")!;
    b.store.put({
      ...bT,
      updatedAt: T(5),
      tasks: bT.tasks.map((t) => (t.id === "tY" ? { ...t, text: "edited", updatedAt: T(5) } : t)),
    });
    a.store.dropTask("DS-001", "tY", T(6));
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");

    expect(boardJson(a.store)).toBe(boardJson(b.store));
    expect(a.store.get("DS-001")!.tasks.find((t) => t.id === "tY")).toBeUndefined();
  });

  test("pendingClose propagates; approval propagates Closed back; concurrent edit drops the flag", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    const b = track(mkClone("cloneB", bare));
    a.store.put(makeIssue({ guid: "g-1", number: 1, createdAt: T(1), updatedAt: T(1), status: "Working" }));
    a.controller.start();
    b.controller.start();
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");

    // Agent files a close request in A.
    const aT = a.store.get("DS-001")!;
    a.store.put({ ...aT, updatedAt: T(2), pendingClose: { by: "agent", at: T(2), note: "done" } });
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    expect(b.store.get("DS-001")!.pendingClose).toEqual({ by: "agent", at: T(2), note: "done" });

    // Human approves in B (resolveCloseRequest semantics: Closed + flag cleared).
    const bT = b.store.get("DS-001")!;
    b.store.put({ ...bT, updatedAt: T(3), status: "Closed", pendingClose: null });
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");
    expect(a.store.get("DS-001")!.status).toBe("Closed");
    expect(a.store.get("DS-001")!.pendingClose).toBeNull();

    // Documented drop (00-overview §risks): request at T4 in A vs newer plain
    // edit at T5 in B → the newer edit wins; flag null on both, converged.
    a.store.put(makeIssue({ guid: "g-2", number: 2, id: "DS-002", createdAt: T(1), updatedAt: T(1) }));
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    const a2 = a.store.get("DS-002")!;
    a.store.put({ ...a2, updatedAt: T(4), pendingClose: { by: "agent", at: T(4) } });
    const b2 = b.store.get("DS-002")!;
    b.store.put({ ...b2, updatedAt: T(5), title: "edited concurrently" });
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    await a.controller.syncNow("manual");
    expect(boardJson(a.store)).toBe(boardJson(b.store));
    expect(a.store.get("DS-002")!.pendingClose).toBeNull();
    expect(a.store.get("DS-002")!.title).toBe("edited concurrently");
  });
});

describe("GitSyncController: failure modes & plumbing behavior", () => {
  test("no remote configured → noRemote local-only mode; ref commits still land", async () => {
    const dir = mkRepo("lonely");
    const store = new FakeStore();
    store.put(makeIssue({ guid: "g-1", number: 1 }));
    const controller = new GitSyncController(store as unknown as SyncStoreLike, () => dir, {
      remote: "origin",
      ref: REF,
      intervalMinutes: 0,
      activeLaneCap: 6,
      tipPollMs: 3_600_000,
      startupSync: false,
      notify: () => {},
    });
    track({ dir, store, controller, notifications: [] });
    controller.start();
    await controller.syncNow("manual");
    expect(controller.status.state).toBe("noRemote");
    // Local ref exists with the ticket committed.
    expect(git(dir, "rev-parse", "--verify", REF).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "ls-tree", "-r", "--name-only", REF)).toContain("tickets/g-1.json");
  });

  test("push failure → pendingPush; recovery on next syncNow", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    a.store.put(makeIssue({ guid: "g-1", number: 1 }));
    a.controller.start();
    await a.controller.syncNow("manual");
    expect(a.controller.status.state).toBe("idle");

    // Break the remote (simulate network death), then edit + sync.
    const hidden = `${bare}-hidden`;
    fs.renameSync(bare, hidden);
    a.store.put({ ...a.store.get("DS-001")!, updatedAt: T(9), title: "offline edit" });
    await a.controller.syncNow("manual");
    expect(["pendingPush", "error"]).toContain(a.controller.status.state);

    // Remote comes back → next sync pushes the backlog.
    fs.renameSync(hidden, bare);
    const result = await a.controller.syncNow("manual");
    expect(result.pushed).toBe(true);
    expect(a.controller.status.state).toBe("idle");
  });

  test("echo suppression: applying inbound state does not trigger an outbound commit", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    const b = track(mkClone("cloneB", bare));
    a.store.put(makeIssue({ guid: "g-1", number: 1 }));
    a.controller.start();
    b.controller.start();
    await a.controller.syncNow("manual");
    await b.controller.syncNow("manual");
    expect(b.store.applySyncCalls).toBeGreaterThan(0);

    const tipAfterApply = git(b.dir, "rev-parse", REF).trim();
    // Give the (5ms) debounce ample time: had the applySync onChange leaked
    // past suppression, a new local commit would have moved the tip.
    await new Promise((r) => setTimeout(r, 80));
    await b.controller.syncNow("manual"); // no-op cycle
    expect(git(b.dir, "rev-parse", REF).trim()).toBe(tipAfterApply);
  });

  test("no-op cycles do not grow history", async () => {
    const bare = mkRepo("origin.git", true);
    const a = track(mkClone("cloneA", bare));
    a.store.put(makeIssue({ guid: "g-1", number: 1 }));
    a.controller.start();
    await a.controller.syncNow("manual");
    const tip1 = git(a.dir, "rev-parse", REF).trim();
    await a.controller.syncNow("manual");
    await a.controller.syncNow("manual");
    expect(git(a.dir, "rev-parse", REF).trim()).toBe(tip1);
  });
});
