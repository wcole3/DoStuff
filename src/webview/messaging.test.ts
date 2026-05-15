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
  useIssues,
  vscodeApi,
} from "./messaging";
import type { Issue } from "../types";
import {
  dispatchHost,
  installVsCodeApi,
  makeIssue,
  pushInit,
  pushIssues,
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
