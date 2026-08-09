// Not a regression test — a measurement harness. Verification step 3 of the
// MCP token-cost plan says measure the win, don't infer it. Run with:
//   bun test -t "MEASURE"
// It asserts only the direction (new < old); the numbers are printed for the PR.
import { test, describe, expect } from "bun:test";
import { publicView, summaryView, statusView, WORKFLOW_POINTER } from "./mcpServer";
import { makeIssueFactory } from "./testSupport";

const makeIssue = makeIssueFactory();

const LOREM =
  "The sync loop clobbers ticket edits when two VSCode windows are open on the " +
  "same workspace: both hold an in-memory sql.js image and the last wholesale " +
  "rewrite wins, silently discarding the other window's changes.";

// `commitCount` defaults to 6: rule 3 tells agents to report a sha on every
// commit, so a ticket that reached Verification has accumulated several. An
// earlier version of this fixture left `commits` empty, which made the
// commit-demotion lever measure ~13 ch instead of its real cost.
function board(n: number, recordEntries: number, commitCount = 6) {
  makeIssue.reset();
  return Array.from({ length: n }, (_, i) =>
    makeIssue({
      commits: Array.from({ length: commitCount }, (_, c) => ({
        sha: `${c}`.padStart(40, "abcdef0123456789"),
        at: `2025-06-0${(c % 9) + 1}T00:00:00.000Z`,
      })),
      id: `DS-${String(i + 1).padStart(3, "0")}`,
      number: i + 1,
      title: `Fix the sync clobber affecting concurrent windows (${i + 1})`,
      status: "Working",
      tags: ["sync", "storage"],
      description: `## Context\n\n${LOREM}\n\n### Detail\n\n${"Further prose. ".repeat(40)}`,
      verifyCriteria: "Two windows editing the same ticket must both survive a sync.",
      tasks: Array.from({ length: 8 }, (_, t) => ({
        id: `t-${"0123456789abcdef".repeat(2)}-${t}`,
        text: `Task number ${t}`,
        done: t < 3,
      })),
      record: Array.from({ length: recordEntries }, (_, r) => ({
        at: `2025-06-0${(r % 9) + 1}T00:00:00.000Z`,
        author: "agent" as const,
        text: `Investigated the ${r}th angle; wrote a probe and confirmed the ref advanced.`,
      })),
    }),
  );
}

const pct = (before: number, after: number) =>
  `${(((before - after) / before) * 100).toFixed(1)}%`;

describe("MEASURE mcp payload sizes", () => {
  test("collection resource: full bodies vs summary rows", () => {
    const rows: string[] = [];
    for (const n of [6, 25, 50]) {
      const all = board(n, 20);
      const before = JSON.stringify(
        { workspace: null, workflow: WORKFLOW_POINTER, tickets: all.map((i) => publicView(i, all)) },
        null,
        2,
      ).length;
      const after = JSON.stringify({
        workspace: null,
        workflow: WORKFLOW_POINTER,
        count: all.length,
        detailUriTemplate: "dostuff://tickets/{id}",
        tickets: all.map(summaryView),
      }).length;
      rows.push(
        `  ${String(n).padStart(2)} tickets: ${String(before).padStart(7)} -> ${String(after).padStart(6)} ch  (${pct(before, after)})`,
      );
      expect(after).toBeLessThan(before);
    }
    console.log("\ndostuff://tickets\n" + rows.join("\n"));
  });

  test("update_ticket_progress echo: every task vs only the changed one", () => {
    const rows: string[] = [];
    for (const [n, idLen] of [
      [12, 38],
      [12, 15],
      [30, 15],
    ] as const) {
      const tasks = Array.from({ length: n }, (_, i) => ({
        id: idLen === 38 ? `t-${"0123456789abcdef".repeat(2)}-${i}` : `tm8x2k1ab${i}`,
        done: i < 3,
      }));
      const before = JSON.stringify(
        {
          workspace: null,
          id: "DS-001",
          tasks: tasks.map((t) => ({ id: t.id, done: t.done })),
          recordLength: 4,
          commitCount: 1,
        },
        null,
        2,
      ).length;
      const after = JSON.stringify(
        {
          workspace: null,
          id: "DS-001",
          tasksChanged: [{ id: tasks[5].id, done: true }],
          tasks: { total: n, done: 4 },
          recordLength: 4,
          commitCount: 1,
        },
        null,
        2,
      ).length;
      rows.push(
        `  ${String(n).padStart(2)} tasks, ${idLen}-char ids: ${String(before).padStart(4)} -> ${String(after).padStart(3)} ch  (${pct(before, after)})`,
      );
      expect(after).toBeLessThan(before);
    }
    console.log("\nupdate_ticket_progress echo\n" + rows.join("\n"));
  });

  test("get_ticket: full vs record-windowed vs status view", () => {
    const rows: string[] = [];
    for (const entries of [5, 16, 40]) {
      const [issue] = board(1, entries);
      const full = JSON.stringify(
        { workspace: null, workflow: WORKFLOW_POINTER, ticket: publicView(issue, []) },
        null,
        2,
      ).length;
      const windowed = JSON.stringify(
        {
          workspace: null,
          workflow: WORKFLOW_POINTER,
          ticket: publicView(issue, [], { recordLimit: 10 }),
        },
        null,
        2,
      ).length;
      const status = JSON.stringify({ workspace: null, ticket: statusView(issue) }, null, 2).length;
      rows.push(
        `  ${String(entries).padStart(2)} record entries: full ${String(full).padStart(6)} -> windowed ${String(windowed).padStart(6)} ch (${pct(full, windowed)})  |  view:"status" ${status} ch (${pct(full, status)})`,
      );
      expect(status).toBeLessThan(full);
    }
    console.log("\nget_ticket\n" + rows.join("\n"));
  });

  test("get_ticket: PR4 levers composed, and where the bytes actually are", () => {
    const [issue] = board(1, 16);
    const wrap = (t: unknown) => ({ workspace: null, workflow: WORKFLOW_POINTER, ticket: t });

    // The four levers applied in order, each on top of the last.
    const baseline = JSON.stringify(wrap(publicView(issue, [], { recordLimit: 10 })), null, 2).length;
    const compact = JSON.stringify(wrap(publicView(issue, [], { recordLimit: 10 }))).length;
    const record3 = JSON.stringify(wrap(publicView(issue, [], { recordLimit: 3 }))).length;
    const demoted = JSON.stringify(
      wrap(publicView(issue, [], { recordLimit: 3, include: [] })),
    ).length;

    console.log(
      "\nget_ticket, PR4 levers composed (16 record entries)" +
        `\n  baseline (pretty, record 10)   ${String(baseline).padStart(5)} ch` +
        `\n  + compact JSON                 ${String(compact).padStart(5)} ch  (${pct(baseline, compact)})` +
        `\n  + record default 3             ${String(record3).padStart(5)} ch  (${pct(baseline, record3)})` +
        `\n  + commits demoted              ${String(demoted).padStart(5)} ch  (${pct(baseline, demoted)} total)`,
    );
    expect(demoted).toBeLessThan(baseline);

    // Per-key breakdown of the baseline — the number that decided PR4's order.
    const view = publicView(issue, [], { recordLimit: 10 }) as Record<string, unknown>;
    const pretty = JSON.stringify(wrap(view), null, 2).length;
    const keyCost = Object.keys(view)
      .map((k) => {
        const without = { ...view };
        delete without[k];
        return { key: k, ch: pretty - JSON.stringify(wrap(without), null, 2).length };
      })
      .filter((r) => r.ch > 0)
      .sort((a, b) => b.ch - a.ch);
    const indent = pretty - JSON.stringify(wrap(view)).length;
    console.log(
      "\nget_ticket per-key cost (pretty, record 10)\n" +
        [
          ...keyCost.map(
            (r) =>
              `  ${r.key.padEnd(22)} ${String(r.ch).padStart(5)} ch  ${((r.ch / pretty) * 100).toFixed(1)}%`,
          ),
          `  ${"(indentation)".padEnd(22)} ${String(indent).padStart(5)} ch  ${((indent / pretty) * 100).toFixed(1)}%`,
        ].join("\n"),
    );
  });
});
