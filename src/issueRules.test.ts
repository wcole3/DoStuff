// planIssueUpdate: the lane-cap-checked merge shared by the extension's
// applyIssueUpdate and the browser demo host.

import { describe, expect, test } from "bun:test";
import { planIssueUpdate } from "./issueRules";
import { toRow, type Issue } from "./types";
import { makeIssueFactory } from "./testSupport";

const makeIssue = makeIssueFactory();

function board(planned: number, extra: Issue[] = []): Issue[] {
  const lane = Array.from({ length: planned }, () => makeIssue({ status: "Planned" }));
  return [...lane, ...extra];
}

describe("planIssueUpdate", () => {
  test("rejects an unknown ticket id", () => {
    const res = planIssueUpdate(board(1), toRow(makeIssue({ id: "DS-999", number: 999 })), 6);
    expect(res).toEqual({ error: "No ticket with id DS-999." });
  });

  test("rejects a move into a full active lane", () => {
    const draft = makeIssue({ status: "Thinking" });
    const issues = board(6, [draft]);
    const res = planIssueUpdate(issues, { ...toRow(draft), status: "Planned" }, 6);
    expect("error" in res && res.error).toContain('Lane "Planned" is full (6/6)');
  });

  test("an in-place edit of a ticket already in a full lane is not blocked by the cap", () => {
    const issues = board(6);
    const target = issues[0]!;
    const res = planIssueUpdate(issues, { ...toRow(target), title: "Renamed" }, 6);
    expect("next" in res && res.next.title).toBe("Renamed");
  });

  test("honors the cap it is given", () => {
    const draft = makeIssue({ status: "Thinking" });
    const issues = board(2, [draft]);
    const moved = { ...toRow(draft), status: "Planned" as const };
    expect("error" in planIssueUpdate(issues, moved, 2)).toBe(true);
    expect("next" in planIssueUpdate(issues, moved, 3)).toBe(true);
  });

  test("a status change appends history; links to unknown tickets are dropped", () => {
    const draft = makeIssue({ status: "Thinking" });
    const other = makeIssue({ status: "Thinking" });
    const res = planIssueUpdate(
      [draft, other],
      {
        ...toRow(draft),
        status: "Working",
        links: [
          { targetId: other.id, kind: "blocks" },
          { targetId: "DS-404", kind: "blocks" },
        ],
      },
      6,
      () => "2026-01-01T00:00:00.000Z",
    );
    if (!("next" in res)) throw new Error(res.error);
    expect(res.next.links).toEqual([{ targetId: other.id, kind: "blocks" }]);
    expect(res.next.statusHistory.at(-1)).toEqual({
      status: "Working",
      at: "2026-01-01T00:00:00.000Z",
      by: "user",
    });
  });

  test("surfaces merge validation errors", () => {
    const draft = makeIssue({ status: "Thinking" });
    const res = planIssueUpdate([draft], { ...toRow(draft), status: "Nope" as never }, 6);
    expect("error" in res && res.error).toContain("Invalid status");
  });
});
