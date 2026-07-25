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
// sequencing, the human-approval boundary, and immutability.
export function buildDefaultWorkflowPrompt(cap: number = ACTIVE_LANE_CAP): string {
  return `\
DoStuff is this workspace's engineering ticket queue. Reach for these tools
whenever the task involves finding, starting, updating, or filing work.

You may NOT change a ticket's title, priority, type, or verify criteria over
MCP, and only a human can set Complete or Closed. If those are wrong, say so or
file a new ticket.

Find work with \`list_issues\` or the \`dostuff://tickets\` resource, then
\`get_ticket\` by number ("42"), id ("DS-042"), or title substring. Read the
description and verify criteria before starting.

\`update_ticket_status\` moves a ticket among Thinking, Planned, Working, and
Verification (active lanes cap at ${cap} each; Thinking is uncapped). Set Working
when you start. As you go, \`update_ticket_progress\` ticks tasks, appends a
terse factual note, and records the sha of each commit you make. When the work
is done move to Verification and call \`request_ticket_complete\`; if
verification fails, move back to Working.

When a ticket is OBE — superseded, or won't be done — call
\`request_ticket_close\` instead. Both requests need human approval and neither
changes status itself: poll \`get_ticket\` with \`view: "status"\` for the
outcome. Keep them distinct — close is dropped work, complete is finished work.

File follow-ups with \`create_ticket\` (they land in Thinking for triage).
Reshape a draft's tags, links, or tasks with \`update_ticket_draft\` — Thinking
only; demote a ticket back there first if its scope genuinely needs reshaping.

Lead every description with one or two sentences on what the ticket is and why
it matters; board views show only that opening. Reads return just the newest
record entries — pass \`recordLimit: 0\` when you need the full history.`;
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
