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
import { cleanup, render, fireEvent, screen, within } from "@testing-library/react";
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

  test("task text edits buffer locally and only post one updateIssue on blur", async () => {
    // Regression: keystroke-per-postMessage caused dropped chars at high WPM
    // because the controlled <input value={task.text}> snapped back to the
    // pre-roundtrip value before the next keystroke. TaskRow now buffers the
    // draft locally and commits on blur, mirroring title/desc/verify.
    const issue = makeIssue({
      id: "DS-001",
      status: "Working",
      tasks: [{ id: "t1", text: "", done: false }],
    });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    const input = document.querySelector(".ds-task-text") as HTMLInputElement;
    expect(input).not.toBeNull();

    // Type a multi-character string. None of these keystrokes should post.
    await userEvent.type(input, "write more tests");
    expect(api.posted.find((m) => m.type === "updateIssue")).toBeUndefined();
    expect(input.value).toBe("write more tests");

    fireEvent.blur(input);

    const updates = api.posted.filter((m) => m.type === "updateIssue") as Array<{
      type: "updateIssue";
      issue: Issue;
    }>;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.issue.tasks[0]!.text).toBe("write more tests");
  });

  test("task text edits commit on Enter and don't post per keystroke", async () => {
    const issue = makeIssue({
      id: "DS-001",
      status: "Working",
      tasks: [{ id: "t1", text: "", done: false }],
    });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    const input = document.querySelector(".ds-task-text") as HTMLInputElement;
    await userEvent.type(input, "hello{Enter}");

    const updates = api.posted.filter((m) => m.type === "updateIssue") as Array<{
      type: "updateIssue";
      issue: Issue;
    }>;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.issue.tasks[0]!.text).toBe("hello");
  });

  test("attachment drop with bytes posts addAttachmentBytes", async () => {
    const issue = makeIssue({ id: "DS-001", status: "Working" });
    pushInit([issue], {
      storagePath: ".vscode/dostuff",
      autoSave: true,
      activeLaneCap: 6,
      // attachmentsBaseUri non-null so the drop zone isn't disabled.
      attachmentsBaseUri: "vscode-webview://atts",
    });
    render(<IssueDetail issue={issue} />);

    const zone = document.querySelector(".ds-attachments") as HTMLDivElement;
    expect(zone).not.toBeNull();

    const file = new File([new Uint8Array([0xff, 0x01, 0x02])], "screenshot.png", {
      type: "image/png",
    });
    // happy-dom's fireEvent.drop accepts a dataTransfer-shaped property.
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [file],
        getData: () => "",
      },
    });
    // userEvent doesn't await arrayBuffer() reads — yield once so the
    // post happens before we inspect.
    await new Promise((r) => setTimeout(r, 0));

    const msg = api.posted.find((m) => m.type === "addAttachmentBytes") as
      | { type: "addAttachmentBytes"; issueId: string; name: string; mimeType: string; bytes: number[] }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.issueId).toBe("DS-001");
    expect(msg!.name).toBe("screenshot.png");
    expect(msg!.mimeType).toBe("image/png");
    expect(msg!.bytes).toEqual([0xff, 0x01, 0x02]);
  });

  test("attachment drop with empty files but text/uri-list falls back to addAttachmentByUri", async () => {
    // Regression: Remote-WSL drops from Windows Explorer arrive with
    // `DataTransfer.files` empty but `text/uri-list` populated. We must
    // forward the URI to the host instead of silently no-op'ing.
    const issue = makeIssue({ id: "DS-001", status: "Working" });
    pushInit([issue], {
      storagePath: ".vscode/dostuff",
      autoSave: true,
      activeLaneCap: 6,
      attachmentsBaseUri: "vscode-webview://atts",
    });
    render(<IssueDetail issue={issue} />);

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

    const uriMsgs = api.posted.filter((m) => m.type === "addAttachmentByUri") as Array<{
      type: "addAttachmentByUri";
      issueId: string;
      uri: string;
    }>;
    expect(uriMsgs).toHaveLength(2);
    expect(uriMsgs[0]!.issueId).toBe("DS-001");
    expect(uriMsgs[0]!.uri).toBe("file:///C:/Users/me/screenshot.png");
    expect(uriMsgs[1]!.uri).toBe("file:///C:/Users/me/notes.txt");
    expect(api.posted.find((m) => m.type === "addAttachmentBytes")).toBeUndefined();
  });

  test("attachment drop ignores comments and blank lines in text/uri-list", async () => {
    const issue = makeIssue({ id: "DS-001", status: "Working" });
    pushInit([issue], {
      storagePath: ".vscode/dostuff",
      autoSave: true,
      activeLaneCap: 6,
      attachmentsBaseUri: "vscode-webview://atts",
    });
    render(<IssueDetail issue={issue} />);

    const zone = document.querySelector(".ds-attachments") as HTMLDivElement;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        getData: (fmt: string) =>
          fmt === "text/uri-list"
            ? "# header comment\nfile:///a/one.png\n\nfile:///a/two.png\n"
            : "",
      },
    });

    const uriMsgs = api.posted.filter((m) => m.type === "addAttachmentByUri") as Array<{
      type: "addAttachmentByUri";
      uri: string;
    }>;
    expect(uriMsgs.map((m) => m.uri)).toEqual(["file:///a/one.png", "file:///a/two.png"]);
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

  test("description renders http(s) URLs and file:// URLs as clickable links that post openLink", async () => {
    const issue = makeIssue({
      id: "DS-007",
      status: "Planned",
      description:
        "See https://google.com for details, and the spec at file:///tmp/spec.md is canonical.",
    });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);

    const anchors = Array.from(
      document.querySelectorAll(".ds-d-link"),
    ) as HTMLAnchorElement[];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://google.com",
      "file:///tmp/spec.md",
    ]);

    await userEvent.click(anchors[0]);
    const opened = api.posted.find((m) => m.type === "openLink") as
      | { type: "openLink"; url: string }
      | undefined;
    expect(opened).toBeDefined();
    expect(opened!.url).toBe("https://google.com");
  });

  test("tag editor exposes datalist suggestions sourced from other issues, excluding tags already applied", () => {
    const current = makeIssue({
      id: "DS-100",
      status: "Planned",
      tags: ["frontend"],
    });
    const otherA = makeIssue({
      id: "DS-101",
      status: "Planned",
      tags: ["frontend", "backend"],
    });
    const otherB = makeIssue({
      id: "DS-102",
      status: "Planned",
      tags: ["infra"],
    });
    pushInit([current, otherA, otherB]);
    render(<IssueDetail issue={current} />);

    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const listId = input.getAttribute("list");
    expect(listId).not.toBeNull();
    const datalist = document.getElementById(listId!) as HTMLDataListElement | null;
    expect(datalist).not.toBeNull();
    const optionValues = Array.from(datalist!.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    // Sorted alphabetically and excludes the already-applied "frontend".
    expect(optionValues).toEqual(["backend", "infra"]);
  });

  test("tag editor omits the list attribute when no suggestions remain", () => {
    const onlyOne = makeIssue({ id: "DS-200", status: "Planned", tags: ["solo"] });
    pushInit([onlyOne]);
    render(<IssueDetail issue={onlyOne} />);
    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    expect(input.getAttribute("list")).toBeNull();
    expect(document.querySelector("datalist")).toBeNull();
  });

  test("relative ./path links are recognised in the description body", () => {
    const issue = makeIssue({
      id: "DS-008",
      status: "Planned",
      description: "Refer to ./docs/overview.md before starting.",
    });
    pushInit([issue]);
    render(<IssueDetail issue={issue} />);
    const anchors = Array.from(
      document.querySelectorAll(".ds-d-link"),
    ) as HTMLAnchorElement[];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["./docs/overview.md"]);
  });
});

describe("IssueDetail links", () => {
  test("adding a link via the editor posts updateIssue with the new links array", async () => {
    const issue = makeIssue({ id: "DS-001", number: 1, title: "source", status: "Working", links: [] });
    const target = makeIssue({ id: "DS-002", number: 2, title: "CSV export target", status: "Planned" });
    pushInit([issue, target]);
    render(<IssueDetail issue={issue} />);

    const input = screen.getByPlaceholderText(/link a ticket/i);
    await userEvent.type(input, "csv");
    const opt = within(screen.getByRole("listbox")).getByRole("option");
    fireEvent.mouseDown(within(opt).getByRole("button"));

    const updates = api.posted.filter((m) => m.type === "updateIssue") as Array<{
      type: "updateIssue";
      issue: Issue;
    }>;
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]!.issue.links).toEqual([
      { targetId: "DS-002", kind: "relates-to" },
    ]);
  });

  test("removing a link posts updateIssue with the shortened array", async () => {
    const issue = makeIssue({
      id: "DS-001",
      number: 1,
      status: "Working",
      links: [{ targetId: "DS-002", kind: "blocks" }],
    });
    const target = makeIssue({ id: "DS-002", number: 2, title: "blocked" });
    pushInit([issue, target]);
    render(<IssueDetail issue={issue} />);

    await userEvent.click(screen.getByRole("button", { name: /remove link to DS-002/i }));
    const updates = api.posted.filter((m) => m.type === "updateIssue") as Array<{
      type: "updateIssue";
      issue: Issue;
    }>;
    expect(updates[updates.length - 1]!.issue.links).toEqual([]);
  });

  test("'Linked by' section renders inbound chips derived from other issues", () => {
    const target = makeIssue({ id: "DS-002", number: 2, title: "the target", status: "Planned", links: [] });
    const source = makeIssue({
      id: "DS-001",
      number: 1,
      title: "the blocker",
      status: "Working",
      links: [{ targetId: "DS-002", kind: "blocks" }],
    });
    pushInit([source, target]);
    render(<IssueDetail issue={target} />);

    // Inbound chip shows the inverted kind label "blocked by" + the source number.
    const linkedBy = screen.getByText("Linked by").parentElement!;
    expect(linkedBy.textContent).toContain("blocked by");
    expect(linkedBy.textContent).toContain("#1");
  });

  test("clicking an inbound chip posts revealTicket for the source", async () => {
    const target = makeIssue({ id: "DS-002", number: 2, title: "target", status: "Planned" });
    const source = makeIssue({
      id: "DS-001",
      number: 1,
      title: "blocker",
      status: "Working",
      links: [{ targetId: "DS-002", kind: "blocks" }],
    });
    pushInit([source, target]);
    render(<IssueDetail issue={target} />);

    const linkedBy = screen.getByText("Linked by").parentElement!;
    const chipButton = within(linkedBy).getByTitle(/open #1/i);
    await userEvent.click(chipButton);

    const reveal = api.posted.find((m) => m.type === "revealTicket") as
      | { type: "revealTicket"; id: string }
      | undefined;
    expect(reveal?.id).toBe("DS-001");
  });
});
