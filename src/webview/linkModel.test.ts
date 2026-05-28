// Tests for the pure link helpers: deriveInbound, buildGraphModel,
// searchIssuesForLink. No DOM / React — runs as a plain unit test.

import { describe, expect, test } from "bun:test";
import {
  buildGraphModel,
  deriveInbound,
  searchIssuesForLink,
} from "./linkModel";
import { makeIssue, resetCounter } from "./__tests__/testUtils";

describe("deriveInbound", () => {
  test("returns [] when nothing links to the target", () => {
    const issues = [makeIssue({ id: "DS-001" }), makeIssue({ id: "DS-002" })];
    expect(deriveInbound("DS-001", issues)).toEqual([]);
  });

  test("single inbound link is reported with inverted kind", () => {
    const issues = [
      makeIssue({ id: "DS-001", title: "blocker", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", title: "blocked" }),
    ];
    expect(deriveInbound("DS-002", issues)).toEqual([
      { sourceId: "DS-001", sourceTitle: "blocker", kind: "blocked-by" },
    ]);
  });

  test("child-of inverts to parent-of", () => {
    const issues = [
      makeIssue({ id: "DS-001", title: "kid", links: [{ targetId: "DS-002", kind: "child-of" }] }),
      makeIssue({ id: "DS-002", title: "parent" }),
    ];
    expect(deriveInbound("DS-002", issues)[0]!.kind).toBe("parent-of");
  });

  test("relates-to is symmetric", () => {
    const issues = [
      makeIssue({ id: "DS-001", links: [{ targetId: "DS-002", kind: "relates-to" }] }),
      makeIssue({ id: "DS-002" }),
    ];
    expect(deriveInbound("DS-002", issues)[0]!.kind).toBe("relates-to");
  });

  test("collects multiple inbound links from different sources", () => {
    const issues = [
      makeIssue({ id: "DS-001", links: [{ targetId: "DS-003", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", links: [{ targetId: "DS-003", kind: "child-of" }] }),
      makeIssue({ id: "DS-003" }),
    ];
    const inbound = deriveInbound("DS-003", issues);
    expect(inbound).toHaveLength(2);
    expect(inbound.map((l) => l.sourceId).sort()).toEqual(["DS-001", "DS-002"]);
  });
});

describe("buildGraphModel", () => {
  test("excludes tickets that participate in no link", () => {
    const issues = [
      makeIssue({ id: "DS-001", number: 1, links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2 }),
      makeIssue({ id: "DS-003", number: 3 }), // isolated
    ];
    const { nodes, edges } = buildGraphModel(issues);
    expect(nodes.map((n) => n.id).sort()).toEqual(["DS-001", "DS-002"]);
    expect(edges).toEqual([{ sourceId: "DS-001", targetId: "DS-002", kind: "blocks" }]);
  });

  test("includes both endpoints of every edge as nodes", () => {
    const issues = [
      makeIssue({ id: "DS-001", number: 1, links: [{ targetId: "DS-002", kind: "relates-to" }] }),
      makeIssue({ id: "DS-002", number: 2 }),
    ];
    const { nodes } = buildGraphModel(issues);
    expect(nodes).toHaveLength(2);
  });

  test("drops edges whose target doesn't exist (dangling ref)", () => {
    const issues = [
      makeIssue({ id: "DS-001", number: 1, links: [{ targetId: "DS-999", kind: "blocks" }] }),
    ];
    const { nodes, edges } = buildGraphModel(issues);
    expect(edges).toEqual([]);
    expect(nodes).toEqual([]);
  });

  test("nodes are sorted by number ascending (deterministic layout seed)", () => {
    const issues = [
      makeIssue({ id: "DS-003", number: 3, links: [{ targetId: "DS-001", kind: "blocks" }] }),
      makeIssue({ id: "DS-001", number: 1 }),
    ];
    const { nodes } = buildGraphModel(issues);
    expect(nodes.map((n) => n.number)).toEqual([1, 3]);
  });
});

describe("searchIssuesForLink", () => {
  function fixture() {
    resetCounter();
    return [
      makeIssue({ id: "DS-001", number: 1, title: "Fix OAuth login" }),
      makeIssue({ id: "DS-002", number: 2, title: "Add CSV export" }),
      makeIssue({ id: "DS-042", number: 42, title: "OAuth refresh tokens" }),
    ];
  }

  test("empty query returns all candidates (sorted by number)", () => {
    const out = searchIssuesForLink("", fixture(), undefined, new Set());
    expect(out.map((i) => i.number)).toEqual([1, 2, 42]);
  });

  test("matches by exact ticket number", () => {
    const out = searchIssuesForLink("42", fixture(), undefined, new Set());
    expect(out.map((i) => i.id)).toEqual(["DS-042"]);
  });

  test("matches by #-prefixed number", () => {
    const out = searchIssuesForLink("#2", fixture(), undefined, new Set());
    expect(out.map((i) => i.id)).toEqual(["DS-002"]);
  });

  test("matches by DS- id case-insensitively", () => {
    const out = searchIssuesForLink("ds-001", fixture(), undefined, new Set());
    expect(out.map((i) => i.id)).toEqual(["DS-001"]);
  });

  test("matches by title substring case-insensitively", () => {
    const out = searchIssuesForLink("oauth", fixture(), undefined, new Set());
    expect(out.map((i) => i.id).sort()).toEqual(["DS-001", "DS-042"]);
  });

  test("excludes the current issue", () => {
    const out = searchIssuesForLink("oauth", fixture(), "DS-001", new Set());
    expect(out.map((i) => i.id)).toEqual(["DS-042"]);
  });

  test("excludes already-linked targets", () => {
    const out = searchIssuesForLink("oauth", fixture(), undefined, new Set(["DS-042"]));
    expect(out.map((i) => i.id)).toEqual(["DS-001"]);
  });
});
