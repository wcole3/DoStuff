// Input caps for agent-facing MCP writes, in one place so the zod schemas in
// `mcpServer.ts`, the agent skill's client-side cap table
// (`skills/dostuff-tickets/scripts/dostuff.sh`), and the drift tests in
// `agentSkill.test.ts` all read the same numbers. vscode-free by design.
//
// These are *input* caps only — a longer value written by an older build or by
// a human in the UI still loads and is served unchanged (see CLAUDE.md).
export const FIELD_LIMITS = {
  title: 200,
  description: 10_000,
  verifyCriteria: 10_000,
  taskText: 500,
  tag: 64,
  // update_ticket_status carries a fuller "why this move" note; every other
  // note/recordEntry is a one-line record write and shares the tight cap.
  statusNote: 2_000,
  note: 500,
  recordEntry: 500,
  commitMinHex: 7,
  commitMaxHex: 40,
  recordLimitMax: 500,
  listLimitMax: 250,
} as const;

export const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
