// Tests for the TagEditor primitive. Focus: the stale-prop race that bit two
// rapid Enter commits before SQLite (and now post-SQLite even more so).
//
// The component used to compute the new tag list from `tags` (prop) each
// commit. Because the IssueDetail caller wires `onChange = postUpdateIssue`,
// the prop only updates after a host round-trip. Two Enters within a single
// round-trip therefore both read the same stale array and the second post
// overwrote the first. The fix: local mirror state + `lastSentRef` so prop
// echoes don't clobber unflushed local edits.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TagEditor } from "./Tags";

afterEach(() => {
  cleanup();
});

describe("TagEditor", () => {
  test("two rapid Enter commits without prop-echo do NOT lose the first tag", async () => {
    const onChange = (() => {
      const calls: string[][] = [];
      const fn = (next: string[]) => calls.push(next);
      (fn as unknown as { calls: string[][] }).calls = calls;
      return fn as unknown as ((next: string[]) => void) & { calls: string[][] };
    })();

    // Render with a static `tags` prop that NEVER updates — simulates a host
    // whose echo arrives after both commits have already fired.
    render(<TagEditor tags={["x"]} onChange={onChange} />);

    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    await userEvent.type(input, "alpha{Enter}");
    await userEvent.type(input, "beta{Enter}");

    expect(onChange.calls).toHaveLength(2);
    expect(onChange.calls[0]).toEqual(["x", "alpha"]);
    // Pre-fix this was ["x", "beta"] — "alpha" was lost.
    expect(onChange.calls[1]).toEqual(["x", "alpha", "beta"]);

    // UI also shows all three chips.
    const chips = Array.from(document.querySelectorAll(".ds-tag-chip-edit")).map((el) =>
      (el.textContent ?? "").replace(/×$/, "").trim(),
    );
    expect(chips).toEqual(["x", "alpha", "beta"]);
  });

  test("backspace on empty draft removes the last tag and posts the updated list", async () => {
    const calls: string[][] = [];
    render(<TagEditor tags={["a", "b"]} onChange={(next) => calls.push(next)} />);
    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(calls).toEqual([["a"]]);
  });

  test("comma key commits the draft same as Enter", async () => {
    const calls: string[][] = [];
    render(<TagEditor tags={[]} onChange={(next) => calls.push(next)} />);
    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    await userEvent.type(input, "alpha,");
    expect(calls).toEqual([["alpha"]]);
  });

  test("commit ignores a duplicate (case-insensitive) without re-posting", async () => {
    const calls: string[][] = [];
    render(<TagEditor tags={["Alpha"]} onChange={(next) => calls.push(next)} />);
    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    await userEvent.type(input, "alpha{Enter}");
    expect(calls).toHaveLength(0);
    expect(input.value).toBe("");
  });

  test("post-mount prop change is NOT adopted (local mirror is authoritative)", () => {
    // Contract: once the editor has mounted, the parent owning a different
    // copy of `tags` does not override the local view. We can't reliably
    // distinguish a stale echo from an intentional rewrite, and the user
    // study said losing in-flight local edits is the worse failure. Callers
    // must remount (key={entityId}) when they actually want a reset.
    function Harness() {
      const [tags, setTags] = useState<string[]>(["x"]);
      return (
        <>
          <button data-testid="rewrite" onClick={() => setTags(["foo", "bar"])}>rewrite</button>
          <TagEditor tags={tags} onChange={() => {}} />
        </>
      );
    }
    render(<Harness />);
    expect(Array.from(document.querySelectorAll(".ds-tag-chip-edit")).length).toBe(1);
    act(() => {
      (document.querySelector('[data-testid="rewrite"]') as HTMLButtonElement).click();
    });
    // Still showing the initial ["x"], not the rewritten ["foo","bar"].
    const chips = Array.from(document.querySelectorAll(".ds-tag-chip-edit")).map((el) =>
      (el.textContent ?? "").replace(/×$/, "").trim(),
    );
    expect(chips).toEqual(["x"]);
  });

  test("late-arriving echo of an older commit does NOT clobber a newer local edit", async () => {
    function Harness() {
      const [tags, setTags] = useState<string[]>(["x"]);
      return (
        <>
          <button data-testid="echo-old" onClick={() => setTags(["x", "alpha"])}>echo</button>
          <TagEditor tags={tags} onChange={setTags} />
        </>
      );
    }
    render(<Harness />);
    const input = document.querySelector(".ds-tag-edit-input") as HTMLInputElement;
    await userEvent.type(input, "alpha{Enter}");
    await userEvent.type(input, "beta{Enter}");

    // Simulate a late echo whose payload matches the first commit's state.
    // Pre-fix this would have set localTags back to ["x","alpha"] and lost "beta".
    act(() => {
      (document.querySelector('[data-testid="echo-old"]') as HTMLButtonElement).click();
    });

    const chips = Array.from(document.querySelectorAll(".ds-tag-chip-edit")).map((el) =>
      (el.textContent ?? "").replace(/×$/, "").trim(),
    );
    expect(chips).toEqual(["x", "alpha", "beta"]);
  });

  test("`key` prop remount resets local state to a fresh `tags` value", async () => {
    // Verifies that the documented "remount to reset" contract works — this
    // is how IssueDetail handles ticket switches without needing prop-sync.
    function Harness() {
      const [issueId, setIssueId] = useState("A");
      const [tagsForA] = useState<string[]>(["from-A"]);
      const [tagsForB] = useState<string[]>(["from-B"]);
      const tags = issueId === "A" ? tagsForA : tagsForB;
      return (
        <>
          <button data-testid="switch" onClick={() => setIssueId("B")}>switch</button>
          <TagEditor key={issueId} tags={tags} onChange={() => {}} />
        </>
      );
    }
    render(<Harness />);
    let chips = Array.from(document.querySelectorAll(".ds-tag-chip-edit")).map((el) =>
      (el.textContent ?? "").replace(/×$/, "").trim(),
    );
    expect(chips).toEqual(["from-A"]);

    act(() => {
      (document.querySelector('[data-testid="switch"]') as HTMLButtonElement).click();
    });

    chips = Array.from(document.querySelectorAll(".ds-tag-chip-edit")).map((el) =>
      (el.textContent ?? "").replace(/×$/, "").trim(),
    );
    expect(chips).toEqual(["from-B"]);
  });
});
