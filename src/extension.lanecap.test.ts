// Lane-cap chokepoint at the host level.
//
// The host applies two pure helpers to enforce the active-lane cap:
//   1. `mergeIssueUpdate` validates + reconstructs the issue from a webview
//      payload.
//   2. `canMoveToActiveLane` (from types.ts) checks the resulting set against
//      ACTIVE_LANE_CAP before the host commits the upsert.
// Tests here exercise the *composition* of those helpers so a future refactor
// can't accidentally drop one half.
//
// The import-time lane-cap check is the other chokepoint; it lives in the
// `dostuff.importJson` command handler. The pure helper it relies on
// (`activeLaneOverflow`) is exported for direct testing here. The full
// command-level flow (file dialog → JSON parse → user-pick mode → refusal
// dialog) is intentionally deferred to manual smoke testing — see
// SMOKE-TEST.md — because it requires VS Code's dialog API surface that
// the unit-test mock deliberately stubs out.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  activeLaneOverflow,
  mergeIssueUpdate,
  validateImportList,
} from "./extension";
import {
  ACTIVE_LANE_CAP,
  canMoveToActiveLane,
  type Issue,
  type IssueType,
  type Priority,
  type Status,
} from "./types";

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
    statusHistory:
      overrides.statusHistory ?? [{ status: overrides.status ?? "Planned", at, by: "user" }],
    record: overrides.record ?? [],
  };
}

beforeEach(() => {
  issueCounter = 0;
});

describe("lane-cap chokepoint composition (mergeIssueUpdate + canMoveToActiveLane)", () => {
  test("rejects a Thinking → Working move when Working lane is already at cap", () => {
    const others: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      others.push(makeIssue({ id: `DS-${String(i).padStart(3, "0")}`, status: "Working" }));
    }
    const candidate = makeIssue({ id: "DS-099", number: 99, status: "Thinking" });
    const allIssues = [...others, candidate];

    const merged = mergeIssueUpdate(candidate, { status: "Working" }, "user");
    expect("error" in merged).toBe(false);
    if ("error" in merged) return;
    const next = merged.next;

    const check = canMoveToActiveLane(allIssues, next.status, next.id);
    expect(typeof check).toBe("string");
    if (typeof check === "string") {
      expect(check).toContain("Working");
      expect(check).toContain(String(ACTIVE_LANE_CAP));
    }
  });

  test("permits an in-place save of an already-located ticket (movingIssueId excluded from count)", () => {
    // Working lane has ACTIVE_LANE_CAP tickets; one of them edits its title
    // without changing status. The composition must allow that.
    const allIssues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      allIssues.push(makeIssue({ id: `DS-${String(i).padStart(3, "0")}`, status: "Working" }));
    }

    const target = allIssues[0]!;
    const merged = mergeIssueUpdate(target, { title: "edited" }, "user");
    expect("error" in merged).toBe(false);
    if ("error" in merged) return;
    const next = merged.next;

    // status didn't change, but check anyway — the host calls this only on
    // status changes. Here we assert that *if* it were called, it'd pass,
    // because the moving id is excluded.
    expect(canMoveToActiveLane(allIssues, next.status, next.id)).toBe(true);
  });

  test("Thinking and Complete targets are never lane-capped", () => {
    const allIssues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      allIssues.push(makeIssue({ id: `DS-${String(i).padStart(3, "0")}`, status: "Working" }));
    }
    expect(canMoveToActiveLane(allIssues, "Thinking", "DS-999")).toBe(true);
    expect(canMoveToActiveLane(allIssues, "Complete", "DS-999")).toBe(true);
  });
});

describe("activeLaneOverflow (import-time helper)", () => {
  test("returns [] when every active lane is at-or-under cap", () => {
    const set: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      set.push(makeIssue({ id: `P-${i}`, number: i, status: "Planned" }));
    }
    expect(activeLaneOverflow(set)).toEqual([]);
  });

  test("returns the lane(s) that exceed cap with their counts", () => {
    const set: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP + 1; i++) {
      set.push(makeIssue({ id: `W-${i}`, number: i, status: "Working" }));
    }
    for (let i = 1; i <= ACTIVE_LANE_CAP + 2; i++) {
      set.push(makeIssue({
        id: `T-${i}`,
        number: 100 + i,
        status: "Verification",
      }));
    }
    const overflow = activeLaneOverflow(set);
    expect(overflow).toEqual(
      expect.arrayContaining([
        { lane: "Working", count: ACTIVE_LANE_CAP + 1 },
        { lane: "Verification", count: ACTIVE_LANE_CAP + 2 },
      ]),
    );
    // Planned is empty so it must not appear in overflow.
    expect(overflow.some((o) => o.lane === "Planned")).toBe(false);
  });

  test("ignores non-active lanes (Thinking, Complete) regardless of count", () => {
    const set: Issue[] = [];
    for (let i = 1; i <= 50; i++) {
      set.push(makeIssue({ id: `H-${i}`, number: i, status: "Thinking" }));
    }
    for (let i = 1; i <= 50; i++) {
      set.push(makeIssue({ id: `C-${i}`, number: 100 + i, status: "Complete" }));
    }
    expect(activeLaneOverflow(set)).toEqual([]);
  });
});

describe("validateImportList sanity (defense-in-depth at import boundary)", () => {
  test("drops entries missing required fields and reports the skipped count", () => {
    const raw: unknown[] = [
      // good
      {
        id: "DS-001",
        number: 1,
        title: "ok",
        type: "Bug",
        priority: "High",
        status: "Planned",
        description: "",
        verifyCriteria: "",
        tasks: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        resolvedAt: null,
        statusHistory: [],
        record: [],
      },
      // bad: missing id
      { title: "no id" },
      // bad: not an object
      "string",
      // bad: bad id shape
      { id: "x", title: "bad id" },
      // bad: missing title
      { id: "DS-002", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const { valid, skipped } = validateImportList(raw);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.id).toBe("DS-001");
    expect(skipped).toBe(4);
  });

  test("coerces unrecognised status/type/priority to safe defaults", () => {
    const raw: unknown[] = [
      {
        id: "DS-001",
        title: "x",
        createdAt: "2025-01-01T00:00:00.000Z",
        status: "Mystery",
        type: "Epic",
        priority: "Urgent",
      },
    ];
    const { valid } = validateImportList(raw);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.status).toBe("Thinking");
    expect(valid[0]!.type).toBe("Chore");
    expect(valid[0]!.priority).toBe("Regular");
  });
});
