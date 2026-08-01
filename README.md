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
| `dostuff.mcp.recordLimit` | number | `3` | Newest record entries included when a ticket is served over MCP. The record log is append-only and never shrinks, so an old ticket would otherwise dominate every agent read. `0` = no limit. Agents override per call with `get_ticket`'s `recordLimit`. Window-scoped. |
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

<details>
<summary><strong>How the sync mechanism works</strong> (click to expand)</summary>

### Where the data lives

Your ticket board's source of truth stays the local SQLite DB (`<storagePath>/dostuff.db`). Sync adds a second representation: every ticket serialized as one canonical-JSON blob inside a git **tree**, committed under the hidden ref `refs/dostuff/state`. The tree looks like:

```
meta.json                        { "formatVersion": 1 }
tickets/<guid>.json              one ticket per blob, keyed by a stable guid
tombstones/<guid>.json           deletion witnesses (which ticket died, when)
attachments/<guid>/<attId>       raw attachment bytes (optional, capped)
```

Because it's a ref — not files in your worktree — `git status` stays clean, branches and PRs never see it, and collaborators who don't enable sync never notice it exists. Fetches land in a second hidden ref (`refs/dostuff/remote`) that's deliberately kept out of `refs/remotes/` so branch pickers don't show it.

### Identity: guid vs DS-NNN

`DS-NNN` numbers are minted locally, so two clones will mint the same number for different tickets. Sync therefore gives every ticket a `guid` — random for new tickets, *derived deterministically* from `id + createdAt` for tickets that predate sync. Derivation matters: a ticket you copied between machines via JSON export/import derives the **same** guid on both sides, so the first sync merges it instead of duplicating it. The wire format stores ticket links by target guid, which is why renumbering never breaks links.

### The sync cycle

**Outbound** — every local edit already funnels through one store chokepoint, which stamps the ticket's `updatedAt` (and per-task stamps) and records tombstones for anything deleted. About 2 seconds after your last edit, the controller serializes the board, merges it with whatever the local ref tip already holds, and commits — a compare-and-swap ref update, retried with a re-merge if another window won the race. This works fully offline.

**Inbound** — on a timer (`dostuff.sync.intervalMinutes`), on demand, and at startup: fetch the remote ref, then decide with two ancestry checks:

1. Remote is behind → nothing to apply; just push.
2. Remote is ahead → fast-forward the local ref and apply its state. No new commit.
3. Histories diverged → **merge in JavaScript, never as a git content merge**: compute the merged state, write it as a new tree, commit it with both tips as parents, apply, push.

A cheap 15-second `rev-parse` poll also watches the local ref tip, which is how two VSCode windows on the same clone converge without any network.

### How the merge decides

The merge is a pure function with three properties — commutative, associative, idempotent — which means any two replicas that have seen the same edits compute **byte-identical** state, no matter the order they synced in. No merge base needed. Rules:

- **Ticket vs ticket** — last-writer-wins on `(updatedAt, content-hash)`. The hash breaks exact-timestamp ties the same way on every machine. The winner supplies title/description/status/tags/links/pendingClose wholesale; `createdAt` takes the min, `updatedAt` the max (never "now" — a merge must not look newer than its inputs).
- **Tasks** — merged per element. Each task carries its own `updatedAt`, and deletions leave per-task tombstones, so "you toggled a task done while I deleted it" resolves to whichever happened later, instead of the deleted task silently resurrecting.
- **History and record** — pure union. These are append-only logs; nothing ever deletes an entry, so merging is just dedup + sort.
- **Deletes** — a deleted ticket leaves a tombstone. A tombstone kills the ticket only if the delete is *newer* than the ticket's last edit; otherwise the edit wins and the tombstone is discarded (so it can't re-kill later). Tombstones expire after 90 days — a replica offline longer than that can resurrect a deleted ticket, which is the standard trade for not keeping tombstones forever.
- **Numbers** — after merging, any `DS-NNN` claimed by two guids is resolved deterministically: oldest `createdAt` keeps it, the loser gets the next free number, and both machines compute the identical assignment independently.

### Attachments

Attachment bytes ride the same tree, keyed by guid (immune to renumbering). Files over `dostuff.sync.maxAttachmentSyncBytes` (default 5 MiB) sync metadata only. Blobs already committed are reused by object id — commits cost O(changed bytes), not O(total attachments). On the receiving side only *missing* files are restored; nothing local is ever overwritten.

### Failure behavior

| Situation | What happens |
| --- | --- |
| Offline / push fails | Local commits keep landing on the ref; status shows `pendingPush`; retried next sync. |
| Someone pushed first | Push rejects (no force, ever) → fetch → re-merge → retry, a few times, then `pendingPush`. |
| No remote configured | Local-only mode: ref history + same-machine convergence still work. |
| Not a git repo / no git | Sync goes inert; the extension behaves exactly as with sync off. |
| Newer wire format from a future build | Refuses to merge rather than corrupt; upgrade to sync. |

</details>

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

### Claude Code Agent Skill (skip MCP registration)

The repo ships a Claude Code [Agent Skill](https://code.claude.com/docs/en/skills) — `skills/dostuff-tickets/` — that covers the entire MCP surface without registering the server as an MCP client. The server is stateless loopback HTTP, so the skill's helper script (`scripts/dostuff.sh`) drives it with bare one-shot `curl` POSTs: it discovers the right port from the instance registry, validates field length caps locally before sending, wraps the JSON-RPC envelope, and unwraps SSE framing. Full parameter schemas live in a lazy-loaded reference file.

Why bother: a registered MCP server costs every Claude Code session the workflow instructions (~1.5 KB) plus connection metadata, whether or not any ticket work happens. The skill costs only its one-line listing entry at session start; the body loads when ticket work actually comes up, and the schema reference only if the agent needs exact shapes.

Install one of two ways:

- **From the extension** — run **DoStuff: Install Claude Code Agent Skill** (command palette). Copies the bundled skill to `~/.claude/skills/dostuff-tickets`; new Claude Code sessions pick it up automatically. Re-run after extension updates.
- **As a plugin** — `/plugin marketplace add wcole3/DoStuff`, then `/plugin install dostuff@dostuff`. Versioned with the repo.

Keep registering the MCP server instead when you want typed tool schemas with client-side validation, concurrent dispatch of read-only tools (`readOnlyHint`), per-tool permission gating, or a non-Claude-Code client. The two paths coexist: the skill detects registered `mcp__dostuff__*` tools and defers to them, so installing both is safe.

### Default workflow prompt

This is intentionally terse.

```text
DoStuff is this workspace's engineering ticket queue. Use these tools to find,
start, update, and file work.

You may NOT change a ticket's title, priority, type, or verify criteria over
MCP, and only a human can set Complete or Closed. Wrong? Say so, or file a new
ticket.

Write terse — every byte is re-read on each later ticket read. Fragments fine,
grammar not important. Record notes: one line, ~15 words, facts and outcomes.
No narration, no restating the ticket, no summarizing what you read or plan.
Descriptions: 1-2 sentences of what + why, detail below; boards show only that
opening.

Find work: `list_issues` or `dostuff://tickets`, then `get_ticket` by number
("42"), id ("DS-042"), or title substring. Read description + verify criteria
first.

`update_ticket_status` moves among Thinking, Planned, Working, Verification
(active lanes cap 6 each; Thinking uncapped). Working when you start. As you
go, `update_ticket_progress` ticks tasks, appends one note, records each commit
sha. Done → Verification, then `request_ticket_complete`. Verify fails → back
to Working.

OBE — superseded or won't be done → `request_ticket_close` instead. Both
requests need human approval, neither changes status: poll `get_ticket` with
`view: "status"`. Close = dropped work, complete = finished work.

Follow-ups → `create_ticket` (lands in Thinking). Reshape a draft's tags,
links, tasks with `update_ticket_draft` — Thinking only. Reads return newest
record entries only — `recordLimit: 0` for full history.
```

(The lane-cap number tracks your `dostuff.activeLaneCap` setting.) Override the text per-user via **DoStuff: Edit MCP Workflow Instructions…** or `dostuff.mcp.instructions` in Settings. Leave the setting blank to use the built-in text above.

> **Keep a custom prompt under 2KB.** Claude Code truncates MCP server instructions at 2KB and drops the remainder with no error — a prompt that overruns loses its *tail*, which is where rules usually put the things you least want dropped. The built-in text is ~1.5KB for this reason, and a test enforces the budget. Detail that doesn't fit belongs in a tool's own `description`, which gets its own 2KB.

> **The prompt also bounds what agents write.** Ticket prose is replayed on every later read of that ticket, by every agent, so the built-in text caps record notes at one ~15-word line and descriptions at a 1-2 sentence lead. The schema backs it up: `recordEntry` / `note` are capped at 500 chars and `description` at 10,000 (an over-long value is rejected, not truncated). These caps apply **only to agent writes over MCP** — the UI is uncapped, and tickets already on disk with longer prose load and are served unchanged. A custom prompt that drops the write-terse rule gives that back.

### Tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `get_ticket` | `query` — `#NN`, `DS-id`, or title substring; optional `view`, `recordLimit`, `include[]` | Returns the ticket plus a one-line workflow pointer (the full prompt is served as MCP initialize instructions and at `dostuff://instructions/workflow`). Thinking, Planned, Working, and Verification tickets are servable; Complete and Closed are rejected. `statusHistory` and `resolvedAt` are stripped; outbound `links` and derived `inboundLinks` are included. The append-only `record` log is windowed to its newest `dostuff.mcp.recordLimit` entries (default 3), adding `recordCount`/`recordOmitted` when entries were dropped; `recordLimit: 0` returns the whole log. Commit shas are replaced by `commitCount`, and `verifyCriteria` is truncated past 2,000 chars (flagged with `verifyCriteriaTruncated`); both are restored with `include: ["commits"]` / `include: ["verifyCriteria"]`. Whatever was withheld is named in `omitted`, spelled exactly as `include` expects. `view: "status"` returns only `{id, number, title, status, pendingClose, tasks: {total, done}}` — for the approval-poll loop, so a waiting agent stops re-fetching the description and record on every check. Marked `readOnlyHint`, so Claude Code can dispatch it concurrently. |
| `list_issues` | optional `type`, `priority`, `status`, `limit`, `offset` | Returns a compact id/title index of all issues (including Thinking and Complete), filtered by any combination of type, priority, and status. Paged: `limit` defaults to 100 (max 250), `offset` defaults to 0. `count` is the **total matching**, `returned` is this page's size, and `nextOffset` appears only when another page exists. Includes a one-line workflow pointer and workspace context in every response. Use for dynamic discovery before calling `get_ticket`. Marked `readOnlyHint`. |
| `create_ticket` | `title`, optional `description` (≤10,000 chars), `type`, `priority`, `verifyCriteria`, `tasks[]`, `tags[]`, `links[]` | Files a new ticket in **Thinking** for the human to triage. Agents cannot create tickets in any other lane. `links[]` entries are `{ targetId, kind }` (kinds: `blocks` / `child-of` / `relates-to`); unknown target ids are dropped. |
| `update_ticket_status` | `id`, `status` (one of Thinking / Planned / Working / Verification), optional `note` | Moves a ticket among the non-terminal states — promote a draft out of Thinking, shuffle the active lanes, or demote back to Thinking (uncapped). Honors the active-lane cap. Rejects Complete/Closed as either target or source. |
| `update_ticket_description` | `id`, `description` (≤10,000 chars), optional `note` (≤500) | Replaces the ticket's description (and appends one record entry). Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. Only the description changes — title, priority, type, and verifyCriteria stay locked. |
| `update_ticket_progress` | `id`, `taskUpdates[]`, optional `recordEntry` (≤500 chars), optional `commit` | Toggles `tasks[].done` and appends one record entry. Optional `commit` (a git sha, 7–40 hex — prefer the full 40) is appended to the ticket's append-only commits list; duplicates ignored. The ticket stores only `{sha, at}` — the UI derives the subject and touched files from your repo lazily. Responds with `tasksChanged` (only the tasks this call touched) plus `tasks: {total, done}` — it does not echo back every task id on the ticket. **Locked**: cannot edit title, priority, type, verifyCriteria, or links (edit the description via `update_ticket_description`). Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. |
| `update_ticket_draft` | `id`, optional `tags[]`, `links[]`, `tasks[]` | Reshapes an untriaged draft's tags, links, and/or task list. **Thinking-only** — rejected once the ticket is triaged to an active lane (use the UI after that). Omit a field to leave it unchanged; pass `[]` to clear it. Unknown link targets are dropped. |
| `request_ticket_close` | `id`, optional `note` | Flags a ticket as **OBE / no longer needed** and awaits human approval — does **not** change status. A human approves (→ Closed, "won't do") or denies in the DoStuff UI. Allowed on Thinking + active-lane tickets; Complete and Closed are rejected. For finished work use `request_ticket_complete` instead. Poll `get_ticket` with `view: "status"` for the outcome. |
| `request_ticket_complete` | `id`, optional `note` | Flags a ticket's work as **finished** and awaits human acceptance — does **not** change status. A human accepts (→ Complete, stamping `resolvedAt`) or denies in the DoStuff UI. **Verification-only** — move the ticket there first. A completion request replaces a pending close request (and vice versa), recorded in the ticket history. Poll `get_ticket` with `view: "status"` for the outcome. |

### Resources

- `dostuff://tickets` — **summary index** of Thinking + active-lane tickets (Complete and Closed hidden). One compact row per ticket — `id`, `number`, `title`, `type`, `priority`, `status`, `tags`, a `done/total` task count, and a short `excerpt` of the description's opening paragraph — plus `count` and a single `detailUriTemplate`. Full bodies are deliberately *not* served here: fetch one from `dostuff://tickets/{id}`.
- `dostuff://tickets/{id}` — one Thinking or active-lane ticket, full body (record windowed as in `get_ticket`).
- `dostuff://attachments/{ticketId}/{attachmentId}` — raw attachment bytes (base64).
- `dostuff://instructions/workflow` — the workflow prompt.

Resources are URI templates with nowhere to put arguments, so they always serve the default shape. An agent that needs a demoted section calls `get_ticket` with `include`.

### Why the reads are lean

Everything an MCP tool returns lands in the agent's context window and is paid for on every call, so DoStuff's reads are shaped to be small by default and complete on request:

- **The `record` log is windowed** to its newest few entries (`dostuff.mcp.recordLimit`, default 3). It is append-only and git sync only ever unions it, so on a long-lived ticket it grows without bound and would otherwise dominate every read of that ticket. `recordLimit: 0` returns all of it.
- **Commit shas collapse to a `commitCount`.** They're shas the agent itself reported, and git holds them authoritatively. `include: ["commits"]` brings the list back.
- **`verifyCriteria` is truncated past 2,000 characters** — insurance against one verbose ticket taxing every read of it, not something you'll normally hit.
- **The board listing serves summary rows**, not full ticket bodies. Fetching 25 full tickets to decide which one to work on costs roughly 20× what the index does.
- Anything withheld is named in **`omitted`**, spelled exactly as `include` expects — so the escape hatch is visible at the moment an agent wants it, rather than only in the tool docs.

If your agents routinely need deeper history, raise `dostuff.mcp.recordLimit`; that is the one knob most worth tuning. `src/measure.bench.test.ts` prints the byte cost of each of these on every `bun test` run if you want to see the tradeoff on your own tickets.

Two Claude Code behaviors also shape this ([docs](https://code.claude.com/docs/en/mcp)): it truncates MCP server instructions at **2KB** silently, and it **defers tool schemas by default** (tool search), so the workflow prompt — not the tool list — is what costs context each session. Both are why the built-in prompt is terse and leads with what the server is for.

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

**With sync off (the default), the ticket DB is single-writer.** Each clone keeps its own local board, and opening the *same* workspace in two VSCode windows at once can silently overwrite edits (last save wins). Turning on [git sync](#sharing-tickets-across-clones-git-sync) fixes both: clones converge through a hidden git ref, and two windows on one workspace reconcile within ~15 seconds.

## Roadmap

Nothing committed yet — [git sync](#sharing-tickets-across-clones-git-sync) was the headline item and has shipped. Design docs for it live in [docs/plans/ticket-sync/](docs/plans/ticket-sync/00-overview.md); they're a historical record of how it was built, not a description of current behavior.

Ideas under consideration, none promised:

- **Sync status per ticket** — surfacing which tickets are ahead of the remote, rather than only a global status-bar state.
- **Richer agent read shaping** — the `include` mechanism currently covers commits and verify criteria; attachments and status history are the obvious next candidates if reads get heavy again.

If you want something, open an issue — the roadmap is mostly "what someone asked for."

## Building from source

```bash
git clone https://github.com/wcole3/DoStuff
cd DoStuff
bun install
bun run package
```

`bun run package` produces a `.vsix`. In VSCode, right-click the file and choose **Install Extension VSIX**.

## Changelog

<details open>
<summary><strong>v2.0.0</strong> (unreleased) — shared ticket boards via git, leaner MCP reads</summary>

**Added**

- **Git ticket sync** — share a ticket board across clones and contributors with no server and no new dependencies. Ticket state lives as git objects under a hidden ref (`refs/dostuff/state`) that never touches your worktree, branches, or PRs; you push and pull tickets over the remote you already use. Opt in with `dostuff.sync.enabled` or **DoStuff: Toggle Git Ticket Sync**; **DoStuff: Sync Tickets Now** forces a cycle, and a `$(sync)` status-bar item shows state and doubles as the button. Off by default, and off means exactly the old single-writer behavior.
  - Offline-first: local edits always commit to the ref and pushes retry on the next cycle (`dostuff.sync.intervalMinutes`, default 5).
  - Conflicts resolve without prompting — per-ticket last-writer-wins on `updatedAt` with a deterministic content-hash tiebreak, per-task and per-attachment LWW for concurrent delete-vs-edit, and append-only union for history and records. Replicas converge; clock skew biases who wins a concurrent edit but never causes divergence. Deletes propagate as tombstones, GC'd after 90 days.
  - Two clones that filed tickets independently collide on `DS-NNN`; the first sync renumbers deterministically (oldest ticket keeps its number) and both sides toast the rename list.
  - Attachments sync too, under `dostuff.sync.syncAttachments` with a per-file ceiling (`dostuff.sync.maxAttachmentSyncBytes`, default 5 MB).
  - Sync is invisible to MCP agents — every write boundary holds unchanged. One caveat: after a renumbering merge, a `DS-NNN` an agent memorized mid-session can change, and it recovers via `list_issues` / `get_ticket` by title.
- **Claude Code agent skill** — `skills/dostuff-tickets/` covers the full MCP surface over bare curl, so Claude Code can drive the queue without registering the server as an MCP client (near-zero per-session context cost). Ships in the vsix: install with **DoStuff: Install Claude Code Agent Skill**, or as a plugin via `/plugin marketplace add wcole3/DoStuff`. The helper script discovers the per-workspace port from the instance registry and enforces the server's field caps locally before sending. See "Claude Code Agent Skill" above.

**Fixed**

- **Enabling sync also fixes same-machine clobbering.** Two VSCode windows on one workspace previously overwrote each other's edits (last save wins); with sync on they converge within ~15 seconds.
- **The workflow prompt was being silently truncated.** Claude Code cuts MCP server instructions at 2KB; the prompt had grown to 2,830 bytes, so ~780 bytes were dropped — taking the OBE/close flow and the "you may not change title, priority, type, or verify criteria" contract with it. Agents were never seeing either. The prompt is rewritten to ~1.7KB with every rule intact, and a test now enforces the budget.

**Changed**

- **MCP reads are substantially smaller.** A ticket read on a well-worked ticket drops ~50%: the append-only `record` log is now windowed to its newest few entries (`dostuff.mcp.recordLimit`, default 3), commit shas collapse to a `commitCount`, long `verifyCriteria` is truncated, and single-ticket payloads are no longer pretty-printed. `get_ticket` gained `include: ["commits" | "verifyCriteria"]` to restore any of it, and every response names what it withheld in `omitted`.
- **`dostuff://tickets` serves a summary index**, not full ticket bodies — ~95% smaller on a 25-ticket board. Each row carries an `excerpt` of the description's opening paragraph, so **lead your descriptions with the point**.
- **`get_ticket` gained `view: "status"`** for the approval-poll loop — the wait after `request_ticket_complete` no longer re-sends the whole ticket on every check.
- **`list_issues` is paged** (`limit`, default 100, max 250; `offset`). `count` stays the total matching; `returned` and `nextOffset` describe the page.
- **`update_ticket_progress` echoes only what changed** — `tasksChanged` plus a `{total, done}` count, instead of every task id on the ticket.
- `get_ticket` and `list_issues` are marked `readOnlyHint`, so Claude Code can dispatch them concurrently rather than serializing them.
- Task ids minted over MCP now use the same short format the UI has always used. Existing ids keep working untouched.

</details>

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
