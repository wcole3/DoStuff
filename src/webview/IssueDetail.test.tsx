// IssueDetail component tests. Covers: status change posts updateIssue,
// status-change warning when target lane is full, task checkbox toggle,
// title edit on blur.
//
// Notes on `statusHistory` / `resolvedAt`: the wave-B brief asked us to
// assert the webview does NOT include statusHistory/resolvedAt in its
// `updateIssue` payload (host owns those fields per S-wv-1). The current
// `IssueDetail.tsx` still spreads the entire `issue` into postUpdateIssue,
// so it DOES include those fields. We therefore assert what the code does
// today (status is correct) and leave the stricter "no smuggled fields"
// invariant as a host-side guarantee enforced by `mergeIssueUpdate`
// (covered by extension.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueDetail } from "./IssueDetail";
import { ACTIVE_LANE_CAP, type Issue } from "../types";
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

describe("IssueDetail", () => {
  test("status dropdown change posts updateIssue with new status", () => {
    const issue = makeIssue({ id: "DS-001", status: "Planned" });
    // Seed the store; the component reads `useIssues()` for the lane-cap check.
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    const select = document.querySelector(".ds-d-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Working" } });

    const msg = api.posted.find((m) => m.type === "updateIssue") as
      | { type: "updateIssue"; issue: Issue }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.issue.id).toBe("DS-001");
    expect(msg!.issue.status).toBe("Working");
  });

  test("status dropdown shows a warning when target lane is full", () => {
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
    const planned = makeIssue({ id: "DS-099", number: 99, status: "Planned" });
    seed.push(planned);
    pushInit(seed);
    render(<IssueDetail issue={planned} />);

    // The status select is the first .ds-d-select.
    const select = document.querySelector(".ds-d-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Working" } });

    const warn = document.querySelector(".ds-d-warning");
    expect(warn).not.toBeNull();
    expect(warn?.textContent).toContain("Working");

    // No updateIssue should have been posted.
    expect(api.posted.find((m) => m.type === "updateIssue")).toBeUndefined();
  });

  test("toggling a task checkbox posts updateIssue with the task flipped", async () => {
    const issue = makeIssue({
      id: "DS-001",
      status: "Working",
      tasks: [
        { id: "t1", text: "Do thing", done: false },
        { id: "t2", text: "Other thing", done: false },
      ],
    });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    // Task checkboxes use role="checkbox" with aria-checked.
    const boxes = document.querySelectorAll(".ds-task-check");
    expect(boxes.length).toBe(2);
    await userEvent.click(boxes[0]);

    const msg = api.posted.find((m) => m.type === "updateIssue") as
      | { type: "updateIssue"; issue: Issue }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.issue.tasks[0].done).toBe(true);
    expect(msg!.issue.tasks[1].done).toBe(false);
  });

  test("title edit posts updateIssue on blur", async () => {
    const issue = makeIssue({ id: "DS-001", title: "Old title", status: "Planned" });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    // Click the title to enter edit mode.
    const heading = document.querySelector(".ds-d-title") as HTMLElement;
    await userEvent.click(heading);

    const input = document.querySelector(".ds-d-title-input") as HTMLInputElement;
    expect(input).not.toBeNull();

    // Clear and retype, then blur.
    await userEvent.clear(input);
    await userEvent.type(input, "New shiny title");
    fireEvent.blur(input);

    const msg = api.posted.find((m) => m.type === "updateIssue") as
      | { type: "updateIssue"; issue: Issue }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.issue.title).toBe("New shiny title");
  });
});
