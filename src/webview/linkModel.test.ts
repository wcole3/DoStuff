// Tests for the pure link helpers: deriveInbound, buildGraphModel,
// searchIssuesForLink. No DOM / React — runs as a plain unit test.

import { describe, expect, test } from "bun:test";
import {
  RELATIONSHIP_OPTIONS,
  buildGraphModel,
  deriveInbound,
  graphNodeMatchesQuery,
  relationshipOption,
  searchIssuesForLink,
  visibleGraphNodeIds,
  type GraphNode,
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
      { sourceId: "DS-001", sourceTitle: "blocker", kind: "blocked-by", storedKind: "blocks" },
    ]);
  });

  test("includes the storedKind so the link can be removed from the source", () => {
    const issues = [
      makeIssue({ id: "DS-001", title: "kid", links: [{ targetId: "DS-002", kind: "child-of" }] }),
      makeIssue({ id: "DS-002", title: "parent" }),
    ];
    expect(deriveInbound("DS-002", issues)[0]!.storedKind).toBe("child-of");
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

describe("RELATIONSHIP_OPTIONS", () => {
  test("offers the three forward kinds plus the two inverse kinds", () => {
    expect(RELATIONSHIP_OPTIONS.map((o) => o.rel)).toEqual([
      "blocks",
      "blocked-by",
      "child-of",
      "parent-of",
      "relates-to",
    ]);
  });

  test("inverse options carry the forward storedKind they persist", () => {
    expect(relationshipOption("blocked-by")).toMatchObject({ inverse: true, storedKind: "blocks" });
    expect(relationshipOption("parent-of")).toMatchObject({ inverse: true, storedKind: "child-of" });
  });

  test("forward options store their own kind", () => {
    expect(relationshipOption("blocks")).toMatchObject({ inverse: false, storedKind: "blocks" });
    expect(relationshipOption("child-of")).toMatchObject({ inverse: false, storedKind: "child-of" });
    expect(relationshipOption("relates-to")).toMatchObject({ inverse: false, storedKind: "relates-to" });
  });
});

describe("graphNodeMatchesQuery", () => {
  const node: GraphNode = {
    id: "DS-042",
    number: 42,
    title: "Fix OAuth login",
    status: "Planned",
    type: "Bug",
    tags: ["auth", "backend"],
  };

  test("empty query matches everything", () => {
    expect(graphNodeMatchesQuery(node, "")).toBe(true);
    expect(graphNodeMatchesQuery(node, "   ")).toBe(true);
  });
  test("matches by number and #number", () => {
    expect(graphNodeMatchesQuery(node, "42")).toBe(true);
    expect(graphNodeMatchesQuery(node, "#42")).toBe(true);
  });
  test("matches by id substring (case-insensitive)", () => {
    expect(graphNodeMatchesQuery(node, "ds-042")).toBe(true);
  });
  test("matches by title substring (case-insensitive)", () => {
    expect(graphNodeMatchesQuery(node, "oauth")).toBe(true);
  });
  test("matches by tag substring", () => {
    expect(graphNodeMatchesQuery(node, "auth")).toBe(true);
    expect(graphNodeMatchesQuery(node, "back")).toBe(true);
  });
  test("no match returns false", () => {
    expect(graphNodeMatchesQuery(node, "zzz")).toBe(false);
  });
});

describe("visibleGraphNodeIds (chain preservation)", () => {
  // A -> B -> C  is one chain;  D -> E is a separate one.
  const edges = [
    { sourceId: "A", targetId: "B" },
    { sourceId: "B", targetId: "C" },
    { sourceId: "D", targetId: "E" },
  ];

  test("a match pulls in its whole connected chain (both directions)", () => {
    // Match the middle node B → the entire A-B-C chain is visible.
    const vis = visibleGraphNodeIds(new Set(["B"]), edges);
    expect([...vis].sort()).toEqual(["A", "B", "C"]);
  });

  test("matching an endpoint still preserves the full chain", () => {
    const vis = visibleGraphNodeIds(new Set(["A"]), edges);
    expect([...vis].sort()).toEqual(["A", "B", "C"]);
  });

  test("does not pull in a disconnected chain", () => {
    const vis = visibleGraphNodeIds(new Set(["A"]), edges);
    expect(vis.has("D")).toBe(false);
    expect(vis.has("E")).toBe(false);
  });

  test("multiple matches across chains union their components", () => {
    const vis = visibleGraphNodeIds(new Set(["C", "D"]), edges);
    expect([...vis].sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("a match with no edges is visible on its own", () => {
    const vis = visibleGraphNodeIds(new Set(["Z"]), edges);
    expect([...vis]).toEqual(["Z"]);
  });
});
