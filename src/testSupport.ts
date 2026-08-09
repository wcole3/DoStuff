// Shared test fixtures. Not shipped: imported only by *.test.* files.
//
// `makeIssueFactory` is the one home for the full Issue field list — a schema
// addition is one edit here instead of a lockstep edit across every suite's
// private copy (the tax that motivated this module: adding guid/updatedAt/
// pendingClose meant touching seven near-identical factories).

import * as vscode from "vscode";
import { formatIssueId } from "./syncMerge";
import { IssueStore } from "./storage";
import { DEFAULT_RECORD_LIMIT, type McpConfig } from "./mcpHost";
import type { DoStuffMcpServer } from "./mcpServer";
import { ACTIVE_LANE_CAP, type Issue, type IssueType, type Priority, type Status } from "./types";

/**
 * Returns a fresh counter-backed `makeIssue`. Each suite creates its own so
 * default numbers/timestamps start from 1 per file regardless of how many
 * suites share the process. Defaults mirror the historical per-file factories
 * exactly: counter-derived number/id/createdAt, a seeded statusHistory entry,
 * and `guid-<id>` sync identity.
 *
 * (gitSync.test.ts keeps its own fixture on purpose — fixed deterministic
 * timestamps, required guid, no history seed.)
 */
export interface IssueFactory {
  (overrides?: Partial<Issue>): Issue;
  /** Restart default numbering — suites that assert counter-derived ids call this in beforeEach. */
  reset(): void;
}

export function makeIssueFactory(): IssueFactory {
  let counter = 0;
  const makeIssue = function makeIssue(overrides: Partial<Issue> = {}): Issue {
    counter += 1;
    const number = overrides.number ?? counter;
    const id = overrides.id ?? formatIssueId(number);
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
      links: overrides.links ?? [],
      pendingClose: overrides.pendingClose ?? null,
      guid: overrides.guid ?? `guid-${id}`,
      updatedAt: overrides.updatedAt ?? at,
      commits: overrides.commits ?? [],
    };
  } as IssueFactory;
  makeIssue.reset = () => {
    counter = 0;
  };
  return makeIssue;
}

// ----- MCP HTTP test harness -------------------------------------------------
// Shared by mcpServer.test.ts and agentSkill.test.ts: boot a real HTTP-backed
// MCP server against a mocked `dostuff.*` configuration. `./mcpServer` is
// imported lazily so suites that only want `makeIssueFactory` don't pay for
// the MCP SDK.

function makeMemento(): vscode.Memento {
  const map = new Map<string, unknown>();
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

export function makeTestContext(): vscode.ExtensionContext {
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

/** In-memory IssueStore (globalState-backed — no workspace folder in tests). */
export async function makeTestStore(seed: Issue[] = []): Promise<IssueStore> {
  const store = new IssueStore(makeTestContext());
  await store.init();
  for (const issue of seed) await store.upsert(issue);
  return store;
}

// Config stub for the MCP host seam. `setMcpConfig` replaces the whole value
// record (same wholesale semantics the old getConfiguration patch had);
// `testMcpConfigProvider` reads it live, so a test can flip `mcp.enabled` or
// `mcp.port` mid-flight and the next reconcile()/request sees it. Keys use the
// `dostuff.*` setting spellings so call sites read like the real settings.
let __mcpConfigValues: Record<string, unknown> = {};

export function setMcpConfig(values: Record<string, unknown>): void {
  __mcpConfigValues = { ...values };
}

export function restoreMcpConfig(): void {
  __mcpConfigValues = {};
}

export function testMcpConfigProvider(): McpConfig {
  const v = __mcpConfigValues;
  return {
    enabled: (v["mcp.enabled"] as boolean | undefined) ?? true,
    preferredPort: (v["mcp.port"] as number | undefined) ?? 0,
    instructions: v["mcp.instructions"] as string | undefined,
    activeLaneCap: (v["activeLaneCap"] as number | undefined) ?? ACTIVE_LANE_CAP,
    recordLimit: (v["mcp.recordLimit"] as number | undefined) ?? DEFAULT_RECORD_LIMIT,
  };
}

// Each booted server gets a distinct synthetic workspace path so registry
// entries don't collide across tests.
let __nextWs = 0;
export function makeWorkspaceId(): () => { path: string; name: string } {
  __nextWs += 1;
  const path = `/tmp/dostuff-test-ws-${process.pid}-${__nextWs}`;
  const n = __nextWs;
  return () => ({ path, name: `ws-${n}` });
}

export async function bootServer(
  store: IssueStore,
  opts: {
    enabled?: boolean;
    instructions?: string;
    workspaceId?: () => { path: string; name: string } | null;
    preferredPort?: number;
  } = {},
): Promise<{ server: DoStuffMcpServer; port: number }> {
  const cfg: Record<string, unknown> = { "mcp.enabled": opts.enabled ?? true };
  if (opts.instructions !== undefined) cfg["mcp.instructions"] = opts.instructions;
  if (opts.preferredPort !== undefined) cfg["mcp.port"] = opts.preferredPort;
  setMcpConfig(cfg);
  const { DoStuffMcpServer: ServerCtor } = await import("./mcpServer");
  const server = new ServerCtor(store, opts.workspaceId ?? makeWorkspaceId(), {
    config: testMcpConfigProvider,
  });
  await server.reconcile();
  return { server, port: server.status.port ?? 0 };
}
