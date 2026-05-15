// Modals tests: AddIssueModal + DeleteConfirmModal.
//
// Covered behavior:
//   - AddIssueModal mounts with title input autofocused.
//   - Empty title disables the Create button.
//   - Submit posts createIssue with status: "Thinking" (no status picker
//     in the modal — that was removed by fix-webview-agent).
//   - DeleteConfirmModal Confirm posts deleteIssue.
//   - Esc closes either modal.
//   - Backdrop click closes either modal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddIssueModal, DeleteConfirmModal } from "./Modals";
import {
  installVsCodeApi,
  makeIssue,
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

describe("AddIssueModal", () => {
  test("title input is autofocused on mount", () => {
    render(<AddIssueModal onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/short summary/i) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  test("empty title disables the Create button", async () => {
    render(<AddIssueModal onClose={() => {}} />);
    const create = screen.getByRole("button", { name: /^create$/i }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/short summary/i);
    await userEvent.type(input, "Has a title");
    expect(create.disabled).toBe(false);
  });

  test("submit posts createIssue with status: 'Thinking'", async () => {
    let closed = false;
    render(<AddIssueModal onClose={() => (closed = true)} />);

    const input = screen.getByPlaceholderText(/short summary/i);
    await userEvent.type(input, "Find the memory leak");

    const create = screen.getByRole("button", { name: /^create$/i });
    await userEvent.click(create);

    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { status: string; title: string } }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.status).toBe("Thinking");
    expect(msg!.partial.title).toBe("Find the memory leak");
    expect(closed).toBe(true);
  });

  test("status picker is not rendered (fix-webview-agent removed it)", () => {
    render(<AddIssueModal onClose={() => {}} />);
    // The modal has labels for Priority and Type but NOT Status. The label
    // text we expect to be absent is exactly "Status" on a form row.
    const labels = Array.from(document.querySelectorAll(".ds-form-row span")).map(
      (el) => el.textContent,
    );
    expect(labels).not.toContain("Status");
    // Sanity: it still has the expected fields.
    expect(labels).toContain("Title");
    expect(labels).toContain("Priority");
    expect(labels).toContain("Type");
  });

  test("Esc closes the modal", () => {
    let closed = false;
    render(<AddIssueModal onClose={() => (closed = true)} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(true);
  });

  test("clicking the backdrop closes the modal", async () => {
    let closed = false;
    render(<AddIssueModal onClose={() => (closed = true)} />);
    const backdrop = document.querySelector(".ds-modal-backdrop") as HTMLElement;
    await userEvent.click(backdrop);
    expect(closed).toBe(true);
  });
});

describe("DeleteConfirmModal", () => {
  test("clicking Delete posts deleteIssue and closes", async () => {
    const issue = makeIssue({ id: "DS-042", number: 42, title: "Doomed" });
    let closed = false;
    render(<DeleteConfirmModal issue={issue} onClose={() => (closed = true)} />);

    const del = screen.getByRole("button", { name: /^delete$/i });
    await userEvent.click(del);

    const msg = api.posted.find((m) => m.type === "deleteIssue") as
      | { type: "deleteIssue"; id: string }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.id).toBe("DS-042");
    expect(closed).toBe(true);
  });

  test("Esc closes the modal", () => {
    const issue = makeIssue({ id: "DS-001" });
    let closed = false;
    render(<DeleteConfirmModal issue={issue} onClose={() => (closed = true)} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(true);
  });

  test("clicking the backdrop closes the modal", async () => {
    const issue = makeIssue({ id: "DS-001" });
    let closed = false;
    render(<DeleteConfirmModal issue={issue} onClose={() => (closed = true)} />);
    const backdrop = document.querySelector(".ds-modal-backdrop") as HTMLElement;
    await userEvent.click(backdrop);
    expect(closed).toBe(true);
  });
});
