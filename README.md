# DoStuff Issue Board

A simple software issue board for VSCode with a built-in MCP server, so coding agents can read tickets and report progress without being able to silently change scope.

Made mostly for solo devs who have trouble keeping track of things they were totally going to fix after the agent broke it.

Keeps an audit log of changes to a ticket — in case you still have the willpower to read something after reviewing the 113-file PR the agent opened.

![DoStuff board screenshot](media/board_image.png)

## Install

**From the Marketplace** — search for "DoStuff" in the VSCode Extensions view and click Install.

**From a `.vsix`** — download the latest release, then in VSCode open the Extensions view (`Ctrl+Shift+X`), click the `…` menu → **Install from VSIX…**, and pick the file. Or right-click the `.vsix` in your file explorer and choose **Install Extension VSIX**.

## Quick start

1. Click the **DoStuff** icon in the activity bar — the sidebar opens with a sample ticket.
2. Hit `Ctrl+Shift+I` (or `Cmd+Shift+I`) to file a new issue. New tickets always land in **Thinking**.
3. Run **DoStuff: Show Board** from the command palette (or click the board icon in the sidebar title bar) for the full Kanban view.
4. (Optional) Enable the MCP server — **DoStuff: Toggle MCP Server** — to let coding agents read your queue and report progress. See [Using the MCP server](#using-the-mcp-server) below.

## Using the extension

### Sidebar

The sidebar lists every issue, newest first. The search box matches title, id, description, and tags; the status chips filter by lane. **Complete tickets are hidden by default** — toggle "Show completed" to reveal them.

Click any row to expand an inline detail panel for editing title, description, type, priority, status, tags, links, tasks, verify criteria, and attachments. Edits autosave as you type (toggleable in settings).

### Board

The board has five lanes:

```text
Thinking drawer  →  Planned  →  Working  →  Verification  →  Complete drawer
   (left)                                                          (right)
```

Drag a card between lanes to change its status. Each active lane (Planned, Working, Verification) is capped — six tickets by default; configurable via `dostuff.activeLaneCap`.

You can also start a drag in the **sidebar**. The board lights each lane and drawer with a "Move to *lane*" overlay; click any lane to drop, or press **Esc** to cancel. If the board isn't open, dragging from the sidebar opens it.

**Thinking drawer**: click a card to view its details. **Shift+Click** promotes the draft straight to Planned.

### Ticket links

Relate tickets to each other from the detail panel's **Links** field. Pick a relationship — **blocks**, **blocked by**, **child of**, **parent of**, or **relates to** — then search the target by `#number`, `DS-id`, or a title substring. Forward kinds (blocks / child of / relates to) are stored on the current ticket and shown as chips; inverse kinds (blocked by / parent of) define the relationship from the *other* ticket's side without leaving the current one, and appear under **Linked by**. Click any chip to jump to that ticket; remove a **Linked by** chip to delete the relationship from its source. Links are directional and stored once — deleting the link, or the ticket, cleans up both ends. The new-issue dialog offers the same relationships (forward and inverse); inverse ones are applied to their source tickets right after the new ticket is created.

### Graph view

Run **DoStuff: Show Graph** (command palette or the sidebar toolbar) to see the link network as an interactive node-link diagram — only tickets that participate in at least one link appear. Edges are colored and arrowed by kind, and the legend doubles as a filter: click a relationship type to hide or show its edges (tickets left with no visible link drop out too). **Drag** a node to rearrange; **scroll** to zoom; **drag the background** to pan; **click** a node (or focus it and press Enter) to open that ticket. *Fit to view* frames everything currently shown, and **Forces** opens sliders to tune link distance, repulsion, and node spacing on the fly.

Use the **filter** box (by `#id`, title, or tag) to focus on part of the network. Filtering preserves context: a matched ticket keeps its whole connected chain so you never see it stripped of its blockers, children, or related tickets — matches render normally while the surrounding chain dims. The view auto-fits to the matching cluster.

### Attachments

Each ticket has an Attachments strip in its detail panel. Drop one or more files onto it, or hit the **+** to pick via the OS dialog. Image attachments render as thumbnails — click to view full-size (Esc closes). Non-images open in VSCode via the system handler. Cap is 10 MB per file. Binaries live next to the ticket database, so the default `.gitignore` keeps them out of Git. Deleting a ticket removes its attachments too.

Attachments are exposed to MCP clients through `get_ticket`'s `attachments[]` field; agents fetch the bytes by reading `dostuff://attachments/{ticketId}/{attachmentId}`. Export/import JSON includes the metadata but not the bytes — re-upload after an import if you need them.

### Tags

Tags are free-form labels (like Jira labels), edited in the detail panel and rendered as colored chips on sidebar rows and board cards. Once a row runs out of space the extras collapse to dots. Chip colors are derived deterministically from the tag name — no per-tag setup. Sidebar search and the board drawer filter both match tag substrings.

### Links in ticket text

Description and verify-criteria text is auto-linkified. Bare `http(s)://`, `file:///`, `mailto:`, and workspace-relative `./path/to/file` references become clickable. External links open in your browser; file links and relative paths open in VSCode.

### Import / export

Run **DoStuff: Export Issues (JSON)…** or **DoStuff: Import Issues (JSON)…** from the command palette, or use the cloud icons in the sidebar title bar. The exported JSON contains the ticket data and attachment metadata — attachment bytes are not bundled.

## Workflow rules

- New tickets always start in **Thinking** for human triage.
- Agents may move tickets freely among the non-terminal states — promote out of Thinking, shuffle the active lanes, or demote back to Thinking — and edit the description of any non-terminal ticket.
- Tickets move freely between Planned, Working, and Verification.
- Only humans can set the terminal states, and agents signal them through **two distinct flows**: `request_ticket_complete` (from **Verification** only) says "the work is finished — please accept" and approval moves the ticket to **Complete**; `request_ticket_close` says "this is OBE / no longer needed" and approval moves it to **Closed**. Distinct on purpose — history records whether a ticket was *done* or *dropped*.
- Active lanes (Planned, Working, Verification) are each capped — a workflow throttle. Finish or de-scope before starting more work. Or raise `dostuff.activeLaneCap`; I'm not your supervisor.
- **Closed** is a "won't do" state. It lives only in the sidebar (no board lane/drawer), is hidden under the **All** filter, and is reachable via its dedicated filter chip. The sidebar also has an **Awaiting decision** filter that surfaces tickets with a pending agent close/completion request.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+I` / `Cmd+Shift+I` | New Issue |

## Settings reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dostuff.storagePath` | string | `.vscode/dostuff` | Folder (relative to workspace root) where the SQLite database and attachments live. |
| `dostuff.writeStorageGitignore` | boolean | `true` | Write a `.gitignore` inside the storage folder so the ticket DB and attachments stay out of Git even when `.vscode/` is tracked. |
| `dostuff.autoSave` | boolean | `true` | Persist edits automatically as you type. |
| `dostuff.activeLaneCap` | number | `6` | Maximum tickets per active lane (Planned, Working, Verification). Enforced by the UI, the host, and the MCP server. |
| `dostuff.mcp.enabled` | boolean | `false` | Run an in-process MCP server that exposes the active ticket queue to local agents. |
| `dostuff.mcp.port` | number | `0` | Localhost port for this workspace's MCP server. `0` lets the OS pick an ephemeral port each session. Set a fixed value to keep `mcp.json` URLs stable. Easiest set: **DoStuff: Pin MCP Port to Workspace**. Window-scoped. |
| `dostuff.mcp.workspaceOverride` | string | `""` | Absolute path to advertise in the multi-workspace registry. Leave blank to use the first workspace folder. Window-scoped. |
| `dostuff.mcp.instructions` | string | (built-in workflow prompt) | System-level workflow prompt served as MCP initialize instructions and at `dostuff://instructions/workflow`. Leave blank to use the default. User-level only. |
| `dostuff.sync.enabled` | boolean | `false` | Sync the ticket board across clones through a hidden git ref. Off = exactly current single-writer behavior. Window-scoped. |
| `dostuff.sync.remote` | string | `origin` | Git remote used to fetch/push the sync ref. |
| `dostuff.sync.ref` | string | `refs/dostuff/state` | Full ref name the ticket state is stored under (must start with `refs/`). |
| `dostuff.sync.intervalMinutes` | number | `5` | Minutes between automatic network syncs. `0` = manual network sync only (local ref commits still happen). |
| `dostuff.sync.syncAttachments` | boolean | `true` | Sync attachment bytes through the ref tree (metadata always syncs). |
| `dostuff.sync.maxAttachmentSyncBytes` | number | `5242880` | Per-file cap for attachment byte sync. Larger files sync metadata only. |

## Sharing tickets across clones (git sync)

Share your ticket board across clones via git — no server. Tickets sync through a hidden git ref (`refs/dostuff/state`) that never touches your worktree, branches, or PRs: enable `dostuff.sync.enabled` (or run **DoStuff: Toggle Git Ticket Sync**), and everyone pushes/pulls tickets over the remote you already use. Offline-first — local edits always commit to the ref; pushes retry on the next sync. **DoStuff: Sync Tickets Now** forces a cycle; the `$(sync)` status-bar item shows state and doubles as the button.

How conflicts resolve: state-level last-writer-wins on a per-ticket `updatedAt` (with a deterministic tiebreak, so replicas never diverge), per-task/attachment LWW for concurrent delete-vs-edit, and append-only union for history/records. Clock skew between machines biases who wins a concurrent edit but never causes divergence. Deletes propagate via tombstones (kept 90 days).

Two clones that filed tickets independently will collide on `DS-NNN` numbers: the first sync renumbers deterministically (oldest ticket keeps its number) and both sides toast the rename list. **Agent note:** after such a merge, a `DS-NNN` handle an agent memorized mid-session can change — agents recover via `list_issues` / `get_ticket` by title. Sync is otherwise invisible to MCP agents; all write boundaries hold unchanged.

Enabling sync also fixes same-machine clobbering: two VSCode windows on one workspace converge within ~15 seconds instead of overwriting each other.

## Using the MCP server

DoStuff runs an HTTP MCP server on `127.0.0.1:<port>/mcp`. Each VSCode window binds its **own** port and writes a registry entry so agents can discover which port serves which workspace — no port collision with multiple windows open. The server is **disabled by default** — enable it with **DoStuff: Toggle MCP Server** or by setting `dostuff.mcp.enabled: true`.

Every tool response includes a `workspace` field (`{ name, rootPath }` or `null`) so agents can verify they're connected to the intended project.

### Pinning the port (_recommended_)

By default the OS picks an ephemeral port each session, so any `mcp.json` URL with a hard-coded port breaks at the next restart. To keep the URL stable:

1. Start the MCP server in this workspace (status bar shows `$(plug) DoStuff MCP :<port>`).
2. Run **DoStuff: Pin MCP Port to Workspace** from the command palette. DoStuff writes the live port to this workspace's settings as `dostuff.mcp.port`.
3. From then on the server tries to bind that exact port at every start. If the port is busy (e.g. another DoStuff window pinned it), the server falls back to an ephemeral port and logs a warning to `Output → DoStuff MCP`.

You can also edit `dostuff.mcp.port` (window-scoped, 1024–65535) by hand. Set it back to `0` to return to ephemeral.

### Looking up the live port

- **Status bar**: the `$(plug) DoStuff MCP :<port>` indicator shows the live port.
- **Registry file**: `~/.config/dostuff/instances.json` (Linux/macOS) or `%APPDATA%/dostuff/instances.json` (Windows) lists every running instance. See [Multi-workspace agent discovery](#multi-workspace-agent-discovery) below.

### Pointing a client at it

Pin the port (above), then drop it into your client config:

#### VSCode MCP settings (VS Code 1.99+)

```json
"dostuff": {
  "servers": {
    "dostuff-ticket": {
      "url": "http://127.0.0.1:<PORT>/mcp",
      "type": "http"
    }
  },
  "inputs": []
}
```

#### Claude Code

Add an entry to your `.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "dostuff": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:<PORT>/mcp"
    }
  }
}
```

Customize the workflow prompt via the `dostuff.mcp.instructions` setting or the **DoStuff: Edit MCP Workflow Instructions…** command. The command pre-fills the editor with the built-in default so you can see it before editing; clearing the field and saving reverts to the default.

The full prompt is served **once per connection** as the MCP server's initialize `instructions` (clients like Claude Code inject it into agent context automatically — visible under `/mcp`), and stays readable at the `dostuff://instructions/workflow` resource and the `workflow` MCP prompt. Individual tool responses carry only a one-line pointer instead of repeating the full text, keeping per-call context small.

### Default workflow prompt

This is intentionally terse.

```text
You are an engineering agent working the DoStuff issue queue.

Address tickets by number ("42"), id ("DS-042"), or a title substring — e.g.
"get ticket 42 and begin work" or "start on the OAuth ticket" (use `get_ticket`).
Discover work via `list_issues` or the `dostuff://tickets` resource (Thinking +
active lanes; Complete/Closed hidden). Read the description and verify criteria
before starting.

Rules:
  1. `update_ticket_status` moves tickets among Thinking, Planned, Working, and
     Verification: promote a draft out of Thinking, shuffle the active lanes, or
     demote back to Thinking. Set "Working" when you start, "Verification" when
     ready for review. Only a human can set Complete or Closed; if verification
     fails, move the ticket back to "Working".
  2. Active lanes (Planned, Working, Verification) are capped at 6 tickets
     each; over-cap moves are rejected, including promotions. Thinking is uncapped.
  3. As you work, call `update_ticket_progress` to tick tasks and append a terse,
     factual note to the ticket's record.
  4. `update_ticket_description` corrects or expands the description of any
     non-terminal ticket.
  5. File follow-up work with `create_ticket`; new tickets land in "Thinking" for
     human triage. Optionally pass `links: [{ targetId, kind }]`
     (kinds: blocks, child-of, relates-to).
  6. Reshape a ticket's tags, links, or task list with `update_ticket_draft` —
     Thinking only. Once triaged, scope locks; demote the ticket back to Thinking
     first if its scope genuinely needs reshaping.
  7. When the work is finished, move the ticket to "Verification" and call
     `request_ticket_complete`. It does not change status — a human accepts
     (→ Complete) or denies in DoStuff. Poll `get_ticket` for the outcome.
  8. When a ticket is OBE — no longer needed, superseded, or won't be done —
     call `request_ticket_close` instead. Same approval flow, but approval
     moves it to Closed ("won't do"). Keep the two distinct: close is for
     dropped work, complete is for finished work.

You may NOT modify a ticket's title, priority, type, or verify criteria via
MCP. If those are wrong, file a new ticket.
```

(The lane-cap number tracks your `dostuff.activeLaneCap` setting.) Override the text per-user via **DoStuff: Edit MCP Workflow Instructions…** or `dostuff.mcp.instructions` in Settings. Leave the setting blank to use the built-in text above.

### Tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `get_ticket` | `query` — `#NN`, `DS-id`, or title substring | Returns the ticket plus a one-line workflow pointer (the full prompt is served as MCP initialize instructions and at `dostuff://instructions/workflow`). Thinking, Planned, Working, and Verification tickets are servable; Complete and Closed are rejected. `statusHistory` and `resolvedAt` are stripped; outbound `links` and derived `inboundLinks` are included. |
| `list_issues` | optional `type`, `priority`, `status` | Returns a compact id/title index of all issues (including Thinking and Complete), filtered by any combination of type, priority, and status. Includes a one-line workflow pointer and workspace context in every response. Use for dynamic discovery before calling `get_ticket`. |
| `create_ticket` | `title`, optional `description`, `type`, `priority`, `verifyCriteria`, `tasks[]`, `tags[]`, `links[]` | Files a new ticket in **Thinking** for the human to triage. Agents cannot create tickets in any other lane. `links[]` entries are `{ targetId, kind }` (kinds: `blocks` / `child-of` / `relates-to`); unknown target ids are dropped. |
| `update_ticket_status` | `id`, `status` (one of Thinking / Planned / Working / Verification), optional `note` | Moves a ticket among the non-terminal states — promote a draft out of Thinking, shuffle the active lanes, or demote back to Thinking (uncapped). Honors the active-lane cap. Rejects Complete/Closed as either target or source. |
| `update_ticket_description` | `id`, `description`, optional `note` | Replaces the ticket's description (and appends one record entry). Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. Only the description changes — title, priority, type, and verifyCriteria stay locked. |
| `update_ticket_progress` | `id`, `taskUpdates[]`, optional `recordEntry` | Toggles `tasks[].done` and appends one record entry. **Locked**: cannot edit title, priority, type, verifyCriteria, or links (edit the description via `update_ticket_description`). Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. |
| `update_ticket_draft` | `id`, optional `tags[]`, `links[]`, `tasks[]` | Reshapes an untriaged draft's tags, links, and/or task list. **Thinking-only** — rejected once the ticket is triaged to an active lane (use the UI after that). Omit a field to leave it unchanged; pass `[]` to clear it. Unknown link targets are dropped. |
| `request_ticket_close` | `id`, optional `note` | Flags a ticket as **OBE / no longer needed** and awaits human approval — does **not** change status. A human approves (→ Closed, "won't do") or denies in the DoStuff UI. Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. For finished work use `request_ticket_complete` instead. Poll `get_ticket` for the outcome. |
| `request_ticket_complete` | `id`, optional `note` | Flags a ticket's work as **finished** and awaits human acceptance — does **not** change status. A human accepts (→ Complete, stamping `resolvedAt`) or denies in the DoStuff UI. **Verification-only** — move the ticket there first. A completion request replaces a pending close request (and vice versa), recorded in the ticket history. Poll `get_ticket` for the outcome. |

### Resources

- `dostuff://tickets` — list of Thinking + active-lane tickets (Complete and Closed hidden).
- `dostuff://tickets/{id}` — one Thinking or active-lane ticket.
- `dostuff://attachments/{ticketId}/{attachmentId}` — raw attachment bytes (base64).
- `dostuff://instructions/workflow` — the workflow prompt.

## Multi-workspace agent discovery

**TL;DR: just pin the port.**

Each VSCode window with DoStuff enabled binds its MCP server to a localhost port and registers itself in a user-global file so external agents can find the right endpoint per workspace.

- Registry file: `~/.config/dostuff/instances.json` on Linux/macOS, `%APPDATA%/dostuff/instances.json` on Windows.
- Entry shape: `{ "workspacePath": string, "port": number, "pid": number, "name": string, "startedAt": ISO8601 }`. Paths are resolved absolute and lowercased on Windows.
- Stale entries are pruned automatically on activation (via `process.kill(pid, 0)`) and removed on extension deactivation.

Recommended agent discovery algorithm:

1. Read the registry file. Treat ENOENT and corrupt JSON as an empty list.
2. Normalize `process.cwd()` the same way (resolve absolute; lowercase on Windows).
3. Filter entries whose `workspacePath` is a path-prefix of the normalized cwd; pick the longest match.
4. On a tie, prefer the most recent `startedAt`. If no entry is a prefix and the list has a single entry, fall back to it.
5. Optionally verify with `process.kill(pid, 0)` before connecting. The MCP endpoint is `http://127.0.0.1:<port>/mcp`.

If the auto-pick is wrong (e.g. an agent runs from a deeply nested cwd that doesn't share a prefix with the workspace root), set `dostuff.mcp.workspaceOverride` on that window to the path you want advertised.

## Storage

Tickets are stored in a single SQLite database — `dostuff.db` — under `<workspace>/.vscode/dostuff/` (or in VSCode `globalState` if no workspace is open). The folder is configurable via `dostuff.storagePath`. Attachment binaries live alongside the DB at `<storagePath>/attachments/<issueId>/`.

Legacy `<id>.json` ticket files from earlier versions are migrated into the DB on first launch and moved to a `legacy-json-backup/` folder next to the DB — your tickets carry over automatically.

On first use, DoStuff writes a nested `.gitignore` inside the storage folder so the DB and attachments are excluded from Git even when `.vscode/` is tracked. The gitignore itself is kept trackable (via `!.gitignore`) so teammates can see why their tickets aren't there. Disable via `dostuff.writeStorageGitignore: false`.

**Known limitation**: the ticket DB is single-writer. Each clone keeps its own local board, and opening the *same* workspace in two VSCode windows at once can silently overwrite edits (last save wins). Multi-clone sync is planned — see [Roadmap](#roadmap).

## Roadmap

**Shared ticket boards via git (planned, not yet shipped).** The next major feature syncs the ticket DB across clones and contributors with zero infrastructure: ticket state is stored as git objects under a hidden ref (`refs/dostuff/state`) — no files in your working tree, no PR noise, no server, no new dependencies. You push and pull tickets through the same remote you already use; conflicts resolve automatically (per-ticket last-write-wins with deterministic id-collision renumbering), and MCP-connected agents keep working against the local board, which converges with everyone else's. It also fixes the two-windows-clobbering limitation above. Opt-in via a `dostuff.sync.enabled` setting; off means exactly today's behavior.

Full design docs live in [docs/plans/ticket-sync/](docs/plans/ticket-sync/00-overview.md).

## Building from source

```bash
git clone https://github.com/wcole3/DoStuff
cd DoStuff
bun install
bun run package
```

`bun run package` produces a `.vsix`. In VSCode, right-click the file and choose **Install Extension VSIX**.

## Changelog

<details>
<summary><strong>v1.1.0</strong> — graph view, ticket links, MCP draft editing</summary>

**Added**

- **Graph view** (**DoStuff: Show Graph**) — an interactive node-link diagram of linked tickets, with a chain-preserving filter, relationship-type toggles in the legend, and live force-tuning sliders.
- **Ticket links** — relate tickets via *blocks / blocked by / child of / parent of / relates to*. Relationships are stored once and the **Linked by** view is derived, so deleting a link (or a ticket) cleans up both ends. The new-issue dialog can stage links — and attachments — before the ticket exists.

**Changed**

- **MCP** — new `update_ticket_draft` tool reshapes a Thinking draft's tags/links/tasks; `create_ticket` now accepts `links[]`; agents can read and annotate Thinking drafts (and the `dostuff://tickets` resource now lists them).

**Fixed**

- Status-dropdown moves now honor `dostuff.activeLaneCap` instead of a hardcoded cap of 6 — matching board drag-and-drop.

**Docs**

- Split architecture and workflow internals into [docs/architecture.md](docs/architecture.md) and [docs/workflow-rules.md](docs/workflow-rules.md).

</details>

## License

MIT — see [LICENSE.txt](LICENSE.txt).
