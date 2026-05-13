// Sample issue data + types
// Issue shape:
// {
//   id, number, title, type, priority, status,
//   description, tasks: [{id,text,done}],
//   verifyCriteria, createdAt, resolvedAt,
//   statusHistory: [{status, at, by?}],
//   record: [{at, author, text, source?}]   // append-only log; agent-writable via MCP
// }

const ISSUE_TYPES = ["Bug", "Feature", "Refactor", "Chore", "Spike"];
const PRIORITIES = ["Critical", "High", "Regular", "Low"];
const STATUSES = ["Thinking", "Planned", "Working", "Testing", "Complete"];

const NOW = Date.now();
const DAY = 86400000;

// Helpers
const at = (daysAgo, hour = 10) =>
  new Date(NOW - daysAgo * DAY + hour * 3600 * 1000).toISOString();

const mkHistory = (steps) =>
  steps.map(([status, daysAgo]) => ({ status, at: at(daysAgo) }));

const SAMPLE_ISSUES = [
  {
    id: "DS-001",
    number: 1,
    title: "OAuth callback fails on Safari iOS 17",
    type: "Bug",
    priority: "Critical",
    status: "Working",
    description:
      "Users on Safari iOS 17 are redirected to a blank page after granting consent. Server logs show the auth code is never exchanged. Suspect ITP blocking the cross-site cookie used in PKCE state verification.",
    tasks: [
      { id: "t1", text: "Reproduce on a real iOS 17 device", done: true },
      { id: "t2", text: "Audit Set-Cookie SameSite values", done: true },
      { id: "t3", text: "Switch state storage to sessionStorage", done: false },
      { id: "t4", text: "Add Sentry breadcrumb on callback entry", done: false },
    ],
    verifyCriteria:
      "Complete a fresh OAuth flow end-to-end on iOS 17 Safari, iOS 16 Safari, and Chrome 120. All three must land on /dashboard without manual refresh.",
    createdAt: at(8),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 8],
      ["Planned", 7],
      ["Working", 4],
    ]),
    record: [
      { at: "2026-05-11T03:19:41.284Z", author: "agent", text: "Reproduced the blank redirect on iOS 17.4. Set-Cookie audit confirmed SameSite=Lax was dropping the PKCE state cookie." },
      { at: "2026-05-12T00:19:41.284Z", author: "agent", text: "Migrated state storage to sessionStorage. Full flow now works on iOS 17 in a clean profile." },
      { at: "2026-05-12T22:19:41.284Z", author: "agent", text: "Adding the Sentry breadcrumb next." },
    ],
  },
  {
    id: "DS-002",
    number: 2,
    title: "Sidebar virtualization for 10k+ issue lists",
    type: "Feature",
    priority: "High",
    status: "Planned",
    description:
      "Current sidebar renders every issue node, causing a 1.8s freeze on workspaces with 10k+ issues. Need windowed rendering with stable scroll position across filter changes.",
    tasks: [
      { id: "t1", text: "Spike react-virtual vs custom impl", done: true },
      { id: "t2", text: "Wire up to filtered list", done: false },
      { id: "t3", text: "Preserve expanded state across virtualization", done: false },
    ],
    verifyCriteria:
      "Open a workspace seeded with 25k issues. Scroll the sidebar continuously for 10s. Frame time must stay under 16ms on M1 baseline.",
    createdAt: at(12),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 12], ["Planned", 6]]),
    record: [],
  },
  {
    id: "DS-003",
    number: 3,
    title: "Drag preview shows wrong card on Firefox",
    type: "Bug",
    priority: "Regular",
    status: "Testing",
    description:
      "When dragging a card from Working to Testing on Firefox, the drag image shows the card directly below the picked one. Chrome/Safari are correct.",
    tasks: [
      { id: "t1", text: "Override setDragImage with manual offset", done: true },
      { id: "t2", text: "QA across FF 120, 121, ESR", done: true },
    ],
    verifyCriteria:
      "Pick up 10 different cards on Firefox 121. The drag image must match the card under the cursor in every case.",
    createdAt: at(6),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 6],
      ["Planned", 5],
      ["Working", 3],
      ["Testing", 1],
    ]),
    record: [],
  },
  {
    id: "DS-004",
    number: 4,
    title: "Extract issue serializer into shared module",
    type: "Refactor",
    priority: "Low",
    status: "Thinking",
    description:
      "Both the webview and the extension host re-implement JSON normalization. Pull into a shared module so we can change schema once.",
    tasks: [
      { id: "t1", text: "Inventory all serialize call sites", done: false },
      { id: "t2", text: "Decide on Zod vs hand-rolled validators", done: false },
    ],
    verifyCriteria:
      "Schema changes only require edits in one file. Round-trip a sample workspace through export/import with no diff.",
    createdAt: at(2),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 2]]),
    record: [],
  },
  {
    id: "DS-005",
    number: 5,
    title: "Keyboard shortcut to focus search (Cmd+P style)",
    type: "Feature",
    priority: "Regular",
    status: "Complete",
    description:
      "Add Ctrl+Shift+F when the DoStuff panel is focused to jump the cursor into the search input and select existing text.",
    tasks: [
      { id: "t1", text: "Register command in package.json", done: true },
      { id: "t2", text: "Bind focus + select-all in webview", done: true },
      { id: "t3", text: "Document in README", done: true },
    ],
    verifyCriteria:
      "Press Ctrl+Shift+F with sidebar open. Search input must focus and any existing text must be selected.",
    createdAt: at(20),
    resolvedAt: at(11),
    statusHistory: mkHistory([
      ["Thinking", 20],
      ["Planned", 18],
      ["Working", 16],
      ["Testing", 13],
      ["Complete", 11],
    ]),
    record: [],
  },
  {
    id: "DS-006",
    number: 6,
    title: "Memory leak in webview when switching workspaces",
    type: "Bug",
    priority: "High",
    status: "Working",
    description:
      "Heap snapshot shows the previous webview's React tree retained after a workspace switch. Suspect a listener on the host messenger not being disposed.",
    tasks: [
      { id: "t1", text: "Repro with --inspect-extensions", done: true },
      { id: "t2", text: "Audit window.addEventListener calls", done: false },
      { id: "t3", text: "Hook into Disposable lifecycle", done: false },
    ],
    verifyCriteria:
      "Switch workspaces 20 times. Heap delta under 5MB. No detached HTMLElements.",
    createdAt: at(10),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 10],
      ["Planned", 9],
      ["Working", 5],
    ]),
    record: [
      { at: "2026-05-09T23:19:41.284Z", author: "agent", text: "Captured baseline heap snapshot — 18 detached HTMLElement nodes per workspace switch." },
      { at: "2026-05-12T05:19:41.284Z", author: "agent", text: "Found host messenger holds a closure over the webview. Going to thread it through a Disposable." },
    ],
  },
  {
    id: "DS-007",
    number: 7,
    title: "Bulk-edit selection in Kanban view",
    type: "Feature",
    priority: "Regular",
    status: "Thinking",
    description:
      "Shift-click to extend selection, then move/delete/relabel multiple cards at once. Should feel native — no modal.",
    tasks: [
      { id: "t1", text: "Mock the multi-select hover state", done: false },
      { id: "t2", text: "Decide selection persistence across filter", done: false },
    ],
    verifyCriteria:
      "Select 5 cards across two lanes, drag together to Testing. All five animate as a group.",
    createdAt: at(1),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 1]]),
    record: [],
  },
  {
    id: "DS-008",
    number: 8,
    title: "Export should preserve task IDs not regenerate them",
    type: "Bug",
    priority: "High",
    status: "Planned",
    description:
      "Round-tripping an issue through export → import gives new task UUIDs, which breaks external links to specific subtasks.",
    tasks: [
      { id: "t1", text: "Audit serializer for ID stripping", done: true },
      { id: "t2", text: "Add fixture test for stable IDs", done: false },
    ],
    verifyCriteria:
      "Export issue, import into clean workspace, diff task IDs. Must match exactly.",
    createdAt: at(5),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 5], ["Planned", 3]]),
    record: [],
  },
  {
    id: "DS-009",
    number: 9,
    title: "Add 'Critical' lane that floats above all others",
    type: "Feature",
    priority: "Low",
    status: "Thinking",
    description:
      "A sticky row at the top of the board showing only Critical-priority cards regardless of status, so they're never lost.",
    tasks: [
      { id: "t1", text: "Mock the floating lane visual", done: false },
    ],
    verifyCriteria:
      "Mark any card Critical → it appears in the top row AND in its status lane.",
    createdAt: at(3),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 3]]),
    record: [],
  },
  {
    id: "DS-010",
    number: 10,
    title: "Fix flake in storage round-trip test",
    type: "Chore",
    priority: "Low",
    status: "Working",
    description:
      "storage.test.ts fails ~1 in 30 runs on CI. Suspect a timestamp comparison hitting the same ms.",
    tasks: [
      { id: "t1", text: "Add jitter to test timestamps", done: true },
      { id: "t2", text: "Run 100 iterations on CI to confirm", done: false },
    ],
    verifyCriteria: "100 consecutive CI runs of storage.test.ts must pass.",
    createdAt: at(4),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 4],
      ["Planned", 3],
      ["Working", 2],
    ]),
    record: [],
  },
  {
    id: "DS-011",
    number: 11,
    title: "Investigate SQLite vs JSON-file backend perf",
    type: "Spike",
    priority: "Regular",
    status: "Testing",
    description:
      "Benchmark read/write/search across 50k issues. Decide default storage. JSON wins on portability; SQLite likely wins on search.",
    tasks: [
      { id: "t1", text: "Build benchmark harness", done: true },
      { id: "t2", text: "Run on M1 + Linux CI runner", done: true },
      { id: "t3", text: "Write up findings doc", done: false },
    ],
    verifyCriteria:
      "Findings doc reviewed by 2 engineers. Decision recorded in ADR-007.",
    createdAt: at(15),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 15],
      ["Planned", 13],
      ["Working", 9],
      ["Testing", 2],
    ]),
    record: [],
  },
  {
    id: "DS-012",
    number: 12,
    title: "Drop legacy v1 settings migration code",
    type: "Chore",
    priority: "Low",
    status: "Complete",
    description:
      "It's been 14 months since v2. Migration shim can go.",
    tasks: [
      { id: "t1", text: "Verify telemetry shows no v1 users", done: true },
      { id: "t2", text: "Delete migrateV1.ts + tests", done: true },
    ],
    verifyCriteria: "Bundle size drops; no v1-related code paths reachable.",
    createdAt: at(30),
    resolvedAt: at(22),
    statusHistory: mkHistory([
      ["Thinking", 30],
      ["Planned", 28],
      ["Working", 25],
      ["Testing", 24],
      ["Complete", 22],
    ]),
    record: [],
  },
  {
    id: "DS-013",
    number: 13,
    title: "Inline edit doesn't commit on tab-out",
    type: "Bug",
    priority: "Regular",
    status: "Planned",
    description:
      "Editing a title inline, then pressing Tab to leave, reverts to the old value. Only Enter saves.",
    tasks: [
      { id: "t1", text: "Add blur handler that commits", done: false },
      { id: "t2", text: "Distinguish Esc-cancel from blur-commit", done: false },
    ],
    verifyCriteria:
      "Edit title, press Tab. Title persists. Edit title, press Esc. Title reverts.",
    createdAt: at(7),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 7], ["Planned", 5]]),
    record: [],
  },
  {
    id: "DS-014",
    number: 14,
    title: "Restore Kanban scroll position across reloads",
    type: "Feature",
    priority: "Low",
    status: "Thinking",
    description:
      "Each lane scrolls independently. Persist scrollTop per lane in webview state so a reload doesn't yank the user back to the top.",
    tasks: [
      { id: "t1", text: "Decide storage: webview state vs workspace state", done: false },
    ],
    verifyCriteria:
      "Scroll Working lane halfway, reload window. Working lane is restored to same scrollTop ±20px.",
    createdAt: at(2),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 2]]),
    record: [],
  },
  {
    id: "DS-015",
    number: 15,
    title: "Add a 'today' indicator on history dates",
    type: "Feature",
    priority: "Low",
    status: "Testing",
    description:
      "Within the state history list, render 'Today', 'Yesterday', '3 days ago' relative pills instead of raw ISO strings.",
    tasks: [
      { id: "t1", text: "Build formatRelative util", done: true },
      { id: "t2", text: "Hover reveals absolute timestamp", done: true },
    ],
    verifyCriteria:
      "Open any issue with history. Each entry shows relative; hover shows absolute.",
    createdAt: at(9),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 9],
      ["Planned", 8],
      ["Working", 6],
      ["Testing", 3],
    ]),
    record: [],
  },
  {
    id: "DS-016",
    number: 16,
    title: "Card drop animation feels jittery on Linux",
    type: "Bug",
    priority: "Regular",
    status: "Thinking",
    description:
      "Drop animation runs at ~40fps on Wayland. Suspect we're animating layout (top/left) instead of transform.",
    tasks: [
      { id: "t1", text: "Profile with Chrome devtools timeline", done: false },
    ],
    verifyCriteria: "Drop animation hits 60fps on Wayland baseline machine.",
    createdAt: at(1),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 1]]),
    record: [],
  },
  {
    id: "DS-017",
    number: 17,
    title: "Sidebar context menu: right-click an issue",
    type: "Feature",
    priority: "Regular",
    status: "Working",
    description:
      "Right-clicking a sidebar entry should show Edit, Duplicate, Change Status →, Delete. Native VSCode menu look.",
    tasks: [
      { id: "t1", text: "Wire vscode.window.showQuickPick fallback", done: true },
      { id: "t2", text: "Build cascading status submenu", done: false },
      { id: "t3", text: "Add 'Open in Board' entry point", done: false },
    ],
    verifyCriteria:
      "Right-click any sidebar entry. Menu shows. Each item performs its action.",
    createdAt: at(11),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 11],
      ["Planned", 9],
      ["Working", 4],
    ]),
    record: [
      { at: "2026-05-11T04:19:41.284Z", author: "agent", text: "QuickPick fallback wired. Submenu cascading needs the native VS Code menu API — investigating contribution route." },
    ],
  },
  {
    id: "DS-018",
    number: 18,
    title: "Light theme contrast on priority pills",
    type: "Bug",
    priority: "Low",
    status: "Planned",
    description:
      "Critical pill is unreadable in Light+ theme — pure red on white background fails WCAG AA.",
    tasks: [
      { id: "t1", text: "Pick theme-aware color tokens", done: false },
      { id: "t2", text: "Verify contrast with axe", done: false },
    ],
    verifyCriteria:
      "All priority pills pass WCAG AA contrast in both Dark+ and Light+.",
    createdAt: at(4),
    resolvedAt: null,
    statusHistory: mkHistory([["Thinking", 4], ["Planned", 2]]),
    record: [],
  },
  {
    id: "DS-019",
    number: 19,
    title: "Auto-save toggle in settings",
    type: "Feature",
    priority: "Regular",
    status: "Complete",
    description:
      "Setting to enable/disable auto-save on every keystroke vs explicit save action.",
    tasks: [
      { id: "t1", text: "Add config schema entry", done: true },
      { id: "t2", text: "Honor setting in webview", done: true },
    ],
    verifyCriteria:
      "Toggle setting. With auto-save off, edits require an explicit Save.",
    createdAt: at(25),
    resolvedAt: at(18),
    statusHistory: mkHistory([
      ["Thinking", 25],
      ["Planned", 24],
      ["Working", 22],
      ["Testing", 20],
      ["Complete", 18],
    ]),
    record: [],
  },
  {
    id: "DS-020",
    number: 20,
    title: "Webview fails to load offline (CSP issue)",
    type: "Bug",
    priority: "Critical",
    status: "Testing",
    description:
      "When offline, webview shows blank. CSP is blocking an inline font URL that we should be bundling.",
    tasks: [
      { id: "t1", text: "Bundle font assets via asWebviewUri", done: true },
      { id: "t2", text: "Tighten CSP to disallow http(s):*", done: true },
      { id: "t3", text: "QA on airplane mode", done: false },
    ],
    verifyCriteria:
      "Disable network. Reload window. DoStuff webview loads fully with no console errors.",
    createdAt: at(6),
    resolvedAt: null,
    statusHistory: mkHistory([
      ["Thinking", 6],
      ["Planned", 5],
      ["Working", 3],
      ["Testing", 1],
    ]),
    record: [
      { at: "2026-05-11T22:19:41.284Z", author: "agent", text: "Bundled fonts via asWebviewUri. CSP tightened to disallow http(s):*." },
      { at: "2026-05-13T01:19:41.284Z", author: "agent", text: "Verified clean console load in airplane mode on macOS. Ready for QA sign-off." },
    ],
  },
];

window.DS_DATA = {
  ISSUE_TYPES,
  PRIORITIES,
  STATUSES,
  SAMPLE_ISSUES,
};
