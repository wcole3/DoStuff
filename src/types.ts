// Shared types for the DoStuff extension.

export const ACTIVE_LANE_CAP = 6;
export const ACTIVE_LANES = ["Planned", "Working", "Verification"] as const;
export type ActiveLane = (typeof ACTIVE_LANES)[number];
export function isActiveLane(s: string): s is ActiveLane {
  return (ACTIVE_LANES as readonly string[]).includes(s);
}

export const STATUSES   = ["Thinking", "Planned", "Working", "Verification", "Complete", "Closed"] as const;
export const PRIORITIES = ["Critical", "High", "Regular", "Low"] as const;
export const TYPES      = ["Bug", "Feature", "Refactor", "Chore", "Spike"] as const;

export type Status    = (typeof STATUSES)[number];
export type Priority  = (typeof PRIORITIES)[number];
export type IssueType = (typeof TYPES)[number];

export function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}
export function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}
export function isType(v: unknown): v is IssueType {
  return typeof v === "string" && (TYPES as readonly string[]).includes(v);
}

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

/**
 * File or image attached to an issue. The bytes live on disk under
 * `<storagePath>/attachments/<issueId>/<attachmentId><ext>`; this struct
 * carries only metadata. See `IssueStore.writeAttachment` for the writer.
 */
export interface Attachment {
  /** Host-minted nanoid-ish; unique per workspace. */
  id: string;
  /** Original filename for display only — never used to construct disk paths. */
  name: string;
  /** Best-effort sniff from the original extension. */
  mimeType: string;
  sizeBytes: number;
  /** ISO 8601 */
  addedAt: string;
}

/** Hard cap on a single attachment, enforced at the host upload edge and at MCP read. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

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
  /** Free-form labels for cross-cutting categorization (like Jira labels).
   *  Each tag's display color is derived deterministically from its name. */
  tags: string[];
  /** Files & images attached to this issue. The bytes are stored on disk
   *  alongside the ticket JSON; this list carries only metadata. */
  attachments: Attachment[];
}

/** Statuses an MCP-connected agent is allowed to set via update_ticket_status. */
export const AGENT_WRITABLE_STATUSES: Status[] = ["Planned", "Working", "Verification"];

/** Statuses that get served as tickets to MCP clients. */
export const AGENT_SERVABLE_STATUSES: Status[] = ["Planned", "Working", "Verification"];

/** Wire format for host ↔ webview messaging. */
export type HostToWebview =
  | { type: "init"; issues: Issue[]; settings: Settings }
  | { type: "issues"; issues: Issue[] }
  | { type: "focusSearch" }
  | { type: "settings"; settings: Settings }
  | { type: "showNewIssue" }
  // Sidebar dragstart broadcast: the board uses this to enter a "pick a
  // lane" mode (lanes/drawers highlight as click targets) since native
  // HTML5 drag cannot cross VSCode webview boundaries reliably.
  | { type: "externalDragStart"; issueId: string }
  | { type: "externalDragEnd" };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "createIssue"; partial: Omit<Issue, "id" | "number" | "createdAt" | "statusHistory" | "tasks" | "resolvedAt" | "record" | "attachments"> & { tasks?: Task[] } }
  | { type: "updateIssue"; issue: Issue }
  | { type: "deleteIssue"; id: string }
  | { type: "openBoard" }
  | { type: "importJson" }
  | { type: "exportJson" }
  | { type: "openSettings" }
  | { type: "externalDragStart"; issueId: string }
  | { type: "externalDragEnd" }
  | { type: "openLink"; url: string }
  // Webview-initiated upload via the host file picker. Host opens a
  // `showOpenDialog` and reads bytes itself — keeps large files off the
  // webview IPC channel.
  | { type: "pickAttachment"; issueId: string }
  // Drag-drop upload: webview already has the bytes (from DataTransfer.files)
  // and ships them to the host. Bounded by `MAX_ATTACHMENT_BYTES` at both
  // ends.
  | { type: "addAttachmentBytes"; issueId: string; name: string; mimeType: string; bytes: number[] }
  | { type: "deleteAttachment"; issueId: string; attachmentId: string }
  // Open a non-image attachment in VSCode via its on-disk URI.
  | { type: "openAttachment"; issueId: string; attachmentId: string };

export interface Settings {
  storagePath: string;
  autoSave: boolean;
  activeLaneCap: number;
  /**
   * Resolved base URL for attachment binaries on disk, in webview-addressable
   * form (`vscode-webview-resource://…`). The webview composes per-attachment
   * URLs as `${attachmentsBaseUri}/<issueId>/<attachmentId><ext>`. `null` when
   * no workspace folder is open (attachments disabled).
   */
  attachmentsBaseUri: string | null;
}

/**
 * Lane-cap check. Returns `true` if a move into `targetStatus` is allowed,
 * otherwise an error string describing why.
 *
 *  - Inactive targets (Thinking, Complete) are always allowed.
 *  - Active targets (Planned, Working, Verification) are capped at ACTIVE_LANE_CAP.
 *  - The issue identified by `movingIssueId` is excluded from the count so an
 *    in-place save of an already-located ticket isn't blocked by itself.
 */
/**
 * Cap on the number of distinct chips rendered inline next to a ticket. Any
 * additional tags collapse to colored dots so the row height stays predictable.
 */
export const MAX_INLINE_TAG_CHIPS = 2;

/**
 * Normalise a raw tag string for display + matching. Trims whitespace, collapses
 * internal runs, and drops empties. Returns the empty string when the input
 * isn't usable as a tag.
 */
export function normalizeTag(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Coerce arbitrary input (string or array) into a deduplicated, normalised tag
 * list. Used by import, the MCP `create_ticket` handler, and the storage
 * normaliser so all entry points end up with the same shape.
 */
export function coerceTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Validate + dedupe a raw `attachments` value into a clean `Attachment[]`.
 * Used by storage normalisation, import validation, and the `mergeIssueUpdate`
 * reconciliation step. Drops malformed entries; never throws.
 */
export function coerceAttachments(input: unknown): Attachment[] {
  if (!Array.isArray(input)) return [];
  const byId = new Map<string, Attachment>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id.length > 0 ? r.id : null;
    const name = typeof r.name === "string" && r.name.length > 0 ? r.name : null;
    const mimeType = typeof r.mimeType === "string" && r.mimeType.length > 0 ? r.mimeType : null;
    const sizeBytes =
      typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) && r.sizeBytes >= 0
        ? r.sizeBytes
        : null;
    const addedAt = typeof r.addedAt === "string" && ISO_RE.test(r.addedAt) ? r.addedAt : null;
    if (id === null || name === null || mimeType === null || sizeBytes === null || addedAt === null) {
      continue;
    }
    // Last write wins so the host-side reconciliation in mergeIssueUpdate can
    // overwrite a metadata-only update.
    byId.set(id, { id, name, mimeType, sizeBytes, addedAt });
  }
  return Array.from(byId.values());
}

export function canMoveToActiveLane(
  currentIssues: Issue[],
  targetStatus: Status,
  movingIssueId?: string,
  cap = ACTIVE_LANE_CAP,
): true | string {
  if (!isActiveLane(targetStatus)) return true;
  const count = currentIssues.filter(
    (i) => i.status === targetStatus && i.id !== movingIssueId,
  ).length;
  if (count >= cap) {
    return `Lane "${targetStatus}" is full (${count}/${cap}). Complete or move a ticket out before adding another.`;
  }
  return true;
}
