# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

# [0.1.0]

## Added

- Sidebar issue list with search, status-chip filter, "Show completed" toggle (Complete hidden by default), inline detail panel for editing, and `react-window` virtualization for the row list.
- Full-tab Kanban board with HTML5 drag-and-drop across five lanes: Thinking drawer → Planned → Working → Testing → Complete drawer.
- Active-lane cap of 6 open tickets per lane (Planned, Working, Testing); enforced in the board UI, the host's `applyIssueUpdate` chokepoint, and the MCP `update_ticket_status` tool.
- JSON file storage: one `<id>.json` per ticket under `<workspace>/.vscode/dostuff/`, with a `globalState` fallback when no workspace is open. Export and import via commands.
- MCP server (HTTP, `127.0.0.1:3947` by default) with four tools: `get_ticket`, `create_ticket`, `update_ticket_status`, `update_ticket_progress`. Only Planned / Working / Testing tickets are returned to agents. Agents cannot promote tickets out of Thinking, cannot mark Complete, and cannot re-open Complete tickets. `update_ticket_progress` is restricted to toggling tasks and appending a record entry — title, description, priority, type, and verifyCriteria are immutable through MCP.
- Three MCP resources: `dostuff://tickets`, `dostuff://tickets/{id}`, `dostuff://instructions/workflow`.
- Settings: `dostuff.storagePath`, `dostuff.autoSave`, `dostuff.mcp.enabled`, `dostuff.mcp.port`, `dostuff.mcp.instructions`.
- Keybindings: `Ctrl+Shift+I` (New Issue), `Ctrl+Shift+F` (Focus Search when the sidebar is focused).

## Fixed

- MCP per-ticket resource `dostuff://tickets/{id}` now uses `ResourceTemplate`; previously registered as a static URI with a literal `{id}` and was unreachable.
- MCP stateless HTTP transport is now built fresh per request; the prior shared-transport design failed on the 2nd request to the same listener.
- Host `applyIssueUpdate` no longer trusts client-supplied `statusHistory`; the host appends a single event derived from server-authoritative state on status change.
- Active-lane cap (6 per Planned/Working/Testing) is now enforced on `importIssues` too; previously imports could exceed the cap silently.
- Issue id/number allocation is serialised; previously concurrent `nextNumber()`/`nextId()` calls could collide.
- Sidebar webview now disposes its `onChange` subscription on view dispose; previously the listener leaked on view recreation.
- All zod schemas exposed via the MCP tool surface use `strict()` so unknown fields are rejected at the boundary.
- `reconcile()` on the MCP server is single-flight; concurrent config changes can no longer race start/stop and leak a partially-initialised server.
- Sidebar list rows are keyboard-reachable: focusable, arrow-navigable, Enter/Space activates, Esc collapses the inline detail.
- Board drag handler tags drops with the dragged ticket's id; previously a fast follow-up drag could race the prior drop's id and apply the wrong update.

# [0.0.1]

- Created this extension!
