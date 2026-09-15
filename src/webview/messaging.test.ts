// Tests for the webview <-> host messaging module.
//
// Strategy: install a fake VSCode API on `window`, dispatch synthetic
// `message` events on `window`, and assert against the captured
// postMessage queue + the `useIssues` snapshot.

import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { renderHook, cleanup, act } from "@testing-library/react";
import {
  onHostMessage,
  postUpdateIssue,
  useIssueDetail,
  useIssues,
  vscodeApi,
} from "./messaging";
import { toRow, type Issue } from "../types";
import {
  dispatchHost,
  installVsCodeApi,
  makeIssue,
  pushInit,
  pushIssueDetail,
  pushIssues,
  pushIssuesDelta,
  resetCounter,
  restoreVsCodeApi,
  type FakeVsCodeApi,
} from "./__tests__/testUtils";

let api: FakeVsCodeApi;

beforeEach(() => {
  resetCounter();
  api = installVsCodeApi();
});

afterEach(() => {
  cleanup();
  restoreVsCodeApi();
});

describe("vscodeApi.postMessage", () => {
  test("delivers the envelope to the installed VSCode API", () => {
    const issue = makeIssue({ id: "DS-001", title: "Hello", status: "Planned" });
    postUpdateIssue(issue);
    expect(api.posted).toHaveLength(1);
    const sent = api.posted[0] as { type: string; issue: Issue };
    expect(sent.type).toBe("updateIssue");
    expect(sent.issue.id).toBe("DS-001");
    expect(sent.issue.title).toBe("Hello");
  });

  test("vscodeApi getter forwards through the cached api", () => {
    // Smoke: postMessage on the exported proxy lands in the fake.
    vscodeApi.postMessage({ type: "openBoard" });
    expect(api.posted.at(-1)).toEqual({ type: "openBoard" });
  });
});

describe("onHostMessage", () => {
  test("subscribes and unsubscribes correctly", () => {
    const calls: unknown[] = [];
    const unsubscribe = onHostMessage((msg) => calls.push(msg));

    dispatchHost({ type: "issues", issues: [] });
    expect(calls).toHaveLength(1);

    unsubscribe();
    dispatchHost({ type: "issues", issues: [] });
    expect(calls).toHaveLength(1); // no new delivery
  });
});

describe("useIssues store", () => {
  test("re-broadcasts an `issues` message into the hook snapshot", () => {
    const seedA = [makeIssue({ id: "DS-001", title: "first", status: "Planned" })];
    pushInit(seedA);

    const { result } = renderHook(() => useIssues());
    expect(result.current.issues.map((i) => i.id)).toEqual(["DS-001"]);
    expect(result.current.initialized).toBe(true);

    const seedB = [
      makeIssue({ id: "DS-002", title: "second", status: "Planned" }),
      makeIssue({ id: "DS-003", title: "third", status: "Working" }),
    ];
    act(() => {
      pushIssues(seedB);
    });
    expect(result.current.issues.map((i) => i.id)).toEqual(["DS-002", "DS-003"]);
  });
});

describe("unknown host message", () => {
  test("logs a warning via console.warn", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      dispatchHost({ type: "bogus-message-type", foo: 1 });
      expect(warn).toHaveBeenCalled();
      const args = warn.mock.calls.at(-1)!;
      expect(String(args[0])).toContain("[dostuff]");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("commitDetails bridge", () => {
  test("re-dispatches the host message as a dostuff:commitDetails CustomEvent", () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("dostuff:commitDetails", handler);
    try {
      const details = [{ sha: "abcdef0", found: true, subject: "s", files: ["a.ts"] }];
      dispatchHost({ type: "commitDetails", issueId: "DS-001", pathPrefix: ".", details });
      expect(seen).toEqual([{ issueId: "DS-001", pathPrefix: ".", details }]);
    } finally {
      window.removeEventListener("dostuff:commitDetails", handler);
    }
  });
});

describe("issuesDelta", () => {
  test("upserts, replaces and removes rows without a full list", () => {
    const a = makeIssue({ id: "DS-001", title: "a", status: "Planned" });
    const b = makeIssue({ id: "DS-002", title: "b", status: "Planned" });
    pushInit([a, b]);
    const { result } = renderHook(() => useIssues());
    pushIssuesDelta([toRow({ ...b, title: "b2" }), toRow(makeIssue({ id: "DS-003", title: "c" }))], ["DS-001"]);
    expect(result.current.issues.map((i) => `${i.id}:${i.title}`).sort()).toEqual(["DS-002:b2", "DS-003:c"]);
  });

  test("untouched rows keep their identity across a delta", () => {
    const a = makeIssue({ id: "DS-001", title: "a" });
    const b = makeIssue({ id: "DS-002", title: "b" });
    pushInit([a, b]);
    const { result } = renderHook(() => useIssues());
    const before = result.current.issues.find((i) => i.id === "DS-001");
    pushIssuesDelta([toRow({ ...b, title: "b2" })]);
    expect(result.current.issues.find((i) => i.id === "DS-001")).toBe(before);
  });
});

describe("useIssueDetail", () => {
  test("a row without the heavy fields triggers exactly one fetch, then resolves from issueDetail", () => {
    const full = makeIssue({ id: "DS-001", title: "a", record: [{ at: "2026-01-01T00:00:00.000Z", author: "user", text: "note" }] });
    const row = toRow(full);
    pushInit([row as Issue]);
    const { result, rerender } = renderHook(() => useIssueDetail(row));
    expect(result.current.loaded).toBe(false);
    expect(result.current.issue.record).toEqual([]);
    rerender();
    expect(api.posted.filter((p) => (p as { type: string }).type === "fetchIssueDetail")).toEqual([
      { type: "fetchIssueDetail", id: "DS-001" },
    ]);
    pushIssueDetail(full);
    expect(result.current.loaded).toBe(true);
    expect(result.current.issue.record).toHaveLength(1);
  });

  test("a delta for the open ticket keeps the stale detail visible and refetches", () => {
    const full = makeIssue({ id: "DS-001", title: "a", record: [{ at: "2026-01-01T00:00:00.000Z", author: "user", text: "note" }] });
    pushInit([toRow(full) as Issue]);
    const { result } = renderHook(() => useIssueDetail(toRow(full)));
    pushIssueDetail(full);
    api.posted.length = 0;
    pushIssuesDelta([toRow({ ...full, title: "a2" })]);
    expect(result.current.issue.record).toHaveLength(1); // stale body stays until the refresh lands
    expect(api.posted).toEqual([{ type: "fetchIssueDetail", id: "DS-001" }]);
  });

  test("a full Issue counts as loaded and never fetches", () => {
    const full = makeIssue({ id: "DS-001", title: "a" });
    pushInit([full]);
    const { result, rerender } = renderHook(() => useIssueDetail(full));
    rerender();
    expect(result.current.loaded).toBe(true);
    expect(api.posted).toEqual([]);
  });
});
