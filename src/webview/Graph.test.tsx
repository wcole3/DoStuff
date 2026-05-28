// Graph webview smoke tests. d3-force layout is non-deterministic, so we
// assert structure (node/edge counts), interactions (click + Enter reveal,
// wheel zoom), and the empty state — never specific coordinates.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Graph } from "./Graph";
import {
  installVsCodeApi,
  makeIssue,
  pushInit,
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

describe("Graph empty state", () => {
  test("shows guidance when no ticket has links", () => {
    pushInit([makeIssue({ id: "DS-001" }), makeIssue({ id: "DS-002" })]);
    render(<Graph />);
    expect(screen.getByText(/no linked tickets yet/i)).toBeDefined();
    expect(document.querySelector(".ds-graph-svg")).toBeNull();
  });
});

describe("Graph rendering", () => {
  function seedLinked() {
    pushInit([
      makeIssue({
        id: "DS-001",
        number: 1,
        title: "blocker",
        links: [{ targetId: "DS-002", kind: "blocks" }],
      }),
      makeIssue({
        id: "DS-002",
        number: 2,
        title: "middle",
        links: [{ targetId: "DS-003", kind: "child-of" }],
      }),
      makeIssue({ id: "DS-003", number: 3, title: "leaf" }),
    ]);
  }

  test("renders one node per linked ticket and one line per edge", () => {
    seedLinked();
    render(<Graph />);
    expect(document.querySelectorAll("[data-node]")).toHaveLength(3);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(2);
  });

  test("isolated tickets are not rendered as nodes", () => {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2 }),
      makeIssue({ id: "DS-003", number: 3 }), // isolated
    ]);
    render(<Graph />);
    expect(document.querySelectorAll("[data-node]")).toHaveLength(2);
    expect(document.querySelector('[data-node="DS-003"]')).toBeNull();
  });

  test("Enter on a focused node posts revealTicket", () => {
    seedLinked();
    render(<Graph />);
    const node = document.querySelector('[data-node="DS-002"]') as SVGGElement;
    fireEvent.keyDown(node, { key: "Enter" });
    const reveal = api.posted.find((m) => m.type === "revealTicket") as
      | { type: "revealTicket"; id: string }
      | undefined;
    expect(reveal?.id).toBe("DS-002");
  });

  test("a click (pointer down+up without movement) posts revealTicket", () => {
    seedLinked();
    render(<Graph />);
    const node = document.querySelector('[data-node="DS-001"]') as SVGGElement;
    const svg = document.querySelector(".ds-graph-svg") as SVGSVGElement;
    fireEvent.pointerDown(node, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 100, pointerId: 1 });
    const reveal = api.posted.find((m) => m.type === "revealTicket") as
      | { type: "revealTicket"; id: string }
      | undefined;
    expect(reveal?.id).toBe("DS-001");
  });

  test("wheel scroll changes the viewport transform (zoom)", () => {
    seedLinked();
    render(<Graph />);
    const svg = document.querySelector(".ds-graph-svg") as SVGSVGElement;
    const g = svg.querySelector("g[transform]") as SVGGElement;
    const before = g.getAttribute("transform");
    fireEvent.wheel(svg, { deltaY: -120, clientX: 200, clientY: 200 });
    const after = (svg.querySelector("g[transform]") as SVGGElement).getAttribute("transform");
    expect(after).not.toBe(before);
    expect(after).toMatch(/scale\(/);
  });

  test("legend lists every link kind", () => {
    seedLinked();
    render(<Graph />);
    const legend = document.querySelector(".ds-graph-legend")!;
    expect(legend.textContent).toContain("blocks");
    expect(legend.textContent).toContain("child of");
    expect(legend.textContent).toContain("relates to");
    // One line sample per kind so the legend reads as the edge coloring.
    expect(legend.querySelectorAll(".ds-graph-legend-line")).toHaveLength(3);
  });
});
