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
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddIssueModal, DeleteConfirmModal } from "./Modals";
import {
  dispatchHost,
  installVsCodeApi,
  makeIssue,
  pushInit,
  resetCounter,
  restoreVsCodeApi,
  type FakeVsCodeApi,
} from "./__tests__/testUtils";

/**
 * Push an `init` that opts attachments in by giving the modal a non-null
 * attachmentsBaseUri. Mirrors the helper pattern in IssueDetail.test.tsx.
 */
function enableAttachments(): void {
  pushInit([], {
    storagePath: ".vscode/dostuff",
    autoSave: true,
    activeLaneCap: 6,
    attachmentsBaseUri: "vscode-webview://atts",
  });
}

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

  test("backdrop has ds-panel-style class", () => {
    render(<AddIssueModal onClose={() => {}} />);
    const backdrop = document.querySelector(".ds-modal-backdrop") as HTMLElement;
    expect(backdrop.classList.contains("ds-panel-style")).toBe(true);
  });
});

describe("AddIssueModal: attachment staging", () => {
  test("+ button posts pickAttachmentForStaging when a workspace is open", async () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    const attachBtn = screen.getByRole("button", { name: /attach a file/i });
    expect((attachBtn as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(attachBtn);

    expect(api.posted.find((m) => m.type === "pickAttachmentForStaging")).toBeDefined();
  });

  test("+ button is disabled and empty-state copy nudges to open a folder when no workspace", () => {
    // pushInit defaults attachmentsBaseUri to null in testUtils.
    pushInit([]);
    render(<AddIssueModal onClose={() => {}} />);

    const attachBtn = screen.getByRole("button", { name: /attach a file/i }) as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(true);

    const empty = document.querySelector(".ds-att-empty")!;
    expect(empty.textContent).toMatch(/open a workspace folder/i);
  });

  test("dropping a file with bytes stages a chip locally (no host post)", async () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    const zone = document.querySelector(".ds-attachments") as HTMLDivElement;
    const file = new File([new Uint8Array([0x68, 0x69])], "notes.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [file], getData: () => "" },
      });
      // f.arrayBuffer() resolves on a microtask — yield so React commits the
      // setPendingAttachments call before we read the DOM.
      await new Promise((r) => setTimeout(r, 0));
    });

    const chipName = document.querySelector(".ds-att-name")!;
    expect(chipName.textContent).toBe("notes.txt");
    // Staging is purely local — no host message should go out for bytes drops.
    expect(api.posted.find((m) => m.type === "addAttachmentBytes")).toBeUndefined();
    expect(api.posted.find((m) => m.type === "stageAttachmentByUri")).toBeUndefined();
  });

  test("dropping with empty files but text/uri-list posts stageAttachmentByUri", async () => {
    // Remote-WSL fallback: webview can't read bytes itself, so it ships the
    // URI to the host for the round-trip.
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    const zone = document.querySelector(".ds-attachments") as HTMLDivElement;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        getData: (fmt: string) =>
          fmt === "text/uri-list"
            ? "file:///C:/Users/me/screenshot.png\r\nfile:///C:/Users/me/notes.txt"
            : "",
      },
    });

    const uriMsgs = api.posted.filter((m) => m.type === "stageAttachmentByUri") as Array<{
      type: "stageAttachmentByUri";
      uri: string;
    }>;
    expect(uriMsgs.map((m) => m.uri)).toEqual([
      "file:///C:/Users/me/screenshot.png",
      "file:///C:/Users/me/notes.txt",
    ]);
  });

  test("drop is a no-op when attachments are disabled", async () => {
    pushInit([]); // attachmentsBaseUri: null
    render(<AddIssueModal onClose={() => {}} />);

    const zone = document.querySelector(".ds-attachments") as HTMLDivElement;
    const file = new File([new Uint8Array([0x00])], "noop.bin", { type: "application/octet-stream" });
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: {
          files: [file],
          getData: (fmt: string) =>
            fmt === "text/uri-list" ? "file:///should/be/ignored" : "",
        },
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    // No chip rendered, no host posts.
    expect(document.querySelector(".ds-att-chip")).toBeNull();
    expect(api.posted.find((m) => m.type === "stageAttachmentByUri")).toBeUndefined();
  });

  test("host attachmentStaged event appends a chip with the bytes", () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    act(() => {
      dispatchHost({
        type: "attachmentStaged",
        name: "from-picker.txt",
        mimeType: "text/plain",
        bytes: [104, 105],
      });
    });

    const chipName = document.querySelector(".ds-att-name")!;
    expect(chipName.textContent).toBe("from-picker.txt");
    const size = document.querySelector(".ds-att-size")!;
    // 2 bytes formatted by formatBytes() — "2 B".
    expect(size.textContent).toBe("2 B");
  });

  test("clicking a chip's × removes it from staging", async () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    act(() => {
      dispatchHost({
        type: "attachmentStaged",
        name: "to-remove.txt",
        mimeType: "text/plain",
        bytes: [1, 2, 3],
      });
    });
    expect(document.querySelector(".ds-att-name")!.textContent).toBe("to-remove.txt");

    const removeBtn = screen.getByRole("button", { name: /remove attachment/i });
    await userEvent.click(removeBtn);

    expect(document.querySelector(".ds-att-chip")).toBeNull();
  });

  test("submit packs staged attachments into createIssue.partial.attachments", async () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    act(() => {
      dispatchHost({
        type: "attachmentStaged",
        name: "a.txt",
        mimeType: "text/plain",
        bytes: [10, 11],
      });
      dispatchHost({
        type: "attachmentStaged",
        name: "b.png",
        mimeType: "image/png",
        bytes: [20, 21, 22],
      });
    });

    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "Has attachments");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const msg = api.posted.find((m) => m.type === "createIssue") as
      | {
          type: "createIssue";
          partial: {
            title: string;
            attachments?: Array<{ name: string; mimeType: string; bytes: number[] }>;
          };
        }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.title).toBe("Has attachments");
    expect(msg!.partial.attachments).toEqual([
      { name: "a.txt", mimeType: "text/plain", bytes: [10, 11] },
      { name: "b.png", mimeType: "image/png", bytes: [20, 21, 22] },
    ]);
  });

  test("submit without staged attachments omits the attachments key", async () => {
    enableAttachments();
    render(<AddIssueModal onClose={() => {}} />);

    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "No attachments");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { attachments?: unknown } }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.attachments).toBeUndefined();
  });

  test("Esc-closing the modal with staged attachments discards them silently", () => {
    enableAttachments();
    let closed = false;
    render(<AddIssueModal onClose={() => (closed = true)} />);

    act(() => {
      dispatchHost({
        type: "attachmentStaged",
        name: "discarded.txt",
        mimeType: "text/plain",
        bytes: [9, 9, 9],
      });
    });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(closed).toBe(true);
    // No createIssue went out — the bytes only lived in modal state.
    expect(api.posted.find((m) => m.type === "createIssue")).toBeUndefined();
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

describe("AddIssueModal: links staging", () => {
  test("submit packs staged links into createIssue.partial.links", async () => {
    // Seed an existing ticket so the LinkEditor typeahead has something to find.
    pushInit([makeIssue({ id: "DS-002", number: 2, title: "CSV export" })]);
    render(<AddIssueModal onClose={() => {}} />);

    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "Needs CSV");
    // Add a link via the editor typeahead.
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "csv");
    const opt = within(screen.getByRole("listbox")).getByRole("option");
    fireEvent.mouseDown(within(opt).getByRole("button"));

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { links?: Array<{ targetId: string; kind: string }> } }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.links).toEqual([{ targetId: "DS-002", kind: "relates-to" }]);
  });

  test("submit without staged links omits the links key", async () => {
    pushInit([makeIssue({ id: "DS-002", number: 2, title: "CSV export" })]);
    render(<AddIssueModal onClose={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "No links");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { links?: unknown } }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.links).toBeUndefined();
  });

  test("inverse options are offered in the modal and staged into inboundLinks", async () => {
    pushInit([makeIssue({ id: "DS-002", number: 2, title: "CSV blocker" })]);
    render(<AddIssueModal onClose={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "Needs unblocking");

    // Modal now offers inverse kinds.
    const opts = Array.from(screen.getByLabelText(/link kind/i).querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(opts).toContain("blocked-by");

    // "blocked by DS-002" ⇒ host should store {DS-002 blocks new ticket}.
    fireEvent.change(screen.getByLabelText(/link kind/i), { target: { value: "blocked-by" } });
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "csv");
    fireEvent.mouseDown(within(within(screen.getByRole("listbox")).getByRole("option")).getByRole("button"));

    // A staged inbound chip is shown for feedback (its remove button is unique).
    expect(screen.getByRole("button", { name: /remove link from DS-002/i })).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { links?: unknown; inboundLinks?: Array<{ sourceId: string; kind: string }> } }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.partial.links).toBeUndefined(); // forward list empty
    expect(msg!.partial.inboundLinks).toEqual([{ sourceId: "DS-002", kind: "blocks" }]);
  });

  test("a staged inbound chip can be removed before submit", async () => {
    pushInit([makeIssue({ id: "DS-002", number: 2, title: "CSV blocker" })]);
    render(<AddIssueModal onClose={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/short summary/i), "x");
    fireEvent.change(screen.getByLabelText(/link kind/i), { target: { value: "blocked-by" } });
    await userEvent.type(screen.getByPlaceholderText(/link a ticket/i), "csv");
    fireEvent.mouseDown(within(within(screen.getByRole("listbox")).getByRole("option")).getByRole("button"));

    await userEvent.click(screen.getByRole("button", { name: /remove link from DS-002/i }));

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    const msg = api.posted.find((m) => m.type === "createIssue") as
      | { type: "createIssue"; partial: { inboundLinks?: unknown } }
      | undefined;
    expect(msg!.partial.inboundLinks).toBeUndefined();
  });
});
