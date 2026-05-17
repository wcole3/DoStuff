// Sidebar component tests. Covers: empty state, sort order, completed
// visibility, status-chip filter, search, expand/collapse keyboard a11y.
//
// Strategy: render with React Testing Library against a happy-dom DOM,
// seed issues by dispatching a synthetic {type:"init"} on `window` (the
// same message the host sends in production), then assert against rendered
// DOM.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
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

describe("Sidebar", () => {
  test("renders empty state when there are no issues", () => {
    render(<Sidebar />);
    pushInit([]);
    expect(screen.getByText(/no issues yet/i)).toBeDefined();
  });

  test("renders rows sorted by createdAt descending", () => {
    const oldest = makeIssue({
      id: "DS-001",
      number: 1,
      title: "Oldest",
      status: "Planned",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const middle = makeIssue({
      id: "DS-002",
      number: 2,
      title: "Middle",
      status: "Planned",
      createdAt: "2025-02-01T00:00:00.000Z",
    });
    const newest = makeIssue({
      id: "DS-003",
      number: 3,
      title: "Newest",
      status: "Planned",
      createdAt: "2025-03-01T00:00:00.000Z",
    });
    render(<Sidebar />);
    pushInit([oldest, middle, newest]);

    const titles = screen.getAllByText(/^(Newest|Middle|Oldest)$/).map((el) => el.textContent);
    expect(titles).toEqual(["Newest", "Middle", "Oldest"]);
  });

  test("complete tickets hidden by default", () => {
    const planned = makeIssue({ id: "DS-001", title: "Plan me", status: "Planned" });
    const done = makeIssue({ id: "DS-002", title: "Shipped already", status: "Complete" });
    render(<Sidebar />);
    pushInit([planned, done]);

    expect(screen.queryByText("Plan me")).not.toBeNull();
    expect(screen.queryByText("Shipped already")).toBeNull();
  });

  test("toggling 'Show completed' reveals Complete tickets", async () => {
    const planned = makeIssue({ id: "DS-001", title: "Plan me", status: "Planned" });
    const done = makeIssue({ id: "DS-002", title: "Shipped already", status: "Complete" });
    render(<Sidebar />);
    pushInit([planned, done]);

    expect(screen.queryByText("Shipped already")).toBeNull();
    const toggle = screen.getByRole("checkbox", { name: /show completed/i });
    await userEvent.click(toggle);
    expect(screen.queryByText("Shipped already")).not.toBeNull();
  });

  test("Closed tickets hidden by default under the 'All' filter", () => {
    const planned = makeIssue({ id: "DS-001", title: "Plan me", status: "Planned" });
    const closed = makeIssue({ id: "DS-002", title: "Wont do this", status: "Closed" });
    render(<Sidebar />);
    pushInit([planned, closed]);

    expect(screen.queryByText("Plan me")).not.toBeNull();
    expect(screen.queryByText("Wont do this")).toBeNull();
  });

  test("type filter dropdown narrows to one issue type", async () => {
    const bug = makeIssue({ id: "DS-001", title: "Squash it", status: "Planned", type: "Bug" });
    const feature = makeIssue({
      id: "DS-002",
      title: "Ship it",
      status: "Planned",
      type: "Feature",
    });
    render(<Sidebar />);
    pushInit([bug, feature]);

    const typeSelect = screen.getByTitle("Filter by type") as HTMLSelectElement;
    await userEvent.selectOptions(typeSelect, "Bug");

    expect(screen.queryByText("Squash it")).not.toBeNull();
    expect(screen.queryByText("Ship it")).toBeNull();
  });

  test("priority filter dropdown narrows to one priority", async () => {
    const crit = makeIssue({
      id: "DS-001",
      title: "Urgent thing",
      status: "Planned",
      priority: "Critical",
    });
    const low = makeIssue({
      id: "DS-002",
      title: "Nice to have",
      status: "Planned",
      priority: "Low",
    });
    render(<Sidebar />);
    pushInit([crit, low]);

    const prioSelect = screen.getByTitle("Filter by priority") as HTMLSelectElement;
    await userEvent.selectOptions(prioSelect, "Critical");

    expect(screen.queryByText("Urgent thing")).not.toBeNull();
    expect(screen.queryByText("Nice to have")).toBeNull();
  });

  test("alphabetical sort orders by title", async () => {
    const c = makeIssue({ id: "DS-001", title: "Charlie", status: "Planned" });
    const a = makeIssue({ id: "DS-002", title: "Alpha", status: "Planned" });
    const b = makeIssue({ id: "DS-003", title: "Bravo", status: "Planned" });
    render(<Sidebar />);
    pushInit([c, a, b]);

    const sortSelect = screen.getByTitle("Sort order") as HTMLSelectElement;
    await userEvent.selectOptions(sortSelect, "alphabetical");

    const titles = screen
      .getAllByText(/^(Alpha|Bravo|Charlie)$/)
      .map((el) => el.textContent);
    expect(titles).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("search matches against tag substrings", async () => {
    const a = makeIssue({ id: "DS-001", title: "First", status: "Planned", tags: ["frontend"] });
    const b = makeIssue({ id: "DS-002", title: "Second", status: "Planned", tags: ["api"] });
    render(<Sidebar />);
    pushInit([a, b]);

    const input = screen.getByPlaceholderText(/search issues/i);
    await userEvent.type(input, "front");
    expect(screen.queryByText("First")).not.toBeNull();
    expect(screen.queryByText("Second")).toBeNull();
  });

  test("clicking the 'Closed' status chip reveals only Closed tickets", async () => {
    const planned = makeIssue({ id: "DS-001", title: "Plan me", status: "Planned" });
    const closed = makeIssue({ id: "DS-002", title: "Wont do this", status: "Closed" });
    render(<Sidebar />);
    pushInit([planned, closed]);

    expect(screen.queryByText("Wont do this")).toBeNull();
    const chip = screen
      .getAllByRole("button")
      .find((b) => /^Closed\s*\d+$/.test(b.textContent ?? ""))!;
    await userEvent.click(chip);

    expect(screen.queryByText("Wont do this")).not.toBeNull();
    expect(screen.queryByText("Plan me")).toBeNull();
  });

  test("clicking the 'Planned' status chip filters to Planned only", async () => {
    const planned = makeIssue({ id: "DS-001", title: "Plan me", status: "Planned" });
    const working = makeIssue({ id: "DS-002", title: "Crank on it", status: "Working" });
    render(<Sidebar />);
    pushInit([planned, working]);

    expect(screen.queryByText("Crank on it")).not.toBeNull();

    // chips are buttons containing the status name. There are multiple
    // (status meta dot etc.), so we match by exact button text via predicate.
    const chip = screen
      .getAllByRole("button")
      .find((b) => /^Planned\s*\d+$/.test(b.textContent ?? ""))!;
    await userEvent.click(chip);

    expect(screen.queryByText("Plan me")).not.toBeNull();
    expect(screen.queryByText("Crank on it")).toBeNull();
  });

  test("search filters by title (case-insensitive)", async () => {
    const a = makeIssue({ id: "DS-001", title: "Fix Auth Bug", status: "Planned" });
    const b = makeIssue({ id: "DS-002", title: "Polish UI", status: "Planned" });
    render(<Sidebar />);
    pushInit([a, b]);

    const input = screen.getByPlaceholderText(/search issues/i);
    await userEvent.type(input, "auth");

    expect(screen.queryByText("Fix Auth Bug")).not.toBeNull();
    expect(screen.queryByText("Polish UI")).toBeNull();
  });

  test("search filters by id", async () => {
    const a = makeIssue({ id: "DS-001", title: "First", status: "Planned" });
    const b = makeIssue({ id: "DS-002", title: "Second", status: "Planned" });
    render(<Sidebar />);
    pushInit([a, b]);

    const input = screen.getByPlaceholderText(/search issues/i);
    await userEvent.type(input, "DS-002");

    expect(screen.queryByText("Second")).not.toBeNull();
    expect(screen.queryByText("First")).toBeNull();
  });

  test("clicking a row toggles aria-expanded", async () => {
    const issue = makeIssue({ id: "DS-001", title: "Toggle me", status: "Planned" });
    render(<Sidebar />);
    pushInit([issue]);

    const row = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(row);
    // After clicking, the IssueDetail mounts. Re-query the row by aria-label.
    const refreshed = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(refreshed.getAttribute("aria-expanded")).toBe("true");
  });

  test("pressing Enter on a focused row toggles aria-expanded", () => {
    const issue = makeIssue({ id: "DS-001", title: "Press enter", status: "Planned" });
    render(<Sidebar />);
    pushInit([issue]);

    const row = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(row.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(row, { key: "Enter" });
    const refreshed = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(refreshed.getAttribute("aria-expanded")).toBe("true");
  });

  test("pressing Space on a focused row toggles aria-expanded", () => {
    const issue = makeIssue({ id: "DS-001", title: "Press space", status: "Planned" });
    render(<Sidebar />);
    pushInit([issue]);

    const row = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(row.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(row, { key: " " });
    const refreshed = screen.getByRole("button", { name: /Issue DS-001/i });
    expect(refreshed.getAttribute("aria-expanded")).toBe("true");
  });

  test("dispatching dostuff:showNewIssue event opens AddIssueModal", () => {
    render(<Sidebar />);
    pushInit([]);
    act(() => { window.dispatchEvent(new CustomEvent("dostuff:showNewIssue")); });
    expect(screen.queryByPlaceholderText(/short summary/i)).not.toBeNull();
  });

  test("right-clicking a row opens DeleteConfirmModal", async () => {
    const issue = makeIssue({ id: "DS-001", title: "Delete me", status: "Planned" });
    render(<Sidebar />);
    pushInit([issue]);

    const row = screen.getByRole("button", { name: /Issue DS-001/i });
    fireEvent.contextMenu(row);
    expect(screen.queryByText(/delete issue/i)).not.toBeNull();
  });

  // Sanity: the eslint-disable here avoids the unused-import warning on
  // `within`, which is exported for completeness for future tests.
  void within;
});
