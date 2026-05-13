// Shared types for the DoStuff extension.

export type IssueType = "Bug" | "Feature" | "Refactor" | "Chore" | "Spike";
export type Priority  = "Critical" | "High" | "Regular" | "Low";
export type Status    = "Thinking" | "Planned" | "Working" | "Testing" | "Complete";

export interface Task {
  id: string;
  text: string;
  done: boolean;
}

export interface StatusEvent {
  status: Status;
  /** ISO 8601 */
  at: string;
  /** "user" by default; "agent" when the change came from the MCP server. */
  by?: "user" | "agent";
}

/**
 * Append-only log entries on an issue. Used by the MCP server so an agent can
 * narrate progress without being able to mutate the title/description/etc.
 */
export interface RecordEntry {
  /** ISO 8601 */
  at: string;
  author: "user" | "agent";
  /** Optional source label — e.g. the MCP client name. */
  source?: string;
  text: string;
}

export interface Issue {
  id: string;
  /** Short, human-readable, monotonically-increasing reference number.
   *  Mirrors the numeric suffix of `id` but is the preferred handle for prompts
   *  ("get ticket 42 and begin work"). Unique within a workspace. */
  number: number;
  title: string;
  type: IssueType;
  priority: Priority;
  status: Status;
  description: string;
  tasks: Task[];
  verifyCriteria: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 — null until status becomes Complete */
  resolvedAt: string | null;
  statusHistory: StatusEvent[];
  /** Append-only progress log. Populated by the MCP server's update_ticket_progress tool. */
  record: RecordEntry[];
}

/** Statuses an MCP-connected agent is allowed to set via update_ticket_status. */
export const AGENT_WRITABLE_STATUSES: Status[] = ["Planned", "Working", "Testing"];

/** Statuses that get served as tickets to MCP clients. */
export const AGENT_SERVABLE_STATUSES: Status[] = ["Planned", "Working", "Testing"];

/** Wire format for host ↔ webview messaging. */
export type HostToWebview =
  | { type: "init"; issues: Issue[]; settings: Settings }
  | { type: "issues"; issues: Issue[] }
  | { type: "focusSearch" }
  | { type: "settings"; settings: Settings };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "createIssue"; partial: Omit<Issue, "id" | "createdAt" | "statusHistory" | "tasks" | "resolvedAt"> & { tasks?: Task[] } }
  | { type: "updateIssue"; issue: Issue }
  | { type: "deleteIssue"; id: string }
  | { type: "openBoard" }
  | { type: "importJson" }
  | { type: "exportJson" }
  | { type: "openSettings" };

export interface Settings {
  storageMode: "json-files" | "sqlite";
  storagePath: string;
  autoSave: boolean;
}

export const STATUSES:   Status[]    = ["Thinking", "Planned", "Working", "Testing", "Complete"];
export const PRIORITIES: Priority[]  = ["Critical", "High", "Regular", "Low"];
export const TYPES:      IssueType[] = ["Bug", "Feature", "Refactor", "Chore", "Spike"];
