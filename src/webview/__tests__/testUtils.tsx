// Shared utilities for webview component tests.
//
// Provides:
//   1. `makeIssue` — Issue factory mirroring the one in mcpServer.test.ts.
//   2. `installVsCodeApi` / `restoreVsCodeApi` — install a postMessage spy
//      on `window.acquireVsCodeApi` so messaging.ts has something to bind to.
//   3. `resetIssueStore` — clear and re-seed the singleton in messaging.ts
//      by dispatching synthetic `{type:"init"}` host messages.
//   4. `flushAsync` — wait one microtask + paint for React to commit.

import type { Issue, IssueType, Priority, Settings, Status, HostToWebview } from "../../types";
import { startMessageBridge } from "../messaging";
import { act } from "@testing-library/react";

let counter = 0;

export function resetCounter(): void {
  counter = 0;
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  counter += 1;
  const number = overrides.number ?? counter;
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
    links: overrides.links ?? [],
    pendingClose: overrides.pendingClose ?? null,
  };
}

interface PostedMessage {
  type: string;
  [k: string]: unknown;
}

export interface FakeVsCodeApi {
  posted: PostedMessage[];
  postMessage(msg: PostedMessage): void;
  getState(): unknown;
  setState(s: unknown): void;
}

// Window globals (__DOSTUFF_MODE__, __VSCODE_API__, acquireVsCodeApi) are
// declared in messaging.ts. We satisfy that shape with `FakeVsCodeApi` (the
// real `VsCodeApi` only types `postMessage(WebviewToHost)`; our fake widens
// it to record arbitrary PostedMessage, so we cast on assignment).

// messaging.ts caches the FIRST api object it resolves and reuses it for
// the lifetime of the module — so we keep a single singleton fake here and
// just clear its `posted[]` buffer between tests. Both `__VSCODE_API__`
// and `acquireVsCodeApi` point at the same instance.
const fakeApi: FakeVsCodeApi = {
  posted: [],
  postMessage(msg) {
    this.posted.push(msg);
  },
  getState: () => undefined,
  setState: () => undefined,
};

let bridgeBooted = false;
export function installVsCodeApi(): FakeVsCodeApi {
  fakeApi.posted.length = 0;
  window.__VSCODE_API__ = fakeApi as unknown as NonNullable<Window["__VSCODE_API__"]>;
  window.acquireVsCodeApi = (() => fakeApi) as unknown as NonNullable<Window["acquireVsCodeApi"]>;
  // The webview store only updates when the message bridge is listening.
  // Boot it once for the whole test run; subsequent calls are no-ops in
  // messaging.ts (it has its own `bridgeStarted` guard).
  if (!bridgeBooted) {
    startMessageBridge();
    bridgeBooted = true;
    // Discard the {type:"ready"} that startMessageBridge fires on mount.
    fakeApi.posted.length = 0;
  }
  return fakeApi;
}

export function restoreVsCodeApi(): void {
  fakeApi.posted.length = 0;
  // We deliberately KEEP __VSCODE_API__ + acquireVsCodeApi installed so
  // that messaging.ts's cachedApi stays bound across tests. Wiping them
  // would force a fresh resolveApi() that throws if hit too early.
}

const defaultSettings: Settings = {
  storagePath: ".vscode/dostuff",
  autoSave: true,
  activeLaneCap: 6,
  attachmentsBaseUri: null,
};

/**
 * Push an `init`-shaped message into the webview store. messaging.ts's
 * `startMessageBridge` listens to `window` 'message' events.
 *
 * Wrapped in `act` so React commits before the caller asserts.
 */
export function pushInit(issues: Issue[], settings: Settings = defaultSettings): void {
  act(() => {
    dispatchHostRaw({ type: "init", issues, settings });
  });
}

export function pushIssues(issues: Issue[]): void {
  act(() => {
    dispatchHostRaw({ type: "issues", issues });
  });
}

/** Bare dispatch — no act wrapper. Use for tests that aren't rendering. */
export function dispatchHost(msg: HostToWebview | { type: string; [k: string]: unknown }): void {
  dispatchHostRaw(msg);
}

function dispatchHostRaw(msg: unknown): void {
  // happy-dom's MessageEvent supports the `data` property.
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
