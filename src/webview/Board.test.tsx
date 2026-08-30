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
import { Board, decideDrop, stepStatus } from "./Board";
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

  test("thinking drawer cards render tag chips when the ticket has tags", () => {
    const tagged = makeIssue({
      id: "DS-050",
      title: "Idea with tags",
      status: "Thinking",
      tags: ["frontend"],
    });
    render(<Board />);
    pushInit([tagged]);

    const drawerBtn = document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement;
    fireEvent.click(drawerBtn);

    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    expect(card).not.toBeNull();
    const chip = card.querySelector(".ds-tag-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("frontend");
  });

  test("every drawer card carries a `.bd-drawer-card-tags` slot regardless of tag presence (DS-009 regression)", () => {
    // Mixed dataset: untagged + tagged cards must share identical structure
    // so each FixedSizeList slot is occupied uniformly and no inter-card
    // gaps appear. Catches the bug where conditional `<TagStrip>` rendering
    // left untagged cards short.
    const a = makeIssue({ id: "DS-060", title: "Untagged idea", status: "Thinking" });
    const b = makeIssue({
      id: "DS-061",
      title: "Tagged idea",
      status: "Thinking",
      tags: ["polish"],
    });
    render(<Board />);
    pushInit([a, b]);

    const drawerBtn = document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement;
    fireEvent.click(drawerBtn);

    const cards = Array.from(document.querySelectorAll(".bd-drawer-card"));
    expect(cards.length).toBe(2);
    for (const card of cards) {
      expect(card.querySelector(".bd-drawer-card-tags")).not.toBeNull();
    }
    // Tagged card has a chip; untagged card has none — but the slot exists either way.
    const taggedCard = cards.find((c) => c.textContent?.includes("Tagged idea"))!;
    const untaggedCard = cards.find((c) => c.textContent?.includes("Untagged idea"))!;
    expect(taggedCard.querySelector(".ds-tag-chip")).not.toBeNull();
    expect(untaggedCard.querySelector(".ds-tag-chip")).toBeNull();
  });

  test("complete drawer cards also reserve the tag slot (DS-009 regression, right drawer)", () => {
    const a = makeIssue({ id: "DS-070", title: "Shipped no tags", status: "Complete" });
    const b = makeIssue({
      id: "DS-071",
      title: "Shipped with tags",
      status: "Complete",
      tags: ["v2"],
    });
    render(<Board />);
    pushInit([a, b]);

    const drawerBtn = document.querySelector(".bd-drawer-right .bd-drawer-head") as HTMLElement;
    fireEvent.click(drawerBtn);

    const cards = Array.from(document.querySelectorAll(".bd-drawer-card"));
    expect(cards.length).toBe(2);
    for (const card of cards) {
      expect(card.querySelector(".bd-drawer-card-tags")).not.toBeNull();
    }
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

describe("stepStatus", () => {
  test("walks the board order in both directions", () => {
    expect(stepStatus("Thinking", 1)).toBe("Planned");
    expect(stepStatus("Planned", 1)).toBe("Working");
    expect(stepStatus("Working", 1)).toBe("Verification");
    expect(stepStatus("Verification", 1)).toBe("Complete");
    expect(stepStatus("Planned", -1)).toBe("Thinking");
    expect(stepStatus("Working", -1)).toBe("Planned");
    expect(stepStatus("Verification", -1)).toBe("Working");
    expect(stepStatus("Complete", -1)).toBe("Verification");
  });

  test("returns null at the board edges", () => {
    expect(stepStatus("Thinking", -1)).toBeNull();
    expect(stepStatus("Complete", 1)).toBeNull();
  });

  test("returns null for Closed (off-board) in both directions", () => {
    expect(stepStatus("Closed", -1)).toBeNull();
    expect(stepStatus("Closed", 1)).toBeNull();
  });
});

describe("Board card step arrows", () => {
  test("a lane card renders both arrows; clicking right moves one lane right without opening detail", () => {
    const a = makeIssue({ id: "DS-201", number: 201, title: "Step me", status: "Working" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    const card = document.querySelector(".bd-card") as HTMLElement;
    expect(card.querySelector(".bd-card-step-left")?.getAttribute("title")).toBe("Move to Planned");
    expect(card.querySelector(".bd-card-step-right")?.getAttribute("title")).toBe("Move to Verification");
    // Each zone immediately precedes its rail (the `~` hover chain depends on
    // this order), and the content sits in an inner column between the rails.
    expect(card.querySelector(".bd-card-zone-left + .bd-card-step-left")).not.toBeNull();
    expect(card.querySelector(".bd-card-zone-right + .bd-card-step-right")).not.toBeNull();
    expect(card.querySelector(".bd-card-inner")).not.toBeNull();

    fireEvent.click(card.querySelector(".bd-card-step-right") as HTMLElement);

    expect(document.querySelector(".bd-focus")).toBeNull();
    const updates = api.posted.filter((m) => m.type === "updateIssue");
    expect(updates).toHaveLength(1);
    expect((updates[0] as unknown as { issue: Issue }).issue.status).toBe("Verification");
  });

  test("a lane move renders optimistically before the host echoes", () => {
    const a = makeIssue({ id: "DS-220", number: 220, title: "Optimist", status: "Working" });
    installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    const card = document.querySelector(".bd-card") as HTMLElement;
    fireEvent.click(card.querySelector(".bd-card-step-right") as HTMLElement);

    // No `issues` echo has been pushed — the card must already render inside
    // the Verification lane (the host echo later confirms or reverts).
    const laneCard = document.querySelector('[data-drop-status="Verification"] .bd-card');
    expect(laneCard?.textContent ?? "").toContain("Optimist");
  });

  test("clicking left on a Planned card demotes it into the Thinking drawer", () => {
    const a = makeIssue({ id: "DS-202", number: 202, title: "Back to drawer", status: "Planned" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    const card = document.querySelector(".bd-card") as HTMLElement;
    fireEvent.click(card.querySelector(".bd-card-step-left") as HTMLElement);

    const updates = api.posted.filter((m) => m.type === "updateIssue");
    expect(updates).toHaveLength(1);
    expect((updates[0] as unknown as { issue: Issue }).issue.status).toBe("Thinking");
  });

  test("right arrow into a full lane is blocked with a toast and no update", () => {
    const mover = makeIssue({ id: "DS-210", number: 210, title: "Blocked", status: "Working" });
    const fillers: Issue[] = [];
    for (let i = 0; i < ACTIVE_LANE_CAP; i++) {
      fillers.push(makeIssue({ id: `DS-25${i}`, number: 250 + i, status: "Verification" }));
    }
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([mover, ...fillers]);

    const workingCard = Array.from(document.querySelectorAll(".bd-card")).find((c) =>
      c.textContent?.includes("Blocked"),
    ) as HTMLElement;
    fireEvent.click(workingCard.querySelector(".bd-card-step-right") as HTMLElement);

    expect(api.posted.filter((m) => m.type === "updateIssue")).toHaveLength(0);
    expect(document.querySelector(".bd-toast")?.textContent ?? "").toContain("full");
  });

  test("Thinking drawer card: only a right arrow, promoting to Planned", () => {
    const a = makeIssue({ id: "DS-203", number: 203, title: "Draft", status: "Thinking" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    fireEvent.click(document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement);
    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    expect(card.querySelector(".bd-card-step-left")).toBeNull();
    expect(card.querySelector(".bd-card-step-right")?.getAttribute("title")).toBe("Move to Planned");

    fireEvent.click(card.querySelector(".bd-card-step-right") as HTMLElement);

    const updates = api.posted.filter((m) => m.type === "updateIssue");
    expect(updates).toHaveLength(1);
    expect((updates[0] as unknown as { issue: Issue }).issue.status).toBe("Planned");
    expect(document.querySelector(".bd-focus")).toBeNull();
  });

  test("Complete drawer card: only a left arrow, moving back to Verification", () => {
    const a = makeIssue({ id: "DS-204", number: 204, title: "Reopen", status: "Complete" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([a]);

    fireEvent.click(document.querySelector(".bd-drawer-right .bd-drawer-head") as HTMLElement);
    const card = document.querySelector(".bd-drawer-card") as HTMLElement;
    expect(card.querySelector(".bd-card-step-right")).toBeNull();
    expect(card.querySelector(".bd-card-step-left")?.getAttribute("title")).toBe("Move to Verification");

    fireEvent.click(card.querySelector(".bd-card-step-left") as HTMLElement);

    const updates = api.posted.filter((m) => m.type === "updateIssue");
    expect(updates).toHaveLength(1);
    expect((updates[0] as unknown as { issue: Issue }).issue.status).toBe("Verification");
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

describe("Focus overlay after resolving a pending close request", () => {
  const pendingComplete = { by: "agent" as const, at: "2025-01-02T00:00:00.000Z", target: "Complete" as const };

  test("approve advances focus to the next ticket in the same lane", () => {
    // High priority sorts first in the lane, so the overlay opens on `first`
    // and approval should advance to `second`.
    const first = makeIssue({
      id: "DS-301", number: 301, title: "First verify", status: "Verification",
      priority: "High", pendingClose: pendingComplete,
    });
    const second = makeIssue({
      id: "DS-302", number: 302, title: "Second verify", status: "Verification",
    });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([first, second]);

    const card = Array.from(document.querySelectorAll(".bd-card")).find((c) =>
      c.textContent?.includes("First verify"),
    ) as HTMLElement;
    fireEvent.click(card);
    expect(document.querySelector(".bd-focus .ds-d-title")?.textContent).toContain("First verify");

    fireEvent.click(document.querySelector(".ds-d-close-req-approve") as HTMLElement);

    const resolve = api.posted.find((m) => m.type === "resolveClose") as
      | { type: "resolveClose"; id: string; verdict: string }
      | undefined;
    expect(resolve).toEqual({ type: "resolveClose", id: "DS-301", verdict: "approve" });
    expect(document.querySelector(".bd-focus .ds-d-title")?.textContent).toContain("Second verify");
  });

  test("approve closes the overlay when the lane has no other tickets", () => {
    const only = makeIssue({
      id: "DS-311", number: 311, title: "Lone verify", status: "Verification",
      pendingClose: pendingComplete,
    });
    // A ticket in a DIFFERENT lane must not become the next focus.
    const elsewhere = makeIssue({ id: "DS-312", number: 312, title: "Elsewhere", status: "Working" });
    installVsCodeApi();
    render(<Board />);
    pushInit([only, elsewhere]);

    const card = Array.from(document.querySelectorAll(".bd-card")).find((c) =>
      c.textContent?.includes("Lone verify"),
    ) as HTMLElement;
    fireEvent.click(card);
    expect(document.querySelector(".bd-focus")).not.toBeNull();

    fireEvent.click(document.querySelector(".ds-d-close-req-approve") as HTMLElement);

    expect(document.querySelector(".bd-focus")).toBeNull();
  });

  test("deny keeps the overlay on the same ticket", () => {
    const first = makeIssue({
      id: "DS-321", number: 321, title: "Denied verify", status: "Verification",
      priority: "High", pendingClose: pendingComplete,
    });
    const second = makeIssue({ id: "DS-322", number: 322, title: "Other verify", status: "Verification" });
    const api = installVsCodeApi();
    render(<Board />);
    pushInit([first, second]);

    const card = Array.from(document.querySelectorAll(".bd-card")).find((c) =>
      c.textContent?.includes("Denied verify"),
    ) as HTMLElement;
    fireEvent.click(card);

    fireEvent.click(document.querySelector(".ds-d-close-req-deny") as HTMLElement);

    const resolve = api.posted.find((m) => m.type === "resolveClose") as
      | { type: "resolveClose"; id: string; verdict: string }
      | undefined;
    expect(resolve).toEqual({ type: "resolveClose", id: "DS-321", verdict: "deny" });
    expect(document.querySelector(".bd-focus .ds-d-title")?.textContent).toContain("Denied verify");
  });

  test("approving a close request from the Thinking drawer advances within the drawer lane", () => {
    // OBE close (target Closed) filed against a Thinking draft: same
    // next-in-lane rule, scoped to the drawer's lane.
    const first = makeIssue({
      id: "DS-331", number: 331, title: "Drop me", status: "Thinking",
      priority: "High",
      pendingClose: { by: "agent" as const, at: "2025-01-02T00:00:00.000Z", target: "Closed" as const },
    });
    const second = makeIssue({ id: "DS-332", number: 332, title: "Keep thinking", status: "Thinking" });
    installVsCodeApi();
    render(<Board />);
    pushInit([first, second]);

    fireEvent.click(document.querySelector(".bd-drawer-left .bd-drawer-head") as HTMLElement);
    const card = Array.from(document.querySelectorAll(".bd-drawer-card")).find((c) =>
      c.textContent?.includes("Drop me"),
    ) as HTMLElement;
    fireEvent.click(card);
    expect(document.querySelector(".bd-focus .ds-d-title")?.textContent).toContain("Drop me");

    fireEvent.click(document.querySelector(".ds-d-close-req-approve") as HTMLElement);

    expect(document.querySelector(".bd-focus .ds-d-title")?.textContent).toContain("Keep thinking");
  });
});

// The "Loading…" empty-state for Board is skipped: the webview store is a
// module singleton and is `initialized: true` for the remainder of the test
// process after any earlier test pushed an init message. Asserting against
// the pristine pre-init state would require resetting a module-private
// flag we don't want to expose just for tests.
void screen;
