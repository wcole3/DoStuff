// Tests for `mergeIssueUpdate`, the pure merge function at the heart of the
// host's update chokepoint. Server-derived fields must never come from the
// `incoming` payload; status transitions must mint StatusEvent entries with
// the right `by` stamp; and resolvedAt must be managed only on transitions
// in or out of "Complete".

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clampSyncInterval,
  mergeIssueUpdate,
  resolveCloseRequest,
  validateImportList,
  validateLinks,
  type UpdateBy,
} from "./extension";
import { deriveGuid } from "./syncMerge";
import type { Issue, IssueType, Priority, Status, StatusEvent, TicketLink } from "./types";
import { makeIssueFactory } from "./testSupport";

const makeIssue = makeIssueFactory();

function ok<T extends { next: Issue } | { error: string }>(r: T): Issue {
  if ("error" in r) throw new Error(`expected success, got error: ${r.error}`);
  return r.next;
}

beforeEach(() => {
  makeIssue.reset();
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

  test("incoming.pendingClose is ignored; prior.pendingClose survives a normal edit", () => {
    const prior = makeIssue({
      status: "Working",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", note: "keep" },
    });
    const incoming: Partial<Issue> = {
      title: "edit",
      // A stale/hostile webview payload forging a clear must be ignored:
      // pendingClose is preserved via `...prior`, never taken from `incoming`.
      pendingClose: null,
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.pendingClose).toBe(prior.pendingClose);
    expect(next.pendingClose).toEqual({ by: "agent", at: "2026-05-18T00:00:00.000Z", note: "keep" });
    // No status move, so the auto-resolve never fires and no record is appended.
    expect(next.record).toBe(prior.record);
    expect(next.title).toBe("edit");
  });

  test("incoming.guid/updatedAt are ignored; prior values survive a normal edit", () => {
    const prior = makeIssue({
      status: "Working",
      guid: "real-guid",
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
    const incoming: Partial<Issue> = {
      title: "edit",
      // Forged sync identity/ordering from a stale/hostile webview payload
      // must be ignored — both come from `...prior` by construction (and
      // `IssueStore.upsert` then restamps `updatedAt` server-side).
      guid: "forged-guid",
      updatedAt: "2099-01-01T00:00:00.000Z",
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.guid).toBe("real-guid");
    expect(next.updatedAt).toBe("2026-05-18T00:00:00.000Z");
    expect(next.title).toBe("edit");
  });

  test("incoming.commits is ignored; prior.commits survive a normal edit", () => {
    const prior = makeIssue({
      status: "Working",
      commits: [{ sha: "abcdef0", at: "2026-07-01T00:00:00.000Z" }],
    });
    const incoming: Partial<Issue> = {
      title: "edit",
      // The webview must not be able to forge or clear commit anchors —
      // only MCP update_ticket_progress appends them.
      commits: [{ sha: "0000000", at: "2026-07-02T00:00:00.000Z" }],
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));

    expect(next.commits).toBe(prior.commits);
    expect(next.commits).toEqual([{ sha: "abcdef0", at: "2026-07-01T00:00:00.000Z" }]);
    expect(next.title).toBe("edit");
  });
});

describe("mergeIssueUpdate — pending request auto-resolution", () => {
  const NOW = () => "2026-06-01T00:00:00.000Z";

  test("Verification -> Complete consumes a pending completion request", () => {
    const prior = makeIssue({
      status: "Verification",
      resolvedAt: null,
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Complete" }, "user", NOW));

    expect(next.status).toBe("Complete");
    expect(next.pendingClose).toBeNull();
    expect(next.resolvedAt).toBe(NOW());
    expect(next.record.at(-1)).toEqual({
      at: NOW(),
      author: "user",
      text: "Completion request approved by move to Complete",
    });
    expect(next.statusHistory.at(-1)).toEqual({ status: "Complete", at: NOW(), by: "user" });
  });

  test("move to Closed consumes a legacy target-less request (absent target means Closed)", () => {
    const prior = makeIssue({
      status: "Working",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", note: "obe" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Closed" }, "user", NOW));

    expect(next.status).toBe("Closed");
    expect(next.pendingClose).toBeNull();
    expect(next.record.at(-1)).toMatchObject({
      author: "user",
      text: "Close request approved by move to Closed",
    });
    // Closed is "won't do" — acceptance is never stamped.
    expect(next.resolvedAt).toBe(prior.resolvedAt);
  });

  test("mismatch: move to Closed leaves a pending completion request alone", () => {
    const prior = makeIssue({
      status: "Working",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Closed" }, "user", NOW));

    expect(next.status).toBe("Closed");
    expect(next.pendingClose).toBe(prior.pendingClose);
    expect(next.record).toBe(prior.record);
  });

  test("mismatch: move to Complete leaves a pending close (OBE) request alone", () => {
    const prior = makeIssue({
      status: "Verification",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Closed" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Complete" }, "user", NOW));

    expect(next.status).toBe("Complete");
    expect(next.pendingClose).toBe(prior.pendingClose);
    expect(next.record).toBe(prior.record);
  });

  test("a non-terminal move never consumes a pending request", () => {
    const prior = makeIssue({
      status: "Thinking",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Working" }, "user", NOW));

    expect(next.status).toBe("Working");
    expect(next.pendingClose).toBe(prior.pendingClose);
    expect(next.record).toBe(prior.record);
  });

  test("an agent-authored move never consumes a pending request", () => {
    const prior = makeIssue({
      status: "Verification",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = ok(mergeIssueUpdate(prior, { status: "Complete" }, "agent", NOW));

    expect(next.pendingClose).toBe(prior.pendingClose);
    expect(next.record).toBe(prior.record);
  });

  test("nothing pending: a plain move to Complete appends no record entry", () => {
    const prior = makeIssue({ status: "Verification", pendingClose: null });
    const next = ok(mergeIssueUpdate(prior, { status: "Complete" }, "user", NOW));

    expect(next.pendingClose).toBeNull();
    expect(next.record).toBe(prior.record);
    expect(next.resolvedAt).toBe(NOW());
  });
});

describe("resolveCloseRequest", () => {
  const NOW = () => "2026-06-01T00:00:00.000Z";

  test("approve moves the ticket to Closed, clears the flag, appends user history + record", () => {
    const prior = makeIssue({
      status: "Working",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z" },
    });
    const next = resolveCloseRequest(prior, "approve", NOW);
    expect(next).not.toBeNull();
    expect(next!.status).toBe("Closed");
    expect(next!.pendingClose).toBeNull();
    expect(next!.statusHistory.at(-1)).toEqual({ status: "Closed", at: NOW(), by: "user" });
    expect(next!.record.at(-1)).toMatchObject({ author: "user", text: "Close request approved" });
    // Closed is "won't do" — never stamps acceptance.
    expect(next!.resolvedAt).toBe(prior.resolvedAt);
  });

  test("approve with target 'Complete' moves to Complete, stamps resolvedAt, records acceptance", () => {
    const prior = makeIssue({
      status: "Verification",
      resolvedAt: null,
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = resolveCloseRequest(prior, "approve", NOW);
    expect(next).not.toBeNull();
    expect(next!.status).toBe("Complete");
    expect(next!.resolvedAt).toBe(NOW());
    expect(next!.pendingClose).toBeNull();
    expect(next!.statusHistory.at(-1)).toEqual({ status: "Complete", at: NOW(), by: "user" });
    expect(next!.record.at(-1)).toMatchObject({ author: "user", text: "Completion request approved" });
  });

  test("deny of a completion request records the completion wording, status unchanged", () => {
    const prior = makeIssue({
      status: "Verification",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", target: "Complete" },
    });
    const next = resolveCloseRequest(prior, "deny", NOW);
    expect(next!.status).toBe("Verification");
    expect(next!.pendingClose).toBeNull();
    expect(next!.record.at(-1)).toMatchObject({ text: "Completion request denied" });
  });

  test("deny clears the flag, leaves status + history unchanged, appends a user record", () => {
    const prior = makeIssue({
      status: "Verification",
      pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z" },
    });
    const next = resolveCloseRequest(prior, "deny", NOW);
    expect(next).not.toBeNull();
    expect(next!.status).toBe("Verification");
    expect(next!.pendingClose).toBeNull();
    expect(next!.statusHistory).toBe(prior.statusHistory);
    expect(next!.record.at(-1)).toMatchObject({ author: "user" });
  });

  test("returns null when there is nothing pending to resolve", () => {
    const prior = makeIssue({ status: "Working", pendingClose: null });
    expect(resolveCloseRequest(prior, "approve", NOW)).toBeNull();
    expect(resolveCloseRequest(prior, "deny", NOW)).toBeNull();
  });
});

describe("validateImportList — pendingClose", () => {
  test("defaults a missing pendingClose to null and coerces a malformed one", () => {
    const { valid } = validateImportList([
      { id: "DS-001", title: "a", createdAt: "2025-01-01T00:00:00.000Z" },
      {
        id: "DS-002",
        title: "b",
        createdAt: "2025-01-01T00:00:00.000Z",
        pendingClose: { by: "agent", at: "2026-05-18T00:00:00.000Z", note: "n" },
      },
      {
        id: "DS-003",
        title: "c",
        createdAt: "2025-01-01T00:00:00.000Z",
        pendingClose: { by: "user", at: "bad" },
      },
    ]);
    const byId = new Map(valid.map((i) => [i.id, i]));
    expect(byId.get("DS-001")?.pendingClose).toBeNull();
    expect(byId.get("DS-002")?.pendingClose).toEqual({
      by: "agent",
      at: "2026-05-18T00:00:00.000Z",
      note: "n",
    });
    expect(byId.get("DS-003")?.pendingClose).toBeNull();
  });
});

describe("validateImportList — commits", () => {
  test("round-trips valid commits, drops garbage, defaults missing to []", () => {
    const { valid } = validateImportList([
      { id: "DS-001", title: "no commits", createdAt: "2025-01-01T00:00:00.000Z" },
      {
        id: "DS-002",
        title: "with commits",
        createdAt: "2025-01-01T00:00:00.000Z",
        commits: [
          { sha: "ABCDEF0", at: "2026-07-01T00:00:00.000Z" }, // lowercased
          { sha: "nothex", at: "2026-07-01T00:00:00.000Z" }, // dropped
          { sha: "abcdef1", at: "garbage" }, // dropped
        ],
      },
      { id: "DS-003", title: "garbage shape", createdAt: "2025-01-01T00:00:00.000Z", commits: "nope" },
    ]);
    const byId = new Map(valid.map((i) => [i.id, i]));
    expect(byId.get("DS-001")?.commits).toEqual([]);
    expect(byId.get("DS-002")?.commits).toEqual([{ sha: "abcdef0", at: "2026-07-01T00:00:00.000Z" }]);
    expect(byId.get("DS-003")?.commits).toEqual([]);
  });
});

describe("validateImportList — sync fields (guid / updatedAt / tasks[].updatedAt)", () => {
  test("keeps well-formed provided values and derives missing ones", () => {
    const { valid } = validateImportList([
      {
        id: "DS-001",
        title: "provided",
        createdAt: "2025-01-01T00:00:00.000Z",
        guid: "kept-guid",
        updatedAt: "2025-06-01T00:00:00.000Z",
        tasks: [{ id: "t1", text: "kept", done: false, updatedAt: "2025-05-01T00:00:00.000Z" }],
      },
      {
        id: "DS-002",
        title: "missing",
        createdAt: "2025-02-01T00:00:00.000Z",
        tasks: [{ id: "t2", text: "bare", done: true, updatedAt: "garbage" }],
      },
    ]);
    const byId = new Map(valid.map((i) => [i.id, i]));
    expect(byId.get("DS-001")?.guid).toBe("kept-guid");
    expect(byId.get("DS-001")?.updatedAt).toBe("2025-06-01T00:00:00.000Z");
    expect(byId.get("DS-001")?.tasks[0]?.updatedAt).toBe("2025-05-01T00:00:00.000Z");
    expect(byId.get("DS-002")?.guid).toBe(deriveGuid("DS-002", "2025-02-01T00:00:00.000Z"));
    expect(byId.get("DS-002")?.updatedAt).toBe("2025-02-01T00:00:00.000Z");
    expect(byId.get("DS-002")?.tasks[0]).toEqual({ id: "t2", text: "bare", done: true });
  });

  test("path-hardening: hostile guid is re-derived; unsafe attachment/task ids are dropped", () => {
    const { valid } = validateImportList([
      {
        id: "DS-001",
        title: "hostile import",
        createdAt: "2025-01-01T00:00:00.000Z",
        // Guids name attachment dirs in the sync ref tree; a path-shaped one
        // must not survive an import.
        guid: "../../escape",
        attachments: [
          { id: "att-ok", name: "a.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2025-01-01T00:00:00.000Z" },
          { id: "../evil", name: "b.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2025-01-01T00:00:00.000Z" },
        ],
        tasks: [
          { id: "t-ok", text: "kept", done: false },
          { id: "../../up", text: "dropped", done: false },
          { id: 42, text: "not-a-string-id", done: false },
        ],
      },
    ]);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.guid).toBe(deriveGuid("DS-001", "2025-01-01T00:00:00.000Z"));
    expect(valid[0]!.attachments.map((a) => a.id)).toEqual(["att-ok"]);
    expect(valid[0]!.tasks.map((t) => t.id)).toEqual(["t-ok"]);
  });
});

describe("clampSyncInterval", () => {
  test("declared min/max are enforced in code, not just the settings UI", () => {
    expect(clampSyncInterval(5)).toBe(5);
    expect(clampSyncInterval(0)).toBe(0); // manual-only stays manual-only
    expect(clampSyncInterval(-3)).toBe(0);
    expect(clampSyncInterval(0.001)).toBe(1); // no 60ms network sync storms
    expect(clampSyncInterval(9999)).toBe(120);
    expect(clampSyncInterval(Number.NaN)).toBe(5);
    expect(clampSyncInterval("7" as unknown)).toBe(5);
  });
});

describe("mergeIssueUpdate attachments allow-list", () => {
  test("incoming.attachments adding a new id is dropped (webview can't mint attachments)", () => {
    const prior = makeIssue({
      attachments: [
        {
          id: "a1",
          name: "exists.png",
          mimeType: "image/png",
          sizeBytes: 10,
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    const incoming: Partial<Issue> = {
      attachments: [
        prior.attachments[0]!,
        {
          id: "smuggled",
          name: "evil.png",
          mimeType: "image/png",
          sizeBytes: 999,
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));
    expect(next.attachments).toHaveLength(1);
    expect(next.attachments[0]!.id).toBe("a1");
  });

  test("incoming.attachments reordering existing entries is accepted", () => {
    const a1 = {
      id: "a1",
      name: "first.png",
      mimeType: "image/png",
      sizeBytes: 10,
      addedAt: "2026-05-18T00:00:00.000Z",
    };
    const a2 = {
      id: "a2",
      name: "second.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20,
      addedAt: "2026-05-18T00:00:01.000Z",
    };
    const prior = makeIssue({ attachments: [a1, a2] });
    const incoming: Partial<Issue> = { attachments: [a2, a1] };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));
    expect(next.attachments.map((a) => a.id)).toEqual(["a2", "a1"]);
  });

  test("incoming.attachments removing an existing entry is accepted", () => {
    const a1 = {
      id: "a1",
      name: "first.png",
      mimeType: "image/png",
      sizeBytes: 10,
      addedAt: "2026-05-18T00:00:00.000Z",
    };
    const a2 = {
      id: "a2",
      name: "second.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20,
      addedAt: "2026-05-18T00:00:01.000Z",
    };
    const prior = makeIssue({ attachments: [a1, a2] });
    const incoming: Partial<Issue> = { attachments: [a1] };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));
    expect(next.attachments).toHaveLength(1);
    expect(next.attachments[0]!.id).toBe("a1");
  });

  test("attachment metadata is taken from prior (webview can't rewrite size/name)", () => {
    const prior = makeIssue({
      attachments: [
        {
          id: "a1",
          name: "real.png",
          mimeType: "image/png",
          sizeBytes: 100,
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    const incoming: Partial<Issue> = {
      attachments: [
        {
          id: "a1",
          name: "FAKE.png",
          mimeType: "image/jpeg",
          sizeBytes: 999_999_999,
          addedAt: "1970-01-01T00:00:00.000Z",
        },
      ],
    };
    const next = ok(mergeIssueUpdate(prior, incoming, "user"));
    expect(next.attachments[0]).toEqual(prior.attachments[0]!);
  });

  test("attachments default to prior when not provided", () => {
    const prior = makeIssue({
      attachments: [
        {
          id: "a1",
          name: "keep.png",
          mimeType: "image/png",
          sizeBytes: 1,
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    const next = ok(mergeIssueUpdate(prior, { title: "rename only" }, "user"));
    expect(next.attachments).toBe(prior.attachments);
  });
});

describe("validateLinks", () => {
  test("keeps every link whose target is in knownIds and isn't self", () => {
    const links: TicketLink[] = [
      { targetId: "DS-002", kind: "blocks" },
      { targetId: "DS-003", kind: "relates-to" },
    ];
    const { kept, dropped } = validateLinks(links, "DS-001", new Set(["DS-002", "DS-003"]));
    expect(kept).toEqual(links);
    expect(dropped).toEqual([]);
  });

  test("drops links to unknown targets", () => {
    const links: TicketLink[] = [
      { targetId: "DS-002", kind: "blocks" },
      { targetId: "DS-999", kind: "blocks" }, // unknown
    ];
    const { kept, dropped } = validateLinks(links, "DS-001", new Set(["DS-002"]));
    expect(kept).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
    expect(dropped).toEqual([{ targetId: "DS-999", kind: "blocks" }]);
  });

  test("drops self-links", () => {
    const links: TicketLink[] = [
      { targetId: "DS-001", kind: "blocks" }, // self
      { targetId: "DS-002", kind: "blocks" },
    ];
    const { kept, dropped } = validateLinks(links, "DS-001", new Set(["DS-001", "DS-002"]));
    expect(kept).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.targetId).toBe("DS-001");
  });
});

describe("mergeIssueUpdate — links reconciliation", () => {
  test("when incoming.links is missing, prior.links is preserved verbatim", () => {
    const prior = makeIssue({
      id: "DS-001",
      links: [{ targetId: "DS-002", kind: "blocks" }],
    });
    const r = mergeIssueUpdate(prior, { title: "still mergeable" }, "user");
    if ("error" in r) throw new Error(r.error);
    expect(r.next.links).toBe(prior.links);
  });

  test("when knownIds NOT supplied, accepts coerced shape without store check", () => {
    const prior = makeIssue({ id: "DS-001", links: [] });
    const links: TicketLink[] = [
      { targetId: "DS-002", kind: "blocks" },
      { targetId: "DS-999", kind: "relates-to" }, // unknown but no store check
    ];
    const r = mergeIssueUpdate(prior, { links }, "user");
    if ("error" in r) throw new Error(r.error);
    expect(r.next.links).toEqual(links);
  });

  test("when knownIds supplied, drops links to unknown targets", () => {
    const prior = makeIssue({ id: "DS-001", links: [] });
    const incoming: Partial<Issue> = {
      links: [
        { targetId: "DS-002", kind: "blocks" },
        { targetId: "DS-999", kind: "relates-to" }, // unknown
      ],
    };
    const knownIds = new Set(["DS-001", "DS-002"]);
    const r = mergeIssueUpdate(prior, incoming, "user", undefined, knownIds);
    if ("error" in r) throw new Error(r.error);
    expect(r.next.links).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });

  test("drops self-links even with knownIds", () => {
    const prior = makeIssue({ id: "DS-001", links: [] });
    const r = mergeIssueUpdate(
      prior,
      { links: [{ targetId: "DS-001", kind: "blocks" }] },
      "user",
      undefined,
      new Set(["DS-001"]),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.next.links).toEqual([]);
  });

  test("malformed incoming.links shapes are dropped by coerceLinks", () => {
    const prior = makeIssue({ id: "DS-001", links: [] });
    const r = mergeIssueUpdate(
      prior,
      // @ts-expect-error -- test deliberately bad shape
      { links: [null, { targetId: "ds-002", kind: "blocks" }, { kind: "blocks" }] },
      "user",
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.next.links).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });
});
