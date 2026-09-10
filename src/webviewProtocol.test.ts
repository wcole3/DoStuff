// Tests for the store-change → webview-message translation shared by every
// provider: a reset re-sends the (row-projected) board, anything else is a
// small delta.

import { describe, expect, test } from "bun:test";
import { changeToMessage } from "./webviewProtocol";
import { makeIssueFactory } from "./testSupport";

const makeIssue = makeIssueFactory();

describe("changeToMessage", () => {
  test("a reset becomes a full `issues` message of rows", () => {
    const a = makeIssue({ id: "DS-001", record: [{ at: "2026-01-01T00:00:00.000Z", author: "user", text: "x" }] });
    const msg = changeToMessage({ issues: [a], upserted: [], removed: [], reset: true });
    expect(msg.type).toBe("issues");
    if (msg.type !== "issues") throw new Error("unreachable");
    expect(msg.issues).toHaveLength(1);
    expect("record" in msg.issues[0]!).toBe(false);
  });

  test("a mutation becomes an `issuesDelta` carrying only what changed", () => {
    const a = makeIssue({ id: "DS-001" });
    const b = makeIssue({ id: "DS-002" });
    const msg = changeToMessage({ issues: [a, b], upserted: [b], removed: ["DS-003"], reset: false });
    expect(msg.type).toBe("issuesDelta");
    if (msg.type !== "issuesDelta") throw new Error("unreachable");
    expect(msg.upserted.map((r) => r.id)).toEqual(["DS-002"]);
    expect(msg.removed).toEqual(["DS-003"]);
    expect("statusHistory" in msg.upserted[0]!).toBe(false);
  });
});
