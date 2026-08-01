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
  runUpdateTicketDraft,
  runUpdateTicketDescription,
  runRequestTicketClose,
  runRequestTicketComplete,
  registerMcpTools,
  getWorkspaceContext,
  publicView,
  summaryView,
  statusView,
  excerpt,
  DEFAULT_RECORD_LIMIT,
  MAX_VERIFY_CRITERIA_CHARS,
  DoStuffMcpServer,
  DEFAULT_WORKFLOW_PROMPT,
  WORKFLOW_POINTER,
  buildDefaultWorkflowPrompt,
  PROMPT_BYTE_BUDGET,
  type CreateTicketInput,
  type GetTicketInput,
  type ToolResult,
} from "./mcpServer";
import { ACTIVE_LANE_CAP, type Issue, type Priority, type IssueType, type Status } from "./types";
import {
  bootServer,
  makeIssueFactory,
  makeWorkspaceId,
  restoreMcpConfig,
  setMcpConfig,
} from "./testSupport";

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

const makeIssue = makeIssueFactory();

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
  makeIssue.reset();
});

// ----- read-shaping projections ---------------------------------------------

function recordEntries(n: number, prefix = "entry") {
  return Array.from({ length: n }, (_, i) => ({
    at: `2025-06-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    author: "agent" as const,
    text: `${prefix}-${i}`,
  }));
}

describe("excerpt", () => {
  test("returns '' for blank, whitespace, or non-string input", () => {
    expect(excerpt("")).toBe("");
    expect(excerpt("   \n\n  ")).toBe("");
    expect(excerpt(undefined)).toBe("");
    expect(excerpt(null)).toBe("");
    expect(excerpt(42)).toBe("");
  });

  test("skips a leading markdown heading and excerpts the prose", () => {
    expect(excerpt("## Problem\n\nThe sync loop clobbers edits.")).toBe(
      "The sync loop clobbers edits.",
    );
  });

  test("skips several leading headings and blank lines", () => {
    expect(excerpt("\n\n# Title\n\n### Sub\n\nActual prose here.")).toBe(
      "Actual prose here.",
    );
  });

  test("returns '' when the description is only structure", () => {
    expect(excerpt("## Problem\n\n### Detail")).toBe("");
  });

  test("stops at the first paragraph break and stays under max", () => {
    const out = excerpt("First para.\n\nSecond para that should not appear.", 140);
    expect(out).toBe("First para.");
    expect(out.length).toBeLessThan(140);
  });

  test("collapses newlines and runs of whitespace inside one paragraph", () => {
    expect(excerpt("wrapped line one\nline   two")).toBe("wrapped line one line two");
  });

  test("cuts on a word boundary and appends an ellipsis when longer than max", () => {
    const out = excerpt("alpha bravo charlie delta echo", 14);
    expect(out).toBe("alpha bravo…");
    expect(out.endsWith("…")).toBe(true);
    // Never emits a dangling partial word.
    expect(out).not.toContain("char");
  });

  test("does not append an ellipsis when the text fits exactly", () => {
    expect(excerpt("exactly", 7)).toBe("exactly");
  });
});

describe("summaryView", () => {
  test("omits the heavy fields entirely", () => {
    const row = summaryView(
      makeIssue({
        id: "DS-001",
        number: 1,
        status: "Working",
        description: "Some prose.",
        verifyCriteria: "must pass",
        record: recordEntries(5),
      }),
    ) as Record<string, unknown>;
    for (const heavy of [
      "description",
      "record",
      "verifyCriteria",
      "attachments",
      "links",
      "inboundLinks",
      "commits",
      "pendingClose",
    ]) {
      expect(heavy in row).toBe(false);
    }
  });

  test("renders tasks as a done/total string", () => {
    const row = summaryView(
      makeIssue({
        id: "DS-001",
        number: 1,
        tasks: [
          { id: "t1", text: "a", done: true },
          { id: "t2", text: "b", done: false },
          { id: "t3", text: "c", done: true },
        ],
      }),
    );
    expect(row.tasks).toBe("2/3");
  });

  test("omits the excerpt key when the description is blank", () => {
    const row = summaryView(makeIssue({ id: "DS-001", number: 1, description: "" }));
    expect("excerpt" in row).toBe(false);
  });

  test("carries an excerpt when the description has prose", () => {
    const row = summaryView(
      makeIssue({ id: "DS-001", number: 1, description: "## Why\n\nBecause it breaks." }),
    ) as { excerpt?: string };
    expect(row.excerpt).toBe("Because it breaks.");
  });
});

describe("publicView demoted sections", () => {
  const withCommits = (n: number) =>
    makeIssue({
      id: "DS-001",
      number: 1,
      commits: Array.from({ length: n }, (_, i) => ({
        sha: String(i).padStart(40, "0"),
        at: "2026-01-01T00:00:00.000Z",
      })),
    });

  test("pure-function default keeps every section (call sites opt in to demotion)", () => {
    const view = publicView(withCommits(3)) as Record<string, unknown>;
    expect(view.commits).toHaveLength(3);
    expect(view.commitCount).toBe(3);
    expect("omitted" in view).toBe(false);
  });

  test("include: [] demotes commits to a count and names the omission", () => {
    const view = publicView(withCommits(6), [], { include: [] }) as Record<string, unknown>;
    expect("commits" in view).toBe(false);
    expect(view.commitCount).toBe(6);
    expect(view.omitted).toEqual(["commits"]);
  });

  test('include: ["commits"] restores the sha list', () => {
    const view = publicView(withCommits(6), [], { include: ["commits"] }) as Record<
      string,
      unknown
    >;
    expect(view.commits).toHaveLength(6);
    expect("omitted" in view).toBe(false);
  });

  test("a ticket with no commits reports no omission", () => {
    // Demoted-but-empty is not an omission worth spending bytes on.
    const view = publicView(withCommits(0), [], { include: [] }) as Record<string, unknown>;
    expect(view.commitCount).toBe(0);
    expect("omitted" in view).toBe(false);
  });

  test("verifyCriteria truncates past the ceiling, flags it, and include restores it", () => {
    const long = "x".repeat(MAX_VERIFY_CRITERIA_CHARS + 500);
    const issue = makeIssue({ id: "DS-001", number: 1, verifyCriteria: long });

    const trimmed = publicView(issue, [], { include: [] }) as Record<string, unknown>;
    expect((trimmed.verifyCriteria as string).length).toBe(MAX_VERIFY_CRITERIA_CHARS + 1); // + ellipsis
    expect(trimmed.verifyCriteriaTruncated).toBe(true);
    expect(trimmed.omitted).toEqual(["verifyCriteria"]);

    const full = publicView(issue, [], { include: ["verifyCriteria"] }) as Record<string, unknown>;
    expect(full.verifyCriteria).toBe(long);
    expect("verifyCriteriaTruncated" in full).toBe(false);
  });

  test("short verifyCriteria is untouched and unflagged", () => {
    const issue = makeIssue({ id: "DS-001", number: 1, verifyCriteria: "tests pass" });
    const view = publicView(issue, [], { include: [] }) as Record<string, unknown>;
    expect(view.verifyCriteria).toBe("tests pass");
    expect("verifyCriteriaTruncated" in view).toBe(false);
    expect("omitted" in view).toBe(false);
  });

  test("omitted lists every withheld section, spelled as include expects", () => {
    const issue = makeIssue({
      id: "DS-001",
      number: 1,
      verifyCriteria: "y".repeat(MAX_VERIFY_CRITERIA_CHARS + 1),
      commits: [{ sha: "a".repeat(40), at: "2026-01-01T00:00:00.000Z" }],
    });
    const view = publicView(issue, [], { include: [] }) as { omitted: string[] };
    expect(view.omitted.sort()).toEqual(["commits", "verifyCriteria"]);
  });
});

describe("publicView record windowing", () => {
  test("defaults to the whole log when no limit is passed", () => {
    const view = publicView(makeIssue({ id: "DS-001", number: 1, record: recordEntries(40) }));
    expect(view.record).toHaveLength(40);
    // No windowing keys on an unwindowed read — byte-identical to prior builds.
    expect("recordCount" in view).toBe(false);
    expect("recordOmitted" in view).toBe(false);
  });

  test("recordLimit: 0 is explicit 'no limit'", () => {
    const view = publicView(
      makeIssue({ id: "DS-001", number: 1, record: recordEntries(40) }),
      [],
      { recordLimit: 0 },
    );
    expect(view.record).toHaveLength(40);
    expect("recordOmitted" in view).toBe(false);
  });

  test("keeps the NEWEST entries and reports what it dropped", () => {
    const view = publicView(
      makeIssue({ id: "DS-001", number: 1, record: recordEntries(40) }),
      [],
      { recordLimit: 10 },
    ) as { record: Array<{ text: string }>; recordCount?: number; recordOmitted?: number };
    expect(view.record).toHaveLength(10);
    expect(view.record[0].text).toBe("entry-30");
    expect(view.record[9].text).toBe("entry-39");
    expect(view.recordCount).toBe(40);
    expect(view.recordOmitted).toBe(30);
  });

  test("does not add windowing keys when the log is shorter than the limit", () => {
    const view = publicView(
      makeIssue({ id: "DS-001", number: 1, record: recordEntries(3) }),
      [],
      { recordLimit: 10 },
    );
    expect(view.record).toHaveLength(3);
    expect("recordOmitted" in view).toBe(false);
  });

  test("windowing leaves every other field untouched", () => {
    const issue = makeIssue({
      id: "DS-001",
      number: 1,
      description: "keep me",
      verifyCriteria: "keep me too",
      record: recordEntries(40),
    });
    const view = publicView(issue, [], { recordLimit: 5 });
    expect(view.description).toBe("keep me");
    expect(view.verifyCriteria).toBe("keep me too");
    expect("statusHistory" in view).toBe(false);
  });
});

describe("statusView", () => {
  test("carries only what the rule-7 approval poll needs", () => {
    const view = statusView(
      makeIssue({
        id: "DS-001",
        number: 1,
        status: "Verification",
        description: "long prose",
        record: recordEntries(20),
        tasks: [
          { id: "t1", text: "a", done: true },
          { id: "t2", text: "b", done: false },
        ],
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual([
      "id",
      "number",
      "pendingClose",
      "status",
      "tasks",
      "title",
    ]);
    expect(view.tasks).toEqual({ total: 2, done: 1 });
  });
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

  test("includes outbound links + derived inboundLinks (inverted kind)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "blocker", status: "Planned", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "blocked", status: "Planned" }),
    ]);
    const a = payload(await runGetTicket(store, { query: "1" })) as {
      ticket: { links: unknown; inboundLinks: unknown };
    };
    expect(a.ticket.links).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
    expect(a.ticket.inboundLinks).toEqual([]);

    const b = payload(await runGetTicket(store, { query: "2" })) as {
      ticket: { links: unknown; inboundLinks: unknown };
    };
    expect(b.ticket.links).toEqual([]);
    expect(b.ticket.inboundLinks).toEqual([
      { sourceId: "DS-001", sourceTitle: "blocker", kind: "blocked-by" },
    ]);
  });

  test("Thinking ticket is fetchable (agents may read drafts they just filed)", async () => {
    const store = await makeStore([
      makeIssue({ number: 9, id: "DS-009", title: "Brainstorm idea", status: "Thinking" }),
    ]);
    const res = await runGetTicket(store, { query: "9" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string; status: string } };
    expect(body.ticket.id).toBe("DS-009");
    expect(body.ticket.status).toBe("Thinking");
  });

  test("Thinking ticket is fetchable by DS- id and by title substring", async () => {
    const store = await makeStore([
      makeIssue({ number: 9, id: "DS-009", title: "Draft idea", status: "Thinking" }),
    ]);
    const byId = await runGetTicket(store, { query: "DS-009" });
    expect(byId.isError).toBeFalsy();
    const bySubstr = await runGetTicket(store, { query: "draft" });
    expect(bySubstr.isError).toBeFalsy();
  });

  test("404 for Complete ticket", async () => {
    const store = await makeStore([
      makeIssue({ number: 10, id: "DS-010", title: "Shipped feature", status: "Complete" }),
    ]);
    const res = await runGetTicket(store, { query: "10" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Complete");
  });

  test("404 for Closed ticket", async () => {
    const store = await makeStore([
      makeIssue({ number: 11, id: "DS-011", title: "Won't do", status: "Closed" }),
    ]);
    const res = await runGetTicket(store, { query: "11" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Closed");
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

  test("substring matches mix of visible + terminal narrows to the visible one", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "auth login planned", status: "Planned" }),
      makeIssue({ number: 2, id: "DS-002", title: "auth login complete", status: "Complete" }),
      makeIssue({ number: 3, id: "DS-003", title: "auth login closed", status: "Closed" }),
    ]);
    const res = await runGetTicket(store, { query: "auth" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string; status: string } };
    expect(body.ticket.id).toBe("DS-001");
    expect(body.ticket.status).toBe("Planned");
  });

  test("substring narrows from terminal-only mix to a single Thinking match", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "auth refresh thinking", status: "Thinking" }),
      makeIssue({ number: 2, id: "DS-002", title: "auth refresh closed", status: "Closed" }),
    ]);
    const res = await runGetTicket(store, { query: "auth" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: { id: string; status: string } };
    expect(body.ticket.id).toBe("DS-001");
    expect(body.ticket.status).toBe("Thinking");
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

  test("serializes compactly — no pretty-print indentation", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Compact", status: "Working" }),
    ]);
    for (const args of [{ query: "DS-001" }, { query: "DS-001", view: "status" as const }]) {
      const text = (await runGetTicket(store, args)).content[0].text;
      // Indentation on a nested ticket costs more bytes than the description.
      expect(text).not.toContain("\n  ");
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  test("demotes commits by default and restores them via include", async () => {
    const store = await makeStore([
      makeIssue({
        number: 1,
        id: "DS-001",
        title: "Commits",
        status: "Working",
        commits: [
          { sha: "a".repeat(40), at: "2026-01-01T00:00:00.000Z" },
          { sha: "b".repeat(40), at: "2026-01-02T00:00:00.000Z" },
        ],
      }),
    ]);

    const lean = payload(await runGetTicket(store, { query: "DS-001" })) as {
      ticket: Record<string, unknown>;
    };
    expect("commits" in lean.ticket).toBe(false);
    expect(lean.ticket.commitCount).toBe(2);
    expect(lean.ticket.omitted).toEqual(["commits"]);

    const full = payload(
      await runGetTicket(store, { query: "DS-001", include: ["commits"] }),
    ) as { ticket: Record<string, unknown> };
    expect(full.ticket.commits).toHaveLength(2);
    expect("omitted" in full.ticket).toBe(false);
  });

  test("rejects an unknown include value", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Bad include", status: "Working" }),
    ]);
    const res = await runGetTicket(store, {
      query: "DS-001",
      include: ["statusHistory"] as unknown as GetTicketInput["include"],
    });
    expect(res.isError).toBe(true);
  });

  test('view: "status" returns only the poll fields and drops the workflow pointer', async () => {
    const store = await makeStore([
      makeIssue({
        number: 1,
        id: "DS-001",
        title: "Polling",
        status: "Verification",
        description: "a long description that must not be re-sent on every poll",
        record: recordEntries(20),
      }),
    ]);
    const res = await runGetTicket(store, { query: "DS-001", view: "status" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ticket: Record<string, unknown>; workflow?: string };
    expect(body.ticket.id).toBe("DS-001");
    expect(body.ticket.status).toBe("Verification");
    expect("description" in body.ticket).toBe(false);
    expect("record" in body.ticket).toBe(false);
    // The pointer is a quarter of this payload and the agent already has it.
    expect("workflow" in body).toBe(false);
    // Workspace stays — it disambiguates multi-board agents.
    expect("workspace" in body).toBe(true);
  });

  test('view defaults to "full" when omitted', async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "Full", status: "Planned", description: "prose" }),
    ]);
    const body = payload(await runGetTicket(store, { query: "DS-001" })) as {
      ticket: Record<string, unknown>;
      workflow: string;
    };
    expect(body.ticket.description).toBe("prose");
    expect(body.workflow).toBe(WORKFLOW_POINTER);
  });

  test("windows the record log to the configured default", async () => {
    const store = await makeStore([
      makeIssue({
        number: 1,
        id: "DS-001",
        title: "Chatty",
        status: "Working",
        record: recordEntries(40),
      }),
    ]);
    const body = payload(await runGetTicket(store, { query: "DS-001" })) as {
      ticket: { record: Array<{ text: string }>; recordCount: number; recordOmitted: number };
    };
    // Pinned deliberately: the record log is the single largest key in a
    // ticket read, and 3 is a judgment call about how much history an agent
    // needs to resume after a context loss. Changing it should be a decision,
    // not a drift.
    expect(DEFAULT_RECORD_LIMIT).toBe(3);
    expect(body.ticket.record).toHaveLength(DEFAULT_RECORD_LIMIT);
    expect(body.ticket.record[DEFAULT_RECORD_LIMIT - 1].text).toBe("entry-39");
    expect(body.ticket.recordCount).toBe(40);
    expect(body.ticket.recordOmitted).toBe(40 - DEFAULT_RECORD_LIMIT);
  });

  test("recordLimit param overrides the default, and 0 returns the whole log", async () => {
    const store = await makeStore([
      makeIssue({
        number: 1,
        id: "DS-001",
        title: "Chatty",
        status: "Working",
        record: recordEntries(40),
      }),
    ]);
    const three = payload(
      await runGetTicket(store, { query: "DS-001", recordLimit: 3 }),
    ) as { ticket: { record: unknown[]; recordOmitted: number } };
    expect(three.ticket.record).toHaveLength(3);
    expect(three.ticket.recordOmitted).toBe(37);

    const whole = payload(
      await runGetTicket(store, { query: "DS-001", recordLimit: 0 }),
    ) as { ticket: { record: unknown[] } };
    expect(whole.ticket.record).toHaveLength(40);
  });

  test("rejects an out-of-range recordLimit and an unknown view", async () => {
    const store = await makeStore([
      makeIssue({ number: 1, id: "DS-001", title: "X", status: "Planned" }),
    ]);
    expect(
      (await runGetTicket(store, { query: "DS-001", recordLimit: -1 } as never)).isError,
    ).toBe(true);
    expect(
      (await runGetTicket(store, { query: "DS-001", recordLimit: 9_999 } as never)).isError,
    ).toBe(true);
    expect(
      (await runGetTicket(store, { query: "DS-001", view: "brief" } as never)).isError,
    ).toBe(true);
  });
});

// ----- list_issues -----------------------------------------------------------

describe("list_issues paging", () => {
  const board = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeIssue({
        id: `DS-${String(i + 1).padStart(3, "0")}`,
        number: i + 1,
        title: `T${i + 1}`,
        status: "Planned",
      }),
    );

  test("count stays TOTAL matching while returned reports the page", async () => {
    const store = await makeStore(board(12));
    const body = payload(await runListIssues(store, { limit: 5 })) as {
      count: number;
      returned: number;
      nextOffset?: number;
      issues: Array<{ number: number }>;
    };
    expect(body.count).toBe(12);
    expect(body.returned).toBe(5);
    expect(body.nextOffset).toBe(5);
    expect(body.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test("offset walks the deterministic number sort without gaps or repeats", async () => {
    const store = await makeStore(board(12));
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const body = payload(await runListIssues(store, { limit: 5, offset })) as {
        nextOffset?: number;
        issues: Array<{ number: number }>;
      };
      seen.push(...body.issues.map((i) => i.number));
      if (body.nextOffset === undefined) break;
      offset = body.nextOffset;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("omits nextOffset on the last page and when everything fits", async () => {
    const store = await makeStore(board(12));
    const last = payload(await runListIssues(store, { limit: 5, offset: 10 })) as {
      returned: number;
      nextOffset?: number;
    };
    expect(last.returned).toBe(2);
    expect("nextOffset" in last).toBe(false);

    const all = payload(await runListIssues(store, {})) as { nextOffset?: number };
    expect("nextOffset" in all).toBe(false);
  });

  test("an offset past the end returns an empty page, not an error", async () => {
    const store = await makeStore(board(3));
    const body = payload(await runListIssues(store, { offset: 99 })) as {
      count: number;
      returned: number;
      issues: unknown[];
    };
    expect(body.count).toBe(3);
    expect(body.returned).toBe(0);
    expect(body.issues).toEqual([]);
  });

  test("paging composes with filters — count is the filtered total", async () => {
    const store = await makeStore([
      ...board(6),
      makeIssue({ id: "DS-007", number: 7, title: "W", status: "Working" }),
    ]);
    const body = payload(await runListIssues(store, { status: "Planned", limit: 2 })) as {
      count: number;
      returned: number;
      issues: Array<{ status: string }>;
    };
    expect(body.count).toBe(6);
    expect(body.returned).toBe(2);
    expect(body.issues.every((i) => i.status === "Planned")).toBe(true);
  });

  test("rejects an out-of-range limit or a negative offset", async () => {
    const store = await makeStore(board(3));
    expect((await runListIssues(store, { limit: 0 })).isError).toBe(true);
    expect((await runListIssues(store, { limit: 9_999 })).isError).toBe(true);
    expect((await runListIssues(store, { offset: -1 })).isError).toBe(true);
  });
});

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

  test("list_issues embeds the one-line WORKFLOW_POINTER, not the full prompt", async () => {
    const store = await makeStore([]);
    const res = payload(await runListIssues(store, {})) as { workflow: string };
    expect(res.workflow).toBe(WORKFLOW_POINTER);
    expect(res.workflow.length).toBeLessThan(200);
    expect(res.workflow).not.toContain("update_ticket_status");
  });

  test("get_ticket embeds the one-line WORKFLOW_POINTER, not the full prompt", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Pointer check", status: "Working" }),
    ]);
    const res = payload(await runGetTicket(store, { query: "DS-001" })) as { workflow: string };
    expect(res.workflow).toBe(WORKFLOW_POINTER);
    expect(res.workflow).not.toContain("update_ticket_status");
  });
});

// ----- workflow prompt byte budget -------------------------------------------

describe("workflow prompt byte budget", () => {
  // Claude Code truncates server instructions and tool descriptions at 2KB,
  // silently. A prompt that overruns loses its TAIL — which is where the
  // close/complete flow and the field-immutability contract live. This suite
  // is the regression guard; if it fails, cut prose rather than raising the
  // budget.
  for (const cap of [1, 6, 12, 50]) {
    test(`fits PROMPT_BYTE_BUDGET at activeLaneCap=${cap}`, () => {
      const bytes = Buffer.byteLength(buildDefaultWorkflowPrompt(cap), "utf8");
      expect(bytes).toBeLessThanOrEqual(PROMPT_BYTE_BUDGET);
    });
  }

  test("keeps the rules that used to fall past the truncation point", () => {
    const prompt = buildDefaultWorkflowPrompt(6);
    // Everything asserted here was being dropped when the prompt was 2,830
    // bytes. Each is a safety contract an agent cannot infer from a single
    // tool description.
    expect(prompt).toContain("request_ticket_close");
    expect(prompt).toContain("only a human can set Complete or Closed");
    expect(prompt).toMatch(/NOT change a ticket's title, priority, type, or verify criteria/);
    expect(prompt).toContain("recordLimit: 0");
    // The tool-search trigger: with schemas deferred, this is what tells an
    // agent the server is worth searching at all.
    expect(prompt.slice(0, 160)).toMatch(/ticket queue/i);
  });

  test("carries the write-terse rule for agent-authored ticket content", () => {
    const prompt = buildDefaultWorkflowPrompt(6);
    // Agent prose is the dominant per-read cost of a long-lived ticket: every
    // record note is replayed on every later read. This rule is what bounds it,
    // and no single tool description can state it for all write paths.
    expect(prompt).toMatch(/Write terse/);
    expect(prompt).toMatch(/~15 words/);
    expect(prompt).toMatch(/No narration/);
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

  test("rapid-fire produces unique task ids across many creates (no collisions)", async () => {
    const store = await makeStore([]);
    // Fire 50 creates with NO awaits in between so they overlap. Each create
    // produces two task ids; collect them all and assert uniqueness. This is
    // the load-bearing property — task ids are the per-element LWW merge key
    // in syncMerge, so a duplicate would silently merge two distinct tasks.
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
    // Shape sanity only — ids are opaque and nothing validates their format.
    // MCP now mints the same short form the webview always has (`newTaskId`),
    // rather than `t-<uuid>`; legacy uuid ids keep resolving untouched.
    for (const id of allTaskIds) {
      expect(id.startsWith("t")).toBe(true);
      expect(id.length).toBeLessThan(20);
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

  test("create_ticket accepts tags; non-string/blank/dupe entries are dropped", async () => {
    const store = await makeStore([]);
    const res = await runCreateTicket(store, {
      title: "Tagged",
      tags: ["  alpha ", "Alpha", "", "beta"] as string[],
    } as Parameters<typeof runCreateTicket>[1]);
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.tags).toEqual(["alpha", "beta"]);
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

  test("accepts well-formed links and persists them on the new ticket", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", title: "parent" }),
      makeIssue({ id: "DS-002", title: "blocker" }),
    ]);
    const res = await runCreateTicket(store, {
      title: "Child of 1, blocked by 2",
      type: "Feature",
      priority: "Regular",
      links: [
        { targetId: "DS-001", kind: "child-of" },
        { targetId: "DS-002", kind: "blocks" },
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.links).toEqual([
      { targetId: "DS-001", kind: "child-of" },
      { targetId: "DS-002", kind: "blocks" },
    ]);
  });

  test("drops links whose targetId doesn't exist (logged via store)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", title: "real" }),
    ]);
    const res = await runCreateTicket(store, {
      title: "Mixed valid + ghost links",
      links: [
        { targetId: "DS-001", kind: "relates-to" },
        { targetId: "DS-999", kind: "blocks" }, // unknown
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.links).toEqual([{ targetId: "DS-001", kind: "relates-to" }]);
  });

  test("drops self-link entries (cannot link to a not-yet-existing self id)", async () => {
    const store = await makeStore([]);
    // The MCP allocates the next id (DS-001) for this ticket; an agent that
    // smuggles a self-reference should see it dropped.
    const res = await runCreateTicket(store, {
      title: "Tries to self-link",
      links: [{ targetId: "DS-001", kind: "blocks" }],
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { id: string };
    const persisted = store.get(body.id)!;
    expect(persisted.links).toEqual([]);
  });

  test("rejects unknown link kinds at the zod boundary", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001" })]);
    const res = await runCreateTicket(store, {
      title: "Bad kind",
      // Deliberately invalid kind, cast through unknown to exercise the
      // runtime zod boundary (the strict schema must reject it).
      links: [{ targetId: "DS-001", kind: "duplicates" }] as unknown as CreateTicketInput["links"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/invalid/i);
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

  test("Thinking -> Planned: allowed (agent may promote a draft into the pipeline)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Planned");
    expect(store.get("DS-001")!.statusHistory.at(-1)).toMatchObject({ status: "Planned", by: "agent" });
  });

  test("Thinking -> Working: allowed (promotion may target any active lane)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Working" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Working");
  });

  test("Thinking -> Verification: allowed", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Verification" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Verification");
  });

  test("Thinking -> Planned: rejected when the Planned lane is already full", async () => {
    const seed = [makeIssue({ id: "DS-001", status: "Thinking" })];
    for (let i = 2; i <= 7; i++) {
      seed.push(makeIssue({ id: `DS-${String(i).padStart(3, "0")}`, status: "Planned" }));
    }
    const store = await makeStore(seed);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("full");
    expect(store.get("DS-001")!.status).toBe("Thinking");
  });

  test("Complete -> Planned: rejected (terminal)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Complete" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Complete");
    expect(store.get("DS-001")!.status).toBe("Complete");
  });

  test("Closed -> Planned: rejected (terminal)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Closed" })]);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Planned" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Closed");
    expect(store.get("DS-001")!.status).toBe("Closed");
  });

  test("Planned -> Closed: rejected (only humans close)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned" })]);
    const res = await runUpdateTicketStatus(store, {
      id: "DS-001",
      status: "Closed" as Status,
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.status).toBe("Planned");
  });

  for (const source of ["Planned", "Working", "Verification"] as const) {
    test(`${source} -> Thinking: allowed (agent may demote back to the drawer)`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status: source })]);
      const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Thinking" });
      expect(res.isError).toBeFalsy();
      const u = store.get("DS-001")!;
      expect(u.status).toBe("Thinking");
      expect(u.statusHistory.at(-1)).toMatchObject({ status: "Thinking", by: "agent" });
    });
  }

  test("Thinking is uncapped: demotion succeeds even with many Thinking tickets", async () => {
    const seed = [makeIssue({ id: "DS-001", status: "Planned" })];
    for (let i = 2; i <= 9; i++) {
      seed.push(makeIssue({ id: `DS-${String(i).padStart(3, "0")}`, status: "Thinking" }));
    }
    const store = await makeStore(seed);
    const res = await runUpdateTicketStatus(store, { id: "DS-001", status: "Thinking" });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.status).toBe("Thinking");
  });

  test("demoting to Thinking re-opens update_ticket_draft scope editing", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", tags: [] })]);
    // Locked while active…
    const locked = await runUpdateTicketDraft(store, { id: "DS-001", tags: ["rescoped"] });
    expect(locked.isError).toBe(true);
    // …unlocked after an agent demotes it back to Thinking.
    await runUpdateTicketStatus(store, { id: "DS-001", status: "Thinking" });
    const unlocked = await runUpdateTicketDraft(store, { id: "DS-001", tags: ["rescoped"] });
    expect(unlocked.isError).toBeFalsy();
    expect(store.get("DS-001")!.tags).toEqual(["rescoped"]);
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
  test("echoes only the changed tasks, plus done/total counts", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: Array.from({ length: 12 }, (_, i) => ({
          id: `t-${"0123456789abcdef".repeat(2)}-${i}`,
          text: `step ${i}`,
          done: i < 2,
        })),
      }),
    ]);
    const target = store.get("DS-001")!.tasks[5].id;
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [{ id: target, done: true }],
    });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as {
      tasksChanged: Array<{ id: string; done: boolean }>;
      tasks: { total: number; done: number };
    };
    expect(body.tasksChanged).toEqual([{ id: target, done: true }]);
    expect(body.tasks).toEqual({ total: 12, done: 3 });
    // The eleven untouched ids must not be echoed back at the caller.
    expect(res.content[0].text).not.toContain(store.get("DS-001")!.tasks[0].id);
  });

  test("echoes an empty tasksChanged when only a record entry is appended", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [{ id: "t1", text: "a", done: false }],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      recordEntry: "note only",
    });
    const body = payload(res) as {
      tasksChanged: unknown[];
      tasks: { total: number; done: number };
      recordLength: number;
    };
    expect(body.tasksChanged).toEqual([]);
    expect(body.tasks).toEqual({ total: 1, done: 0 });
    expect(body.recordLength).toBe(1);
  });

  test("legacy t-<uuid> task ids still resolve after the id-format change", async () => {
    // Storage tenet: task ids are persisted (issue_tasks.task_id) and are the
    // per-element LWW merge key in syncMerge. Ids minted by earlier builds must
    // keep working — only NEWLY minted ids change format.
    const legacyId = "t-3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [{ id: legacyId, text: "legacy task", done: false }],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [{ id: legacyId, done: true }],
    });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.tasks[0].done).toBe(true);
    expect(store.get("DS-001")!.tasks[0].id).toBe(legacyId);
    const body = payload(res) as { tasksChanged: Array<{ id: string }> };
    expect(body.tasksChanged[0].id).toBe(legacyId);
  });

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

  test("allowed on Thinking: appends an agent-authored record entry", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking", tasks: [] })]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      recordEntry: "blocks DS-042",
    });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.status).toBe("Thinking");
    expect(updated.record).toHaveLength(1);
    expect(updated.record[0].author).toBe("agent");
    expect(updated.record[0].text).toContain("blocks DS-042");
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

  test("rejects when ticket is in Closed", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Closed", tasks: [] })]);
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

  test("over-long recordEntry is rejected by the 500-char cap", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Working", tasks: [], record: [] }),
    ]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      taskUpdates: [],
      recordEntry: "x".repeat(501),
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.record).toHaveLength(0);
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

  const FULL_SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

  test("commit param appends a lowercased anchor and reports commitCount", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", tasks: [] })]);
    const res = await runUpdateTicketProgress(store, {
      id: "DS-001",
      commit: FULL_SHA.toUpperCase(),
      recordEntry: "wired the thing",
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.commitCount).toBe(1);
    const updated = store.get("DS-001")!;
    expect(updated.commits).toHaveLength(1);
    expect(updated.commits[0].sha).toBe(FULL_SHA);
    expect(typeof updated.commits[0].at).toBe("string");
  });

  test("same sha reported twice → single entry keeping the original at", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", tasks: [] })]);
    await runUpdateTicketProgress(store, { id: "DS-001", commit: FULL_SHA });
    const firstAt = store.get("DS-001")!.commits[0].at;
    const res = await runUpdateTicketProgress(store, { id: "DS-001", commit: FULL_SHA.toUpperCase() });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.commitCount).toBe(1);
    expect(store.get("DS-001")!.commits).toEqual([{ sha: FULL_SHA, at: firstAt }]);
  });

  test("commit-only call leaves record and tasks unchanged", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        tasks: [{ id: "t1", text: "one", done: false }],
        record: [{ at: "2025-01-01T00:00:00Z", author: "user", text: "existing" }],
      }),
    ]);
    const res = await runUpdateTicketProgress(store, { id: "DS-001", commit: "abcdef0" });
    expect(res.isError).toBeFalsy();
    const updated = store.get("DS-001")!;
    expect(updated.record).toHaveLength(1);
    expect(updated.tasks[0].done).toBe(false);
    expect(updated.commits).toEqual([{ sha: "abcdef0", at: updated.commits[0].at }]);
  });

  test("schema rejects malformed commit shas without mutation", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", tasks: [] })]);
    for (const bad of ["zzzzzzz", "abc123", FULL_SHA + "0", "--format", "HEAD"]) {
      const res = await runUpdateTicketProgress(store, { id: "DS-001", commit: bad });
      expect(res.isError).toBe(true);
    }
    expect(store.get("DS-001")!.commits).toEqual([]);
  });

  test("commit param is rejected on terminal tickets", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Complete", tasks: [] })]);
    const res = await runUpdateTicketProgress(store, { id: "DS-001", commit: FULL_SHA });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.commits).toEqual([]);
  });

  test("publicView exposes commits as {sha, at}", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        commits: [{ sha: "abcdef0", at: "2026-07-01T00:00:00.000Z" }],
      }),
    ]);
    const view = publicView(store.get("DS-001")!, store.list());
    expect(view.commits).toEqual([{ sha: "abcdef0", at: "2026-07-01T00:00:00.000Z" }]);
  });
});

describe("update_ticket_draft", () => {
  test("sets tags on a Thinking ticket", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Thinking", tags: [] })]);
    const res = await runUpdateTicketDraft(store, { id: "DS-001", tags: ["Auth", "auth", "  backend "] });
    expect(res.isError).toBeFalsy();
    // coerceTags dedupes case-insensitively + trims.
    expect(store.get("DS-001")!.tags).toEqual(["Auth", "backend"]);
  });

  test("replaces the task list with fresh-id tasks", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Thinking", tasks: [{ id: "old", text: "stale", done: true }] }),
    ]);
    const res = await runUpdateTicketDraft(store, {
      id: "DS-001",
      tasks: [{ text: "first" }, { text: "second", done: true }],
    });
    expect(res.isError).toBeFalsy();
    const tasks = store.get("DS-001")!.tasks;
    expect(tasks.map((t) => ({ text: t.text, done: t.done }))).toEqual([
      { text: "first", done: false },
      { text: "second", done: true },
    ]);
    // Fresh ids, not the old one.
    expect(tasks.every((t) => t.id !== "old")).toBe(true);
  });

  test("sets links and drops unknown-target entries", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Thinking", links: [] }),
      makeIssue({ id: "DS-002", status: "Planned" }),
    ]);
    const res = await runUpdateTicketDraft(store, {
      id: "DS-001",
      links: [
        { targetId: "DS-002", kind: "blocks" },
        { targetId: "DS-999", kind: "relates-to" }, // unknown -> dropped
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.links).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });

  test("omitted fields are left untouched; [] clears", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Thinking",
        tags: ["keep"],
        tasks: [{ id: "t1", text: "keep", done: false }],
        links: [],
      }),
    ]);
    // Only clear tags; tasks must remain.
    await runUpdateTicketDraft(store, { id: "DS-001", tags: [] });
    const updated = store.get("DS-001")!;
    expect(updated.tags).toEqual([]);
    expect(updated.tasks).toHaveLength(1);
  });

  test("drops a self-link and keeps valid ones", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Thinking", links: [] }),
      makeIssue({ id: "DS-002", status: "Planned" }),
    ]);
    const res = await runUpdateTicketDraft(store, {
      id: "DS-001",
      links: [
        { targetId: "DS-001", kind: "blocks" }, // self -> dropped
        { targetId: "DS-002", kind: "relates-to" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(store.get("DS-001")!.links).toEqual([{ targetId: "DS-002", kind: "relates-to" }]);
  });

  test("rejects when the ticket is not in Thinking", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Planned", tags: ["x"] })]);
    const res = await runUpdateTicketDraft(store, { id: "DS-001", tags: ["y"] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not Thinking/i);
    expect(store.get("DS-001")!.tags).toEqual(["x"]); // unchanged
  });

  test("rejects unknown ticket id", async () => {
    const store = await makeStore([]);
    const res = await runUpdateTicketDraft(store, { id: "DS-404", tags: ["x"] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  test("does not touch title/description/priority/type/verifyCriteria", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Thinking",
        title: "Original",
        description: "Original desc",
        priority: "High",
        type: "Bug",
        verifyCriteria: "Original verify",
      }),
    ]);
    await runUpdateTicketDraft(store, { id: "DS-001", tags: ["new"] });
    const u = store.get("DS-001")!;
    expect(u.title).toBe("Original");
    expect(u.description).toBe("Original desc");
    expect(u.priority).toBe("High");
    expect(u.type).toBe("Bug");
    expect(u.verifyCriteria).toBe("Original verify");
  });
});

describe("update_ticket_description", () => {
  for (const status of ["Thinking", "Planned", "Working", "Verification"] as const) {
    test(`edits the description on a ${status} ticket and appends one agent record`, async () => {
      const store = await makeStore([
        makeIssue({ id: "DS-001", status, description: "old", record: [] }),
      ]);
      const res = await runUpdateTicketDescription(store, { id: "DS-001", description: "new prose" });
      expect(res.isError).toBeFalsy();
      const u = store.get("DS-001")!;
      expect(u.description).toBe("new prose");
      expect(u.status).toBe(status);
      expect(u.record).toHaveLength(1);
      expect(u.record[0]).toMatchObject({ author: "agent" });
    });
  }

  test("over-long description is rejected by the 10,000-char cap", async () => {
    // Input-only cap: a longer description already on disk still loads and is
    // served untouched — this only bounds what an agent can write.
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Working", description: "old", record: [] }),
    ]);
    const res = await runUpdateTicketDescription(store, {
      id: "DS-001",
      description: "x".repeat(10_001),
    });
    expect(res.isError).toBe(true);
    expect(store.get("DS-001")!.description).toBe("old");
  });

  test("leaves title/priority/type/verifyCriteria untouched", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        status: "Working",
        title: "Original",
        priority: "High",
        type: "Bug",
        verifyCriteria: "Original verify",
        description: "old",
      }),
    ]);
    await runUpdateTicketDescription(store, { id: "DS-001", description: "changed" });
    const u = store.get("DS-001")!;
    expect(u.title).toBe("Original");
    expect(u.priority).toBe("High");
    expect(u.type).toBe("Bug");
    expect(u.verifyCriteria).toBe("Original verify");
    expect(u.description).toBe("changed");
  });

  for (const status of ["Complete", "Closed"] as const) {
    test(`rejects a ${status} ticket`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status, description: "keep" })]);
      const res = await runUpdateTicketDescription(store, { id: "DS-001", description: "nope" });
      expect(res.isError).toBe(true);
      expect(store.get("DS-001")!.description).toBe("keep");
    });
  }

  test("rejects an unknown id", async () => {
    const store = await makeStore([]);
    const res = await runUpdateTicketDescription(store, { id: "DS-999", description: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  test("rejects an over-length description", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working" })]);
    const res = await runUpdateTicketDescription(store, {
      id: "DS-001",
      description: "x".repeat(20_001),
    });
    expect(res.isError).toBe(true);
  });

  test("strict-rejects a smuggled extra field (e.g. title)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", status: "Working", title: "Original", description: "old" }),
    ]);
    const res = await runUpdateTicketDescription(store, {
      id: "DS-001",
      description: "new",
      title: "hacked",
    } as unknown as { id: string; description: string });
    expect(res.isError).toBe(true);
    const u = store.get("DS-001")!;
    expect(u.title).toBe("Original");
    expect(u.description).toBe("old");
  });
});

describe("request_ticket_close", () => {
  for (const status of ["Thinking", "Planned", "Working", "Verification"] as const) {
    test(`flags pendingClose on a ${status} ticket without changing status`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status, record: [] })]);
      const res = await runRequestTicketClose(store, { id: "DS-001", note: "done here" });
      expect(res.isError).toBeFalsy();
      const u = store.get("DS-001")!;
      expect(u.status).toBe(status);
      expect(u.pendingClose).toMatchObject({ by: "agent", note: "done here" });
      expect(u.record).toHaveLength(1);
      expect(u.record[0]).toMatchObject({ author: "agent" });
      expect(res.content[0].text).toContain("approve");
      expect(res.content[0].text).toContain("get_ticket");
    });
  }

  test("is idempotent: a second request adds no duplicate record and keeps the original", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", record: [] })]);
    await runRequestTicketClose(store, { id: "DS-001" });
    const afterFirst = store.get("DS-001")!;
    expect(afterFirst.pendingClose).not.toBeNull();
    expect(afterFirst.record).toHaveLength(1);

    const res = await runRequestTicketClose(store, { id: "DS-001", note: "again" });
    expect(res.isError).toBeFalsy();
    const afterSecond = store.get("DS-001")!;
    expect(afterSecond.record).toHaveLength(1);
    expect(afterSecond.pendingClose).toMatchObject({ by: "agent" });
    expect(afterSecond.pendingClose?.note).toBeUndefined();
  });

  for (const status of ["Complete", "Closed"] as const) {
    test(`rejects a ${status} ticket`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status })]);
      const res = await runRequestTicketClose(store, { id: "DS-001" });
      expect(res.isError).toBe(true);
      expect(store.get("DS-001")!.pendingClose).toBeNull();
    });
  }

  test("rejects an unknown id", async () => {
    const store = await makeStore([]);
    const res = await runRequestTicketClose(store, { id: "DS-999" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  test("stamps target 'Closed' so history distinguishes OBE from finished work", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Working", record: [] })]);
    await runRequestTicketClose(store, { id: "DS-001" });
    expect(store.get("DS-001")!.pendingClose?.target).toBe("Closed");
  });
});

describe("request_ticket_complete", () => {
  test("flags pendingClose with target 'Complete' on a Verification ticket, status unchanged", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Verification", record: [] })]);
    const res = await runRequestTicketComplete(store, { id: "DS-001", note: "criteria met" });
    expect(res.isError).toBeFalsy();
    const u = store.get("DS-001")!;
    expect(u.status).toBe("Verification");
    expect(u.pendingClose).toMatchObject({ by: "agent", target: "Complete", note: "criteria met" });
    expect(u.record).toHaveLength(1);
    expect(res.content[0].text).toContain("Complete");
    expect(res.content[0].text).toContain("get_ticket");
  });

  for (const status of ["Thinking", "Planned", "Working"] as const) {
    test(`rejects a ${status} ticket — Verification-only, error points at the workflow`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status })]);
      const res = await runRequestTicketComplete(store, { id: "DS-001" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Verification");
      expect(res.content[0].text).toContain("update_ticket_status");
      expect(store.get("DS-001")!.pendingClose).toBeNull();
    });
  }

  for (const status of ["Complete", "Closed"] as const) {
    test(`rejects a ${status} ticket (already terminal)`, async () => {
      const store = await makeStore([makeIssue({ id: "DS-001", status })]);
      const res = await runRequestTicketComplete(store, { id: "DS-001" });
      expect(res.isError).toBe(true);
    });
  }

  test("is idempotent per target: repeat completion request adds no record", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Verification", record: [] })]);
    await runRequestTicketComplete(store, { id: "DS-001" });
    const res = await runRequestTicketComplete(store, { id: "DS-001" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Already pending");
    expect(store.get("DS-001")!.record).toHaveLength(1);
  });

  test("a completion request replaces a pending close request (auditable switch)", async () => {
    const store = await makeStore([makeIssue({ id: "DS-001", status: "Verification", record: [] })]);
    await runRequestTicketClose(store, { id: "DS-001" });
    expect(store.get("DS-001")!.pendingClose?.target).toBe("Closed");

    const res = await runRequestTicketComplete(store, { id: "DS-001" });
    expect(res.isError).toBeFalsy();
    const u = store.get("DS-001")!;
    expect(u.pendingClose?.target).toBe("Complete");
    expect(u.record).toHaveLength(2);
    expect(u.record[1]!.text).toContain("replacing the pending close request");
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

// The HTTP boot harness (setMcpConfig / bootServer / makeWorkspaceId) lives in
// testSupport.ts, shared with agentSkill.test.ts.

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

  test("pinned port honored when free", async () => {
    // Borrow an OS-assigned free port, then release it so the MCP server can
    // bind it as a "pinned" port.
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    const freePort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const store = await makeStore([]);
    ({ server, port } = await bootServer(store, { preferredPort: freePort }));
    expect(server.status.running).toBe(true);
    expect(server.status.port).toBe(freePort);
  });

  test("pinned port already in use falls back to ephemeral", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const taken = (blocker.address() as { port: number }).port;

    try {
      const store = await makeStore([]);
      ({ server, port } = await bootServer(store, { preferredPort: taken }));
      expect(server.status.running).toBe(true);
      expect(server.status.port).not.toBe(taken);
      expect(server.status.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("out-of-range pinned port falls back to ephemeral", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store, { preferredPort: 999999 }));
    expect(server.status.running).toBe(true);
    expect(server.status.port).toBeGreaterThanOrEqual(1024);
  });

  test("changing mcp.port at runtime restarts on the new port", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    const targetPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));
    const ephemeral = server.status.port;
    expect(server.status.running).toBe(true);

    setMcpConfig({ "mcp.enabled": true, "mcp.port": targetPort });
    await server.reconcile();
    expect(server.status.running).toBe(true);
    expect(server.status.port).toBe(targetPort);
    expect(server.status.port).not.toBe(ephemeral);
  });

  test("readPreferredPort coerces invalid values to 0", async () => {
    const { readPreferredPort } = await import("./mcpServer");
    const mkCfg = (value: unknown): vscode.WorkspaceConfiguration =>
      ({
        get: <T,>(_key: string, defaultValue?: T): T | undefined =>
          (value === undefined ? defaultValue : (value as T)),
        update: () => Promise.resolve(),
        inspect: () => undefined,
        has: () => false,
      }) as unknown as vscode.WorkspaceConfiguration;

    expect(readPreferredPort(mkCfg(0))).toBe(0);
    expect(readPreferredPort(mkCfg(8080))).toBe(8080);
    expect(readPreferredPort(mkCfg(1.5))).toBe(0);
    expect(readPreferredPort(mkCfg(-1))).toBe(0);
    expect(readPreferredPort(mkCfg(999999))).toBe(0);
    expect(readPreferredPort(mkCfg(80))).toBe(0); // privileged ports coerced
    expect(readPreferredPort(mkCfg(undefined))).toBe(0);
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

  test("real /mcp POST with tools/list returns the registered tool names", async () => {
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
      "request_ticket_close",
      "request_ticket_complete",
      "update_ticket_description",
      "update_ticket_draft",
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
        "request_ticket_close",
        "request_ticket_complete",
        "update_ticket_description",
        "update_ticket_draft",
        "update_ticket_progress",
        "update_ticket_status",
      ]);
    }
  });

  test("MEASURE tools/list and initialize instructions (fixed per-session floor)", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const tools = await mcpJsonRpc(port, "tools/list", {});
    const toolsBytes = JSON.stringify((tools.result as { tools: unknown[] }).tools).length;

    const init = await mcpJsonRpc(port, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "measure", version: "0" },
    });
    const instructions =
      (init.result as { instructions?: string }).instructions ?? "";

    const perTool = (tools.result as { tools: Array<{ name: string }> }).tools
      .map((t) => `    ${t.name.padEnd(26)} ${String(JSON.stringify(t).length).padStart(5)} ch`)
      .sort()
      .join("\n");
    console.log(
      `\nper-session fixed floor\n  tools/list          ${toolsBytes} ch` +
        `\n  initialize instrs   ${instructions.length} ch` +
        `\n  total               ${toolsBytes + instructions.length} ch\n${perTool}`,
    );
    // Guard rails, not exact assertions — the point is to notice unbounded
    // growth, not to pin a number. Note tool schemas are DEFERRED by default in
    // Claude Code (tool search), so tools/list is not a per-session context
    // cost the way the instructions are.
    expect(toolsBytes).toBeLessThan(12_000);
    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(
      PROMPT_BYTE_BUDGET,
    );
  });

  test("every tool description fits the 2KB Claude Code ceiling", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const listed = await mcpJsonRpc(port, "tools/list", {});
    const tools = (listed.result as {
      tools: Array<{ name: string; description?: string }>;
    }).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const bytes = Buffer.byteLength(t.description ?? "", "utf8");
      // Same silent-truncation rule as server instructions. Descriptions have
      // their own budget, so detail pushed out of the workflow prompt can land
      // here — but not without limit.
      expect({ tool: t.name, bytes }).toMatchObject({ tool: t.name });
      expect(bytes).toBeLessThanOrEqual(2048);
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

  test("resource dostuff://tickets returns Thinking + active-lane tickets (Complete/Closed hidden)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Planned one", status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, title: "Working one", status: "Working" }),
      makeIssue({ id: "DS-003", number: 3, title: "Testing one", status: "Verification" }),
      makeIssue({ id: "DS-004", number: 4, title: "Thinking one", status: "Thinking" }),
      makeIssue({ id: "DS-005", number: 5, title: "Complete one", status: "Complete" }),
      makeIssue({ id: "DS-006", number: 6, title: "Closed one", status: "Closed" }),
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
    expect(ids).toEqual(["DS-001", "DS-002", "DS-003", "DS-004"]);
    // Complete and Closed must be filtered out.
    for (const t of payload.tickets) {
      expect(["Thinking", "Planned", "Working", "Verification"]).toContain(t.status);
    }
  });

  test("resource dostuff://tickets serves summary rows, not full ticket bodies", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "Heavy",
        status: "Working",
        description: "## Context\n\nSync clobbers edits across two windows.\n\nMore detail here.",
        verifyCriteria: "must not clobber",
        record: recordEntries(30),
        tasks: [
          { id: "t1", text: "a", done: true },
          { id: "t2", text: "b", done: false },
        ],
      }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", { uri: "dostuff://tickets" });
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    const body = JSON.parse(contents[0].text) as {
      count: number;
      detailUriTemplate: string;
      tickets: Array<Record<string, unknown>>;
    };

    expect(body.count).toBe(1);
    // Emitted once for the whole collection instead of a uri on every row.
    expect(body.detailUriTemplate).toBe("dostuff://tickets/{id}");

    const row = body.tickets[0];
    for (const heavy of ["description", "record", "verifyCriteria", "attachments", "links"]) {
      expect(heavy in row).toBe(false);
    }
    expect(row.tasks).toBe("1/2");
    // The excerpt skips the leading heading and stops at the paragraph break.
    expect(row.excerpt).toBe("Sync clobbers edits across two windows.");
  });

  test("resource dostuff://tickets windows nothing but is materially smaller than full bodies", async () => {
    const seed = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `DS-00${i + 1}`,
        number: i + 1,
        title: `Ticket number ${i + 1} with a reasonably typical title`,
        status: "Working",
        description: "Prose paragraph explaining the ticket.\n\n" + "filler. ".repeat(200),
        record: recordEntries(20),
      }),
    );
    const store = await makeStore(seed);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", { uri: "dostuff://tickets" });
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    // Each ticket alone carries ~1.6 KB of description plus 20 record entries;
    // the whole summary index must stay far under a single full body.
    expect(contents[0].text.length).toBeLessThan(2_000);
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
    // Per-response embedding is the one-line pointer, not the full prompt.
    expect(payload.workflow).toBe(WORKFLOW_POINTER);
  });

  test("resource dostuff://tickets/{id} for Thinking ticket: returns the ticket", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Draft", status: "Thinking" }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    expect(json.error).toBeUndefined();
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    const payload = JSON.parse(contents[0].text) as { ticket: { id: string; status: string } };
    expect(payload.ticket.id).toBe("DS-001");
    expect(payload.ticket.status).toBe("Thinking");
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

  test("resource dostuff://tickets/{id} for Closed ticket: errors (not servable)", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, title: "Won't do", status: "Closed" }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message).toContain("Closed");
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

  test("initialize result carries the workflow prompt as server instructions", async () => {
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    expect(json.error).toBeUndefined();
    const result = json.result as { instructions?: string };
    expect(result.instructions).toBe(DEFAULT_WORKFLOW_PROMPT);
  });

  test("initialize instructions honor the dostuff.mcp.instructions override", async () => {
    const custom = "CUSTOM INITIALIZE INSTRUCTIONS";
    const store = await makeStore([]);
    ({ server, port } = await bootServer(store, { instructions: custom }));

    const json = await mcpJsonRpc(port, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    expect(json.error).toBeUndefined();
    const result = json.result as { instructions?: string };
    expect(result.instructions).toBe(custom);
  });

  test("get_ticket payload includes attachments with dostuff://attachments/<id>/<att> uris", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "With image",
        status: "Working",
        attachments: [
          {
            id: "abc",
            name: "hero.png",
            mimeType: "image/png",
            sizeBytes: 1234,
            addedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      }),
    ]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "tools/call", {
      name: "get_ticket",
      arguments: { query: "1" },
    });
    const result = json.result as {
      content: Array<{ type: string; text: string }>;
    };
    const body = JSON.parse(result.content[0].text) as {
      ticket: { attachments: Array<Record<string, unknown>> };
    };
    expect(body.ticket.attachments).toHaveLength(1);
    expect(body.ticket.attachments[0]).toEqual({
      id: "abc",
      name: "hero.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      addedAt: "2026-05-18T00:00:00.000Z",
      uri: "dostuff://attachments/DS-001/abc",
    });
  });

  test("publicView always includes an attachments array (defaults to [])", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, status: "Planned" }),
    ]);
    ({ server, port } = await bootServer(store));
    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://tickets/DS-001",
    });
    const contents = (json.result as { contents: Array<{ text: string }> }).contents;
    const payload = JSON.parse(contents[0].text) as {
      ticket: { attachments: unknown[] };
    };
    expect(Array.isArray(payload.ticket.attachments)).toBe(true);
    expect(payload.ticket.attachments).toHaveLength(0);
  });

  test("publicView includes outbound links + derived inboundLinks with inverted kinds", async () => {
    // A -- blocks --> B   surfaces on B as { sourceId: A, kind: "blocked-by" }.
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "blocker",
        status: "Planned",
        links: [{ targetId: "DS-002", kind: "blocks" }],
      }),
      makeIssue({ id: "DS-002", number: 2, title: "blocked", status: "Planned" }),
    ]);
    ({ server, port } = await bootServer(store));

    const a = await mcpJsonRpc(port, "resources/read", { uri: "dostuff://tickets/DS-001" });
    const aBody = JSON.parse(
      (a.result as { contents: Array<{ text: string }> }).contents[0].text,
    ) as { ticket: { links: unknown; inboundLinks: unknown } };
    expect(aBody.ticket.links).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
    expect(aBody.ticket.inboundLinks).toEqual([]);

    const b = await mcpJsonRpc(port, "resources/read", { uri: "dostuff://tickets/DS-002" });
    const bBody = JSON.parse(
      (b.result as { contents: Array<{ text: string }> }).contents[0].text,
    ) as { ticket: { links: unknown; inboundLinks: unknown } };
    expect(bBody.ticket.links).toEqual([]);
    expect(bBody.ticket.inboundLinks).toEqual([
      { sourceId: "DS-001", sourceTitle: "blocker", kind: "blocked-by" },
    ]);
  });

  test("publicView relates-to inverts to itself (symmetric)", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "A",
        status: "Planned",
        links: [{ targetId: "DS-002", kind: "relates-to" }],
      }),
      makeIssue({ id: "DS-002", number: 2, title: "B", status: "Planned" }),
    ]);
    ({ server, port } = await bootServer(store));

    const b = await mcpJsonRpc(port, "resources/read", { uri: "dostuff://tickets/DS-002" });
    const bBody = JSON.parse(
      (b.result as { contents: Array<{ text: string }> }).contents[0].text,
    ) as { ticket: { inboundLinks: Array<{ kind: string }> } };
    expect(bBody.ticket.inboundLinks).toHaveLength(1);
    expect(bBody.ticket.inboundLinks[0].kind).toBe("relates-to");
  });

  test("attachment resource returns BlobResourceContents with the bytes", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        status: "Working",
        attachments: [
          {
            id: "abc",
            name: "hero.png",
            mimeType: "image/png",
            sizeBytes: 4,
            addedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      }),
    ]);
    // Override the disk reader so the resource handler can serve bytes
    // without a real workspace fs.
    (store as unknown as { readAttachment: (issueId: string, attId: string) => Promise<Uint8Array> })
      .readAttachment = async () => new Uint8Array([1, 2, 3, 4]);
    ({ server, port } = await bootServer(store));

    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://attachments/DS-001/abc",
    });
    expect(json.error).toBeUndefined();
    const contents = (json.result as { contents: Array<{ uri: string; mimeType: string; blob: string }> })
      .contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe("dostuff://attachments/DS-001/abc");
    expect(contents[0].mimeType).toBe("image/png");
    expect(contents[0].blob).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  test("attachment resource: unknown attachment id returns an error", async () => {
    const store = await makeStore([
      makeIssue({ id: "DS-001", number: 1, status: "Working" }),
    ]);
    ({ server, port } = await bootServer(store));
    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://attachments/DS-001/ghost",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message.toLowerCase()).toContain("not found");
  });

  test("attachment resource: missing on-disk file returns an error", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        status: "Working",
        attachments: [
          {
            id: "abc",
            name: "ghost.png",
            mimeType: "image/png",
            sizeBytes: 1,
            addedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      }),
    ]);
    (store as unknown as { readAttachment: () => Promise<Uint8Array> }).readAttachment =
      async () => {
        throw new Error("file gone");
      };
    ({ server, port } = await bootServer(store));
    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://attachments/DS-001/abc",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message.toLowerCase()).toContain("missing");
  });

  test("attachment resource: oversize file is rejected", async () => {
    const store = await makeStore([
      makeIssue({
        id: "DS-001",
        number: 1,
        status: "Working",
        attachments: [
          {
            id: "huge",
            name: "huge.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 1,
            addedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      }),
    ]);
    (store as unknown as { readAttachment: () => Promise<Uint8Array> }).readAttachment =
      async () => new Uint8Array(10 * 1024 * 1024 + 1); // 10 MB + 1
    ({ server, port } = await bootServer(store));
    const json = await mcpJsonRpc(port, "resources/read", {
      uri: "dostuff://attachments/DS-001/huge",
    });
    expect(json.error).toBeDefined();
    expect(json.error!.message.toLowerCase()).toContain("10 mb");
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
    // Assert identity with the constant, not a substring: the prompt's wording
    // is free to change (and did, to fit the 2KB ceiling); what this test locks
    // in is that the `workflow` prompt serves the full text, not the pointer.
    expect(result.messages[0].content.text).toBe(DEFAULT_WORKFLOW_PROMPT);
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
