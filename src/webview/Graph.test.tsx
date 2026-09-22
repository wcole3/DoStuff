// Graph webview smoke tests. d3-force layout is non-deterministic, so we
// assert structure (node/edge counts), interactions (click + Enter reveal,
// wheel zoom), and the empty state — never specific coordinates.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Graph } from "./Graph";
import { STATUSES } from "../types";
import { STATUS_META } from "./Icons";
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

describe("Graph relationship-type toggles", () => {
  // DS-001 --blocks--> DS-002 --child-of--> DS-003. Each node's sole edge is a
  // distinct kind, so hiding one kind strands exactly one node.
  function seedLinked() {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, title: "blocker", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "middle", links: [{ targetId: "DS-003", kind: "child-of" }] }),
      makeIssue({ id: "DS-003", number: 3, title: "leaf" }),
    ]);
  }

  const toggle = (label: RegExp) => screen.getByRole("button", { name: label });

  test("every relationship type is shown (pressed) by default", () => {
    seedLinked();
    render(<Graph />);
    expect(toggle(/blocks/i).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(/child of/i).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(/relates to/i).getAttribute("aria-pressed")).toBe("true");
  });

  test("hiding a kind drops its edges and any now-isolated node", () => {
    seedLinked();
    render(<Graph />);
    fireEvent.click(toggle(/blocks/i));
    // DS-001's only link was the blocks edge, so it disappears with it.
    expect(document.querySelector('[data-node="DS-001"]')).toBeNull();
    expect(document.querySelectorAll("[data-node]")).toHaveLength(2);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(1);
    expect(toggle(/blocks/i).getAttribute("aria-pressed")).toBe("false");
  });

  test("re-showing a kind restores its edges and nodes", () => {
    seedLinked();
    render(<Graph />);
    fireEvent.click(toggle(/blocks/i));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(2);
    fireEvent.click(toggle(/blocks/i));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(3);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(2);
  });

  test("hiding every kind shows the empty-selection message", () => {
    seedLinked();
    render(<Graph />);
    fireEvent.click(toggle(/blocks/i));
    fireEvent.click(toggle(/child of/i));
    fireEvent.click(toggle(/relates to/i));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(screen.getByText(/no relationships of the selected type/i)).toBeDefined();
  });
});

describe("Graph filtering", () => {
  // Two separate chains: A-B-C (the "auth" cluster) and D-E (unrelated).
  function seedTwoChains() {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, title: "auth blocker", tags: ["auth"], links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "auth middle", links: [{ targetId: "DS-003", kind: "child-of" }] }),
      makeIssue({ id: "DS-003", number: 3, title: "auth leaf" }),
      makeIssue({ id: "DS-004", number: 4, title: "billing one", links: [{ targetId: "DS-005", kind: "blocks" }] }),
      makeIssue({ id: "DS-005", number: 5, title: "billing two" }),
    ]);
  }

  test("filtering preserves the whole chain of a matched node", () => {
    seedTwoChains();
    render(<Graph />);
    // Match only the middle node's title; its full A-B-C chain must remain.
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "auth middle" } });
    const shown = Array.from(document.querySelectorAll("[data-node]")).map((n) => n.getAttribute("data-node"));
    expect(shown.sort()).toEqual(["DS-001", "DS-002", "DS-003"]);
  });

  test("the unrelated chain is hidden when it has no match", () => {
    seedTwoChains();
    render(<Graph />);
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "auth" } });
    expect(document.querySelector('[data-node="DS-004"]')).toBeNull();
    expect(document.querySelector('[data-node="DS-005"]')).toBeNull();
  });

  test("context nodes (preserved but not matched) are dimmed; matches are not", () => {
    seedTwoChains();
    render(<Graph />);
    // Only DS-001 matches by tag; DS-002/DS-003 are context (dimmed).
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "auth blocker" } });
    expect(document.querySelector('[data-node="DS-001"]')!.getAttribute("data-dimmed")).toBeNull();
    expect(document.querySelector('[data-node="DS-002"]')!.getAttribute("data-dimmed")).toBe("true");
  });

  test("clearing the filter restores all nodes", () => {
    seedTwoChains();
    render(<Graph />);
    const input = screen.getByLabelText(/filter graph/i);
    fireEvent.change(input, { target: { value: "auth" } });
    expect(document.querySelectorAll("[data-node]")).toHaveLength(3);
    fireEvent.change(input, { target: { value: "" } });
    expect(document.querySelectorAll("[data-node]")).toHaveLength(5);
  });

  test("a query matching nothing shows the no-match message", () => {
    seedTwoChains();
    render(<Graph />);
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "zzz-nope" } });
    expect(document.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(screen.getByText(/no linked tickets match/i)).toBeDefined();
  });
});

describe("Graph status filters", () => {
  // DS-001 (Working) --blocks--> DS-002 (Planned) --child-of--> DS-003 (Complete).
  // Each node carries a distinct status, so hiding one status strands exactly
  // the nodes whose only edges touched it.
  function seedStatuses() {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, title: "working one", status: "Working", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "planned two", status: "Planned", links: [{ targetId: "DS-003", kind: "child-of" }] }),
      makeIssue({ id: "DS-003", number: 3, title: "complete three", status: "Complete" }),
    ]);
  }

  // The chip's text is its accessible name, so match the status label exactly.
  const statusToggle = (status: string) =>
    screen.getByRole("button", { name: new RegExp(`^${status}$`, "i") }) as HTMLButtonElement;

  test("every status is shown (pressed) by default", () => {
    seedStatuses();
    render(<Graph />);
    for (const s of STATUSES) {
      expect(statusToggle(s).getAttribute("aria-pressed")).toBe("true");
    }
    expect(document.querySelectorAll("[data-node]")).toHaveLength(3);
  });

  test("hiding a status drops its node and every edge incident to it", () => {
    seedStatuses();
    render(<Graph />);
    fireEvent.click(statusToggle("Planned"));
    // DS-002 goes, and both edges went through it — DS-001 and DS-003 strand too.
    expect(document.querySelector('[data-node="DS-002"]')).toBeNull();
    expect(document.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(0);
    expect(statusToggle("Planned").getAttribute("aria-pressed")).toBe("false");
  });

  test("hiding a leaf status keeps the rest of the chain", () => {
    seedStatuses();
    render(<Graph />);
    fireEvent.click(statusToggle("Complete"));
    const shown = Array.from(document.querySelectorAll("[data-node]")).map((n) => n.getAttribute("data-node"));
    expect(shown.sort()).toEqual(["DS-001", "DS-002"]);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(1);
  });

  test("re-showing a status restores its nodes and edges", () => {
    seedStatuses();
    render(<Graph />);
    fireEvent.click(statusToggle("Complete"));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(2);
    fireEvent.click(statusToggle("Complete"));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(3);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(2);
  });

  test("hiding every status shows the empty-selection message", () => {
    seedStatuses();
    render(<Graph />);
    for (const s of STATUSES) fireEvent.click(statusToggle(s));
    expect(document.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(screen.getByText(/no tickets in the selected statuses/i)).toBeDefined();
  });

  test("each node circle carries its status color", () => {
    seedStatuses();
    render(<Graph />);
    const node = document.querySelector('[data-node="DS-001"]') as SVGGElement;
    expect(node.getAttribute("style")).toContain(STATUS_META.Working.color);
  });

  test("status legend shows a color swatch per status", () => {
    seedStatuses();
    render(<Graph />);
    const legend = document.querySelector(".ds-graph-status-legend")!;
    expect(legend.querySelectorAll(".ds-graph-legend-dot")).toHaveLength(STATUSES.length);
    expect(legend.textContent).toContain("Verification");
  });

  test("status, kind and text filters compose", () => {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, title: "auth one", status: "Working", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "auth two", status: "Planned" }),
      makeIssue({ id: "DS-003", number: 3, title: "billing one", status: "Working", links: [{ targetId: "DS-004", kind: "blocks" }] }),
      makeIssue({ id: "DS-004", number: 4, title: "billing two", status: "Planned" }),
    ]);
    render(<Graph />);
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "auth" } });
    expect(document.querySelectorAll("[data-node]")).toHaveLength(2);
    // Hiding Planned drops DS-002 and the edge into it. DS-001 still matched the
    // text filter, so it stays as a lone node — same as a match stranded by a
    // kind toggle. The billing chain stays out on the text filter.
    fireEvent.click(statusToggle("Planned"));
    const shown = Array.from(document.querySelectorAll("[data-node]")).map((n) => n.getAttribute("data-node"));
    expect(shown).toEqual(["DS-001"]);
    expect(document.querySelectorAll(".ds-graph-svg line")).toHaveLength(0);
  });

  test("a hidden-status node cannot seed a chain through the text filter", () => {
    pushInit([
      makeIssue({ id: "DS-001", number: 1, title: "auth root", status: "Closed", links: [{ targetId: "DS-002", kind: "blocks" }] }),
      makeIssue({ id: "DS-002", number: 2, title: "downstream", status: "Working" }),
    ]);
    render(<Graph />);
    fireEvent.click(statusToggle("Closed"));
    fireEvent.change(screen.getByLabelText(/filter graph/i), { target: { value: "auth root" } });
    expect(document.querySelectorAll("[data-node]")).toHaveLength(0);
  });
});
