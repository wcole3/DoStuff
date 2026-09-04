---
name: dostuff-tickets
description: >-
  Drive the DoStuff ticket queue (VSCode issue-board extension) over its
  loopback MCP HTTP API with curl — no MCP client registration needed. Use when
  the user mentions tickets, the ticket queue or board, DoStuff, ids like
  DS-42, filing/starting/updating/completing/closing an issue or ticket, or
  asks what to work on next.
allowed-tools: Read, Bash(curl:*), Bash(sh:*)
---

# DoStuff ticket queue

DoStuff is this workspace's engineering ticket queue, served by the DoStuff
VSCode extension as a **stateless MCP server over loopback HTTP**. You are the
HTTP client: every call is a bare one-shot JSON-RPC POST — no initialize
handshake, no session header.

**If `mcp__dostuff__*` tools are available in this session, use them and skip
everything below** — this skill exists for sessions where the server is not
registered as an MCP client.

## Find the server

```
sh <this-skill-dir>/scripts/dostuff.sh discover
```

Prints `PORT<tab>WORKSPACE` for the instance matching your cwd. `DOSTUFF_PORT`
env var short-circuits discovery; `DOSTUFF_TIMEOUT` (seconds, default 15)
bounds each call. A "did not answer" error means the host is busy — retry,
don't re-discover. If the script is unavailable, do it
manually: Read the registry — `$DOSTUFF_REGISTRY_PATH` if set, else
`~/.config/dostuff/instances.json` (Linux/macOS) or
`%APPDATA%/dostuff/instances.json` (Windows) — a JSON array of
`{workspacePath, port, pid, name, startedAt}`. Pick the entry whose
`workspacePath` is the longest path-prefix of your cwd; tie → newest
`startedAt`; no prefix match and exactly one entry → use it.

## Calling tools

```
sh <this-skill-dir>/scripts/dostuff.sh call <tool> '<json-arguments>'
sh <this-skill-dir>/scripts/dostuff.sh call <tool> -        # args JSON on stdin (long descriptions)
sh <this-skill-dir>/scripts/dostuff.sh resource <uri>       # e.g. dostuff://tickets
```

The script discovers the port, validates field length caps locally, wraps the
JSON-RPC envelope, unwraps SSE framing, and prints the tool's JSON payload
(or `ERROR: …` on failure). Raw curl equivalent, if you need it:

```
curl -sS -X POST http://127.0.0.1:<port>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_ticket","arguments":{"query":"42"}}}'
```

The response body is either plain JSON or SSE (`data:` lines — concatenate
them). The tool's payload is the JSON string at `result.content[0].text`;
`result.isError: true` means the text is an error message.

## Tools

Full parameter schemas, field limits, and response shapes: read
`references/tools.md` in this skill's directory. One-liners:

- `get_ticket` — fetch by number ("42"), id ("DS-042"), or title substring.
  `view: "status"` for cheap polling; `recordLimit: 0` for full history;
  `include: ["commits"|"verifyCriteria"]` restores sections listed under `omitted`.
- `list_issues` — compact index; filter by `type`/`priority`/`status`; paged
  (`count`, `returned`, follow `nextOffset` if present).
- `create_ticket` — file new work; always lands in `Thinking` for human triage.
- `update_ticket_status` — move among Thinking/Planned/Working/Verification only.
- `update_ticket_progress` — tick `taskUpdates[].done`, append one terse
  `recordEntry`, record a `commit` sha.
- `update_ticket_draft` — replace tags/links/tasks; Thinking-only.
- `update_ticket_description` — replace description (+ one record note);
  the only prose edit path.
- `request_ticket_close` — ask a human to close OBE / no-longer-needed work.
- `request_ticket_complete` — ask a human to accept finished work;
  Verification-only.

Resources (`resource` subcommand): `dostuff://tickets` (summary index),
`dostuff://tickets/{id}`, `dostuff://instructions/workflow`,
`dostuff://attachments/{ticketId}/{attachmentId}`.

## Workflow rules

- **Only a human can set Complete or Closed.** You may NOT change a ticket's
  title, priority, type, or verifyCriteria. Wrong? Say so, or file a new ticket.
- Find work: `list_issues`, then `get_ticket`. Read description + verify
  criteria before starting. Move to `Working` when you start.
- Active lanes (Planned/Working/Verification) have a server-enforced cap; an
  over-cap move is rejected with an error naming the lane and limit. Thinking
  is uncapped.
- As you go: `update_ticket_progress` ticks tasks, appends one note, records
  each commit sha. Done → move to `Verification`, then
  `request_ticket_complete`. Verify fails → back to `Working`.
- OBE — superseded or won't be done → `request_ticket_close` instead. Both
  requests need human approval and change nothing themselves: poll
  `get_ticket` with `view: "status"` (pendingClose non-null = still pending;
  null again = denied; ticket unfetchable = approved/terminal).
  Close = dropped work, complete = finished work.
- Follow-ups → `create_ticket`. Reshape a draft's tags/links/tasks with
  `update_ticket_draft` — Thinking only.
- **Parallel subagents: one writer per ticket.** Skill calls are raw HTTP with
  no client-side serialization. Partition tickets across concurrent workers;
  if two must touch one ticket, use only the delta tools
  (`update_ticket_progress` toggles by task id, records/commits append) —
  never `update_ticket_draft`, which replaces whole lists and silently drops
  the other writer's edit. Reads are always safe to parallelize. When a
  replace-shaped write (`update_ticket_draft` / `update_ticket_description`)
  can't be avoided on a shared ticket, pass `expectedUpdatedAt` (the
  `updatedAt` from your read) — a stale token rejects with the fresh state
  instead of silently losing the other edit (see `references/tools.md`).
- **Write terse** — every byte you write is re-read on each later ticket read.
  Record notes: one line, ~15 words, facts and outcomes; no narration, no
  restating the ticket. Descriptions: 1-2 sentences of what + why first
  (boards show only that opening), detail below. Over-long fields are
  rejected, not truncated — trim, don't pad.

## Errors

- **Connection refused / no registry entry**: the extension isn't running, or
  `dostuff.mcp.enabled` is false, or the entry is stale — re-run `discover`.
  Two fixes, either works: ask the user to open the workspace in VSCode with
  `dostuff.mcp.enabled` on, **or start the bundled headless server** (no
  VSCode needed — same DB, same API, same registry):

  ```sh
  node "$DOSTUFF_SERVER_JS" serve --workspace /path/to/repo
  # $DOSTUFF_SERVER_JS unset? It ships in the extension install — pick the
  # newest: ls -d ~/.vscode/extensions/*dostuff*/dist/server.cjs | tail -1
  ```

  Suggest the command and let the user (or an approved agent step) run it —
  it stays in the foreground and refuses a workspace another live instance
  already serves (exit 3; `--takeover` for zombies).
- **HTTP 403**: use literal `127.0.0.1` as the host (the server rejects other
  Host/Origin values).
- **`ERROR:` / `isError` responses**: the message states the violated rule
  (lane cap, terminal status, immutable field, over-long input). On a schema
  rejection, check `references/tools.md` for the exact field shapes.
