# DoStuff MCP tool reference

Transcribed from the server's zod schemas (`src/mcpServer.ts` / `src/mcpLimits.ts`).
All requests are `tools/call` POSTs; the tool's payload is the JSON string at
`result.content[0].text`. Unknown extra fields are **rejected** (strict
schemas). Over-long values are rejected, never truncated.

Shared enums:

- `type`: `Bug | Feature | Refactor | Chore | Spike`
- `priority`: `Critical | High | Regular | Low`
- `status`: `Thinking | Planned | Working | Verification | Complete | Closed`
- link `kind`: `blocks | child-of | relates-to`
- ticket `id`: matches `^DS-\d+$` (e.g. `DS-042`)
- commit sha: 7–40 hex chars (`^[0-9a-fA-F]{7,40}$`)

Every write response includes `workspace` (name + path) so you can confirm you
hit the right instance.

## get_ticket (read-only)

| param | type | notes |
|---|---|---|
| `query` | string, required | ticket number (`"42"`/`"#42"`), id (`"DS-042"`), or case-insensitive title substring |
| `view` | `"full"` (default) \| `"status"` | `"status"` = poll view: only id/number/title/status/updatedAt/pendingClose/task counts |
| `recordLimit` | int 0–500 | newest N record entries; `0` = whole log; default is server-configured (usually 3) |
| `include` | array of `"commits"` \| `"verifyCriteria"` | restore sections the response names in `omitted` |

Response (`view: "full"`): `{workspace, workflow, ticket}` where ticket has
`id, number, title, type, priority, status, updatedAt, description, verifyCriteria`
(sliced past 2,000 chars unless included; then `verifyCriteriaTruncated: true`),
`tags, tasks[{id,text,done}], record[{at,author,source,text}]`
(+ `recordCount`/`recordOmitted` when windowed), `attachments[]`,
`links[{targetId,kind}], inboundLinks[{sourceId,sourceTitle,kind}]`,
`commitCount` (+ `commits[{sha,at}]` when included), `createdAt`,
`pendingClose`, and `omitted[]` naming withheld sections in `include` spelling.

Errors: ambiguous query lists the matches; Complete/Closed tickets are not
fetchable by agents.

## list_issues (read-only)

| param | type | notes |
|---|---|---|
| `type` / `priority` / `status` | enum, optional | filters |
| `limit` | int 1–250, default 100 | page size |
| `offset` | int ≥0, default 0 | stable — sort is by ticket number ascending |

Response: `{workspace, workflow, count, returned, nextOffset?, issues[]}` —
`count` is total matching, `nextOffset` present only when another page exists.
Rows: `{id, number, title, type, priority, status}`. Includes Thinking and
Complete tickets for the full picture.

## create_ticket

| param | type | limit |
|---|---|---|
| `title` | string, required | 1–200 chars |
| `description` | string | ≤10000 chars; lead with 1-2 sentences of what + why |
| `type` | enum | default `Feature` |
| `priority` | enum | default `Regular` |
| `verifyCriteria` | string | ≤10000 chars |
| `tasks` | string[] | each 1–500 chars |
| `tags` | string[] | each ≤64 chars |
| `links` | `[{targetId, kind}]` | unknown target ids dropped with a warning |

Response: `{workspace, id, number, status: "Thinking", message}`. Always lands
in Thinking; no agent path creates directly into an active lane.

## update_ticket_status

| param | type | limit |
|---|---|---|
| `id` | `DS-\d+`, required | |
| `status` | enum, required | only Thinking/Planned/Working/Verification succeed |
| `note` | string | ≤2000 chars |

Response: `{workspace, id, status, from}`. Rejections: terminal target or
source (Complete/Closed), or a full active lane (error names the lane and its
limit — the limit tracks the `dostuff.activeLaneCap` setting, don't assume it).

## update_ticket_progress

| param | type | limit |
|---|---|---|
| `id` | `DS-\d+`, required | |
| `taskUpdates` | `[{id, done}]` | task ids from `get_ticket` |
| `recordEntry` | string | ≤500 chars; one line, ~15 words |
| `commit` | string | 7–40 hex; appended to append-only commits list, deduped |

Response: `{workspace, id, tasksChanged[{id,done}], tasks:{total,done},
recordLength, commitCount}` — echoes only the tasks this call touched.
Title/priority/type/verifyCriteria are immutable here; description edits go
through `update_ticket_description`. Non-terminal tickets only.

## update_ticket_draft (Thinking only)

| param | type | limit |
|---|---|---|
| `id` | `DS-\d+`, required | |
| `tags` | string[] | each ≤64 chars; omit = unchanged, `[]` = clear |
| `links` | `[{targetId, kind}]` | same omit/clear semantics |
| `tasks` | `[{text, done?}]` | text 1–500 chars |
| `expectedUpdatedAt` | string, optional | CAS guard: the `updatedAt` from your last read |

Response: `{workspace, id, updatedAt, tags, links, tasks}` (post-update lists;
`updatedAt` is the token for a follow-up guarded write). Rejected once the
ticket leaves Thinking — fall back to `update_ticket_progress` for
done-toggles and `update_ticket_description` for prose.

This tool **replaces** whole lists, so concurrent writers can silently erase
each other. Pass `expectedUpdatedAt` when another agent might touch the same
ticket: a stale token is rejected with the fresh `{updatedAt, tags, links,
tasks}` embedded in the error — re-apply your edit to that state and retry
with the new token.

## update_ticket_description

| param | type | limit |
|---|---|---|
| `id` | `DS-\d+`, required | |
| `description` | string, required | ≤10000 chars |
| `note` | string | ≤500 chars record entry |
| `expectedUpdatedAt` | string, optional | CAS guard: the `updatedAt` from your last read |

Response: `{workspace, id, updatedAt}`. The only MCP path that changes prose.
Non-terminal tickets only. Replace-shaped like `update_ticket_draft`: with
`expectedUpdatedAt` set, a ticket that changed since your read rejects the
write and embeds the fresh `{updatedAt, description}` so you can merge and
retry instead of silently overwriting someone else's edit.

## request_ticket_close / request_ticket_complete

| param | type | limit |
|---|---|---|
| `id` | `DS-\d+`, required | |
| `note` | string | ≤500 chars |

Response: `{workspace, id, pendingClose: true, target, message}`. Neither
changes status; a human approves or denies in the DoStuff UI.

- `request_ticket_close` — OBE / won't-do; approval → `Closed`. Any
  non-terminal ticket.
- `request_ticket_complete` — finished work; approval → `Complete`.
  **Only from `Verification`.**
- A request with the other target replaces the pending one (recorded).
- Poll with `get_ticket {view: "status"}`: `pendingClose` non-null = pending;
  null again = denied; ticket no longer fetchable = approved (terminal).

## Resources (`resources/read`)

| uri | payload |
|---|---|
| `dostuff://tickets` | summary rows: `{id, number, title, type, priority, status, tags, tasks: "done/total", excerpt?}` — Complete/Closed hidden |
| `dostuff://tickets/{id}` | one full ticket (same shape as `get_ticket` full view) |
| `dostuff://instructions/workflow` | the workflow prompt text |
| `dostuff://attachments/{ticketId}/{attachmentId}` | base64 blob, ≤10 MB |

Resource payloads sit at `result.contents[0].text` (or `.blob` for
attachments), not `result.content`.

## Worked examples

Plain-JSON response:

```
$ sh scripts/dostuff.sh call list_issues '{"status":"Planned","limit":5}'
{"workspace":{...},"workflow":"...","count":2,"returned":2,"issues":[
 {"id":"DS-012","number":12,"title":"...","type":"Bug","priority":"High","status":"Planned"}, ...]}
```

SSE-framed response (what the raw HTTP body can look like — the script
unwraps this for you):

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"workspace\":...}"}]},"jsonrpc":"2.0","id":1}
```

JSON-RPC request envelope the script builds:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"update_ticket_progress",
           "arguments":{"id":"DS-012","taskUpdates":[{"id":"<task-id>","done":true}],
                        "recordEntry":"auth fix landed, tests green","commit":"0a1b2c3d"}}}
```
