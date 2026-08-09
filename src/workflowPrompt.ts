// Default workflow prompt served alongside every MCP ticket response.
//
// Lives in its own file so the extension host can read the default text
// without statically importing `mcpServer.ts` (which pulls in the heavy
// MCP SDK + zod and is loaded lazily on activation).

import { ACTIVE_LANE_CAP } from "./types";

/**
 * Byte ceiling for the workflow prompt and for each registered tool
 * description. Claude Code truncates both at 2KB; this sits below that so the
 * `activeLaneCap` interpolation and ordinary edits have room before anything
 * is silently cut. Asserted in `mcpServer.test.ts`.
 */
export const PROMPT_BYTE_BUDGET = 1800;

// Served once per connection as MCP initialize `instructions` (plus the
// dostuff://instructions/workflow resource and the `workflow` MCP prompt).
//
// HARD BUDGET — see PROMPT_BYTE_BUDGET. Claude Code truncates server
// instructions at 2KB and drops the remainder with no error. An earlier draft
// of this prompt ran to 2,830 bytes, which cut the OBE close flow and the
// field-immutability contract off the end: the two rules least safe to lose.
// Keep additions inside the budget, or move the detail into a tool's own
// `description` (each of those gets its own 2KB).
//
// Ordering is deliberate. Claude Code defers MCP tool schemas by default and
// discovers them via tool search, so these instructions are what decides
// whether an agent reaches for DoStuff at all. Lead with what the server is,
// then carry only the rules no single tool description can: cross-tool
// sequencing, the human-approval boundary, immutability, and the write-terse
// rule (every byte an agent writes is re-read on every later ticket read, by
// this agent and the next one).
export function buildDefaultWorkflowPrompt(cap: number = ACTIVE_LANE_CAP): string {
  return `\
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

Find work: \`list_issues\` or \`dostuff://tickets\`, then \`get_ticket\` by number
("42"), id ("DS-042"), or title substring. Read description + verify criteria
first.

\`update_ticket_status\` moves among Thinking, Planned, Working, Verification
(active lanes cap ${cap} each; Thinking uncapped). Working when you start. As you
go, \`update_ticket_progress\` ticks tasks, appends one note, records each commit
sha. Done → Verification, then \`request_ticket_complete\`. Verify fails → back
to Working.

OBE — superseded or won't be done → \`request_ticket_close\` instead. Both
requests need human approval, neither changes status: poll \`get_ticket\` with
\`view: "status"\`. Close = dropped work, complete = finished work.

Follow-ups → \`create_ticket\` (lands in Thinking). Reshape a draft's tags,
links, tasks with \`update_ticket_draft\` — Thinking only. Reads return newest
record entries only — \`recordLimit: 0\` for full history.`;
}

// One-line stand-in embedded in per-call tool/resource responses instead of
// the full prompt (which is served via initialize instructions).
export const WORKFLOW_POINTER =
  "Workflow rules: see this server's initialize instructions, or read resource dostuff://instructions/workflow.";

// Convenience snapshot at the schema-default cap. Used by tests and by
// any caller that just wants the canonical default text. Live callers
// that honor the `dostuff.activeLaneCap` setting should call
// `buildDefaultWorkflowPrompt(cap)` directly.
export const DEFAULT_WORKFLOW_PROMPT = buildDefaultWorkflowPrompt();
