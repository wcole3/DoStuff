// MCP server exposed by the DoStuff extension.
//
// Surface:
//   ── Resources ────────────────────────────────────────────────────────────
//     dostuff://tickets                       List of servable tickets
//     dostuff://tickets/{id}                  One ticket (status ∈ Planned/Working/Testing only)
//     dostuff://instructions/workflow         The workflow prompt (user-configurable)
//
//   ── Prompts ──────────────────────────────────────────────────────────────
//     workflow                                Embedded version of the workflow instructions
//
//   ── Tools ────────────────────────────────────────────────────────────────
//     create_ticket          → adds a new ticket in the "Thinking" state
//     update_ticket_status   → moves a ticket between Planned ↔ Working ↔ Testing
//                              (Complete is reserved for the human; Thinking is one-way)
//     update_ticket_progress → toggles task done/not-done and appends a record entry
//
// Constraints enforced by the server (not just the schema):
//   • Tickets in Thinking or Complete are never returned by the read APIs.
//   • update_ticket_status rejects target status "Complete" and "Thinking".
//   • update_ticket_progress can only touch `tasks[].done` and append to `record`.
//     Title, description, priority, type, verifyCriteria, statusHistory, createdAt,
//     resolvedAt, id are not modifiable through the MCP surface.
//
// The server runs in-process inside the extension host on an HTTP port so any
// MCP-aware agent can connect by URL. Disable via `dostuff.mcp.enabled = false`.

import * as http from "http";
import * as vscode from "vscode";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IssueStore } from "./storage";
import {
  AGENT_SERVABLE_STATUSES,
  AGENT_WRITABLE_STATUSES,
  type Issue,
  type RecordEntry,
} from "./types";

const DEFAULT_WORKFLOW_PROMPT = `\
You are an engineering agent working through the DoStuff issue queue.

Workflow contract:
  1. Tickets are addressed by their number (e.g. "42") or their id ("DS-042").
     Use \`get_ticket\` to fetch one by number, id, or a substring of its title
     when the user says something like "get ticket 42 and begin work" or
     "start on the OAuth ticket".
  2. Read \`dostuff://tickets\` to discover work. Only Planned / Working / Testing
     tickets are visible — Thinking tickets are drafts the human is still shaping,
     and Complete tickets are done.
  3. When you start a ticket, call \`update_ticket_status\` to move it to "Working".
     When you believe it's ready for verification, move it to "Testing".
  4. You cannot mark a ticket "Complete". A human reviews Testing tickets and
     decides. If your verification fails, move it back to "Working".
  5. As you make progress, call \`update_ticket_progress\` to tick tasks off and
     append a short note to the ticket's record. Be terse and factual — what you
     did, what you observed, what's next. The record is append-only.
  6. If you discover follow-up work, call \`create_ticket\` to file it. New
     tickets land in "Thinking" so the human can triage them.

You may NOT modify a ticket's title, description, priority, type, or verify
criteria via the MCP server. If something is wrong with those, file a new
ticket instead.`;

const ToolResultOk = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const ToolResultErr = (text: string) => ({
  isError: true,
  content: [{ type: "text" as const, text }],
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const NEW_TICKET_INPUT = {
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().default(""),
  type: z.enum(["Bug", "Feature", "Refactor", "Chore", "Spike"]).default("Feature"),
  priority: z.enum(["Critical", "High", "Regular", "Low"]).default("Regular"),
  verifyCriteria: z.string().max(10_000).optional().default(""),
  tasks: z.array(z.string().min(1).max(500)).optional().default([]),
};

const STATUS_INPUT = {
  id: z.string().regex(/^DS-\d+$/, "Expected an id like DS-001"),
  status: z.enum(["Planned", "Working", "Testing"] as const),
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

function publicView(issue: Issue) {
  // Trim internal fields that aren't meaningful to agents.
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    type: issue.type,
    priority: issue.priority,
    status: issue.status,
    description: issue.description,
    verifyCriteria: issue.verifyCriteria,
    tasks: issue.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done })),
    record: issue.record.map((r) => ({ at: r.at, author: r.author, source: r.source, text: r.text })),
    createdAt: issue.createdAt,
  };
}

function readWorkflowPrompt(): string {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  const custom = cfg.get<string>("mcp.instructions");
  return (custom && custom.trim()) ? custom : DEFAULT_WORKFLOW_PROMPT;
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

export class DoStuffMcpServer implements vscode.Disposable {
  private httpServer: http.Server | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private mcp: McpServer | null = null;
  private currentPort = 0;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly store: IssueStore) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.status.command = "dostuff.mcp.toggle";
  }

  /** Bring the server in line with current settings. Idempotent. */
  async reconcile(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    const enabled = cfg.get<boolean>("mcp.enabled", true);
    const port = cfg.get<number>("mcp.port", 3947);

    if (!enabled) {
      await this.stop();
      this.setStatus("$(circle-slash) DoStuff MCP off", "DoStuff MCP server disabled");
      return;
    }
    if (this.httpServer && this.currentPort === port) {
      this.setStatus(`$(plug) DoStuff MCP :${port}`, this.tooltip());
      return; // already up on the right port
    }
    await this.stop();
    try {
      await this.start(port);
      this.setStatus(`$(plug) DoStuff MCP :${port}`, this.tooltip());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus("$(error) DoStuff MCP failed", `Failed to start: ${msg}`);
      vscode.window.showErrorMessage(`DoStuff MCP server failed to start: ${msg}`);
    }
  }

  private setStatus(text: string, tip: string) {
    this.status.text = text;
    this.status.tooltip = tip;
    this.status.show();
  }
  private tooltip() {
    return `DoStuff MCP server\nURL: http://127.0.0.1:${this.currentPort}/mcp\nServing ${
      this.store.list().filter((i) => AGENT_SERVABLE_STATUSES.includes(i.status)).length
    } tickets`;
  }

  private async start(port: number): Promise<void> {
    const mcp = new McpServer(
      { name: "dostuff", version: "1.0.0" },
      { capabilities: { resources: {}, prompts: {}, tools: {} } }
    );

    this.registerResources(mcp);
    this.registerPrompts(mcp);
    this.registerTools(mcp);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);

    const server = http.createServer((req, res) => {
      // Only accept localhost connections — this is a developer-tool server.
      const remote = req.socket.remoteAddress ?? "";
      if (!isLocalhost(remote)) {
        res.statusCode = 403;
        res.end("DoStuff MCP only accepts localhost connections");
        return;
      }
      if (!req.url || !req.url.startsWith("/mcp")) {
        res.statusCode = 404;
        res.end("Not found. The MCP endpoint is /mcp.");
        return;
      }
      transport.handleRequest(req, res).catch((e) => {
        console.error("MCP transport error", e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`MCP error: ${e?.message ?? e}`);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });

    this.httpServer = server;
    this.transport = transport;
    this.mcp = mcp;
    this.currentPort = port;
  }

  async stop(): Promise<void> {
    try { await this.transport?.close(); } catch {}
    try { await this.mcp?.close(); } catch {}
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
    }
    this.httpServer = null;
    this.transport = null;
    this.mcp = null;
    this.currentPort = 0;
  }

  dispose() {
    this.stop().catch(() => {});
    this.status.dispose();
  }

  // ─── MCP surface ──────────────────────────────────────────────────────────

  private registerResources(mcp: McpServer) {
    // List of servable tickets — only Planned/Working/Testing.
    mcp.registerResource(
      "tickets",
      "dostuff://tickets",
      {
        title: "DoStuff tickets (active)",
        description:
          "All tickets currently in a non-terminal state (Planned, Working, Testing).",
        mimeType: "application/json",
      },
      async (uri) => {
        const servable = this.store
          .list()
          .filter((i) => AGENT_SERVABLE_STATUSES.includes(i.status))
          .map(publicView);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  workflow: readWorkflowPrompt(),
                  tickets: servable,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Individual ticket — only servable when non-terminal.
    mcp.registerResource(
      "ticket",
      "dostuff://tickets/{id}",
      {
        title: "DoStuff ticket",
        description: "A single ticket. Only Planned / Working / Testing tickets are returned.",
        mimeType: "application/json",
      },
      async (uri, params) => {
        const id = String((params as { id?: string })?.id ?? "");
        const issue = this.store.get(id);
        if (!issue) {
          throw new Error(`Ticket ${id} not found`);
        }
        if (!AGENT_SERVABLE_STATUSES.includes(issue.status)) {
          throw new Error(
            `Ticket ${id} is in "${issue.status}" — only Planned, Working, and Testing tickets are served.`
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
                  ticket: publicView(issue),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Workflow prompt as an addressable resource so clients can fetch it
    // independently of any specific ticket.
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
      })
    );
  }

  private registerPrompts(mcp: McpServer) {
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
      })
    );
  }

  private registerTools(mcp: McpServer) {
    // ── get_ticket ──────────────────────────────────────────────────────
    mcp.registerTool(
      "get_ticket",
      {
        title: "Get ticket",
        description:
          "Look up an active ticket and return its full content + the workflow prompt. " +
          "`query` may be a ticket number (e.g. '42'), an id (e.g. 'DS-042'), or a " +
          "case-insensitive substring of the ticket title. Only tickets currently in " +
          "Planned, Working, or Testing are servable; Thinking and Complete are rejected.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .describe("Ticket number, DS-id, or a substring of the title."),
        },
      },
      async ({ query }) => {
        const q = query.trim();
        if (!q) return ToolResultErr("Empty query.");
        const all = this.store.list();

        // 1. Pure digits → lookup by number.
        let match: Issue | undefined;
        let ambiguous: Issue[] = [];

        if (/^\d+$/.test(q)) {
          const n = parseInt(q, 10);
          match = all.find((i) => i.number === n);
          if (!match) return ToolResultErr(`No ticket with number ${n}.`);
        } else if (/^DS-\d+$/i.test(q)) {
          const id = q.toUpperCase();
          match = all.find((i) => i.id === id);
          if (!match) return ToolResultErr(`No ticket with id ${id}.`);
        } else {
          // 2. Title substring (case-insensitive).
          const needle = q.toLowerCase();
          const hits = all.filter((i) => i.title.toLowerCase().includes(needle));
          if (hits.length === 0) {
            return ToolResultErr(`No ticket matches "${q}". Try the ticket number or a different substring.`);
          }
          if (hits.length > 1) {
            // Prefer servable hits; if that narrows to one, return it.
            const servableHits = hits.filter((h) => AGENT_SERVABLE_STATUSES.includes(h.status));
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
            `Ambiguous query "${q}" — ${ambiguous.length} matches:\n` +
              ambiguous
                .map((i) => `  • #${i.number} (${i.id}) [${i.status}] — ${i.title}`)
                .join("\n") +
              `\nNarrow by number or id.`
          );
        }

        if (!AGENT_SERVABLE_STATUSES.includes(match.status)) {
          return ToolResultErr(
            `Ticket #${match.number} (${match.id}) is in "${match.status}". ` +
              `Only Planned, Working, and Testing tickets are servable. ` +
              (match.status === "Thinking"
                ? "Ask the human to triage and move it to Planned first."
                : "This work is already complete.")
          );
        }

        return ToolResultOk(
          JSON.stringify(
            { workflow: readWorkflowPrompt(), ticket: publicView(match) },
            null,
            2
          )
        );
      }
    );

    // ── create_ticket ────────────────────────────────────────────────────────────
    mcp.registerTool(
      "create_ticket",
      {
        title: "Create ticket",
        description:
          "File a new ticket. It lands in the 'Thinking' state for the human to triage. " +
          "Use this when you discover follow-up work that doesn't belong on the current ticket.",
        inputSchema: NEW_TICKET_INPUT,
      },
      async (input) => {
        const now = new Date().toISOString();
        const number = this.store.nextNumber();
        const id = `DS-${String(number).padStart(3, "0")}`;
        const issue: Issue = {
          id,
          number,
          title: input.title,
          description: input.description ?? "",
          type: input.type,
          priority: input.priority,
          status: "Thinking",
          verifyCriteria: input.verifyCriteria ?? "",
          tasks: (input.tasks ?? []).map((text, idx) => ({
            id: `t${Date.now()}-${idx}`,
            text,
            done: false,
          })),
          createdAt: now,
          resolvedAt: null,
          statusHistory: [{ status: "Thinking", at: now, by: "agent" }],
          record: [
            {
              at: now,
              author: "agent",
              text: `Filed by MCP client.`,
            },
          ],
        };
        await this.store.upsert(issue);
        return ToolResultOk(
          JSON.stringify(
            { id: issue.id, number: issue.number, status: issue.status, message: "Filed in Thinking for human triage." },
            null,
            2
          )
        );
      }
    );

    // ── update_ticket_status ─────────────────────────────────────────────
    mcp.registerTool(
      "update_ticket_status",
      {
        title: "Update ticket status",
        description:
          "Move a ticket between Planned, Working, and Testing. " +
          "You cannot mark a ticket Complete — only a human reviewer can do that. " +
          "You also cannot move a ticket back to Thinking once it has left.",
        inputSchema: STATUS_INPUT,
      },
      async (input) => {
        const issue = this.store.get(input.id);
        if (!issue) return ToolResultErr(`Ticket ${input.id} not found.`);

        if (issue.status === "Complete") {
          return ToolResultErr(
            `Ticket ${issue.id} is Complete and cannot be re-opened by an agent.`
          );
        }
        if (!AGENT_WRITABLE_STATUSES.includes(input.status)) {
          return ToolResultErr(
            `Cannot set status to "${input.status}". Allowed: ${AGENT_WRITABLE_STATUSES.join(", ")}.`
          );
        }
        if (input.status === issue.status) {
          return ToolResultOk(`Ticket ${issue.id} is already in ${issue.status}; no change.`);
        }

        const now = new Date().toISOString();
        const next: Issue = {
          ...issue,
          status: input.status,
          statusHistory: [
            ...issue.statusHistory,
            { status: input.status, at: now, by: "agent" },
          ],
          record: [
            ...issue.record,
            {
              at: now,
              author: "agent",
              text: input.note
                ? `Status → ${input.status}: ${input.note}`
                : `Status → ${input.status}`,
            },
          ],
        };
        await this.store.upsert(next);
        return ToolResultOk(
          JSON.stringify({ id: next.id, status: next.status, from: issue.status }, null, 2)
        );
      }
    );

    // ── update_ticket_progress ────────────────────────────────────────────
    mcp.registerTool(
      "update_ticket_progress",
      {
        title: "Update ticket progress",
        description:
          "Tick tasks done/undone and append a note to the ticket's record. " +
          "This is the ONLY way an agent can write back to a ticket's content. " +
          "Title, description, priority, type, and verifyCriteria are not modifiable here.",
        inputSchema: PROGRESS_INPUT,
      },
      async (input) => {
        const issue = this.store.get(input.id);
        if (!issue) return ToolResultErr(`Ticket ${input.id} not found.`);

        if (!AGENT_SERVABLE_STATUSES.includes(issue.status)) {
          return ToolResultErr(
            `Ticket ${issue.id} is in "${issue.status}". Agents may only update tickets that are Planned, Working, or Testing.`
          );
        }

        // Validate every task id exists before mutating any.
        const knownTaskIds = new Set(issue.tasks.map((t) => t.id));
        for (const u of input.taskUpdates ?? []) {
          if (!knownTaskIds.has(u.id)) {
            return ToolResultErr(`Unknown task id "${u.id}" on ${issue.id}.`);
          }
        }

        const taskMap = new Map((input.taskUpdates ?? []).map((u) => [u.id, u.done]));
        const newTasks = issue.tasks.map((t) =>
          taskMap.has(t.id) ? { ...t, done: taskMap.get(t.id)! } : t
        );

        const now = new Date().toISOString();
        const newRecord: RecordEntry[] = input.recordEntry
          ? [...issue.record, { at: now, author: "agent", text: input.recordEntry }]
          : issue.record;

        const next: Issue = {
          ...issue,
          tasks: newTasks,
          record: newRecord,
        };
        await this.store.upsert(next);
        return ToolResultOk(
          JSON.stringify(
            {
              id: next.id,
              tasks: next.tasks.map((t) => ({ id: t.id, done: t.done })),
              recordLength: next.record.length,
            },
            null,
            2
          )
        );
      }
    );
  }
}

function isLocalhost(addr: string): boolean {
  return (
    addr === "::1" ||
    addr === "127.0.0.1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}
