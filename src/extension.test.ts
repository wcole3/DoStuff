// Tests for `mergeIssueUpdate`, the pure merge function at the heart of the
// host's update chokepoint. Server-derived fields must never come from the
// `incoming` payload; status transitions must mint StatusEvent entries with
// the right `by` stamp; and resolvedAt must be managed only on transitions
// in or out of "Complete".

import { beforeEach, describe, expect, test } from "bun:test";
import { mergeIssueUpdate, type UpdateBy } from "./extension";
import type { Issue, IssueType, Priority, Status, StatusEvent } from "./types";

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

function ok<T extends { next: Issue } | { error: string }>(r: T): Issue {
  if ("error" in r) throw new Error(`expected success, got error: ${r.error}`);
  return r.next;
}

beforeEach(() => {
  issueCounter = 0;
});

describe("mergeIssueUpdate — field merging", () => {
  test("title edit on Working ticket leaves history and resolvedAt alone", () => {
    const prior = makeIssue({ status: "Working", title: "old" });
    const incoming: Partial<Issue> = { ...prior, title: "new title" };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.title).toBe("new title");
    expect(next.statusHistory).toBe(prior.statusHistory);
    expect(next.resolvedAt).toBe(prior.resolvedAt);
    expect(next.status).toBe("Working");
  });

  test("description, verifyCriteria, type, priority all merge from incoming", () => {
    const prior = makeIssue({
      status: "Planned",
      description: "old desc",
      verifyCriteria: "old vc",
      type: "Chore",
      priority: "Low",
    });
    const next = ok(
      mergeIssueUpdate(
        prior,
        {
          description: "new desc",
          verifyCriteria: "new vc",
          type: "Bug",
          priority: "Critical",
        },
        "user",
      ),
    );

    expect(next.description).toBe("new desc");
    expect(next.verifyCriteria).toBe("new vc");
    expect(next.type).toBe("Bug");
    expect(next.priority).toBe("Critical");
  });

  test("task list is replaced wholesale from incoming.tasks", () => {
    const prior = makeIssue({
      tasks: [
        { id: "t1", text: "old1", done: false },
        { id: "t2", text: "old2", done: true },
      ],
    });
    const replacement = [
      { id: "x", text: "new", done: false },
    ];
    const next = ok(mergeIssueUpdate(prior, { tasks: replacement }, "user"));

    expect(next.tasks).toEqual(replacement);
  });
});

describe("mergeIssueUpdate — status transitions", () => {
  test("Planned -> Working appends StatusEvent with supplied now() and by='user'", () => {
    const prior = makeIssue({ status: "Planned" });
    const now = () => "2025-06-01T12:00:00.000Z";
    const next = ok(mergeIssueUpdate(prior, { status: "Working" }, "user", now));

    expect(next.status).toBe("Working");
    expect(next.statusHistory).toHaveLength(prior.statusHistory.length + 1);
    const last = next.statusHistory.at(-1)!;
    expect(last).toEqual<StatusEvent>({
      status: "Working",
      at: "2025-06-01T12:00:00.000Z",
      by: "user",
    });
    expect(next.resolvedAt).toBeNull();
  });

  test("Status change to Complete stamps resolvedAt with now()", () => {
    const prior = makeIssue({ status: "Verification", resolvedAt: null });
    const now = () => "2025-07-04T00:00:00.000Z";
    const next = ok(mergeIssueUpdate(prior, { status: "Complete" }, "user", now));

    expect(next.status).toBe("Complete");
    expect(next.resolvedAt).toBe("2025-07-04T00:00:00.000Z");
    expect(next.statusHistory.at(-1)).toMatchObject({ status: "Complete", by: "user" });
  });

  test("Complete -> Working clears resolvedAt back to null", () => {
    const prior = makeIssue({
      status: "Complete",
      resolvedAt: "2025-01-01T00:00:00.000Z",
    });
    const next = ok(
      mergeIssueUpdate(prior, { status: "Working" }, "user", () => "2025-02-02T00:00:00.000Z"),
    );

    expect(next.status).toBe("Working");
    expect(next.resolvedAt).toBeNull();
    expect(next.statusHistory.at(-1)).toMatchObject({ status: "Working" });
  });

  test("by='agent' stamps the StatusEvent entry with by:'agent'", () => {
    const prior = makeIssue({ status: "Planned" });
    const next = ok(
      mergeIssueUpdate(prior, { status: "Working" }, "agent", () => "2025-03-03T00:00:00.000Z"),
    );

    expect(next.statusHistory.at(-1)).toEqual<StatusEvent>({
      status: "Working",
      at: "2025-03-03T00:00:00.000Z",
      by: "agent",
    });
  });

  test("same-status no-op does not append a StatusEvent", () => {
    const prior = makeIssue({ status: "Working" });
    const next = ok(
      mergeIssueUpdate(prior, { status: "Working", title: "renamed" }, "user", () => "ignored"),
    );

    expect(next.statusHistory).toBe(prior.statusHistory);
    expect(next.title).toBe("renamed");
    expect(next.resolvedAt).toBe(prior.resolvedAt);
  });

  test("now() is called exactly once on a status change, never on a no-change", () => {
    const prior = makeIssue({ status: "Planned" });
    let calls = 0;
    const now = () => {
      calls += 1;
      return "2025-04-04T00:00:00.000Z";
    };

    ok(mergeIssueUpdate(prior, { status: "Working" }, "user", now));
    expect(calls).toBe(1);

    ok(mergeIssueUpdate(prior, { title: "x" }, "user", now));
    expect(calls).toBe(1);
  });
});

describe("mergeIssueUpdate — validation", () => {
  test("invalid status enum returns error and prior is untouched", () => {
    const prior = makeIssue({ status: "Planned" });
    const res = mergeIssueUpdate(prior, { status: "Done" as unknown as Status }, "user");
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toContain("Invalid status");
      expect(res.error).toContain("Done");
    }
  });

  test("invalid priority enum returns error", () => {
    const prior = makeIssue({ status: "Planned" });
    const res = mergeIssueUpdate(
      prior,
      { priority: "Urgent" as unknown as Priority },
      "user",
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("Invalid priority");
  });

  test("invalid type enum returns error", () => {
    const prior = makeIssue({ status: "Planned" });
    const res = mergeIssueUpdate(
      prior,
      { type: "Epic" as unknown as IssueType },
      "user",
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("Invalid type");
  });
});

describe("mergeIssueUpdate — server-derived fields are ignored", () => {
  test("incoming.statusHistory is ignored even when supplied", () => {
    const prior = makeIssue({ status: "Working" });
    const incoming: Partial<Issue> = {
      title: "edited title",
      // status NOT changing, but caller smuggles a forged history entry
      statusHistory: [
        { status: "Complete", at: "forged", by: "agent" },
      ],
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.statusHistory).toBe(prior.statusHistory);
    expect(next.statusHistory).toEqual(prior.statusHistory);
  });

  test("incoming.resolvedAt is ignored when status is unchanged", () => {
    const prior = makeIssue({ status: "Working", resolvedAt: null });
    const incoming: Partial<Issue> = {
      title: "edit",
      resolvedAt: "2020-01-01T00:00:00.000Z",
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.resolvedAt).toBe(prior.resolvedAt);
    expect(next.resolvedAt).toBeNull();
  });

  test("incoming.id / number / createdAt / record are all ignored", () => {
    const prior = makeIssue({
      id: "DS-007",
      number: 7,
      createdAt: "2025-01-07T00:00:00.000Z",
      record: [{ at: "2025-01-08T00:00:00.000Z", author: "user", text: "original" }],
    });
    const incoming: Partial<Issue> = {
      id: "DS-999",
      number: 999,
      createdAt: "1970-01-01T00:00:00.000Z",
      record: [{ at: "forged", author: "agent", text: "smuggled" }],
      title: "renamed",
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.id).toBe(prior.id);
    expect(next.number).toBe(prior.number);
    expect(next.createdAt).toBe(prior.createdAt);
    expect(next.record).toBe(prior.record);
    expect(next.title).toBe("renamed");
  });
});
