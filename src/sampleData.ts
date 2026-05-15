// Sample seed data — used when a fresh workspace has no issues yet.
// Keep this list short; real users will quickly outgrow it.

import type { Issue } from "./types";

const NOW = Date.now();
const DAY = 86400000;
const at = (daysAgo: number, hour = 10) =>
  new Date(NOW - daysAgo * DAY + hour * 3600 * 1000).toISOString();

export const SAMPLE_ISSUES: Issue[] = [
  {
    id: "DS-001",
    number: 1,
    title: "Welcome to DoStuff",
    type: "Chore",
    priority: "Low",
    status: "Thinking",
    description:
      "This is a seeded sample issue. Click the chevron to expand, edit any field, or drag this card to a different lane on the board to change its status.",
    tasks: [
      { id: "t1", text: "Open the Board view from the sidebar", done: false },
      { id: "t2", text: "Drag this card between lanes", done: false },
      { id: "t3", text: "Create your own issue with Ctrl+Shift+I", done: false },
    ],
    verifyCriteria: "You've moved this card to Complete on the board.",
    createdAt: at(0),
    resolvedAt: null,
    statusHistory: [{ status: "Thinking", at: at(0), by: "user" }],
    record: [],
  },
];
