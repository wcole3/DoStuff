# SMOKE-TEST

Manual walkthrough for an Extension Development Host (`F5`). `bun test` +
`bunx tsc --noEmit` cover the host/MCP/schema/sync layers; this checklist
covers what they can't — the React webview and end-to-end wiring. Run the
sections relevant to your change; run everything before a release.

## 1. Sidebar CRUD

- [X] Activity-bar icon opens the sidebar; sample ticket visible on first run.
- [ ] `Ctrl+Shift+I` files a new ticket → lands in **Thinking**; appears without reload.
- [ ] Open a ticket's detail; edit title, description, priority, type, verify criteria; changes persist after closing/reopening the detail.
- [ ] Add/toggle/remove tasks; add/remove tags (chips render with stable colors).
- [ ] Search filters the list; status filter chips work, including **Closed** and **Awaiting decision**.
- [ ] Delete a ticket → gone from every view; links pointing at it disappear.

## 2. Board: drag + lane caps + close requests

- [ ] **DoStuff: Show Board** opens the Kanban view; lanes Planned / Working / Verification plus Thinking and Complete drawers.
- [ ] Drag a card between active lanes; drop persists (check sidebar agrees).
- [ ] Thinking-drawer: click vs. Shift+Click behavior per [docs/workflow-rules.md](docs/workflow-rules.md).
- [ ] Fill a lane to the cap (default 6) → further drops into it are rejected with the toast; demoting one out re-opens capacity.
- [ ] Sidebar→board cross-webview drag: dragging a sidebar card opens/focuses the board and shows the "Move to *lane*" overlay; Esc cancels.
- [ ] A ticket with a pending agent **close** request shows the "no longer needed" badge; **Approve & close** moves it to Closed (vanishes from the board), **Deny** clears the badge and leaves status alone.
- [ ] A ticket with a pending agent **completion** request shows the "work finished" badge with **Accept & complete**; accepting moves it to Complete (with `resolvedAt` set), denying clears the badge.

## 3. Import / export

- [ ] Export JSON → file contains tickets incl. `guid`, `updatedAt`, tags, links, attachment metadata.
- [ ] Import that file into a cleared board → tickets, links, tags intact; numbers/ids stable; re-import is idempotent (no duplicates).

## 4. MCP endpoint end-to-end

Setup: enable the server (**DoStuff: Toggle MCP Server**), pin or read the port, connect an agent (e.g. Claude Code per README).

- [ ] `list_issues` returns the compact index; response `workflow` field is the **one-line pointer**, not the full prompt.
- [ ] `list_issues` paging: with more tickets than `limit`, `count` is the **total** while `returned` is the page size and `nextOffset` points at the next page; walking `nextOffset` to the end yields every ticket once, and the last page has no `nextOffset`.
- [ ] `update_ticket_progress` response carries `tasksChanged` (only the ids you passed) and `tasks: {total, done}` — **not** every task id on the ticket.
- [ ] Task ids: a ticket created via `create_ticket` with tasks gets short ids (`t<base36>`), and toggling a task on an older ticket that still has `t-<uuid>` ids works unchanged.
- [ ] `get_ticket` by number, `DS-id`, and title substring all resolve; Complete/Closed are refused.
- [ ] Read resource `dostuff://tickets`: **summary rows only** — no `description`, `record`, or `verifyCriteria` on any row; each has `tasks: "done/total"` and a one-line `excerpt`; the envelope has `count` and a single `detailUriTemplate`. Full bodies still come from `dostuff://tickets/{id}`.
- [ ] Excerpt quality: on a ticket whose description opens with a `## Heading`, the excerpt shows the **prose**, not the heading; on a ticket with an empty description the `excerpt` key is absent. Every excerpt on the board should be intelligible on its own — if one isn't, the prompt wording or the heuristic needs another pass.
- [ ] Record windowing: on a ticket with more than 10 record entries, `get_ticket` returns the **newest 10** plus `recordCount`/`recordOmitted`; `recordLimit: 0` returns the whole log; a ticket under the limit gets no `recordOmitted` key at all.
- [ ] `get_ticket` with `view: "status"` returns only id/number/title/status/pendingClose/tasks counts, and no `workflow` pointer — and is visibly tiny next to the full read.
- [ ] `create_ticket` lands in **Thinking**. After the prompt change, an agent's description should lead with what/why rather than a `## Context` heading.
- [ ] The full loop: agent **promotes** the ticket to Planned (`update_ticket_status`), moves it to Working, **demotes** it back to Thinking, reshapes it (`update_ticket_draft`), re-promotes, edits the description (`update_ticket_description`), ticks a task + appends a record (`update_ticket_progress`), then files `request_ticket_close` → UI shows the awaiting-decision badge; approve → ticket Closed; agent's `get_ticket` for it is now refused.
- [ ] Completion flow: agent moves a ticket to Verification, files `request_ticket_complete` → "work finished" badge; **Accept & complete** → ticket Complete with `resolvedAt`; history records "Completion request approved".
- [ ] `request_ticket_complete` from a non-Verification lane is rejected, pointing at `update_ticket_status`; a completion request replaces a pending close request (record entry notes the switch).
- [ ] Lane cap: with a full lane, agent promotion into it is rejected with the cap message.
- [ ] `update_ticket_status` to Complete/Closed is rejected, pointing at `request_ticket_close`.
- [ ] Commit anchors: `update_ticket_progress` with `commit: $(git rev-parse HEAD)` → response `commitCount: 1`; same sha again → still 1; `get_ticket` reports `commitCount: 1` and names `commits` under `omitted`, and `get_ticket` with `include: ["commits"]` lists the sha. A **Commits** section appears in the ticket detail without a reload: short sha + subject; expanding lists the touched files; clicking a file opens it in the editor (verify once from a workspace at the repo root and once from a workspace that is a subfolder of the repo). A ticket with no commits shows no section.
- [ ] Commit anchor degradation: report a sha then `git commit --amend` (or fabricate one) → row shows "not found in this repo", detail otherwise usable, no error toast. Also holds with `dostuff.sync.enabled` off and in a non-git workspace.

## 5. Workflow prompt surfaces

- [ ] Client's server info (Claude Code `/mcp`) shows the workflow **initialize instructions**.
- [ ] `dostuff://instructions/workflow` resource and the `workflow` MCP prompt return the full text.
- [ ] Set `dostuff.mcp.instructions` to a custom string → all three surfaces reflect it **without an extension restart**; clearing it restores the default with the live lane cap interpolated.
- [ ] **Arrives untruncated.** Claude Code cuts server instructions at 2KB silently, and the loss is always at the *tail*. Ask a connected agent — without pasting the prompt at it — to state (a) what to do when a ticket is OBE, and (b) which fields it may not change over MCP. Both live in the back half of the prompt; if either answer is missing or invented, the prompt is being truncated and the byte budget in `src/workflowPrompt.ts` needs to come down further.
- [ ] **Earns the tool search.** Claude Code defers MCP tool schemas by default, so an agent only loads them if the instructions convince it to look. In a fresh session that has *not* been told about DoStuff, ask "what am I supposed to be working on?" and confirm it finds and calls the DoStuff tools rather than guessing or asking.
- [ ] A custom `dostuff.mcp.instructions` longer than 2KB is the user's own footgun — worth re-checking the two questions above after setting one.

## 5b. Agent skill (Claude Code without MCP registration)

- [ ] **DoStuff: Install Claude Code Agent Skill** copies the skill to `~/.claude/skills/dostuff-tickets` (toast names the path); re-running prompts before replacing.
- [ ] Auto-update: with the skill installed by the command, edit `.dostuff-skill.json` to a lower version and reload the window → toast "agent skill updated x → y", files refreshed. Repeat but also append a line to the installed SKILL.md → "Replace / Keep mine" prompt; "Keep mine" leaves the edit in place. A skill dir *without* the marker is never touched.
- [ ] In a fresh Claude Code session with **no** dostuff MCP server registered, `/dostuff-tickets` loads the skill; asking to "list my tickets" runs `scripts/dostuff.sh` and returns the board.
- [ ] On Windows (Git Bash), `dostuff.sh discover` resolves the right instance despite the registry's lowercased `C:\` paths; if it misses, `DOSTUFF_PORT` and the pinned-port fallback both work.
- [ ] With the MCP server *also* registered, the agent prefers the `mcp__dostuff__*` tools over curl (coexistence rule in SKILL.md).

## 5c. Headless server

- [ ] With **no** VSCode window on the workspace: `node dist/server.cjs serve --workspace <repo>` prints `{"port": N, ...}`; `dostuff.sh discover` from the skill resolves it; `create_ticket` → ticket lands in `.vscode/dostuff/dostuff.db`; open the workspace in VSCode afterwards → the ticket is on the board.
- [ ] `--print-config` in a workspace with `dostuff.activeLaneCap` set in `.vscode/settings.json` (with comments/trailing commas) shows the value with provenance `settings.json`.
- [ ] With a VSCode window already serving the workspace: `serve` exits 3 naming the pid/port; `--takeover` starts anyway.
- [ ] `Ctrl-C` the server → registry entry removed (`node dist/server.cjs status`).
- [ ] Sync: workspace with `dostuff.sync.enabled: true` in settings.json + a remote — headless `serve`, file a ticket via the skill, wait a cycle → `git for-each-ref 'refs/dostuff/*'` shows the state ref advanced; a VSCode window on a second clone converges.

## 6. Git ticket sync

Setup (two clones + a bare origin):

```bash
DIR=$(mktemp -d)
git init --bare "$DIR/origin.git"
git clone "$DIR/origin.git" "$DIR/cloneA" && (cd "$DIR/cloneA" && git commit --allow-empty -m init && git push)
git clone "$DIR/origin.git" "$DIR/cloneB"
```

- [ ] Open `cloneA` in a Dev Host; enable `dostuff.sync.enabled`; create DS-001..DS-003, drag one to Working.
- [ ] Second window on `cloneB`; enable sync; **before syncing**, create colliding DS-001..DS-002.
- [ ] **DoStuff: Sync Tickets Now** in A, then B, then A → boards identical; B's collisions renumbered (toast lists `DS-00X → DS-00Y`); status bar idle.
- [ ] Delete a ticket in A → sync both → gone in B and **stays gone** after B re-syncs.
- [ ] Attach a small image in A → sync both → opens in B. Attach a >5 MiB file → metadata in B, missing-file UX for bytes.
- [ ] `git status` clean in **both** worktrees; `git for-each-ref 'refs/dostuff/*'` shows `state` (+ `remote` after fetches); no branch/PR noise.
- [ ] Two windows on the *same* clone: edit in both → both converge within ~15s; no clobbering.
- [ ] MCP with sync on: agent `create_ticket` (Thinking) → promote → demote → `update_ticket_description` → `request_ticket_close`; all of it propagates to the other clone incl. the awaiting-close badge; approving in clone B turns it Closed in both. Lane caps and the human-only Complete/Closed boundary hold.
- [ ] Element delete-vs-edit: shared ticket with tasks, synced. Delete task X in A (UI); toggle X done via MCP in B before syncing. Sync A→B→A → both converge (later stamp wins); repeat reversed. Then `update_ticket_draft` wholesale reshape in A concurrent with a done-toggle in B → converges, no resurrected duplicates.
- [ ] pendingClose race: request in A concurrent with an edit in B that wins LWW → flag dropped on both (documented); agent re-request succeeds.
- [ ] Commit anchors union: report different shas on the same ticket in A and B (MCP `update_ticket_progress`), sync both ways → both replicas show the union of commits in identical order; shas from the other clone's unpushed work render "not found in this repo" there.
- [ ] Backward compat: open a workspace with a pre-sync `dostuff.db` → loads clean, derived guids, board unchanged; disabling sync restores exactly the old behavior.
- [ ] Offline: kill the network, edit tickets → local commits succeed, status `pendingPush`; reconnect + sync → pushed.
- [ ] `dostuff.clearAll` with sync on warns that deletion propagates to every replica.
