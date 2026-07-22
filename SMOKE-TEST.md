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
- [ ] `get_ticket` by number, `DS-id`, and title substring all resolve; Complete/Closed are refused.
- [ ] `create_ticket` lands in **Thinking**.
- [ ] The full loop: agent **promotes** the ticket to Planned (`update_ticket_status`), moves it to Working, **demotes** it back to Thinking, reshapes it (`update_ticket_draft`), re-promotes, edits the description (`update_ticket_description`), ticks a task + appends a record (`update_ticket_progress`), then files `request_ticket_close` → UI shows the awaiting-decision badge; approve → ticket Closed; agent's `get_ticket` for it is now refused.
- [ ] Completion flow: agent moves a ticket to Verification, files `request_ticket_complete` → "work finished" badge; **Accept & complete** → ticket Complete with `resolvedAt`; history records "Completion request approved".
- [ ] `request_ticket_complete` from a non-Verification lane is rejected, pointing at `update_ticket_status`; a completion request replaces a pending close request (record entry notes the switch).
- [ ] Lane cap: with a full lane, agent promotion into it is rejected with the cap message.
- [ ] `update_ticket_status` to Complete/Closed is rejected, pointing at `request_ticket_close`.

## 5. Workflow prompt surfaces

- [ ] Client's server info (Claude Code `/mcp`) shows the workflow **initialize instructions**.
- [ ] `dostuff://instructions/workflow` resource and the `workflow` MCP prompt return the full text.
- [ ] Set `dostuff.mcp.instructions` to a custom string → all three surfaces reflect it **without an extension restart**; clearing it restores the default with the live lane cap interpolated.

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
- [ ] Backward compat: open a workspace with a pre-sync `dostuff.db` → loads clean, derived guids, board unchanged; disabling sync restores exactly the old behavior.
- [ ] Offline: kill the network, edit tickets → local commits succeed, status `pendingPush`; reconnect + sync → pushed.
- [ ] `dostuff.clearAll` with sync on warns that deletion propagates to every replica.
