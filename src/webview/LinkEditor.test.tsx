// LinkEditor tests: typeahead filtering by id/title, kind selection, commit,
// removal, exclusion of self + already-linked, and the rapid-commit local
// mirror (mirrors the TagEditor race test).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LinkEditor } from "./LinkEditor";
import type { Issue, TicketLink } from "../types";
import { installVsCodeApi, makeIssue, resetCounter, restoreVsCodeApi } from "./__tests__/testUtils";

let allIssues: Issue[];

beforeEach(() => {
  resetCounter();
  installVsCodeApi();
  allIssues = [
    makeIssue({ id: "DS-001", number: 1, title: "Fix OAuth login" }),
    makeIssue({ id: "DS-002", number: 2, title: "Add CSV export" }),
    makeIssue({ id: "DS-042", number: 42, title: "OAuth refresh tokens" }),
  ];
});

afterEach(() => {
  cleanup();
  restoreVsCodeApi();
});

function lastCall(calls: TicketLink[][]): TicketLink[] {
  return calls[calls.length - 1]!;
}

describe("LinkEditor typeahead", () => {
  test("typing a title substring surfaces matching tickets", async () => {
    render(<LinkEditor value={[]} onChange={() => {}} allIssues={allIssues} currentIssueId="DS-099" />);
    const input = screen.getByPlaceholderText(/link a ticket/i);
    await userEvent.type(input, "oauth");
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    const text = options.map((o) => o.textContent).join(" ");
    expect(text).toContain("Fix OAuth login");
    expect(text).toContain("OAuth refresh tokens");
    expect(text).not.toContain("CSV export");
  });

  test("typing a ticket number surfaces the exact ticket", async () => {
    render(<LinkEditor value={[]} onChange={() => {}} allIssues={allIssues} currentIssueId="DS-099" />);
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "42");
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("OAuth refresh tokens");
  });

  test("excludes the current issue from results", async () => {
    render(<LinkEditor value={[]} onChange={() => {}} allIssues={allIssues} currentIssueId="DS-001" />);
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "oauth");
    const text = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent)
      .join(" ");
    expect(text).not.toContain("Fix OAuth login");
    expect(text).toContain("OAuth refresh tokens");
  });

  test("excludes already-linked targets from results", async () => {
    render(
      <LinkEditor
        value={[{ targetId: "DS-042", kind: "blocks" }]}
        onChange={() => {}}
        allIssues={allIssues}
        currentIssueId="DS-099"
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "oauth");
    const text = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent)
      .join(" ");
    expect(text).toContain("Fix OAuth login");
    expect(text).not.toContain("OAuth refresh tokens");
  });
});

describe("LinkEditor commit + kind", () => {
  test("clicking a result commits a link with the selected kind", async () => {
    const calls: TicketLink[][] = [];
    render(
      <LinkEditor
        value={[]}
        onChange={(n) => calls.push(n)}
        allIssues={allIssues}
        currentIssueId="DS-099"
      />,
    );
    // pick a kind first
    fireEvent.change(screen.getByLabelText(/link kind/i), { target: { value: "blocks" } });
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "csv");
    const option = within(screen.getByRole("listbox")).getByRole("option");
    fireEvent.mouseDown(within(option).getByRole("button"));
    expect(lastCall(calls)).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });

  test("default kind is relates-to", async () => {
    const calls: TicketLink[][] = [];
    render(
      <LinkEditor value={[]} onChange={(n) => calls.push(n)} allIssues={allIssues} currentIssueId="DS-099" />,
    );
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "csv");
    const opt = within(screen.getByRole("listbox")).getByRole("option");
    fireEvent.mouseDown(within(opt).getByRole("button"));
    expect(lastCall(calls)).toEqual([{ targetId: "DS-002", kind: "relates-to" }]);
  });

  test("Enter commits the top result", async () => {
    const calls: TicketLink[][] = [];
    render(
      <LinkEditor value={[]} onChange={(n) => calls.push(n)} allIssues={allIssues} currentIssueId="DS-099" />,
    );
    const input = screen.getByPlaceholderText(/link a ticket/i);
    await userEvent.type(input, "42");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(lastCall(calls)).toEqual([{ targetId: "DS-042", kind: "relates-to" }]);
  });

  test("removing a chip emits the shortened array", async () => {
    const calls: TicketLink[][] = [];
    render(
      <LinkEditor
        value={[{ targetId: "DS-001", kind: "blocks" }]}
        onChange={(n) => calls.push(n)}
        allIssues={allIssues}
        currentIssueId="DS-099"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove link to DS-001/i }));
    expect(lastCall(calls)).toEqual([]);
  });

  test("two rapid commits do not lose the first (local mirror)", async () => {
    const calls: TicketLink[][] = [];
    render(
      <LinkEditor
        value={[]}
        onChange={(n) => calls.push(n)}
        allIssues={allIssues}
        currentIssueId="DS-099"
      />,
    );
    const input = screen.getByPlaceholderText(/link a ticket/i);
    await userEvent.type(input, "42");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await userEvent.clear(input);
      await userEvent.type(input, "csv");
    });
    fireEvent.keyDown(input, { key: "Enter" });
    // The prop never updates (parent doesn't echo); the mirror must retain both.
    expect(lastCall(calls).map((l) => l.targetId).sort()).toEqual(["DS-002", "DS-042"]);
  });
});
