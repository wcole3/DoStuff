// Tests for the createIssue host helpers extracted from SidebarProvider.
//
// These cover the logic that runs after a new ticket is upserted: inline
// attachment replay and inverse-link ("blocked by X") application, plus the
// new-issue construction itself (tags + forward-link validation). The store is
// the globalState-backed IssueStore (mock vscode.workspace.workspaceFolders is
// undefined, so no SQLite/fs work) — the same harness storage.test.ts uses.

import { beforeEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";
import { IssueStore } from "./storage";
import {
  applyInboundLinks,
  applyInlineAttachments,
  buildCreatedIssue,
  type CreateIssuePartial,
} from "./sidebarProvider";
import type { Issue, IssueType, Priority, Status } from "./types";

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
    keys: () => Array.from(map.keys()),
  } as unknown as vscode.Memento;
}

function makeContext(): vscode.ExtensionContext {
  const fakeUri = vscode.Uri.file("/tmp/dostuff-sidebar-test");
  return {
    subscriptions: [],
    globalState: makeMemento(),
    workspaceState: makeMemento(),
    extensionUri: fakeUri,
    globalStorageUri: fakeUri,
    extensionPath: "/tmp/dostuff-sidebar-test",
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
    asAbsolutePath: (p: string) => `/tmp/dostuff-sidebar-test/${p}`,
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
    statusHistory: overrides.statusHistory ?? [{ status: overrides.status ?? "Planned", at, by: "user" }],
    record: overrides.record ?? [],
    attachments: overrides.attachments ?? [],
    links: overrides.links ?? [],
    pendingClose: overrides.pendingClose ?? null,
    guid: overrides.guid ?? `guid-${id}`,
    updatedAt: overrides.updatedAt ?? at,
  };
}

async function makeStore(seed: Issue[] = []): Promise<IssueStore> {
  const store = new IssueStore(makeContext());
  await store.init();
  for (const i of seed) await store.upsert(i);
  return store;
}

function partial(over: Partial<CreateIssuePartial> = {}): CreateIssuePartial {
  return {
    title: "New ticket",
    type: "Bug",
    priority: "Regular",
    description: "",
    verifyCriteria: "",
    status: "Thinking",
    tags: [],
    ...over,
  } as CreateIssuePartial;
}

beforeEach(() => {
  issueCounter = 0;
});

describe("buildCreatedIssue", () => {
  const opts = (knownIds: string[] = []) => ({
    number: 7,
    now: "2026-05-28T00:00:00.000Z",
    knownIds: new Set(knownIds),
  });

  test("mints a Thinking ticket with padded id and a single status event", () => {
    const { issue } = buildCreatedIssue(partial({ title: "Do a thing" }), opts());
    expect(issue.id).toBe("DS-007");
    expect(issue.number).toBe(7);
    expect(issue.status).toBe("Thinking");
    expect(issue.title).toBe("Do a thing");
    expect(issue.resolvedAt).toBeNull();
    expect(issue.statusHistory).toEqual([{ status: "Thinking", at: "2026-05-28T00:00:00.000Z", by: "user" }]);
  });

  test("coerces tags (trim + case-insensitive dedupe)", () => {
    const { issue } = buildCreatedIssue(partial({ tags: ["Auth", "auth", " backend "] }), opts());
    expect(issue.tags).toEqual(["Auth", "backend"]);
  });

  test("keeps valid forward links and drops unknown-target ones", () => {
    const { issue, droppedLinks } = buildCreatedIssue(
      partial({
        links: [
          { targetId: "DS-001", kind: "blocks" },
          { targetId: "DS-999", kind: "relates-to" }, // unknown
        ],
      }),
      opts(["DS-001"]),
    );
    expect(issue.links).toEqual([{ targetId: "DS-001", kind: "blocks" }]);
    expect(droppedLinks).toHaveLength(1);
    expect(droppedLinks[0]!.targetId).toBe("DS-999");
  });

  test("drops a self-link (target equals the new ticket's own id)", () => {
    const { issue } = buildCreatedIssue(
      partial({ links: [{ targetId: "DS-007", kind: "blocks" }] }),
      opts(["DS-007"]),
    );
    expect(issue.links).toEqual([]);
  });
});

describe("applyInlineAttachments", () => {
  function recorder() {
    const calls: Array<{ issueId: string; name: string; mimeType: string; bytes: number[] }> = [];
    return {
      calls,
      onAddBytes: async (issueId: string, name: string, mimeType: string, bytes: Uint8Array) => {
        calls.push({ issueId, name, mimeType, bytes: Array.from(bytes) });
      },
    };
  }

  test("replays each well-formed attachment through onAddBytes", async () => {
    const rec = recorder();
    const res = await applyInlineAttachments(rec, "DS-001", [
      { name: "a.txt", mimeType: "text/plain", bytes: [1, 2] },
      { name: "b.png", mimeType: "image/png", bytes: [3] },
    ]);
    expect(res).toEqual({ applied: 2, skipped: 0 });
    expect(rec.calls).toEqual([
      { issueId: "DS-001", name: "a.txt", mimeType: "text/plain", bytes: [1, 2] },
      { issueId: "DS-001", name: "b.png", mimeType: "image/png", bytes: [3] },
    ]);
  });

  test("skips malformed entries without throwing", async () => {
    const rec = recorder();
    const res = await applyInlineAttachments(rec, "DS-001", [
      { name: "ok.txt", mimeType: "text/plain", bytes: [1] },
      { name: "no-bytes", mimeType: "text/plain" },
      { mimeType: "text/plain", bytes: [1] }, // no name
      null,
      "nope",
    ]);
    expect(res).toEqual({ applied: 1, skipped: 4 });
    expect(rec.calls).toHaveLength(1);
  });

  test("non-array input is a no-op", async () => {
    const rec = recorder();
    expect(await applyInlineAttachments(rec, "DS-001", undefined)).toEqual({ applied: 0, skipped: 0 });
    expect(rec.calls).toHaveLength(0);
  });
});

describe("applyInboundLinks", () => {
  test("writes the inverse as a forward link on the source ticket", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", links: [] }), // the source ("blocks" new ticket)
    ]);
    const res = await applyInboundLinks(store, "DS-050", [{ sourceId: "DS-001", kind: "blocks" }]);
    expect(res.applied).toEqual([{ sourceId: "DS-001", kind: "blocks" }]);
    expect(res.skipped).toBe(0);
    expect(store.get("DS-001")!.links).toEqual([{ targetId: "DS-050", kind: "blocks" }]);
  });

  test("skips unknown sources, self-refs, and bad kinds", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", links: [] })]);
    const res = await applyInboundLinks(store, "DS-050", [
      { sourceId: "DS-999", kind: "blocks" }, // unknown source
      { sourceId: "DS-050", kind: "blocks" }, // self
      { sourceId: "DS-001", kind: "duplicates" }, // bad kind
      { sourceId: "not-an-id", kind: "blocks" }, // bad id shape
    ]);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toBe(4);
    expect(store.get("DS-001")!.links).toEqual([]);
  });

  test("dedupes against an identical existing link (no-op, not counted as skipped)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", links: [{ targetId: "DS-050", kind: "blocks" }] }),
    ]);
    const res = await applyInboundLinks(store, "DS-050", [{ sourceId: "DS-001", kind: "blocks" }]);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toBe(0);
    expect(store.get("DS-001")!.links).toEqual([{ targetId: "DS-050", kind: "blocks" }]); // not doubled
  });

  test("multiple inbound links to the same source accumulate", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", links: [] })]);
    const res = await applyInboundLinks(store, "DS-050", [
      { sourceId: "DS-001", kind: "blocks" },
      { sourceId: "DS-001", kind: "child-of" },
    ]);
    expect(res.applied).toHaveLength(2);
    expect(store.get("DS-001")!.links).toEqual([
      { targetId: "DS-050", kind: "blocks" },
      { targetId: "DS-050", kind: "child-of" },
    ]);
  });

  test("non-array input is a no-op", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", links: [] })]);
    expect(await applyInboundLinks(store, "DS-050", undefined)).toEqual({ applied: [], skipped: 0 });
    expect(store.get("DS-001")!.links).toEqual([]);
  });
});
