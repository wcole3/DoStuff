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

DoStuff serves this workspace's tickets as a stateless MCP server on loopback
HTTP. `scripts/dostuff.sh` is the client: it finds the port, checks field caps,
wraps the JSON-RPC envelope, and prints the tool's JSON payload or `ERROR: …`.

**If `mcp__dostuff__*` tools exist in this session, use them and skip this
skill.**

## Contents

- Call a tool — the one command you need
- Tools — one line each; full schemas in `references/tools.md`
- Work a ticket — the step sequence
- Hard rules — what an agent may never do
- Parallel agents — one writer per ticket, `expectedUpdatedAt`
- When it fails — symptom → fix
- `references/tools.md` — params, limits, response shapes
- `references/transport.md` — manual discovery, raw curl, SSE, headless server

## Call a tool

```
sh <skill-dir>/scripts/dostuff.sh call <tool> '<json-args>'
sh <skill-dir>/scripts/dostuff.sh call <tool> -        # args JSON on stdin
sh <skill-dir>/scripts/dostuff.sh resource <uri>       # e.g. dostuff://tickets
sh <skill-dir>/scripts/dostuff.sh discover             # PORT<tab>WORKSPACE for cwd
```

Needs `sh`, `curl`, `awk`, `sed`. `jq` is optional: without it, caps are not
checked locally and output is the raw JSON-RPC body. Env: `DOSTUFF_PORT` skips
discovery; `DOSTUFF_TIMEOUT` (seconds, default 15) and `DOSTUFF_RETRIES`
(default 3) bound each call. Timeouts and 503s retry under one
`Idempotency-Key`, so a retried write never duplicates. A "busy" error after
the budget means back off, not re-discover. No script, or need raw HTTP? See
`references/transport.md`.

## Tools

Read `references/tools.md` before your first write: schemas are strict, so an
unknown field or over-long value is rejected, never truncated.

| tool | does | gate |
|---|---|---|
| `get_ticket` | fetch by number, `DS-id`, or title substring. `view: "status"` to poll; `recordLimit: 0` for the full log; `include: ["commits","verifyCriteria"]` restores sections listed in `omitted` | not Complete/Closed |
| `list_issues` | compact index; filter `type`/`priority`/`status`; follow `nextOffset` | — |
| `create_ticket` | file new work | lands in Thinking |
| `update_ticket_status` | move among Thinking/Planned/Working/Verification | active lanes capped |
| `update_ticket_progress` | tick `taskUpdates[].done`, one `recordEntry`, one `commit` sha | non-terminal |
| `update_ticket_description` | replace description (+ one `note`); the only prose edit | non-terminal; CAS |
| `update_ticket_draft` | replace tags/links/tasks | Thinking only; CAS |
| `request_ticket_close` | ask a human to drop the ticket (OBE / won't do) | non-terminal |
| `request_ticket_complete` | ask a human to accept finished work | Verification only |

Resources (`resource` subcommand): `dostuff://tickets`, `dostuff://tickets/{id}`,
`dostuff://instructions/workflow`, `dostuff://attachments/{ticketId}/{attachmentId}`.

## Work a ticket

1. Pick: `list_issues`, then `get_ticket`. Read description and verifyCriteria.
2. Start: `update_ticket_status` → `Working`.
3. Loop: after each unit of work, `update_ticket_progress` — tick tasks, one
   record note, the commit sha.
4. Done: status → `Verification`, then `request_ticket_complete`.
5. Poll `get_ticket {view: "status"}`: `pendingClose` set = pending; null
   again = denied; ticket no longer fetchable = approved.
6. Verify failed → back to `Working`, resume step 3. Superseded or won't be
   done → `request_ticket_close` in place of step 4.

Follow-up work → `create_ticket`. Reshape a draft's tags/links/tasks with
`update_ticket_draft` while it is still in Thinking.

## Hard rules

- **Only a human can set Complete or Closed.** Both request tools change
  nothing themselves; they wait for approval in the DoStuff UI.
- You may NOT change title, priority, type, or verifyCriteria. Disagree? Say
  so in a record note, or file a new ticket.
- Active lanes have a server-enforced cap; the rejection names the lane and
  its limit. Thinking is uncapped.
- **Write terse.** Every byte you write is re-read on each later ticket read.
  Record notes: one line, ~15 words, facts and outcomes. Descriptions: 1-2
  sentences of what + why first (boards show only that), detail below.

## Parallel agents

Script calls are raw HTTP with no client-side serialization. **One writer per
ticket.** If two workers must share a ticket, use only the delta tool
(`update_ticket_progress`: toggles by task id, appends notes and commits).
Never `update_ticket_draft` on a shared ticket — it replaces whole lists and
drops the other writer's edit. If a replace-shaped write
(`update_ticket_draft`, `update_ticket_description`) is unavoidable, pass
`expectedUpdatedAt` from your last read: a stale token is rejected with the
fresh state embedded, so merge and retry. Reads always parallelize safely.

## When it fails

| symptom | cause | fix |
|---|---|---|
| `ERROR: …` / `isError` | rule violated: lane cap, terminal status, immutable field, over-long input, schema | message names the rule; check field shapes in `references/tools.md`; fix; retry |
| exit 2, `field … exceeds` | local cap check; no request sent | trim the field, do not pad |
| `Nothing is listening` / `No registry` | extension not running, `dostuff.mcp.enabled` off, or stale entry | re-run `discover`; else ask the user to open the workspace in VSCode, or start the headless server (`references/transport.md`) |
| `did not answer within` / `busy` | extension host stalled or write queue full | retry shortly; raise `DOSTUFF_TIMEOUT` if it recurs |
| HTTP 403 | non-loopback Host/Origin | use literal `127.0.0.1` |
