# DoStuff Smoke Test

Manual checklist to run before publishing 0.1.0. Walk through each section in order.

## Setup

- [x] `bun install` succeeded
- [x] `bun run build` produced `dist/extension.cjs`, `media/index.js`, `media/styles.css`
- [x] `bun test` shows 32/32 passing <- we have more tests now
- [x] `bunx tsc --noEmit` is silent
- [x] Open `/home/welb/devspace/DoStuff/` in VSCode
- [ ] Press `F5` (or Run > Start Debugging) -- a second VSCode window opens labelled "[Extension Development Host]"
- [ ] Open a folder in the dev host (any folder will do; sample data only seeds on first activation when storage is empty)

## 1. Sidebar (Activity Bar view)

- [ ] DoStuff icon shows in the activity bar (left strip). Click it.
- [ ] Sidebar view opens, labelled "Issues"
- [ ] Sample issues are visible (seeded by `sampleData.ts` on first run)
- [ ] Rows are sorted newest first (descending `createdAt`)
- [ ] Complete items are hidden by default
- [ ] Toggle "Show completed" -- Complete items appear; toggle off -- they hide again
- [ ] Type in the search box -- list filters in real-time
- [ ] Click a status chip (Thinking / Planned / Working / Testing) -- list filters to that lane
- [ ] Clear the chip -- full list returns
- [ ] Click a row -- inline detail panel expands beneath the row
- [ ] Edit title, description, priority, type, verifyCriteria -- changes persist (close + reopen sidebar to confirm)
- [ ] Add a task in the detail panel -- it appears in the task list
- [ ] Toggle a task done/undone -- state persists
- [ ] Remove a task -- it disappears
- [ ] Change status via the dropdown -- status updates and history entry appended
- [ ] View status history -- entries listed reverse-chronologically with timestamps

## 2. Virtualization sanity (sidebar)

- [ ] Import 500+ tickets (use Import JSON; see export/import below to seed a large file)
- [ ] Scroll the sidebar list rapidly -- no jank, no white flashes
- [ ] Open DevTools (Help > Toggle Developer Tools), Elements panel -- inspect the row container; row DOM node count should stay bounded (~10-20 rows in DOM at any time, not 500+)

## 3. New issue

- [ ] Press `Ctrl+Shift+I` (or `Cmd+Shift+I` on Mac)
- [ ] Or: Command Palette > "DoStuff: New Issue..."
- [ ] Or: Click the `+` button in the sidebar title bar
- [ ] Modal opens
- [ ] Fill title, type, priority, description, verifyCriteria, optional tasks
- [ ] Submit -- new issue appears in Sidebar (in Thinking) immediately
- [ ] Issue has a fresh `DS-NNN` id and monotonic number

## 4. Board view

- [ ] Command Palette > "DoStuff: Show Board" (or click the layout button in sidebar title bar)
- [ ] Full-tab webview opens with 5 lanes:
  - Thinking drawer (left edge)
  - Planned (active)
  - Working (active)
  - Testing (active)
  - Complete drawer (right edge)
- [ ] Each active lane header shows `(n/6)` count
- [ ] Drag a card from Planned to Working -- card moves, status updates, statusHistory entry appended
- [ ] Open the source issue in Sidebar -- new status reflects, statusHistory entry visible
- [ ] Click into Thinking drawer -- expands to show pending items; can drag a Thinking item INTO Planned
- [ ] Click into Complete drawer -- expands to show completed items
- [ ] Cards in Thinking and Complete drawers are virtualized (scroll smoothly with hundreds of items)

## 5. Lane cap enforcement (board)

- [ ] Drag cards into Working until it shows `(6/6)`
- [ ] Working lane gets a "full" visual state (red border / pulsing / etc.)
- [ ] Attempt to drag a 7th card into Working -- drop is rejected
- [ ] Toast appears naming the lane and current count
- [ ] Source card stays in its original lane (no state change)

## 6. Export / Import JSON

### Export

- [ ] Command Palette > "DoStuff: Export Issues (JSON)..."
- [ ] Save dialog opens; pick a path
- [ ] File written; open it -- contains an array of all issues with full schema

### Import

- [ ] Command Palette > "DoStuff: Import Issues (JSON)..."
- [ ] Pick the file you just exported (or a hand-crafted JSON)
- [ ] Issues load; sidebar refreshes

### Generate a 500-ticket file (one-liner you can paste into a scratch file)

```js
// Save as gen-500.js, run with `bun gen-500.js > issues.json`
const types = ["Bug", "Feature", "Refactor", "Chore", "Spike"];
const prios = ["Critical", "High", "Regular", "Low"];
const statuses = ["Thinking", "Planned", "Working", "Testing", "Complete"];
const issues = Array.from({ length: 500 }, (_, i) => {
  const n = i + 1;
  const now = new Date(Date.now() - i * 60_000).toISOString();
  return {
    id: `DS-${String(n).padStart(3, "0")}`,
    number: n,
    title: `Synthetic ticket ${n}`,
    type: types[i % types.length],
    priority: prios[i % prios.length],
    status: statuses[i % statuses.length],
    description: "",
    tasks: [],
    verifyCriteria: "",
    createdAt: now,
    resolvedAt: null,
    statusHistory: [{ status: statuses[i % statuses.length], at: now }],
    record: [],
  };
});
console.log(JSON.stringify(issues, null, 2));
```

## 7. Focus search

- [ ] In sidebar, press `Ctrl+Shift+F` (or `Cmd+Shift+F` on Mac)
- [ ] Caret jumps to the search input

## 8. MCP server (HTTP at 127.0.0.1:3947/mcp)

Default port is 3947. Confirm `dostuff.mcp.enabled` is `true` (Settings > DoStuff).

In a separate terminal:

### List tools

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

- [ ] Response includes 4 tools: `get_ticket`, `create_ticket`, `update_ticket_status`, `update_ticket_progress`

### get_ticket (Thinking ticket -- expect "not servable" error)

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_ticket",
      "arguments": { "query": "DS-001" }
    }
  }'
```

- [ ] If DS-001 is in Thinking or Complete, response body says "not servable" or similar
- [ ] If DS-001 is Planned/Working/Testing, full ticket JSON returned (minus statusHistory and resolvedAt per spec)

### create_ticket

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "create_ticket",
      "arguments": {
        "title": "Smoke test ticket",
        "type": "Bug",
        "priority": "Regular",
        "description": "Created from curl during smoke test",
        "tasks": ["First sub-task", "Second sub-task"]
      }
    }
  }'
```

- [ ] Response contains a new ticket with id like `DS-NNN`
- [ ] Status is `Thinking`
- [ ] Open Sidebar -- new ticket visible (may require a refresh; the sidebar listens for storage changes)

### update_ticket_status (happy path -- move a Planned ticket to Working)

First move a ticket to Planned via the UI (drag in board, or pick from sidebar status dropdown). Then:

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "update_ticket_status",
      "arguments": {
        "id": "DS-001",
        "status": "Working",
        "note": "Picked up via MCP smoke test"
      }
    }
  }'
```

- [ ] Response is success; ticket now in Working
- [ ] Sidebar reflects the change

### update_ticket_status (reject Thinking)

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "update_ticket_status",
      "arguments": {
        "id": "DS-001",
        "status": "Thinking"
      }
    }
  }'
```

- [ ] Response is a schema validation error (status must be one of Planned/Working/Testing). This is enforced at the schema layer.

### update_ticket_status (reject when target lane at cap)

- [ ] Manually move 6 tickets into Working via the UI
- [ ] Pick a 7th in Planned, then:

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "update_ticket_status",
      "arguments": {
        "id": "DS-007",
        "status": "Working"
      }
    }
  }'
```

- [ ] Response is an error naming the lane and current count (e.g. "Working is at 6/6")

### update_ticket_progress (toggle a task + append record entry)

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "update_ticket_progress",
      "arguments": {
        "id": "DS-001",
        "taskUpdates": [{ "id": "task-1", "done": true }],
        "recordEntry": "Smoke test: marked task-1 done"
      }
    }
  }'
```

Replace `task-1` with an actual task id from the ticket (you can fetch one via `get_ticket`).

- [ ] Response is success; task is marked done
- [ ] Sidebar detail panel shows the task as done
- [ ] Record log shows the new entry with `author: "agent"`
- [ ] Title/description/priority were NOT modified (schema doesn't allow it)

### Reject non-loopback Host header (security check)

```bash
curl -s -X POST http://127.0.0.1:3947/mcp \
  -H 'Host: evil.com' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- [ ] Response is 403 with body "DoStuff MCP rejects non-loopback Host headers"

## 9. MCP toggle + edit instructions

- [ ] Command Palette > "DoStuff: Toggle MCP Server"
- [ ] Status bar (or output channel) reflects new state
- [ ] When OFF, curl to `127.0.0.1:3947/mcp` should be refused (connection refused)
- [ ] Toggle back ON
- [ ] Command Palette > "DoStuff: Edit MCP Workflow Instructions..."
- [ ] Editor opens with the current instructions; edit + save -- subsequent `get_ticket` responses include the new prompt

## 10. Settings

- [ ] Settings > Extensions > DoStuff
- [ ] All these keys appear: storagePath, autoSave, mcp.enabled, mcp.port, mcp.instructions
- [ ] No `storageMode` key (locked decision)
- [ ] Change `dostuff.mcp.port` to e.g. 4040 -- server restarts on new port (verify with curl)

## Cleanup

- [ ] Stop the Extension Development Host (close the window or Shift+F5 in dev host)
- [ ] Delete this SMOKE-TEST.md file once verified
