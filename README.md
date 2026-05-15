# DoStuff

A simple software issue board for VSCode with a built-in MCP server, so coding agents can read tickets and report progress without being able to silently change scope.

## Install

```bash
git clone <this repo>
cd DoStuff
bun install
bun run package
```

`bun run package` produces a `.vsix`. In VSCode, right-click the file and choose **Install Extension VSIX**.

## Using the extension

### Sidebar

Open the DoStuff icon in the activity bar. The view lists every issue sorted by `createdAt` descending. The search box filters by title/description; the status chips filter by lane. **Complete tickets are hidden by default** — toggle "Show completed" to reveal them. Click a row to expand an inline detail panel where you can edit title, description, type, priority, status, tasks, and verify criteria.

### Board

Run **DoStuff: Show Board** from the command palette (or click the board icon in the sidebar title bar). The board has five lanes:

```text
Thinking drawer  →  Planned  →  Working  →  Testing  →  Complete drawer
   (left)                                                    (right)
```

Drag a card between lanes to change its status. Each active lane (Planned, Working, Testing) is capped at **6 open tickets**; the UI rejects drops that would exceed the cap with a toast.

### Import / export

Run **DoStuff: Export Issues (JSON)…** or **DoStuff: Import Issues (JSON)…** from the command palette, or use the cloud icons in the sidebar title bar.

## Workflow rules

- New tickets always start in **Thinking** for human triage.
- Only humans can promote a ticket from Thinking to Planned. Agents cannot.
- Tickets move freely between Planned, Working, and Testing.
- Only humans can move a ticket to **Complete** (via the UI).
- Active lanes (Planned, Working, Testing) are each capped at 6 open tickets. This is a workflow throttle: finish or de-scope before starting more work.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+I` / `Cmd+Shift+I` | New Issue |
| `Ctrl+Shift+F` / `Cmd+Shift+F` (sidebar focused) | Focus Search |

## Settings reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dostuff.storagePath` | string | `.vscode/dostuff` | Folder (relative to workspace root) where issue JSON files are stored. |
| `dostuff.autoSave` | boolean | `true` | Persist edits automatically as you type. |
| `dostuff.mcp.enabled` | boolean | `true` | Run an in-process MCP server that exposes the active ticket queue to local agents. |
| `dostuff.mcp.port` | number | `3947` | Localhost port the MCP server listens on. Endpoint is `http://127.0.0.1:<port>/mcp`. |
| `dostuff.mcp.instructions` | string | (built-in workflow prompt) | System-level workflow prompt served alongside every ticket. Leave blank to use the default. User-level only. |

## Using the MCP server

DoStuff runs an HTTP MCP server on `127.0.0.1:<port>` (default `3947`). The endpoint is `/mcp`. It's enabled by default; toggle it with **DoStuff: Toggle MCP Server** or the `dostuff.mcp.enabled` setting.

### Pointing a client at it

For Claude Code, add an entry to your `.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "dostuff": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3947/mcp"
    }
  }
}
```

Customize the workflow prompt that agents receive with every ticket via the `dostuff.mcp.instructions` setting or the **DoStuff: Edit MCP Workflow Instructions…** command.

### Tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `get_ticket` | `query` — `#NN`, `DS-id`, or title substring | Returns the ticket plus the workflow prompt. Only Planned / Working / Testing tickets are servable. `statusHistory` and `resolvedAt` are stripped. |
| `create_ticket` | `title`, optional `description`, `type`, `priority`, `verifyCriteria`, `tasks[]` | Files a new ticket in **Thinking** for the human to triage. Agents cannot create tickets in any other lane. |
| `update_ticket_status` | `id`, `status` (one of Planned / Working / Testing), optional `note` | Moves a ticket between active lanes. Honors the lane cap. Rejects moves out of Thinking, into Thinking, or to/from Complete. |
| `update_ticket_progress` | `id`, `taskUpdates[]`, optional `recordEntry` | Toggles `tasks[].done` and appends one record entry. **Locked**: cannot edit title, description, priority, type, or verifyCriteria. |

### Resources

- `dostuff://tickets` — list of active (Planned / Working / Testing) tickets.
- `dostuff://tickets/{id}` — one active ticket.
- `dostuff://instructions/workflow` — the workflow prompt.

## Storage

Tickets are stored as one `<id>.json` file per ticket in `<workspace>/.vscode/dostuff/` (or in VSCode `globalState` if no workspace is open). The folder is configurable via `dostuff.storagePath`. The files are plain JSON — diff-friendly and git-friendly.

## Contributing / development

```bash
bun install
bun run watch    # esbuild watches both bundles
bun test         # runs src/mcpServer.test.ts
```

Press **F5** in VSCode to launch an Extension Development Host with the current build. `SMOKE-TEST.md` lists the manual test plan to walk before tagging a release.

The `.mcp.json` file at the repo root is for *Claude Code's* own MCP usage during development of this project — it is unrelated to DoStuff's MCP server. It contains a Context7 API key in plaintext; **do not commit credentials**, and rotate the key before sharing this repo.
