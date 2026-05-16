// Board component tests.
//
// HTML5 DnD cannot be simulated reliably in happy-dom — there is no real
// DataTransfer + the dragstart/dragover/drop pipeline doesn't carry state
// the way a browser does. Per the wave-B plan, the lane-move logic was
// extracted into a pure `decideDrop` helper. We unit-test it directly and
// then exercise the rendered Board for what we can: lane counters and
// `is-full` class.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Board, decideDrop } from "./Board";
import { ACTIVE_LANE_CAP, type Issue } from "../types";
import {
  installVsCodeApi,
  makeIssue,
  pushInit,
  resetCounter,
  restoreVsCodeApi,
} from "./__tests__/testUtils";

beforeEach(() => {
  resetCounter();
  installVsCodeApi();
});

afterEach(() => {
  cleanup();
  restoreVsCodeApi();
});

describe("decideDrop", () => {
  test("allows a move into a non-full active lane", () => {
    const issues: Issue[] = [
      makeIssue({ id: "DS-001", status: "Planned" }),
      makeIssue({ id: "DS-002", status: "Working" }),
    ];
    const r = decideDrop(issues, "DS-001", "Working");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.next.id).toBe("DS-001");
      expect(r.next.status).toBe("Working");
    }
  });

  test("rejects a move into a full lane (6/6)", () => {
    const issues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      issues.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    issues.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));

    const r = decideDrop(issues, "DS-099", "Working");
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.reason).toContain("Working");
      expect(r.reason).toContain(String(ACTIVE_LANE_CAP));
    }
  });

  test("in-place no-op when target lane is already the source (even if full)", () => {
    const issues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      issues.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    // DS-001 is already in Working — moving it INTO Working is a no-op.
    const r = decideDrop(issues, "DS-001", "Working");
    expect(r.kind).toBe("noop");
  });

  test("allows move into Thinking (uncapped)", () => {
    const issues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      issues.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Thinking",
        }),
      );
    }
    issues.push(makeIssue({ id: "DS-099", number: 99, status: "Planned" }));
    const r = decideDrop(issues, "DS-099", "Thinking");
    expect(r.kind).toBe("ok");
  });

  test("allows move into Complete (uncapped)", () => {
    const issues: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      issues.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Complete",
        }),
      );
    }
    issues.push(makeIssue({ id: "DS-099", number: 99, status: "Verification" }));
    const r = decideDrop(issues, "DS-099", "Complete");
    expect(r.kind).toBe("ok");
  });

  test("allows manual demote (Working -> Planned) — UI is human-driven", () => {
    const issues: Issue[] = [
      makeIssue({ id: "DS-001", status: "Working" }),
    ];
    const r = decideDrop(issues, "DS-001", "Planned");
    expect(r.kind).toBe("ok");
  });

  test("returns 'missing' when id is unknown", () => {
    const issues: Issue[] = [makeIssue({ id: "DS-001", status: "Planned" })];
    const r = decideDrop(issues, "DS-404", "Working");
    expect(r.kind).toBe("missing");
  });
});

describe("Board rendering", () => {
  test("each lane header shows count/CAP", () => {
    const seed: Issue[] = [
      makeIssue({ id: "DS-001", number: 1, status: "Planned" }),
      makeIssue({ id: "DS-002", number: 2, status: "Working" }),
      makeIssue({ id: "DS-003", number: 3, status: "Working" }),
    ];
    render(<Board />);
    pushInit(seed);
    // Lane header counters are rendered as `count/CAP` text inside
    // .bd-lane-count spans. Find them by exact textContent match.
    const counters = Array.from(document.querySelectorAll(".bd-lane-count")).map(
      (el) => el.textContent,
    );
    // Order: Planned, Working, Verification
    expect(counters).toEqual([`1/${ACTIVE_LANE_CAP}`, `2/${ACTIVE_LANE_CAP}`, `0/${ACTIVE_LANE_CAP}`]);
  });

  test("applies is-full class at count === CAP", () => {
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    render(<Board />);
    pushInit(seed);
    const lanes = Array.from(document.querySelectorAll(".bd-lane"));
    // Three lanes in order Planned/Working/Verification — only Working is full.
    expect(lanes[0]?.classList.contains("is-full")).toBe(false);
    expect(lanes[1]?.classList.contains("is-full")).toBe(true);
    expect(lanes[2]?.classList.contains("is-full")).toBe(false);
  });

  test("does NOT apply is-full when count is just under CAP", () => {
    const seed: Issue[] = [];
    for (let i = 1; i <= ACTIVE_LANE_CAP - 1; i++) {
      seed.push(
        makeIssue({
          id: `DS-${String(i).padStart(3, "0")}`,
          number: i,
          status: "Working",
        }),
      );
    }
    render(<Board />);
    pushInit(seed);
    const workingLane = Array.from(document.querySelectorAll(".bd-lane"))[1];
    expect(workingLane?.classList.contains("is-full")).toBe(false);
  });
});

describe("Drawer search + filter", () => {
  test("filter input limits visible cards in the Thinking drawer", async () => {
    const a = makeIssue({ id: "DS-001", title: "Alpha task", status: "Thinking" });
    const b = makeIssue({ id: "DS-002", title: "Beta task", status: "Thinking" });
    render(<Board />);
    pushInit([a, b]);

    // Open the Thinking (left) drawer by clicking its head button.
    const drawerBtn = document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement;
    fireEvent.click(drawerBtn);

    // Both cards visible before filtering.
    expect(screen.queryByText("Alpha task")).not.toBeNull();
    expect(screen.queryByText("Beta task")).not.toBeNull();

    // Type into the filter input.
    const filterInput = screen.getByPlaceholderText("Filter…");
    fireEvent.change(filterInput, { target: { value: "alpha" } });

    expect(screen.queryByText("Alpha task")).not.toBeNull();
    expect(screen.queryByText("Beta task")).toBeNull();
  });

  test("closing the Thinking drawer resets filter query", () => {
    const a = makeIssue({ id: "DS-011", title: "Gamma issue", status: "Thinking" });
    render(<Board />);
    pushInit([a]);

    const drawerBtn = document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement;
    fireEvent.click(drawerBtn);

    const filterInput = screen.getByPlaceholderText("Filter…");
    fireEvent.change(filterInput, { target: { value: "no match" } });
    expect(screen.queryByText("Gamma issue")).toBeNull();

    // Close drawer.
    fireEvent.click(drawerBtn);
    // Reopen — filter should be gone.
    fireEvent.click(drawerBtn);
    expect(screen.queryByText("Gamma issue")).not.toBeNull();
  });
});

describe("Thinking drawer card click semantics", () => {
  test("plain click opens the detail overlay and does NOT promote", () => {
    const a = makeIssue({ id: "DS-101", number: 101, title: "Draft idea", status: "Thinking" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    fireEvent.click(document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement);
    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    fireEvent.click(card);

    expect(document.querySelector(".bd-focus")).not.toBeNull();
    expect(api.posted.some((m) => m.type === "updateIssue")).toBe(false);
  });

  test("shift-click promotes to Planned and does NOT open the detail overlay", () => {
    const a = makeIssue({ id: "DS-102", number: 102, title: "Promote me", status: "Thinking" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    fireEvent.click(document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement);
    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    fireEvent.click(card, { shiftKey: true });

    expect(document.querySelector(".bd-focus")).toBeNull();
    const updates = api.posted.filter((m) => m.type === "updateIssue");
    expect(updates).toHaveLength(1);
    const issue = (updates[0] as unknown as { issue: Issue }).issue;
    expect(issue.id).toBe("DS-102");
    expect(issue.status).toBe("Planned");
  });

  test("Complete drawer: plain click opens detail (no promote path)", () => {
    const a = makeIssue({ id: "DS-103", number: 103, title: "Done", status: "Complete" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    fireEvent.click(document.querySelector(".bd-drawer-right .bd-drawer-head") as HTMLElement);
    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    fireEvent.click(card);

    expect(document.querySelector(".bd-focus")).not.toBeNull();
    expect(api.posted.some((m) => m.type === "updateIssue")).toBe(false);
  });
});

// The "Loading…" empty-state for Board is skipped: the webview store is a
// module singleton and is `initialized: true` for the remainder of the test
// process after any earlier test pushed an init message. Asserting against
// the pristine pre-init state would require resetting a module-private
// flag we don't want to expose just for tests.
void screen;
