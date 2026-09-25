// Sample board the demo starts with (and restores on "Reset"). A fictional
// notes app, "Lumen", mid-flight: every lane populated, an agent's pending
// completion + close requests awaiting a verdict, a parent/child + blocks
// link web for the graph, and a Start-here ticket that doubles as a checklist.
// Timestamps are relative to `now` so the board always looks recently active.

import type { Issue, IssueType, Priority, RecordEntry, Status, TicketLink } from "../src/types";
import { formatIssueId } from "../src/syncMerge";

const REPO_URL = "https://github.com/wcole3/DoStuff";

interface Spec {
  n: number;
  title: string;
  type: IssueType;
  priority: Priority;
  /** Status path, oldest first: [status, hours ago, by?]. First entry = creation. */
  path: Array<[Status, number, ("user" | "agent")?]>;
  description: string;
  verify?: string;
  tasks?: Array<[string, boolean]>;
  tags?: string[];
  links?: TicketLink[];
  /** [hours ago, author, text] */
  record?: Array<[number, RecordEntry["author"], string]>;
  pendingClose?: { target: "Closed" | "Complete"; hoursAgo: number; note: string };
  /** [sha, hours ago] */
  commits?: Array<[string, number]>;
}

/** Subject + files for the seeded commit shas (the real host asks git). */
export const SEED_COMMITS: Record<string, { subject: string; files: string[] }> = {
  "1e7a2c90b4d6": {
    subject: "chore: scaffold Tauri shell, CI, and lint config",
    files: ["src-tauri/tauri.conf.json", "package.json", ".github/workflows/ci.yml"],
  },
  "5d2e8f71c3a9": {
    subject: "editor: split-pane markdown preview",
    files: ["src/editor/Preview.tsx", "src/editor/SplitPane.tsx", "src/editor/markdown.ts"],
  },
  "c0ffee4a91b2": {
    subject: "status bar: autosave indicator with 400ms debounce",
    files: ["src/ui/StatusBar.tsx", "src/editor/autosave.ts", "src/editor/autosave.test.ts"],
  },
  "a41c09e2d7f3": {
    subject: "search: add FTS5 notes index + migration",
    files: ["src/search/index.ts", "src/db/migrations/0007_fts.sql"],
  },
  "7be3d58190ac": {
    subject: "search: unicode-aware tokenizer",
    files: ["src/search/tokenize.ts", "src/search/tokenize.test.ts"],
  },
};

const SPECS: Spec[] = [
  {
    n: 1,
    title: "Scaffold the Tauri app shell",
    type: "Chore",
    priority: "Regular",
    path: [["Thinking", 520], ["Planned", 516], ["Working", 510], ["Verification", 490], ["Complete", 488]],
    description: "Tauri + React shell with CI, lint and a release workflow.",
    tasks: [["Tauri + Vite template", true], ["CI: build + test on 3 OSes", true], ["Lint + format config", true]],
    tags: ["infra"],
    commits: [["1e7a2c90b4d6", 492]],
  },
  {
    n: 2,
    title: "Markdown preview pane",
    type: "Feature",
    priority: "High",
    path: [["Thinking", 500], ["Planned", 470], ["Working", 330], ["Verification", 300], ["Complete", 296]],
    description: "Side-by-side rendered preview that scrolls in sync with the editor.",
    verify: "Preview updates within 100ms of a keystroke; scroll position tracks the cursor.",
    tasks: [["Render with markdown-it", true], ["Scroll sync", true], ["Toggle with Ctrl+K V", true]],
    tags: ["editor"],
    record: [[310, "agent", "Preview + scroll sync landed; toggle bound to Ctrl+K V."]],
    commits: [["5d2e8f71c3a9", 305]],
  },
  {
    n: 3,
    title: "Autosave indicator in the status bar",
    type: "Feature",
    priority: "Regular",
    path: [["Thinking", 260], ["Planned", 200], ["Working", 70, "agent"], ["Verification", 8, "agent"]],
    description: "Show saving / saved / failed state for the open note in the status bar.",
    verify: "Indicator flips to Saved within 1s of the last keystroke; a failed write shows Retry.",
    tasks: [
      ["Saving / Saved / Failed states", true],
      ["Debounce so it doesn't flicker while typing", true],
      ["Retry button on failure", true],
      ["Screen-reader live region", true],
    ],
    tags: ["editor", "ui"],
    record: [
      [60, "agent", "Started: indicator driven by the autosave queue's events."],
      [9, "agent", "All four tasks done; debounce set to 400ms."],
      [3, "agent", "Requested completion: verified against criteria on macOS and Windows."],
    ],
    pendingClose: { target: "Complete", hoursAgo: 3, note: "Verified against the criteria on macOS and Windows." },
    commits: [["c0ffee4a91b2", 9]],
  },
  {
    n: 4,
    title: "Sharing & export",
    type: "Feature",
    priority: "High",
    path: [["Thinking", 240], ["Planned", 120]],
    description: "Umbrella for getting notes out of Lumen: files, PDFs and share links. Children carry the work.",
    tags: ["export"],
  },
  {
    n: 5,
    title: "Full-text search across notebooks",
    type: "Feature",
    priority: "Critical",
    path: [["Thinking", 230], ["Planned", 150], ["Working", 50, "agent"]],
    description: "Search every notebook from one box, ranked, with matches highlighted in results.",
    verify: "A query over 10k notes returns in under 150ms; quoted phrases and -exclusions work.",
    tasks: [
      ["FTS5 index table + migration", true],
      ["Unicode-aware tokenizer (CJK, emoji)", true],
      ["Query parser: quoted phrases, -exclusions", false],
      ["Results pane with match highlighting", false],
    ],
    tags: ["search"],
    record: [
      [48, "agent", "Started: FTS5 index, rebuilt per notebook on save."],
      [30, "agent", "Index table + tokenizer landed; 22 tests green."],
      [5, "agent", "Quoted phrases parse; -exclusions next."],
    ],
    commits: [["a41c09e2d7f3", 31], ["7be3d58190ac", 29]],
  },
  {
    n: 6,
    title: "Crash when renaming a note with an emoji in the title",
    type: "Bug",
    priority: "High",
    path: [["Thinking", 40], ["Planned", 36], ["Working", 20, "agent"]],
    description: "Renaming a note to a title containing an emoji closes the app. Reported on Windows and Linux.",
    verify: "Renaming to \"📝 plans\" and \"日本語\" succeeds and the file on disk gets a sane slug.",
    tasks: [["Reproduce with a failing test", true], ["Slugify on character boundaries, not bytes", false]],
    tags: ["editor", "crash"],
    record: [
      [18, "agent", "Repro: slugify slices by byte index and splits the emoji's surrogate pair."],
      [4, "agent", "Fix in progress; failing test added for emoji + CJK titles."],
    ],
  },
  {
    n: 7,
    title: "Split editor.ts into focused modules",
    type: "Refactor",
    priority: "Regular",
    path: [["Thinking", 140], ["Planned", 100], ["Working", 26]],
    description: "editor.ts is 2,400 lines. Split keybindings, commands and the autosave queue into their own modules.",
    tasks: [["Extract keybindings", true], ["Extract command registry", false], ["Extract autosave queue", false]],
    tags: ["tech-debt"],
  },
  {
    n: 8,
    title: "Export notes to PDF",
    type: "Feature",
    priority: "High",
    path: [["Thinking", 110], ["Planned", 72]],
    description: "Export the current note or a whole notebook to PDF with the preview's styling.",
    verify: "Code blocks, tables and images render as they do in the preview.",
    tasks: [["Print stylesheet", false], ["Notebook → single PDF with a TOC", false], ["Page-break controls", false]],
    tags: ["export"],
    links: [{ targetId: "DS-004", kind: "child-of" }],
  },
  {
    n: 9,
    title: "Share a notebook via read-only link",
    type: "Feature",
    priority: "Regular",
    path: [["Thinking", 100], ["Planned", 60]],
    description: "Publish a notebook snapshot to a read-only URL anyone with the link can open.",
    tags: ["export", "sync"],
    links: [{ targetId: "DS-004", kind: "child-of" }],
  },
  {
    n: 10,
    title: "Move settings storage to IndexedDB",
    type: "Refactor",
    priority: "Regular",
    path: [["Thinking", 90], ["Planned", 44]],
    description: "Settings live in a JSON file that races with autosave. Move them to IndexedDB with a one-shot migration.",
    tasks: [["Settings repository over IndexedDB", false], ["Migrate + delete settings.json", false]],
    tags: ["storage"],
    links: [
      { targetId: "DS-009", kind: "blocks" },
      { targetId: "DS-012", kind: "blocks" },
    ],
  },
  {
    n: 11,
    title: "Evaluate an Electron port",
    type: "Spike",
    priority: "Low",
    path: [["Thinking", 430], ["Closed", 216]],
    description: "Would Electron make plugins easier? Timeboxed to one day.",
    tags: ["infra"],
    record: [
      [240, "agent", "Requested close: Tauri shell already meets the plugin and bundle-size goals."],
      [216, "user", "Close request approved"],
    ],
  },
  {
    n: 12,
    title: "Offline mode on mobile",
    type: "Feature",
    priority: "Low",
    path: [["Thinking", 80]],
    description: "Keep the last 50 opened notes readable and editable without a connection; sync on reconnect.",
    tags: ["mobile", "sync"],
  },
  {
    n: 13,
    title: "Flaky search indexer test on CI",
    type: "Bug",
    priority: "Regular",
    path: [["Thinking", 170]],
    description: "indexer.test.ts fails about 1 run in 20 on the Linux runner with a timeout.",
    tags: ["testing", "search"],
    links: [{ targetId: "DS-005", kind: "relates-to" }],
    record: [[6, "agent", "Requested close: no longer reproduces since the DS-005 indexer rewrite."]],
    pendingClose: { target: "Closed", hoursAgo: 6, note: "No longer reproduces since the DS-005 indexer rewrite (50 green CI runs)." },
  },
  {
    n: 14,
    title: "Tag chips fail contrast in the light theme",
    type: "Bug",
    priority: "Low",
    path: [["Thinking", 30]],
    description: "Yellow and lime tag chips measure 2.1:1 on white. WCAG AA needs 4.5:1 for text.",
    tags: ["ui", "a11y"],
  },
  {
    n: 15,
    title: "Keyboard shortcut cheatsheet",
    type: "Chore",
    priority: "Low",
    path: [["Thinking", 26], ["Planned", 22]],
    description: "A searchable overlay listing every shortcut, opened with Ctrl+/.",
    tags: ["ui"],
  },
  {
    n: 16,
    title: "Start here: what to try in this demo",
    type: "Chore",
    priority: "Regular",
    path: [["Thinking", 0.02]],
    description: [
      "This board runs entirely in your browser. Edits are saved to localStorage; Reset in the top bar restores this sample project.",
      "",
      "Try:",
      "• Drag tickets between lanes. Planned, Working and Verification hold at most 6 each (Planned has 5).",
      "• DS-003 has an agent's completion request and DS-013 a close request. Approve or deny them.",
      "• Link tickets (blocks / child-of / relates-to), then open the Graph view.",
      "• Tick tasks, add tags, or file a new ticket with +.",
      "",
      "Not in the demo: the MCP server coding agents use to work the queue, attachments and git sync. Install the extension for those: " +
        REPO_URL,
    ].join("\n"),
    tasks: [
      ["Drag a ticket into another lane", false],
      ["Approve or deny the request on DS-003", false],
      ["Open the Graph view", false],
      ["File a new ticket", false],
    ],
    tags: ["demo"],
  },
];

export function buildSeed(now: Date = new Date()): Issue[] {
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  return SPECS.map((s): Issue => {
    const id = formatIssueId(s.n);
    const createdAt = at(s.path[0]![1]);
    const statusHistory = s.path.map(([status, h, by]) => ({ status, at: at(h), by: by ?? ("user" as const) }));
    const last = statusHistory[statusHistory.length - 1]!;
    const record = (s.record ?? []).map(([h, author, text]) => ({
      at: at(h),
      author,
      ...(author === "agent" ? { source: "claude-code" } : {}),
      text,
    }));
    const times = [createdAt, ...statusHistory.map((e) => e.at), ...record.map((r) => r.at)];
    return {
      id,
      number: s.n,
      title: s.title,
      type: s.type,
      priority: s.priority,
      status: last.status,
      description: s.description,
      verifyCriteria: s.verify ?? "",
      tasks: (s.tasks ?? []).map(([text, done], i) => ({ id: `t${s.n}-${i + 1}`, text, done, updatedAt: last.at })),
      tags: s.tags ?? [],
      attachments: [],
      links: s.links ?? [],
      createdAt,
      resolvedAt: last.status === "Complete" ? last.at : null,
      statusHistory,
      record,
      pendingClose: s.pendingClose
        ? { by: "agent", at: at(s.pendingClose.hoursAgo), target: s.pendingClose.target, note: s.pendingClose.note }
        : null,
      guid: `00000000-0000-4000-8000-${String(s.n).padStart(12, "0")}`,
      updatedAt: times.sort().at(-1)!,
      commits: (s.commits ?? []).map(([sha, h]) => ({ sha, at: at(h) })),
    };
  });
}
