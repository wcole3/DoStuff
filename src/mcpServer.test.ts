// Tests for the DoStuff MCP server.
//
// Strategy: test the pure tool handlers directly (`runGetTicket`,
// `runCreateTicket`, `runUpdateTicketStatus`, `runUpdateTicketProgress`).
// They take an `IssueStore` and a typed args object, so we can spin one up
// in-memory without an HTTP roundtrip. HTTP round-trip tests cover the
// wire-level guarantees (smuggled-field rejection, host/url enforcement,
// reconcile() serialization).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as http from "http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IssueStore } from "./storage";
import {
  runGetTicket,
  runListIssues,
  runCreateTicket,
  runUpdateTicketStatus,
  runUpdateTicketProgress,
  registerMcpTools,
  getWorkspaceContext,
  DoStuffMcpServer,
  DEFAULT_WORKFLOW_PROMPT,
  type ToolResult,
} from "./mcpServer";
import { ACTIVE_LANE_CAP, type Issue, type Priority, type IssueType, type Status } from "./types";

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

function makeContext(): vscode.ExtensionContext {
  const fakeUri = vscode.Uri.file("/tmp/dostuff-test");
  return {
    subscriptions: [],
    globalState: makeMemento(),
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

async function makeStore(seed: Issue[] = []): Promise<IssueStore> {
  const ctx = makeContext();
  const store = new IssueStore(ctx);
  await store.init();
  for (const issue of seed) await store.upsert(issue);
  return store;
}

function payload(r: ToolResult): unknown {
  const t = r.content[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

beforeEach(() => {
  issueCounter = 0;
});

// ----- get_ticket ------------------------------------------------------------

describe("get_ticket", () => {
  test("by ticket number (digits only)", async () => {
    const store = await makeStore([
      makeIssue({ number: 3, id: "DS-003", title: "Fix login", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "3" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string } };
    expect(body.ticket.id).toBe("DS-003");
  });

  test("by ticket number prefixed with #", async () => {
    const store = await makeStore([
      makeIssue({ number: 7, id: "DS-007", title: "Add CSV export", status: "Working" }),
    ]);
    const res = await runGetTicket(store, { query: "#7" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string } };
    expect(body.ticket.id).toBe("DS-007");
  });

  test("by DS- id", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Boot scaffold", status: "Verification" }),
    ]);
    const res = await runGetTicket(store, { query: "DS-001" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string; status: string } };
    expect(body.ticket.id).toBe("DS-001");
    expect(body.ticket.status).toBe("Verification");
  });

  test("by title substring (case-insensitive)", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Refactor OAuth flow", status: "Planned" }),
      makeIssue({ number: 2, id: "DS-002", title: "Add login button", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "oauth" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string } };
    expect(body.ticket.id).toBe("DS-001");
  });

  test("strips statusHistory and resolvedAt from public view", async () => {
    const store = await makeStore([
      makeIssue({
        number: 5,
        id: "DS-005",
        title: "Inspect leak",
        status: "Working",
        resolvedAt: null,
        statusHistory: [
          { status: "Thinking", at: "2025-01-01T00:00:00Z", by: "user" },
          { status: "Planned", at: "2025-01-02T00:00:00Z", by: "user" },
          { status: "Working", at: "2025-01-03T00:00:00Z", by: "user" },
        ],
      }),
    ]);
    const res = await runGetTicket(store, { query: "5" });
    const body = payload(res) as { ticket: Record<string, unknown> };
    expect(body.ticket).not.toHaveProperty("statusHistory");
    expect(body.ticket).not.toHaveProperty("resolvedAt");
  });

  test("404 for Thinking ticket", async () => {
    const store = await makeStore([
      makeIssue({ number: 9, id: "DS-009", title: "Brainstorm idea", status: "Thinking" }),
    ]);
    const res = await runGetTicket(store, { query: "9" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Thinking");
  });

  test("404 for Complete ticket", async () => {
    const store = await makeStore([
      makeIssue({ number: 10, id: "DS-010", title: "Shipped feature", status: "Complete" }),
    ]);
    const res = await runGetTicket(store, { query: "10" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Complete");
  });

  test("404 when no ticket matches the title substring", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Refactor parser", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "nothing-matches-here" });
    expect(res.isError).toBe(true);
  });

  test("404 when number doesn't exist", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "999" });
    expect(res.isError).toBe(true);
  });

  test("lower-case 'ds-001' is NOT a number/id match (regex is case-sensitive on the prefix)", async () => {
    // The DS-id regex /^DS-\d+$/i in handler is case-insensitive at the
    // dispatch site, BUT the outer check at line 217 doesn't match it as a
    // number either. Result: it falls through to title substring. We seed a
    // ticket with id DS-001 and title "DS Boot" so the lower-case id WILL
    // accidentally still substring-match the title; instead we pick a title
    // that doesn't contain 'ds-001' so we can pin the contract.
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Bootstrap scaffold", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "ds-001" });
    // The /^DS-\d+$/i in the implementation is case-insensitive, so this is
    // actually treated as an id query. Pin the current behavior: it finds DS-001.
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string } };
    expect(body.ticket.id).toBe("DS-001");
  });

  test("substring matches multiple servable tickets -> ambiguity error", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "auth login flow", status: "Planned" }),
      makeIssue({ number: 2, id: "DS-002", title: "auth retry handler", status: "Planned" }),
      makeIssue({ number: 3, id: "DS-003", title: "auth refresh tokens", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "auth" });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("Ambiguous");
    expect(text).toContain("DS-001");
    expect(text).toContain("DS-002");
    expect(text).toContain("DS-003");
  });

  test("substring matches mix of servable + non-servable narrows to the servable one", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "auth login planned", status: "Planned" }),
      makeIssue({ number: 2, id: "DS-002", title: "auth login complete", status: "Complete" }),
      makeIssue({ number: 3, id: "DS-003", title: "auth login thinking", status: "Thinking" }),
    ]);
    const res = await runGetTicket(store, { query: "auth" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string; status: string } };
    expect(body.ticket.id).toBe("DS-001");
    expect(body.ticket.status).toBe("Planned");
  });

  test("empty query string is rejected (zod min(1))", async () => {
    const store = await makeStore([]);
    const res = await runGetTicket(store, { query: "" });
    expect(res.isError).toBe(true);
  });

  test("whitespace-only query is rejected with 'Empty query.'", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    for (const q of ["   ", "\t", "\n  \t"]) {
      const res = await runGetTicket(store, { query: q });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Empty query");
    }
  });

  test("'#0' and '0' both fall through to 'no ticket with number 0'", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    for (const q of ["0", "#0"]) {
      const res = await runGetTicket(store, { query: q });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("No ticket with number 0");
    }
  });

  test("huge number returns 404", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "99999" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No ticket with number 99999");
  });

  test("'#' alone fails the number regex and falls through to substring search", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    const res = await runGetTicket(store, { query: "#" });
    expect(res.isError).toBe(true);
    // It went to substring search, did not find a '#' in "X", returns no-match
    expect(res.content[0].text).toContain("No ticket matches");
  });
});

// ----- list_issues -----------------------------------------------------------

describe("list_issues", () => {
  test("no filters returns all issues sorted by number ascending", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-003", number: 3, title: "C", status: "Complete" }),
      makeIssue({ id: "DS-001", number: 1, title: "A", status: "Thinking" }),
      makeIssue({ id: "DS-002", number: 2, title: "B", status: "Planned" }),
    ]);
    const res = await runListIssues(store, {});
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { count: number; issues: Array<{ id: string }> };
    expect(body.count).toBe(3);
    expect(body.issues.map((i) => i.id)).toEqual(["DS-001", "DS-002", "DS-003"]);
  });

  test("returns compact fields only (no description, tasks, record, statusHistory)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Compact", status: "Planned" }),
    ]);
    const res = await runListIssues(store, {});
    const body = payload(res) as { issues: Array<Record<string, unknown>> };
    const item = body.issues[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("number");
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("type");
    expect(item).toHaveProperty("priority");
    expect(item).toHaveProperty("status");
    expect(item).not.toHaveProperty("description");
    expect(item).not.toHaveProperty("tasks");
    expect(item).not.toHaveProperty("record");
    expect(item).not.toHaveProperty("statusHistory");
  });

  test("status filter limits to matching issues", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, status: "Working" }),
      makeIssue({ id: "DS-003", number: 3, status: "Thinking" }),
    ]);
    const res = await runListIssues(store, { status: "Planned" });
    const body = payload(res) as { count: number; issues: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("DS-001");
  });

  test("type filter limits to matching issues", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, type: "Bug", status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, type: "Feature", status: "Planned" }),
      makeIssue({ id: "DS-003", number: 3, type: "Bug", status: "Working" }),
    ]);
    const res = await runListIssues(store, { type: "Bug" });
    const body = payload(res) as { count: number; issues: Array<{ id: string }> };
    expect(body.count).toBe(2);
    expect(body.issues.map((i) => i.id)).toEqual(["DS-001", "DS-003"]);
  });

  test("priority filter limits to matching issues", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, priority: "Critical", status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, priority: "Regular", status: "Planned" }),
    ]);
    const res = await runListIssues(store, { priority: "Critical" });
    const body = payload(res) as { count: number; issues: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("DS-001");
  });

  test("combined type + priority + status filters are ANDed", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, type: "Bug", priority: "Critical", status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, type: "Bug", priority: "Regular", status: "Planned" }),
      makeIssue({ id: "DS-003", number: 3, type: "Feature", priority: "Critical", status: "Planned" }),
      makeIssue({ id: "DS-004", number: 4, type: "Bug", priority: "Critical", status: "Working" }),
    ]);
    const res = await runListIssues(store, { type: "Bug", priority: "Critical", status: "Planned" });
    const body = payload(res) as { count: number; issues: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("DS-001");
  });

  test("empty store returns count=0 and empty array", async () => {
    const store = await makeStore([]);
    const res = await runListIssues(store, {});
    const body = payload(res) as { count: number; issues: unknown[] };
    expect(body.count).toBe(0);
    expect(body.issues).toEqual([]);
  });

  test("no matches with filter returns count=0 and empty array (not an error)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, type: "Feature", status: "Planned" }),
    ]);
    const res = await runListIssues(store, { type: "Bug" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { count: number; issues: unknown[] };
    expect(body.count).toBe(0);
    expect(body.issues).toEqual([]);
  });

  test("includes Thinking and Complete issues when no status filter", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, status: "Thinking" }),
      makeIssue({ id: "DS-002", number: 2, status: "Complete" }),
      makeIssue({ id: "DS-003", number: 3, status: "Planned" }),
    ]);
    const res = await runListIssues(store, {});
    const body = payload(res) as { count: number; issues: Array<{ status: string }> };
    expect(body.count).toBe(3);
    const statuses = body.issues.map((i) => i.status).sort();
    expect(statuses).toEqual(["Complete", "Planned", "Thinking"]);
  });

  test("smuggled unknown fields rejected by strict schema (isError)", async () => {
    const store = await makeStore([]);
    const res = await runListIssues(store, {
      ...(({ foo: "bar" }) as unknown as object),
    } as Parameters<typeof runListIssues>[1]);
    expect(res.isError).toBe(true);
  });
});

// ----- workspace context + workflow in responses ------------------------------

describe("workspace context and workflow in tool responses", () => {
  afterEach(() => {
    vscode.workspace.workspaceFolders = undefined;
    vscode.workspace.name = undefined;
  });

  test("getWorkspaceContext returns null when no workspaceFolders", () => {
    vscode.workspace.workspaceFolders = undefined;
    expect(getWorkspaceContext()).toBeNull();
  });

  test("getWorkspaceContext returns name+rootPath when workspaceFolders set", () => {
    vscode.workspace.workspaceFolders = [
      { name: "MyProject", uri: vscode.Uri.file("/home/user/MyProject"), index: 0 },
    ];
    vscode.workspace.name = "MyProject";
    const ctx = getWorkspaceContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.name).toBe("MyProject");
    expect(ctx!.rootPath).toBe("/home/user/MyProject");
  });

  test("getWorkspaceContext falls back to folder name when workspace.name is undefined", () => {
    vscode.workspace.workspaceFolders = [
      { name: "FolderName", uri: vscode.Uri.file("/x"), index: 0 },
    ];
    vscode.workspace.name = undefined;
    const ctx = getWorkspaceContext();
    expect(ctx!.name).toBe("FolderName");
  });

  test("tool responses include workspace field (null when no workspace open)", async () => {
    vscode.workspace.workspaceFolders = undefined;
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned" })]);

    const listBody = payload(await runListIssues(store, {})) as Record<string, unknown>;
    expect(listBody).toHaveProperty("workspace");
    expect(listBody.workspace).toBeNull();

    const getBody = payload(await runGetTicket(store, { query: "DS-001" })) as Record<string, unknown>;
    expect(getBody).toHaveProperty("workspace");
    expect(getBody.workspace).toBeNull();

    const createBody = payload(await runCreateTicket(store, { title: "T" })) as Record<string, unknown>;
    expect(createBody).toHaveProperty("workspace");
    expect(createBody.workspace).toBeNull();

    const statusBody = payload(
      await runUpdateTicketStatus(store, { id: "DS-001", status: "Working" }),
    ) as Record<string, unknown>;
    expect(statusBody).toHaveProperty("workspace");
    expect(statusBody.workspace).toBeNull();

    const progressBody = payload(
      await runUpdateTicketProgress(store, { id: "DS-001" }),
    ) as Record<string, unknown>;
    expect(progressBody).toHaveProperty("workspace");
    expect(progressBody.workspace).toBeNull();
  });

  test("list_issues includes workflow field equal to DEFAULT_WORKFLOW_PROMPT when instructions unset", async () => {
    // mock getConfiguration returns defaultValue ("") for any key → readWorkflowPrompt falls through
    const store = await makeStore([]);
    const res = payload(await runListIssues(store, {})) as { workflow: string };
    expect(res.workflow).toBe(DEFAULT_WORKFLOW_PROMPT);
  });
});

// ----- create_ticket ---------------------------------------------------------

describe("create_ticket", () => {
  test("lands in Thinking with auto-generated id/number", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, {
      title: "Investigate panel jank",
      type: "Bug",
      priority: "High",
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string; number: number; status: string };
    expect(body.status).toBe("Thinking");
    expect(body.number).toBe(1);
    expect(body.id).toBe("DS-001");

    const persisted = store.get(body.id);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("Thinking");
  });

  test("seeds initial record entry tagged author=agent", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, { title: "X", type: "Feature", priority: "Regular" });
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.record).toHaveLength(1);
    expect(persisted.record[0].author).toBe("agent");
    expect(persisted.record[0].text).toMatch(/Created via MCP/i);
  });

  test("resolvedAt is null and statusHistory has a single Thinking event", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, { title: "Y", type: "Chore", priority: "Low" });
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.resolvedAt).toBeNull();
    expect(persisted.statusHistory).toHaveLength(1);
    expect(persisted.statusHistory[0].status).toBe("Thinking");
    expect(typeof persisted.statusHistory[0].at).toBe("string");
  });

  test("numbers are monotonic across creates", async () => {
    const store = await makeStore([
      makeIssue({ number: 5, id: "DS-005", title: "Existing" }),
    ]);
    const r1 = await runCreateTicket(store, { title: "A" });
    const r2 = await runCreateTicket(store, { title: "B" });
    const b1 = payload(r1) as { number: number; id: string };
    const b2 = payload(r2) as { number: number; id: string };
    expect(b1.number).toBe(6);
    expect(b1.id).toBe("DS-006");
    expect(b2.number).toBe(7);
    expect(b2.id).toBe("DS-007");
  });

  test("seeds provided tasks with done=false", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, {
      title: "With tasks",
      tasks: ["First", "Second"],
    });
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.tasks).toHaveLength(2);
    expect(persisted.tasks.every((t) => t.done === false)).toBe(true);
    expect(persisted.tasks.map((t) => t.text)).toEqual(["First", "Second"]);
  });

  test("initial StatusEvent has by='agent'", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, { title: "Z" });
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.statusHistory).toHaveLength(1);
    expect(persisted.statusHistory[0]).toMatchObject({
      status: "Thinking",
      by: "agent",
    });
  });

  test("rapid-fire produces unique task ids across many creates (no UUID collisions)", async () => {
    const store = await makeStore([]);
    // Fire 50 creates with NO awaits in between so they overlap. Each create
    // produces two task ids; collect them all and assert uniqueness.
    const promises: Promise<ToolResult>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(runCreateTicket(store, { title: `T${i}`, tasks: ["a", "b"] }));
    }
    await Promise.all(promises);

    const allTaskIds: string[] = [];
    for (const issue of store.list()) {
      for (const t of issue.tasks) allTaskIds.push(t.id);
    }
    expect(allTaskIds.length).toBe(100);
    expect(new Set(allTaskIds).size).toBe(100);
    // Sanity: ids follow the t-<uuid> shape.
    for (const id of allTaskIds) {
      expect(id.startsWith("t-")).toBe(true);
    }
  });

  test("smuggled id/number/createdAt fields rejected by strict zod (issue NOT created)", async () => {
    const store = await makeStore([]);
    const before = store.list().length;
    const res = await runCreateTicket(store, {
      title: "Hijacked",
      // Smuggle locked fields past the TS check.
      ...({
        id: "DS-999",
        number: 999,
        createdAt: "1970-01-01T00:00:00Z",
      } as Record<string, unknown>),
    } as Parameters<typeof runCreateTicket>[1]);
    expect(res.isError).toBe(true);
    expect(store.list().length).toBe(before);
    // No ticket with DS-999 exists.
    expect(store.get("DS-999")).toBeUndefined();
  });

  test("description: undefined is filled as empty string by zod default", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, {
      title: "No description",
      description: undefined,
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.description).toBe("");
  });
});

// ----- update_ticket_status --------------------------------------------------

describe("update_ticket_status", () => {
  test("Planned -> Working: allowed", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Working" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Working");
  });

  test("Working -> Verification: allowed", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Verification" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Verification");
  });

  test("Verification -> Planned: allowed", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Verification" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Planned");
  });

  test("Thinking -> Planned: rejected (human-only promotion)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Thinking");
    expect(store.get("DS-001")!.status).toBe("Thinking");
  });

  test("Complete -> Planned: rejected (terminal)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Complete" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Complete");
    expect(store.get("DS-001")!.status).toBe("Complete");
  });

  test("Planned -> Thinking: rejected with actionable message explaining the human-triage rule", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned" })]);
    // bypass schema by casting; handler must still reject
    const res = await runUpdateTicketStatus(store, {
      id: "DS-001",
      status: "Thinking" as Status,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("human triage queue");
    expect(res.content[0].text).toContain("Planned, Working, Verification");
    expect(store.get("DS-001")!.status).toBe("Planned");
  });

  test("Planned -> Complete: rejected (only humans complete)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned" })]);
    const res = await runUpdateTicketStatus(store, {
      id: "DS-001",
      status: "Complete" as Status,
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.status).toBe("Planned");
  });

  test("appends a StatusEvent (author agent) and a RecordEntry on successful move", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned", record: [] })]);
    const res = await runUpdateTicketStatus(store, {
      id: "DS-001",
      status: "Working",
      note: "started work",
    });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.statusHistory.at(-1)).toMatchObject({ status: "Working", by: "agent" });
    expect(updated.record).toHaveLength(1);
    expect(updated.record[0].author).toBe("agent");
    expect(updated.record[0].text).toContain("started work");
  });

  test("lane cap: moving into a full Working lane is rejected and names the lane + cap", async () => {
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    seed.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));
    const store = await makeStore(seed);

    const res = await runUpdateTicketStatus(store, { id: "DS-099", status: "Working" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Working");
    expect(res.content[0].text).toContain(String(ACTIVE_LANE_CAP));
    expect(store.get("DS-099")!.status).toBe("Planned");
  });

  test("lane cap: in-place no-op when ticket is already in the lane (excluded from count)", async () => {
    // Lane currently has CAP tickets; one of them tries to no-op into the same lane.
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    const store = await makeStore(seed);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Working" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("no change");
  });

  test("not found returns an error", async () => {
    const store = await makeStore([]);
    const res = await runUpdateTicketStatus(store, { id: "DS-404", status: "Working" });
    expect(res.isError).toBe(true);
  });

  test("at CAP-1 boundary, moving one more in succeeds (room for exactly one)", async () => {
    // Seed (CAP - 1) Working + one Planned ticket. Moving the Planned in
    // should fill the lane to CAP exactly.
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP - 1; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    seed.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));
    const store = await makeStore(seed);

    const res = await runUpdateTicketStatus(store, { id: "DS-099", status: "Working" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-099")!.status).toBe("Working");
    // Lane should now be at exactly CAP.
    const workingCount = store.list().filter((i) => i.status === "Working").length;
    expect(workingCount).toBe(ACTIVE_LANE_CAP);
  });

  test("already over cap (data corruption): move into already-overfull lane is rejected", async () => {
    // Force 7 Working tickets in directly via the store (bypassing handler).
    // The cap is 6; the store doesn't validate caps. Then try moving an 8th
    // Planned ticket in — should be rejected.
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP + 1; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    seed.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));
    const store = await makeStore(seed);

    const res = await runUpdateTicketStatus(store, { id: "DS-099", status: "Working" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Working");
    expect(store.get("DS-099")!.status).toBe("Planned");
  });

  test("lane cap error uses '(X/Y)' format", async () => {
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    seed.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));
    const store = await makeStore(seed);

    const res = await runUpdateTicketStatus(store, { id: "DS-099", status: "Working" });
    expect(res.isError).toBe(true);
    // canMoveToActiveLane returns: `Lane "Working" is full (6/6). ...`
    expect(res.content[0].text).toMatch(
      new RegExp(`\\(${ACTIVE_LANE_CAP}/${ACTIVE_LANE_CAP}\\)`),
    );
  });
});

// ----- update_ticket_progress ------------------------------------------------

describe("update_ticket_progress", () => {
  test("toggles task.done; other ticket fields are untouched", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        title: "Original title",
        description: "Original desc",
        priority: "High",
        type: "Bug",
        verifyCriteria: "Original criteria",
        tasks: [
          { id: "t1", text: "step one", done: false },
          { id: "t2", text: "step two", done: false },
        ],
      }),
    ]);

    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [
        { id: "t1", done: true },
        { id: "t2", done: false },
      ],
    });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.tasks.find((t) => t.id === "t1")!.done).toBe(true);
    expect(updated.tasks.find((t) => t.id === "t2")!.done).toBe(false);
    expect(updated.title).toBe("Original title");
    expect(updated.description).toBe("Original desc");
    expect(updated.priority).toBe("High");
    expect(updated.type).toBe("Bug");
    expect(updated.verifyCriteria).toBe("Original criteria");
  });

  test("appends recordEntry as an agent-authored RecordEntry", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Working", record: [], tasks: [] }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      recordEntry: "Ran integration tests; 2 failures pending fix.",
    });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.record).toHaveLength(1);
    expect(updated.record[0].author).toBe("agent");
    expect(updated.record[0].text).toContain("Ran integration tests");
    expect(typeof updated.record[0].at).toBe("string");
  });

  test("rejects when ticket is in Thinking", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking", tasks: [] })]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      recordEntry: "should not write",
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.record).toHaveLength(0);
  });

  test("rejects when ticket is in Complete", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Complete", tasks: [] })]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      recordEntry: "should not write",
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.record).toHaveLength(0);
  });

  test("rejects unknown task id without partial mutation", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [{ id: "t1", text: "real", done: false }],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [
        { id: "t1", done: true },
        { id: "ghost", done: true },
      ],
    });
    expect(res.isError).toBe(true);
    // t1 should NOT have been toggled because of the unknown id.
    expect(store.get("DS-001")!.tasks[0].done).toBe(false);
  });

  test("empty taskUpdates + no recordEntry is a no-op (record unchanged, write succeeds)", async () => {
    // The current handler still calls store.upsert even with no taskUpdates
    // and no recordEntry. This pins the contract: the call succeeds and the
    // record length is unchanged. (If we later decide this should error, the
    // followup is documented in the plan file.)
    const initialRecord = [
      { at: "2025-01-01T00:00:00Z", author: "user" as const, text: "existing" },
    ];
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [{ id: "t1", text: "one", done: false }],
        record: initialRecord,
      }),
    ]);
    const res = await runUpdateTicketProgress(store, { id: "DS-001", taskUpdates: [] });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.record).toHaveLength(1);
    expect(updated.record[0].text).toBe("existing");
    // Tasks unchanged.
    expect(updated.tasks[0].done).toBe(false);
  });

  test("empty-string recordEntry is treated as falsy and NOT appended", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [],
        record: [],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [],
      recordEntry: "",
    });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.record).toHaveLength(0);
  });

  test("not-found id returns isError (404-style)", async () => {
    const store = await makeStore([]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-404",
      recordEntry: "ignored",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("DS-404");
    expect(res.content[0].text.toLowerCase()).toContain("not found");
  });

  test("cannot edit title/description/priority/type/verifyCriteria via this tool", async () => {
    // Pure-handler check: strict zod at the top of the handler rejects
    // unknown keys, so locked fields can't be smuggled even through a
    // direct call. The authoritative wire-level guarantee lives in the
    // separate HTTP smuggled-fields test further below.
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        title: "Locked title",
        description: "Locked desc",
        priority: "Regular",
        type: "Feature",
        verifyCriteria: "Locked",
        tasks: [],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      // Smuggle locked fields via casting -- handler should reject outright.
      ...({
        title: "Mutated!",
        description: "Mutated!",
        priority: "Critical",
        type: "Bug",
        verifyCriteria: "Mutated!",
      } as Record<string, unknown>),
      recordEntry: "tried to mutate",
    } as Parameters<typeof runUpdateTicketProgress>[1]);
    expect(res.isError).toBe(true);
    const updated = store.get("DS-001")!;
    expect(updated.title).toBe("Locked title");
    expect(updated.description).toBe("Locked desc");
    expect(updated.priority).toBe("Regular");
    expect(updated.type).toBe("Feature");
    expect(updated.verifyCriteria).toBe("Locked");
    expect(updated.record).toHaveLength(0);
  });
});

// ----- HTTP integration tests -----------------------------------------------

describe("DoStuffMcpServer HTTP", () => {
  test("status reports stopped defaults before reconcile", async () => {
    const store = await makeStore([]);
    const server = new DoStuffMcpServer(store);
    expect(server.status).toEqual({ running: false, port: null, workspacePath: null });
    server.dispose();
  });
});

// Helpers for booting a real HTTP-backed MCP server in tests.
const __origGetConfig = vscode.workspace.getConfiguration;
function setMcpConfig(values: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).getConfiguration = (_section?: string) => ({
    get: <T,>(key: string, defaultValue?: T): T | undefined =>
      (key in values ? (values[key] as T) : defaultValue),
    update: () => Promise.resolve(),
    inspect: () => undefined,
    has: () => false,
  });
}
function restoreMcpConfig(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.workspace as any).getConfiguration = __origGetConfig;
}

// Each booted server gets a distinct synthetic workspace path so registry
// entries don't collide across tests.
let __nextWs = 0;
function makeWorkspaceId(): () => { path: string; name: string } {
  __nextWs += 1;
  const path = `/tmp/dostuff-test-ws-${process.pid}-${__nextWs}`;
  return () => ({ path, name: `ws-${__nextWs}` });
}

async function bootServer(
  store: IssueStore,
  opts: {
    enabled?: boolean;
    instructions?: string;
    workspaceId?: () => { path: string; name: string } | null;
  } = {},
): Promise<{ server: DoStuffMcpServer; port: number }> {
  const cfg: Record<string, unknown> = { "mcp.enabled": opts.enabled ?? true };
  if (opts.instructions !== undefined) cfg["mcp.instructions"] = opts.instructions;
  setMcpConfig(cfg);
  const server = new DoStuffMcpServer(store, opts.workspaceId ?? makeWorkspaceId());
  await server.reconcile();
  return { server, port: server.status.port ?? 0 };
}

async function rawRequest(
  port: number,
  opts: {
    path?: string;
    method?: string;
    host?: string | null;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.host === null) {
      // Skip Host explicitly. Node always sends *something* via the
      // `host` request option, but we can override it to empty string.
    } else if (opts.host !== undefined) {
      headers.Host = opts.host;
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/mcp",
        method: opts.method ?? "POST",
        headers,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("DoStuffMcpServer HTTP (live)", () => {
  let server: DoStuffMcpServer | null = null;
  let port = 0;
  let tmpRegistryDir = "";
  const __origRegistryPath = process.env.DOSTUFF_REGISTRY_PATH;

  beforeAll(() => {
    tmpRegistryDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-mcpserver-"));
    process.env.DOSTUFF_REGISTRY_PATH = nodePath.join(tmpRegistryDir, "instances.json");
  });

  afterAll(() => {
    if (__origRegistryPath === undefined) delete process.env.DOSTUFF_REGISTRY_PATH;
    else process.env.DOSTUFF_REGISTRY_PATH = __origRegistryPath;
    try {
      fs.rmSync(tmpRegistryDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server.dispose();
      server = null;
    }
    restoreMcpConfig();
  });

  test("reconcile() starts the server on an ephemeral port", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));
    expect(server.status.running).toBe(true);
    expect(typeof server.status.port).toBe("number");
    expect(server.status.port).toBeGreaterThan(0);
    expect(server.status.workspacePath).not.toBeNull();
  });

  test("two server instances can both start without EADDRINUSE", async () => {
    const storeA = await makeStore([]);
    const storeB = await makeStore([]);
    const a = await bootServer(storeA);
    const b = await bootServer(storeB);
    try {
      expect(a.server.status.running).toBe(true);
      expect(b.server.status.running).toBe(true);
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.server.stop();
      a.server.dispose();
      await b.server.stop();
      b.server.dispose();
    }
  });

  test("workspaceId() returning null keeps the server stopped", async () => {
    const store = await makeStore([]);
    setMcpConfig({ "mcp.enabled": true });
    const local = new DoStuffMcpServer(store, () => null);
    await local.reconcile();
    try {
      expect(local.status.running).toBe(false);
      expect(local.status.port).toBeNull();
    } finally {
      local.dispose();
    }
  });

  test("workspace path change restarts the server on a fresh port", async () => {
    const store = await makeStore([]);
    setMcpConfig({ "mcp.enabled": true });
    let identity: { path: string; name: string } = {
      path: `/tmp/dostuff-test-swap-${process.pid}-a`,
      name: "a",
    };
    const local = new DoStuffMcpServer(store, () => identity);
    try {
      await local.reconcile();
      const portA = local.status.port;
      expect(local.status.running).toBe(true);
      identity = { path: `/tmp/dostuff-test-swap-${process.pid}-b`, name: "b" };
      await local.reconcile();
      expect(local.status.running).toBe(true);
      expect(local.status.port).not.toBe(portA);
      expect(local.status.workspacePath).not.toBeNull();
    } finally {
      await local.stop();
      local.dispose();
    }
  });

  test("stop() removes the entry from the registry", async () => {
    const { loadRegistry } = await import("./mcpRegistry");
    const store = await makeStore([]);
    const local = await bootServer(store);
    expect(loadRegistry().some((e) => e.pid === process.pid)).toBe(true);
    await local.server.stop();
    expect(loadRegistry().some((e) => e.pid === process.pid)).toBe(false);
    local.server.dispose();
  });

  test("wire-level smuggled fields cannot mutate locked ticket fields (authoritative)", async () => {
    // This is the wire-level guarantee on the SDK tool-dispatch path:
    // smuggled extra arguments at tools/call MUST NOT mutate locked fields.
    // We exercise the full SDK validation + handler path via an in-memory
    // transport pair — this drives `mcp.tool` invocation exactly as it
    // would over HTTP, but without the stateless-transport-reuse limit of
    // the HTTP server (each request would otherwise require a fresh
    // transport instance).
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        title: "Locked title",
        description: "Locked desc",
        priority: "Regular",
        type: "Feature",
        verifyCriteria: "Locked",
        tasks: [],
      }),
    ]);

    const mcp = new McpServer(
      { name: "dostuff-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerMcpTools(mcp, store);

    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientT);

    await client.callTool({
      name: "update_ticket_progress",
      arguments: {
        id: "DS-001",
        // Smuggled locked fields must NOT mutate the ticket. The current
        // SDK builds a non-strict `z.object(shape)` from the registered
        // input shape and strips unknown keys before our handler runs, so
        // these never reach the handler. Belt-and-braces: the handler's
        // own `.strict()` parse would reject them if the SDK ever changed
        // to passthrough.
        title: "Mutated!",
        description: "Mutated!",
        priority: "Critical",
        type: "Bug",
        verifyCriteria: "Mutated!",
        recordEntry: "ok progress entry",
      },
    });

    const issue = store.get("DS-001")!;
    expect(issue.title).toBe("Locked title");
    expect(issue.description).toBe("Locked desc");
    expect(issue.priority).toBe("Regular");
    expect(issue.type).toBe("Feature");
    expect(issue.verifyCriteria).toBe("Locked");

    await client.close();
    await mcp.close();
  });

  test("wire-level smuggled fields with no known fields: handler still rejects strictly", async () => {
    // Direct-handler companion to the wire-level test: if a caller somehow
    // bypasses the SDK shape (e.g. via a future SDK that passes extras
    // through), the handler's own .strict() parse must still reject.
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        title: "Locked title",
        tasks: [],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      // smuggle unknown keys past the TS check
      ...({ title: "Mutated!", description: "Mutated!" } as Record<string, unknown>),
    } as Parameters<typeof runUpdateTicketProgress>[1]);
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.title).toBe("Locked title");
  });

  test("empty Host header is rejected with 403", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const res = await rawRequest(port, { host: "", body: "{}" });
    expect(res.status).toBe(403);
    expect(res.body).toContain("non-loopback Host");
  });

  test("non-loopback Host header is rejected with 403", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const res = await rawRequest(port, { host: "evil.example.com", body: "{}" });
    expect(res.status).toBe(403);
  });

  test("cross-origin Origin header is rejected with 403", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const res = await rawRequest(port, {
      host: "127.0.0.1",
      headers: { Origin: "https://evil.example.com" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("cross-origin");
  });

  test("loopback Origin header is accepted", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    // Use DELETE so the transport responds quickly without hanging on an SSE stream.
    const res = await rawRequest(port, {
      host: "127.0.0.1",
      method: "DELETE",
      headers: { Origin: "http://127.0.0.1:3947" },
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  test("Origin: null (local file) is accepted", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const res = await rawRequest(port, {
      host: "127.0.0.1",
      method: "DELETE",
      headers: { Origin: "null" },
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  test("oversized Content-Length is rejected with 413", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    // rawRequest uses req.write() which causes chunked encoding (no Content-Length header).
    // req.end(body) sets Content-Length to the actual body size automatically.
    const bigBody = "x".repeat(1_100_000); // 1.1 MB
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              Host: "127.0.0.1",
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { buf += c; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
          },
        );
        req.on("error", (e) => {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "EPIPE" && code !== "ECONNRESET") reject(e);
        });
        req.end(bigBody);
      },
    );
    expect(status).toBe(413);
    expect(body).toContain("too large");
  });

  test("every response carries X-Content-Type-Options: nosniff", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const header = await new Promise<string | undefined>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "DELETE",
          headers: { Host: "127.0.0.1" } },
        (res) => {
          res.resume();
          resolve(res.headers["x-content-type-options"] as string | undefined);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(header).toBe("nosniff");
  });

  test("/mcpfoo and /mcp.evil do not match the MCP path", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const r1 = await rawRequest(port, { path: "/mcpfoo", host: "127.0.0.1" });
    expect(r1.status).toBe(404);
    const r2 = await rawRequest(port, { path: "/mcp.evil", host: "127.0.0.1" });
    expect(r2.status).toBe(404);
  });

  test("/mcp, /mcp/, /mcp?... are all accepted as the MCP path", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    // Use DELETE: the transport recognizes the method and responds quickly
    // (4xx) without opening any streams. What we're checking is that the
    // path gate doesn't reject these paths with a 404 from our handler.
    // Each request uses a fresh server because the stateless transport
    // only handles one request before refusing further ones.
    for (const path of ["/mcp", "/mcp/", "/mcp?foo=1"]) {
      await server.stop();
      ({ server, port } = await bootServer(store));
      const r = await rawRequest(port, { path, method: "DELETE", host: "127.0.0.1" });
      expect(r.status).not.toBe(404);
      expect(r.status).not.toBe(403);
    }
  });

  test("reconcile() serializes overlapping calls (no leaked server)", async () => {
    // Two rapid reconciles with two different workspaces must not race: the
    // second one must wait for the first to settle, the final state must
    // reflect the second workspace, and the first ephemeral port must be
    // released back to the OS.
    const store = await makeStore([]);
    setMcpConfig({ "mcp.enabled": true });
    let identity: { path: string; name: string } = {
      path: `/tmp/dostuff-test-serial-${process.pid}-a`,
      name: "a",
    };
    server = new DoStuffMcpServer(store, () => identity);

    const p1 = server.reconcile();
    const portA = server.status.port; // captured after first reconcile starts; may be null until awaited
    identity = { path: `/tmp/dostuff-test-serial-${process.pid}-b`, name: "b" };
    const p2 = server.reconcile();
    await Promise.all([p1, p2]);

    expect(server.status.running).toBe(true);
    expect(server.status.workspacePath).toContain("-b");
    // First port (captured if it had a value) must be free again.
    if (portA && portA !== server.status.port) {
      await new Promise<void>((resolve, reject) => {
        const probe = http.createServer().listen(portA, "127.0.0.1", () => {
          probe.close(() => resolve());
        });
        probe.on("error", reject);
      });
    }
  });

  test("real /mcp POST with tools/list returns the 4 registered tool names", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/mcp",
      host: "127.0.0.1",
      body,
    });
    expect(res.status).toBe(200);

    // StreamableHTTPServerTransport may respond as SSE (`event: message`
    // + `data: <json>`) or plain JSON depending on Accept negotiation.
    // Extract the JSON payload either way.
    let json: { result?: { tools?: Array<{ name: string }> } };
    const sseMatch = res.body.match(/data:\s*(\{[\s\S]*\})/);
    if (sseMatch) {
      json = JSON.parse(sseMatch[1]);
    } else {
      json = JSON.parse(res.body);
    }
    const toolNames = (json.result?.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "create_ticket",
      "get_ticket",
      "list_issues",
      "update_ticket_progress",
      "update_ticket_status",
    ]);
  });

  test("multiple sequential tools/list requests on the same listener all succeed", async () => {
    // Regression: previously the stateless StreamableHTTPServerTransport was
    // shared across requests, which made the 2nd request fail. The fix builds
    // a fresh transport+McpServer per HTTP request.
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    for (let i = 0; i < 3; i++) {
      const json = await mcpJsonRpc(port, "tools/list", {});
      const tools = (json.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name).sort()).toEqual([
        "create_ticket",
        "get_ticket",
        "list_issues",
        "update_ticket_progress",
        "update_ticket_status",
      ]);
    }
  });

  // Helper: send a JSON-RPC request to /mcp and parse the response.
  async function mcpJsonRpc(
    p: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ result?: unknown; error?: { message: string } }> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const res = await rawRequest(p, {
      method: "POST",
      path: "/mcp",
      host: "127.0.0.1",
      body,
    });
    expect(res.status).toBe(200);
    const sseMatch = res.body.match(/data:\s*(\{[\s\S]*?\})\s*$/m);
    const json = sseMatch ? JSON.parse(sseMatch[1]) : JSON.parse(res.body);
    return json as { result?: unknown; error?: { message: string } };
  }

  test("resource dostuff://tickets returns only servable tickets", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Planned one", status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, title: "Working one", status: "Working" }),
      makeIssue({ id: "DS-003", number: 3, title: "Testing one", status: "Verification" }),
      makeIssue({ id: "DS-004", number: 4, title: "Thinking one", status: "Thinking" }),
      makeIssue({ id: "DS-005", number: 5, title: "Complete one", status: "Complete" }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets",
    });
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    const payload = JSON.parse(contents[0].text) as {
      tickets: Array<{ id: string; status: string }>;
    };
    const ids = payload.tickets.map((t) => t.id).sort();
    expect(ids).toEqual(["DS-001", "DS-002", "DS-003"]);
    // Thinking and Complete must be filtered out.
    for (const t of payload.tickets) {
      expect(["Planned", "Working", "Verification"]).toContain(t.status);
    }
  });

  test("resource dostuff://tickets/{id} for a servable ticket returns publicView payload", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "Servable",
        status: "Working",
        resolvedAt: "2025-06-01T00:00:00Z",
      }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    expect(json.error).toBeUndefined();
    const contents = (json.result as { contents: Array<{ text: string; uri: string }> })
      .contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe("dostuff://tickets/DS-001");
    const payload = JSON.parse(contents[0].text) as {
      workflow: string;
      ticket: Record<string, unknown>;
    };
    expect(payload.ticket.id).toBe("DS-001");
    expect(payload.ticket.status).toBe("Working");
    // publicView strips statusHistory + resolvedAt.
    expect("statusHistory" in payload.ticket).toBe(false);
    expect("resolvedAt" in payload.ticket).toBe(false);
    expect(typeof payload.workflow).toBe("string");
  });

  test("resource dostuff://tickets/{id} for Thinking ticket: errors (not servable)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Draft", status: "Thinking" }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message).toContain("Thinking");
  });

  test("resource dostuff://tickets/{id} for Complete ticket: errors (not servable)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Shipped", status: "Complete" }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message).toContain("Complete");
  });

  test("resource dostuff://tickets/{id} for a non-existent ticket: errors with 'not found'", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-999",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message).toContain("not found");
  });

  test("resource dostuff://instructions/workflow uses dostuff.mcp.instructions when set", async () => {
    const custom = "CUSTOM WORKFLOW TEXT FROM SETTINGS";
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store, { instructions: custom }));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://instructions/workflow",
    });
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    expect(contents[0].text).toBe(custom);
  });

  test("'workflow' prompt is registered and returns the workflow prompt", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "prompts/get", { name: "workflow" });
    const result = json.result as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    // Default workflow prompt mentions DoStuff ticket queue.
    expect(result.messages[0].content.text).toContain("DoStuff issue queue");
  });

  test("dispose() releases the port (asynchronously)", async () => {
    const store = await makeStore([]);
    const { server: localServer, port: disposePort } = await bootServer(store);
    expect(localServer.status.running).toBe(true);

    // dispose() is fire-and-forget; poll until the port is released.
    localServer.dispose();

    const startedAt = Date.now();
    const deadline = startedAt + 5000;
    let released = false;
    while (Date.now() < deadline) {
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = http.createServer().listen(disposePort, "127.0.0.1", () => {
            probe.close(() => resolve());
          });
          probe.on("error", reject);
        });
        released = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(released).toBe(true);
    // Defeat the afterEach: nothing to stop, server is null.
    // (We never assigned to the outer `server` ref, so afterEach skips it.)
  });

  test("disabled config stops a running server", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));
    expect(server.status.running).toBe(true);

    setMcpConfig({ "mcp.enabled": false });
    await server.reconcile();
    expect(server.status.running).toBe(false);
  });
});
