// MCP server exposed by the DoStuff extension.
//
// Surface:
//   Resources
//     dostuff://tickets                       List of Thinking + active-lane tickets (Complete/Closed hidden)
//     dostuff://tickets/{id}                  One Thinking or active-lane ticket
//     dostuff://instructions/workflow         The workflow prompt
//
//   Prompt
//     workflow                                Workflow guidance for the agent
//
//   Tools
//     get_ticket             fetch by #NN, DS-id, or title substring
//     list_issues            compact id/title index with optional type/priority/status filters
//     create_ticket          file new ticket in "Thinking" for human triage
//     update_ticket_status   move ticket between Planned <-> Working <-> Verification
//                            with lane-cap enforcement (cap=6) and the
//                            Thinking-one-way rule (current must already be active)
//     update_ticket_progress toggle task[].done and append a record entry
//     update_ticket_draft    reshape a Thinking draft's tags/links/tasks
//
// Constraints enforced by the server (not just the schema):
//   - Tickets in Complete or Closed are never returned by the read APIs.
//     Thinking tickets ARE readable + annotatable (so agents can record
//     relationships on tickets they just filed), but cannot be promoted.
//   - update_ticket_status rejects:
//       * targets that aren't Planned/Working/Verification
//       * current status that isn't Planned/Working/Verification
//         (Thinking-one-way; only humans triage)
//       * moves into a lane already at ACTIVE_LANE_CAP
//   - update_ticket_progress can only touch tasks[].done and append to record.
//   - update_ticket_draft can replace tags/links/tasks, but ONLY while the
//     ticket is in Thinking (untriaged). Title/description/priority/type/
//     verifyCriteria remain UI-only.

import * as http from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IssueStore } from "./storage";
import {
  normalizeWorkspacePath,
  registerEntry,
  unregisterEntry,
} from "./mcpRegistry";
import {
  ACTIVE_LANE_CAP,
  ACTIVE_LANES,
  AGENT_VISIBLE_STATUSES,
  AGENT_WRITABLE_STATUSES,
  INVERSE_LINK_KIND,
  LINK_KINDS,
  MAX_ATTACHMENT_BYTES,
  canMoveToActiveLane,
  coerceLinks,
  coerceTags,
  type Issue,
  type LinkKind,
  type RecordEntry,
  type Status,
} from "./types";
import { validateLinks } from "./extension";

// The default workflow prompt lives in its own small module so the extension
// host can import it without dragging the full MCP SDK + zod into its bundle.
export { DEFAULT_WORKFLOW_PROMPT, buildDefaultWorkflowPrompt } from "./workflowPrompt";
import { buildDefaultWorkflowPrompt } from "./workflowPrompt";

// ----- Tool result helpers ---------------------------------------------------

export type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const ToolResultOk = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});
const ToolResultErr = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

// ----- Input schemas (raw zod shapes per SDK v1.x) ---------------------------

const NEW_TICKET_INPUT = {
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().default(""),
  type: z.enum(["Bug", "Feature", "Refactor", "Chore", "Spike"]).default("Feature"),
  priority: z.enum(["Critical", "High", "Regular", "Low"]).default("Regular"),
  verifyCriteria: z.string().max(10_000).optional().default(""),
  tasks: z.array(z.string().min(1).max(500)).optional().default([]),
  tags: z.array(z.string().max(64)).optional().default([]),
  links: z
    .array(
      z.object({
        targetId: z.string().regex(/^DS-\d+$/i, "Expected an id like DS-001"),
        kind: z.enum(LINK_KINDS),
      }),
    )
    .optional()
    .default([]),
};

const STATUS_INPUT = {
  id: z.string().regex(/^DS-\d+$/, "Expected an id like DS-001"),
  status: z.enum(["Thinking", "Planned", "Working", "Verification", "Complete", "Closed"] as const),
  note: z.string().max(2_000).optional(),
};

const PROGRESS_INPUT = {
  id: z.string().regex(/^DS-\d+$/),
  taskUpdates: z
    .array(
      z.object({
        id: z.string(),
        done: z.boolean(),
      })
    )
    .optional()
    .default([]),
  recordEntry: z.string().max(5_000).optional(),
};

// Shape-edit a *draft* (Thinking) ticket: replace tags / links / tasks. Each
// field is optional; omitted fields are left untouched. Only valid while the
// ticket is in Thinking — once triaged, scope is locked (use the UI).
const DRAFT_INPUT = {
  id: z.string().regex(/^DS-\d+$/),
  tags: z.array(z.string().max(64)).optional(),
  links: z
    .array(
      z.object({
        targetId: z.string().regex(/^DS-\d+$/i, "Expected an id like DS-001"),
        kind: z.enum(LINK_KINDS),
      }),
    )
    .optional(),
  tasks: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        done: z.boolean().optional().default(false),
      }),
    )
    .optional(),
};

const GET_TICKET_INPUT = {
  query: z
    .string()
    .min(1)
    .describe("Ticket number, DS-id, or a substring of the title."),
};

const LIST_ISSUES_INPUT = {
  type: z
    .enum(["Bug", "Feature", "Refactor", "Chore", "Spike"])
    .optional()
    .describe("Narrow to one issue type."),
  priority: z
    .enum(["Critical", "High", "Regular", "Low"])
    .optional()
    .describe("Narrow to one priority level."),
  status: z
    .enum(["Thinking", "Planned", "Working", "Verification", "Complete", "Closed"])
    .optional()
    .describe("Narrow to one status. Omit to list all statuses."),
};

// Strict schemas used at handler entry to reject smuggled-in extra fields.
// The SDK's `registerTool({ inputSchema })` takes the raw shape and its
// behavior for unknown keys is version-dependent. Parsing again in-handler
// with `.strict()` is the authoritative defence-in-depth.
const NewTicketSchema   = z.object(NEW_TICKET_INPUT).strict();
const StatusSchema      = z.object(STATUS_INPUT).strict();
const ProgressSchema    = z.object(PROGRESS_INPUT).strict();
const DraftSchema       = z.object(DRAFT_INPUT).strict();
const GetTicketSchema   = z.object(GET_TICKET_INPUT).strict();
const ListIssuesSchema  = z.object(LIST_ISSUES_INPUT).strict();

// ----- Helpers ---------------------------------------------------------------

export function publicView(issue: Issue, allIssues: Issue[] = []) {
  // Derive inbound links by scanning every other issue's outbound list and
  // inverting the kind via INVERSE_LINK_KIND. Single-source — no dual-write.
  const inboundLinks = allIssues.flatMap((other) => {
    if (other.id === issue.id) return [];
    return other.links
      .filter((l) => l.targetId === issue.id)
      .map((l) => ({
        sourceId: other.id,
        sourceTitle: other.title,
        kind: INVERSE_LINK_KIND[l.kind],
      }));
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    type: issue.type,
    priority: issue.priority,
    status: issue.status,
    description: issue.description,
    verifyCriteria: issue.verifyCriteria,
    tags: issue.tags,
    tasks: issue.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done })),
    record: issue.record.map((r) => ({
      at: r.at,
      author: r.author,
      source: r.source,
      text: r.text,
    })),
    attachments: issue.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      addedAt: a.addedAt,
      uri: `dostuff://attachments/${issue.id}/${a.id}`,
    })),
    links: issue.links.map((l) => ({ targetId: l.targetId, kind: l.kind })),
    inboundLinks,
    createdAt: issue.createdAt,
  };
}

export function readWorkflowPrompt(): string {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  const custom = cfg.get<string>("mcp.instructions");
  if (custom && custom.trim()) return custom;
  const cap = cfg.get<number>("activeLaneCap", ACTIVE_LANE_CAP);
  return buildDefaultWorkflowPrompt(cap);
}

/**
 * Resolve the preferred MCP port from the workspace config. Returns 0 (let the
 * OS pick) when the setting is missing, out of range, or non-integer. Ports
 * 1–1023 are coerced to 0 to avoid surprises with privileged ports.
 */
export function readPreferredPort(cfg: vscode.WorkspaceConfiguration): number {
  const raw = cfg.get<number>("mcp.port", 0);
  if (!Number.isInteger(raw)) return 0;
  if (raw === 0) return 0;
  if (raw < 1024 || raw > 65535) return 0;
  return raw;
}

function isLocalhost(addr: string): boolean {
  return (
    addr === "localhost" ||
    addr === "::1" ||
    addr === "127.0.0.1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

export function getWorkspaceContext(): { name: string; rootPath: string } | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  return {
    name: vscode.workspace.name ?? folders[0].name,
    rootPath: folders[0].uri.fsPath,
  };
}

// ----- Pure tool handlers (exported for tests) -------------------------------

export type GetTicketInput = { query: string };
export type ListIssuesInput = {
  type?: "Bug" | "Feature" | "Refactor" | "Chore" | "Spike";
  priority?: "Critical" | "High" | "Regular" | "Low";
  status?: Status;
};
export type CreateTicketInput = {
  title: string;
  description?: string;
  type?: "Bug" | "Feature" | "Refactor" | "Chore" | "Spike";
  priority?: "Critical" | "High" | "Regular" | "Low";
  verifyCriteria?: string;
  tasks?: string[];
  tags?: string[];
  links?: Array<{ targetId: string; kind: LinkKind }>;
};
export type UpdateStatusInput = { id: string; status: Status; note?: string };
export type UpdateProgressInput = {
  id: string;
  taskUpdates?: Array<{ id: string; done: boolean }>;
  recordEntry?: string;
};
export type UpdateDraftInput = {
  id: string;
  tags?: string[];
  links?: Array<{ targetId: string; kind: LinkKind }>;
  tasks?: Array<{ text: string; done?: boolean }>;
};

/**
 * Look up an active ticket by number (`#42` / `42`), id (`DS-042`), or
 * case-insensitive title substring.
 *
 * Returns the ticket plus the current workflow prompt as JSON.
 *
 * - Thinking, Planned, Working, and Verification tickets are servable;
 *   Complete and Closed return an error.
 * - Title-substring queries that match multiple servable tickets return an
 *   ambiguity error listing each candidate so the agent can narrow.
 * - `statusHistory` and `resolvedAt` are stripped from the response.
 */
export async function runGetTicket(
  store: IssueStore,
  args: GetTicketInput,
): Promise<ToolResult> {
  const parsed = GetTicketSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for get_ticket: ${parsed.error.message}`);
  args = parsed.data;
  const q = args.query.trim();
  if (!q) return ToolResultErr("Empty query.");

  const all = store.list();
  let match: Issue | undefined;
  let ambiguous: Issue[] = [];

  if (/^#?\d+$/.test(q)) {
    const n = parseInt(q.replace(/^#/, ""), 10);
    match = all.find((i) => i.number === n);
    if (!match) return ToolResultErr(`No ticket with number ${n}.`);
  } else if (/^DS-\d+$/i.test(q)) {
    const id = q.toUpperCase();
    match = all.find((i) => i.id === id);
    if (!match) return ToolResultErr(`No ticket with id ${id}.`);
  } else {
    const needle = q.toLowerCase();
    const hits = all.filter((i) => i.title.toLowerCase().includes(needle));
    if (hits.length === 0) {
      return ToolResultErr(
        `No ticket matches "${q}". Try the ticket number or a different substring.`,
      );
    }
    if (hits.length > 1) {
      const servableHits = hits.filter((h) =>
        AGENT_VISIBLE_STATUSES.includes(h.status),
      );
      if (servableHits.length === 1) {
        match = servableHits[0];
      } else {
        ambiguous = hits;
      }
    } else {
      match = hits[0];
    }
  }

  if (!match) {
    return ToolResultErr(
      `Ambiguous query "${q}" -- ${ambiguous.length} matches:\n` +
        ambiguous
          .map((i) => `  - #${i.number} (${i.id}) [${i.status}] -- ${i.title}`)
          .join("\n") +
        `\nNarrow by number or id.`,
    );
  }

  if (!AGENT_VISIBLE_STATUSES.includes(match.status)) {
    return ToolResultErr(
      `Ticket #${match.number} (${match.id}) is in "${match.status}". ` +
        `Agents cannot fetch Complete or Closed tickets.`,
    );
  }

  return ToolResultOk(
    JSON.stringify(
      { workspace: getWorkspaceContext(), workflow: readWorkflowPrompt(), ticket: publicView(match, all) },
      null,
      2,
    ),
  );
}

/**
 * Return a compact index of all issues, optionally filtered by type, priority,
 * and/or status. Intended for agent discovery: call with `status: "Planned"`
 * to see available work, or with no filters to survey the full board.
 *
 * Returns `{ count, issues: [{id, number, title, type, priority, status}] }`
 * sorted by issue number ascending. Includes Thinking and Complete issues so
 * agents get a complete picture — they still cannot act on those via other tools.
 */
export async function runListIssues(
  store: IssueStore,
  args: ListIssuesInput,
): Promise<ToolResult> {
  const parsed = ListIssuesSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for list_issues: ${parsed.error.message}`);
  const { type, priority, status } = parsed.data;

  let issues = store.list();
  if (type)     issues = issues.filter((i) => i.type === type);
  if (priority) issues = issues.filter((i) => i.priority === priority);
  if (status)   issues = issues.filter((i) => i.status === status);
  issues = [...issues].sort((a, b) => a.number - b.number);

  return ToolResultOk(
    JSON.stringify(
      {
        workspace: getWorkspaceContext(),
        workflow: readWorkflowPrompt(),
        count: issues.length,
        issues: issues.map((i) => ({
          id:       i.id,
          number:   i.number,
          title:    i.title,
          type:     i.type,
          priority: i.priority,
          status:   i.status,
        })),
      },
      null,
      2,
    ),
  );
}

/**
 * File a new ticket from an agent.
 *
 * Returns `{ id, number, status, message }` for the newly created ticket.
 *
 * - The ticket always lands in `Thinking` for human triage; agents cannot
 *   create tickets in any other lane.
 * - `id` (`DS-NNN`) and `number` are assigned by the store; the caller cannot
 *   pick them.
 * - The initial `statusHistory` entry and a "Created via MCP" record entry
 *   are written with `author: "agent"`.
 */
export async function runCreateTicket(
  store: IssueStore,
  args: CreateTicketInput,
): Promise<ToolResult> {
  const parsed = NewTicketSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for create_ticket: ${parsed.error.message}`);
  const validated = parsed.data;
  const now = new Date().toISOString();
  const number = store.nextNumber();
  const id = `DS-${String(number).padStart(3, "0")}`;
  // Normalize the agent-supplied links: coerce shape first, then drop entries
  // whose targetId doesn't exist (logged) and self-links (which `coerceLinks`
  // already filters when given the current id).
  const knownIds = new Set(store.list().map((i) => i.id));
  const { kept: validatedLinks, dropped: droppedLinks } = validateLinks(
    coerceLinks(validated.links ?? [], id),
    id,
    knownIds,
  );
  if (droppedLinks.length) {
    // Surface via the store's own log channel for symmetry with the host path.
    store.appendLog(
      `MCP create_ticket on ${id} dropped ${droppedLinks.length} unknown-target link(s).`,
    );
  }
  const issue: Issue = {
    id,
    number,
    title: validated.title,
    description: validated.description ?? "",
    type: validated.type ?? "Feature",
    priority: validated.priority ?? "Regular",
    status: "Thinking",
    verifyCriteria: validated.verifyCriteria ?? "",
    tasks: (validated.tasks ?? []).map((text) => ({
      id: `t-${randomUUID()}`,
      text,
      done: false,
    })),
    tags: coerceTags(validated.tags ?? []),
    attachments: [],
    links: validatedLinks,
    createdAt: now,
    resolvedAt: null,
    statusHistory: [{ status: "Thinking", at: now, by: "agent" }],
    record: [
      {
        at: now,
        author: "agent",
        text: "Created via MCP",
      },
    ],
  };
  await store.upsert(issue);
  return ToolResultOk(
    JSON.stringify(
      {
        workspace: getWorkspaceContext(),
        id: issue.id,
        number: issue.number,
        status: issue.status,
        message: "Filed in Thinking for human triage.",
      },
      null,
      2,
    ),
  );
}

/**
 * Move a ticket between the active lanes (Planned / Working / Verification).
 *
 * Returns `{ id, status, from }` on success.
 *
 * - Target must be Planned, Working, or Verification — never Thinking or Complete.
 * - Current status must already be Planned, Working, or Verification; agents
 *   cannot promote out of Thinking or re-open Complete tickets.
 * - The destination lane is capped at `ACTIVE_LANE_CAP` (6); a move that
 *   would exceed the cap is rejected with an error naming the lane.
 */
export async function runUpdateTicketStatus(
  store: IssueStore,
  args: UpdateStatusInput,
): Promise<ToolResult> {
  // Target must be a writable active lane. Check this BEFORE strict-parsing
  // because the inner zod schema would also reject Thinking/Complete — we
  // want the friendlier "Cannot set status to ..." message for those.
  if (!AGENT_WRITABLE_STATUSES.includes(args.status)) {
    return ToolResultErr(
      `Agents cannot move a ticket to "${args.status}". ` +
      `Thinking is the human triage queue — only humans may route work there. ` +
      `Allowed target statuses for agents: ${AGENT_WRITABLE_STATUSES.join(", ")}.`,
    );
  }

  const parsed = StatusSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for update_ticket_status: ${parsed.error.message}`);
  args = parsed.data;

  const issue = store.get(args.id);
  if (!issue) return ToolResultErr(`Ticket ${args.id} not found.`);

  // Thinking-one-way + Complete-is-terminal: current must already be active.
  // Only humans can promote out of Thinking, and Complete tickets cannot be
  // reopened by an agent.
  if (!AGENT_WRITABLE_STATUSES.includes(issue.status)) {
    if (issue.status === "Thinking") {
      return ToolResultErr(
        `Ticket ${issue.id} is in "Thinking" -- only a human can triage and promote it to Planned.`,
      );
    }
    if (issue.status === "Complete") {
      return ToolResultErr(
        `Ticket ${issue.id} is Complete and cannot be re-opened by an agent.`,
      );
    }
    if (issue.status === "Closed") {
      return ToolResultErr(
        `Ticket ${issue.id} is Closed and cannot be re-opened by an agent.`,
      );
    }
    return ToolResultErr(
      `Ticket ${issue.id} is in "${issue.status}". Agents may only move tickets that are already Planned, Working, or Verification.`,
    );
  }

  if (args.status === issue.status) {
    return ToolResultOk(`Ticket ${issue.id} is already in ${issue.status}; no change.`);
  }

  const cap = vscode.workspace.getConfiguration("dostuff").get<number>("activeLaneCap", ACTIVE_LANE_CAP);
  const laneCheck = canMoveToActiveLane(store.list(), args.status, issue.id, cap);
  if (laneCheck !== true) return ToolResultErr(laneCheck);

  const now = new Date().toISOString();
  const next: Issue = {
    ...issue,
    status: args.status,
    statusHistory: [
      ...issue.statusHistory,
      { status: args.status, at: now, by: "agent" },
    ],
    record: [
      ...issue.record,
      {
        at: now,
        author: "agent",
        text: args.note
          ? `Status -> ${args.status}: ${args.note}`
          : `Status -> ${args.status}`,
      },
    ],
  };
  await store.upsert(next);
  return ToolResultOk(
    JSON.stringify({ workspace: getWorkspaceContext(), id: next.id, status: next.status, from: issue.status }, null, 2),
  );
}

/**
 * Append progress to a non-terminal ticket: toggle task `done` flags and/or
 * append one record entry.
 *
 * Returns `{ id, tasks, recordLength }` on success.
 *
 * - The ticket must currently be Thinking, Planned, Working, or Verification.
 *   Complete and Closed are rejected. Thinking is allowed so an agent can
 *   record relationships ("blocks DS-042") on a ticket it just filed.
 * - Every `taskUpdates[].id` must match an existing task on the ticket; an
 *   unknown id rejects the whole call.
 * - This is the only MCP tool that writes ticket content. Title, description,
 *   priority, type, and verifyCriteria are never modifiable here — only the
 *   UI can edit those.
 */
export async function runUpdateTicketProgress(
  store: IssueStore,
  args: UpdateProgressInput,
): Promise<ToolResult> {
  const parsed = ProgressSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for update_ticket_progress: ${parsed.error.message}`);
  args = parsed.data;

  const issue = store.get(args.id);
  if (!issue) return ToolResultErr(`Ticket ${args.id} not found.`);

  if (!AGENT_VISIBLE_STATUSES.includes(issue.status)) {
    return ToolResultErr(
      `Ticket ${issue.id} is in "${issue.status}". Agents may not update Complete or Closed tickets.`,
    );
  }

  const taskUpdates = args.taskUpdates ?? [];
  const knownTaskIds = new Set(issue.tasks.map((t) => t.id));
  for (const u of taskUpdates) {
    if (!knownTaskIds.has(u.id)) {
      return ToolResultErr(`Unknown task id "${u.id}" on ${issue.id}.`);
    }
  }

  const taskMap = new Map(taskUpdates.map((u) => [u.id, u.done]));
  const newTasks = issue.tasks.map((t) =>
    taskMap.has(t.id) ? { ...t, done: taskMap.get(t.id)! } : t,
  );

  const now = new Date().toISOString();
  const newRecord: RecordEntry[] = args.recordEntry
    ? [...issue.record, { at: now, author: "agent", text: args.recordEntry }]
    : issue.record;

  const next: Issue = {
    ...issue,
    tasks: newTasks,
    record: newRecord,
  };
  await store.upsert(next);
  return ToolResultOk(
    JSON.stringify(
      {
        workspace: getWorkspaceContext(),
        id: next.id,
        tasks: next.tasks.map((t) => ({ id: t.id, done: t.done })),
        recordLength: next.record.length,
      },
      null,
      2,
    ),
  );
}

/**
 * Shape a *draft* ticket: replace its `tags`, `links`, and/or `tasks`.
 *
 * Returns `{ id, tags, links, tasks }` (the post-update lists) on success.
 *
 * - The ticket MUST be in `Thinking`. Once a human triages it to an active
 *   lane, scope is locked again — agents can only toggle task done-state and
 *   append records via `update_ticket_progress`. This keeps agents from
 *   silently rewriting the scope of work that's already been triaged.
 * - Each field is independent: omit one to leave it unchanged; pass `[]` to
 *   clear it. `links` are validated against the store (unknown targets and
 *   self-links dropped); `tasks` are replaced wholesale with fresh ids.
 * - Title, description, priority, type, and verifyCriteria remain UI-only.
 */
export async function runUpdateTicketDraft(
  store: IssueStore,
  args: UpdateDraftInput,
): Promise<ToolResult> {
  const parsed = DraftSchema.safeParse(args);
  if (!parsed.success) return ToolResultErr(`Invalid arguments for update_ticket_draft: ${parsed.error.message}`);
  const validated = parsed.data;

  const issue = store.get(validated.id);
  if (!issue) return ToolResultErr(`Ticket ${validated.id} not found.`);
  if (issue.status !== "Thinking") {
    return ToolResultErr(
      `Ticket ${issue.id} is in "${issue.status}", not Thinking. ` +
        `Tags, links, and tasks can only be edited via MCP while a ticket is an untriaged draft. ` +
        `Use update_ticket_progress to toggle task done-state on active tickets, or the UI to edit scope.`,
    );
  }

  const next: Issue = { ...issue };

  if (validated.tags !== undefined) {
    next.tags = coerceTags(validated.tags);
  }
  if (validated.links !== undefined) {
    const knownIds = new Set(store.list().map((i) => i.id));
    const { kept, dropped } = validateLinks(coerceLinks(validated.links, issue.id), issue.id, knownIds);
    if (dropped.length) {
      store.appendLog(
        `MCP update_ticket_draft on ${issue.id} dropped ${dropped.length} unknown-target link(s).`,
      );
    }
    next.links = kept;
  }
  if (validated.tasks !== undefined) {
    // Replace the task list wholesale with fresh ids — drafts aren't being
    // worked yet, so there's no done-state correlation worth preserving.
    next.tasks = validated.tasks.map((t) => ({
      id: `t-${randomUUID()}`,
      text: t.text,
      done: t.done ?? false,
    }));
  }

  await store.upsert(next);
  return ToolResultOk(
    JSON.stringify(
      {
        workspace: getWorkspaceContext(),
        id: next.id,
        tags: next.tags,
        links: next.links,
        tasks: next.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done })),
      },
      null,
      2,
    ),
  );
}

// ----- Server lifecycle ------------------------------------------------------

export interface WorkspaceIdentity {
  path: string;
  name: string;
}

export class DoStuffMcpServer implements vscode.Disposable {
  private httpServer: http.Server | null = null;
  private currentPort: number | null = null;
  private startedFor: string | null = null;
  private readonly output: vscode.OutputChannel;
  // Single-flight mutex: chain every reconcile() onto one promise so
  // concurrent config changes can't race start() against stop() and leak
  // a partially-initialized server.
  private reconcilePromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: IssueStore,
    private readonly workspaceId: () => WorkspaceIdentity | null = () => null,
  ) {
    this.output = vscode.window.createOutputChannel("DoStuff MCP");
  }

  /** Status snapshot for outside readers (e.g. status bar item). */
  get status(): { running: boolean; port: number | null; workspacePath: string | null } {
    return {
      running: this.httpServer !== null,
      port: this.currentPort,
      workspacePath: this.startedFor,
    };
  }

  /** Bring the server in line with current settings. Idempotent and serialized. */
  reconcile(): Promise<void> {
    this.reconcilePromise = this.reconcilePromise
      .then(() => this.doReconcile())
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.output.appendLine(`reconcile error: ${msg}`);
      });
    return this.reconcilePromise;
  }

  private async doReconcile(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    const enabled = cfg.get<boolean>("mcp.enabled", true);

    if (!enabled) {
      if (this.httpServer) {
        await this.stop();
        this.output.appendLine(`Disabled -- server stopped.`);
      }
      return;
    }

    const ws = this.workspaceId();
    if (!ws) {
      if (this.httpServer) {
        await this.stop();
        this.output.appendLine(`No workspace folder -- server stopped.`);
      } else {
        this.output.appendLine(`No workspace folder -- MCP not started.`);
      }
      return;
    }

    const preferredPort = readPreferredPort(cfg);
    const normalizedPath = normalizeWorkspacePath(ws.path);
    const desiredIdentity = `${normalizedPath}::${preferredPort}`;
    if (this.httpServer && this.startedFor === desiredIdentity) {
      return; // already running for this workspace + preferred port
    }

    if (this.httpServer) {
      await this.stop();
      this.output.appendLine(`Identity changed -- restarting.`);
    }

    try {
      await this.start(ws, preferredPort);
      this.startedFor = desiredIdentity;
      this.output.appendLine(
        `Listening on http://127.0.0.1:${this.currentPort}/mcp for ${ws.path}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`Failed to start: ${msg}`);
      vscode.window.showErrorMessage(`DoStuff MCP server failed to start: ${msg}`);
    }
  }

  private async start(ws: WorkspaceIdentity, preferredPort: number): Promise<void> {
    // StreamableHTTPServerTransport in stateless mode (sessionIdGenerator:
    // undefined) cannot be reused across requests — the SDK throws on the
    // second handleRequest call. So we build a fresh McpServer + transport
    // for every incoming request and tear it down after. The handlers close
    // over `this.store`, so each per-request server still sees live state.
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    // Guard against Slowloris-style DoS: kill connections that never send
    // headers or never finish sending a request body within these windows.
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;

    const tryBind = (p: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        server.once("error", onError);
        server.listen(p, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });

    try {
      await tryBind(preferredPort);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (preferredPort !== 0 && code === "EADDRINUSE") {
        this.output.appendLine(
          `Pinned port ${preferredPort} is in use -- falling back to an ephemeral port.`,
        );
        await tryBind(0);
      } else {
        throw e;
      }
    }

    const addr = server.address() as AddressInfo;
    this.httpServer = server;
    this.currentPort = addr.port;

    try {
      // registerEntry already filters dead PIDs as part of its read-modify-
      // write cycle, so an explicit pruneRegistry() call here is redundant.
      registerEntry({
        workspacePath: ws.path,
        port: addr.port,
        pid: process.pid,
        name: ws.name,
        startedAt: new Date().toISOString(),
      });
    } catch (e) {
      this.output.appendLine(
        `Registry write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Set on every response — prevents MIME-sniffing attacks.
    res.setHeader("X-Content-Type-Options", "nosniff");

    const remote = req.socket.remoteAddress ?? "";
    if (!isLocalhost(remote)) {
      res.statusCode = 403;
      res.end("DoStuff MCP only accepts localhost connections");
      return;
    }
    // Defence-in-depth: reject missing or non-loopback Host headers.
    // An empty Host MUST be treated as hostile (DNS-rebinding payloads can
    // strip it) — not "skip the check".
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    if (!host || (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]")) {
      res.statusCode = 403;
      res.end("DoStuff MCP rejects non-loopback Host headers");
      return;
    }
    // CSRF guard: if a browser includes an Origin header (cross-origin POST
    // from a web page), the origin must also be a loopback address. Legitimate
    // MCP clients (CLI tools, VS Code) do not send Origin at all, so this
    // check never fires for them. The string "null" is sent by browsers for
    // local-file origins (file://) and is treated as safe.
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== "null") {
      let originOk = false;
      try {
        const originHost = new URL(originHeader).hostname.toLowerCase();
        originOk = isLocalhost(originHost);
      } catch {
        // Unparseable Origin is not safe.
      }
      if (!originOk) {
        res.statusCode = 403;
        res.end("DoStuff MCP rejects cross-origin requests");
        return;
      }
    }
    // Match /mcp exactly or as a real path segment — never /mcpfoo or /mcp.evil.
    const url = req.url ?? "";
    const isMcpPath = url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/");
    if (!isMcpPath) {
      res.statusCode = 404;
      res.end("Not found. The MCP endpoint is /mcp.");
      return;
    }
    // Reject oversized bodies before handing to the transport. Without this
    // a single huge request can exhaust the extension host's heap. We check
    // the Content-Length header here; the transport reads the body so we
    // cannot stream-limit it, but Content-Length covers the common case and
    // the 30 s requestTimeout above bounds unbounded chunked uploads.
    const MAX_BODY_BYTES = 1_048_576; // 1 MB
    const clHeader = req.headers["content-length"];
    if (clHeader !== undefined) {
      const cl = parseInt(clHeader, 10);
      if (!Number.isNaN(cl) && cl > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end("Request body too large (max 1 MB)");
        return;
      }
    }

    const mcp = new McpServer(
      { name: "dostuff", version: "1.0.0" },
      { capabilities: { resources: {}, prompts: {}, tools: {} } },
    );
    registerMcpResources(mcp, this.store);
    registerMcpPrompts(mcp);
    registerMcpTools(mcp, this.store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      this.output.appendLine(`Transport error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(`MCP error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      try {
        await transport.close();
      } catch (e) {
        this.output.appendLine(
          `transport.close error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      try {
        await mcp.close();
      } catch (e) {
        this.output.appendLine(`mcp.close error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
    }
    this.httpServer = null;
    this.currentPort = null;
    this.startedFor = null;
    try {
      unregisterEntry(process.pid);
    } catch (e) {
      this.output.appendLine(
        `Registry unregister failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  dispose(): void {
    void this.stop().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`dispose error: ${msg}`);
    });
    this.output.dispose();
  }

}

/**
 * Register the three ticket resources on an `McpServer`. Exposed so the
 * per-request server in `DoStuffMcpServer.start()` and tests can both build
 * an identically-configured MCP surface.
 */
export function registerMcpResources(mcp: McpServer, store: IssueStore): void {
  mcp.registerResource(
    "tickets",
    "dostuff://tickets",
    {
      title: "DoStuff tickets (Thinking + active lanes)",
      description:
        "All tickets currently in a non-terminal state (Thinking, Planned, Working, Verification). Complete and Closed are hidden.",
      mimeType: "application/json",
    },
    async (uri) => {
      const all = store.list();
      const servable = all
        .filter((i) => AGENT_VISIBLE_STATUSES.includes(i.status))
        .map((i) => publicView(i, all));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                workspace: getWorkspaceContext(),
                workflow: readWorkflowPrompt(),
                tickets: servable,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcp.registerResource(
    "ticket",
    new ResourceTemplate("dostuff://tickets/{id}", { list: undefined }),
    {
      title: "DoStuff ticket",
      description:
        "A single ticket. Thinking, Planned, Working, and Verification tickets are returned; Complete and Closed are rejected.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
      const issue = store.get(id);
      if (!issue) {
        throw new Error(`Ticket ${id} not found`);
      }
      if (!AGENT_VISIBLE_STATUSES.includes(issue.status)) {
        throw new Error(
          `Ticket ${id} is in "${issue.status}" -- Complete and Closed tickets are not served.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                workflow: readWorkflowPrompt(),
                ticket: publicView(issue, store.list()),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcp.registerResource(
    "workflow",
    "dostuff://instructions/workflow",
    {
      title: "DoStuff workflow instructions",
      description: "System-level prompt customizable in DoStuff settings.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readWorkflowPrompt(),
        },
      ],
    }),
  );

  // Attachment binaries are served as base64 BlobResourceContents. Agents
  // discover the URIs by reading a ticket via `get_ticket` or the `ticket`
  // resource, which lists `attachments[i].uri` in the JSON payload.
  mcp.registerResource(
    "attachment",
    new ResourceTemplate("dostuff://attachments/{ticketId}/{attachmentId}", { list: undefined }),
    {
      title: "DoStuff attachment",
      description: "Binary content (image, PDF, etc.) attached to a ticket.",
    },
    async (uri, variables) => {
      const ticketRaw = variables.ticketId;
      const attachmentRaw = variables.attachmentId;
      const ticketId = Array.isArray(ticketRaw) ? String(ticketRaw[0] ?? "") : String(ticketRaw ?? "");
      const attachmentId = Array.isArray(attachmentRaw)
        ? String(attachmentRaw[0] ?? "")
        : String(attachmentRaw ?? "");
      const issue = store.get(ticketId);
      if (!issue) {
        throw new Error(`Ticket ${ticketId} not found`);
      }
      const meta = issue.attachments.find((a) => a.id === attachmentId);
      if (!meta) {
        throw new Error(`Attachment ${attachmentId} not found on ticket ${ticketId}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await store.readAttachment(ticketId, attachmentId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Attachment file missing: ${msg}`);
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment ${attachmentId} exceeds the 10 MB cap (${bytes.byteLength} bytes).`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: meta.mimeType,
            blob: Buffer.from(bytes).toString("base64"),
          },
        ],
      };
    },
  );
}

/**
 * Register all prompt(s) on an `McpServer`. Exposed so the per-request
 * server in `DoStuffMcpServer.start()` and tests can mirror the same setup.
 */
export function registerMcpPrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    "workflow",
    {
      title: "DoStuff workflow",
      description: "System-level workflow guidance for agents working tickets.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: readWorkflowPrompt() },
        },
      ],
    }),
  );
}

/**
 * Register the four ticket tools on an `McpServer`. Exposed so tests can
 * exercise the same SDK-validated tool path against an in-memory transport
 * pair without standing up the HTTP server.
 */
export function registerMcpTools(mcp: McpServer, store: IssueStore): void {
  mcp.registerTool(
    "get_ticket",
    {
      title: "Get ticket",
      description:
        "Look up a ticket and return its full content + the workflow prompt. " +
        "`query` may be a ticket number (e.g. '#42' or '42'), an id (e.g. 'DS-042'), " +
        "or a case-insensitive substring of the ticket title. Thinking, Planned, " +
        "Working, and Verification tickets are servable; Complete and Closed are rejected.",
      inputSchema: GET_TICKET_INPUT,
    },
    async (args) => runGetTicket(store, args as GetTicketInput),
  );

  mcp.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "Return a compact index of all issues (id, number, title, type, priority, status). " +
        "Use this to discover work: pass `status: 'Planned'` to see tickets ready to pick up, " +
        "or omit all filters to survey the entire board including Thinking and Complete. " +
        "To fetch the full content of a ticket, use `get_ticket` with its id or number.",
      inputSchema: LIST_ISSUES_INPUT,
    },
    async (args) => runListIssues(store, args as ListIssuesInput),
  );

  mcp.registerTool(
    "create_ticket",
    {
      title: "Create ticket",
      description:
        "File a new ticket. It lands in 'Thinking' for the human to triage. " +
        "Use this when you discover follow-up work that doesn't belong on the current ticket. " +
        "Optionally supply `links` to record relationships at creation time " +
        "(kinds: blocks, child-of, relates-to). Unknown target ids are dropped " +
        "with a warning; links cannot be edited afterwards via the MCP server.",
      inputSchema: NEW_TICKET_INPUT,
    },
    async (args) => runCreateTicket(store, args as CreateTicketInput),
  );

  const liveCap = vscode.workspace
    .getConfiguration("dostuff")
    .get<number>("activeLaneCap", ACTIVE_LANE_CAP);
  mcp.registerTool(
    "update_ticket_status",
    {
      title: "Update ticket status",
      description:
        "Move a ticket between Planned, Working, and Verification. " +
        "You cannot mark a ticket Complete -- only a human reviewer can do that. " +
        "You also cannot move a ticket back to Thinking once it has left. " +
        `Each active lane is capped at ${liveCap} tickets; a move that would exceed the cap is rejected.`,
      inputSchema: STATUS_INPUT,
    },
    async (args) => runUpdateTicketStatus(store, args as UpdateStatusInput),
  );

  mcp.registerTool(
    "update_ticket_progress",
    {
      title: "Update ticket progress",
      description:
        "Tick tasks done/undone and append a note to the ticket's record. " +
        "Title, description, priority, type, and verifyCriteria are not modifiable here. " +
        "Allowed on Thinking, Planned, Working, and Verification tickets; Complete and Closed are rejected. " +
        "To reshape a draft's tags/links/task-list, use update_ticket_draft (Thinking only).",
      inputSchema: PROGRESS_INPUT,
    },
    async (args) => runUpdateTicketProgress(store, args as UpdateProgressInput),
  );

  mcp.registerTool(
    "update_ticket_draft",
    {
      title: "Update ticket draft",
      description:
        "Reshape an untriaged draft: replace its tags, links, and/or task list. " +
        "Only valid while the ticket is in 'Thinking' — once a human triages it to an " +
        "active lane, scope locks and you can only toggle task done-state via " +
        "update_ticket_progress. Omit a field to leave it unchanged; pass [] to clear it. " +
        "Link kinds: blocks, child-of, relates-to (unknown targets are dropped).",
      inputSchema: DRAFT_INPUT,
    },
    async (args) => runUpdateTicketDraft(store, args as UpdateDraftInput),
  );
}

// Re-export the active-lane constants so tests / consumers can reference them.
export { ACTIVE_LANE_CAP, ACTIVE_LANES };
