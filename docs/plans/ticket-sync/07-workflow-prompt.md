# Ticket Sync — Plan 07: Workflow Prompt Slimming (Phase 0)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · [05-attachments](05-attachments.md) · [06-testing-and-docs](06-testing-and-docs.md) · **07**

Phase 0 — **independent of sync, execute first.** Compresses the agent workflow prompt (~58% of current length, no rules lost) and restructures how it is served: today the full prompt is embedded in **every** `get_ticket`/`list_issues`/ticket-resource response (`src/mcpServer.ts:409/443/1189/1229`), a per-call context tax on agents. The MCP SDK supports `ServerOptions.instructions` — surfaced in the `initialize` result and auto-injected by clients like Claude Code — which DoStuff never sets. After this phase: full text at initialize + the `dostuff://instructions/workflow` resource + the `workflow` MCP prompt; a one-line pointer everywhere else.

The prompt gains **nothing sync-specific** — sync is transparent to agents. `publicView` (`src/mcpServer.ts:213`) does **not** gain `guid`: no MCP tool accepts one, agents address by number/id/title, and exposing it invites agents to persist a handle the server won't honor while adding context weight to every response. Renumbering staleness after a first-sync collision merge is handled in docs (README; [06 §2 step 8](06-testing-and-docs.md)) — agents recover via `list_issues`.

## 1. Replacement prompt (`src/workflowPrompt.ts`, `buildDefaultWorkflowPrompt`)

Keeps the cap interpolation, the by-number/id/title addressing examples, and the literal phrase "DoStuff ticket queue" (asserted by `src/mcpServer.test.ts:2447`):

```
You are an engineering agent working the DoStuff ticket queue.

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
2. Active lanes (Planned, Working, Verification) are capped at ${cap} tickets
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
7. When a ticket is done or no longer needed, call `request_ticket_close`. It
   does not close the ticket — a human approves (→ Closed) or denies in DoStuff.
   Poll `get_ticket` for the outcome.

You may NOT modify a ticket's title, priority, type, or verify criteria via
MCP. If those are wrong, file a new ticket.
```

## 2. Wiring (`src/mcpServer.ts`)

1. **Initialize instructions** — per-request server construction (`:1101-1104`) means the live cap and any `dostuff.mcp.instructions` override are picked up without restart:

   ```ts
   const mcp = new McpServer(
     { name: "dostuff", version: "1.0.0" },
     { capabilities: { resources: {}, prompts: {}, tools: {} },
       instructions: readWorkflowPrompt() },
   );
   ```

2. **Slim embedding** — new export in `workflowPrompt.ts`:

   ```ts
   export const WORKFLOW_POINTER =
     "Workflow rules: see this server's initialize instructions, or read resource dostuff://instructions/workflow.";
   ```

   Replace `workflow: readWorkflowPrompt()` with `workflow: WORKFLOW_POINTER` at `:409` (`runGetTicket`), `:443` (`runListIssues`), `:1189` (tickets resource), `:1229` (single-ticket resource). The workflow **resource** (`:1241-1258`) and the **prompt** (`:1314-1330`) keep full text via `readWorkflowPrompt()`. Tool descriptions (`:1337-1453`) keep their per-tool fragments — they are the per-tool contract, not a duplicated prompt.

## 3. Tests (`src/mcpServer.test.ts`)

- `:556-561` → `expect(res.workflow).toBe(WORKFLOW_POINTER)` (import it; rename the test).
- `:2147-2156` (ticket resource) → assert `payload.workflow === WORKFLOW_POINTER`.
- `:2212-2222` (resource honors custom instructions) and `:2436-2447` (prompt) — unchanged.
- New: **initialize result carries instructions** — raw JSON-RPC `initialize` POST against the `bootServer` port (helper at `:1513` already takes `{ instructions }`), assert `result.instructions === DEFAULT_WORKFLOW_PROMPT`; second case with a custom override.
- New: **responses don't embed the full prompt** — `get_ticket`/`list_issues` `workflow` field is short (`< 200` chars, does not contain `"Rules:"`).

## 4. Doc touch list

- `README.md`: replace the "Default workflow prompt" block with the new text; update the `get_ticket`/`list_issues` tool-table rows — "returns the ticket plus a one-line workflow pointer; the full prompt is served as MCP initialize instructions and at `dostuff://instructions/workflow`"; note that Claude Code shows the instructions under `/mcp`.
- `CLAUDE.md`: one line in the MCP paragraph — prompt served as initialize instructions with a slim per-response pointer.
- `docs/workflow-rules.md`: no prompt text lives there — no change.
- `dostuff.mcp.editInstructions` (`src/extension.ts:916-929`): unchanged; its prefill picks up the new default automatically.

## 5. Gate

`bun test` + `bunx tsc --noEmit`; manual: [06 §2 step 13](06-testing-and-docs.md) (initialize instructions visible in Claude Code `/mcp`, pointer in tool responses, full text at resource/prompt, custom override reflected without restart).
