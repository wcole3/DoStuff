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

/**
 * Stored relationship kinds from a source ticket to a target ticket. Only these
 * three "outbound" kinds persist; the matching inbound labels are derived for
 * display via `INVERSE_LINK_KIND` (see below). `relates-to` is symmetric and
 * maps to itself.
 */
export const LINK_KINDS = ["blocks", "child-of", "relates-to"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export type InverseLinkLabel = "blocked-by" | "parent-of" | "relates-to";

/** Labels rendered on derived inbound chips ("Linked by"). */
export const INVERSE_LINK_KIND: Record<LinkKind, InverseLinkLabel> = {
  "blocks": "blocked-by",
  "child-of": "parent-of",
  "relates-to": "relates-to",
};

export function isLinkKind(v: unknown): v is LinkKind {
  return typeof v === "string" && (LINK_KINDS as readonly string[]).includes(v);
}

export interface TicketLink {
  /** Always a `DS-NNN`-style id of an existing ticket. Unknown ids are dropped
   *  at the host edge (in `mergeIssueUpdate` and MCP `create_ticket`). */
  targetId: string;
  kind: LinkKind;
}

const DS_ID_RE = /^DS-\d+$/;

/**
 * Validate + dedupe a raw `links` value into a clean `TicketLink[]`. Mirrors
 * `coerceTags` / `coerceAttachments`: forgiving (returns `[]` on bad shapes),
 * dedupes by `(targetId, kind)` pair, drops self-links.
 *
 * Unknown-target validation is NOT done here (no store access). That belongs
 * to host-side `validateLinks` in `extension.ts` so we keep this module pure.
 */
export function coerceLinks(input: unknown, currentIssueId?: string): TicketLink[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: TicketLink[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const rawTarget = typeof r.targetId === "string" ? r.targetId.toUpperCase() : "";
    if (!DS_ID_RE.test(rawTarget)) continue;
    if (currentIssueId && rawTarget === currentIssueId) continue;
    if (!isLinkKind(r.kind)) continue;
    const key = `${rawTarget}|${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ targetId: rawTarget, kind: r.kind });
  }
  return out;
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
  /** Free-form labels for cross-cutting categorization (like Jira labels).
   *  Each tag's display color is derived deterministically from its name. */
  tags: string[];
  /** Files & images attached to this issue. The bytes are stored on disk
   *  alongside the ticket JSON; this list carries only metadata. */
  attachments: Attachment[];
  /** Outbound relationships to other tickets. Single-source: B's "linked by"
   *  view is derived by scanning all issues and inverting the kind via
   *  `INVERSE_LINK_KIND`. There is no dual-write. */
  links: TicketLink[];
}

/** Statuses an MCP-connected agent is allowed to set via update_ticket_status. */
export const AGENT_WRITABLE_STATUSES: Status[] = ["Planned", "Working", "Verification"];

/** Statuses an MCP-connected agent is allowed to read (get_ticket, resources)
 *  and annotate (update_ticket_progress). Excludes Complete and Closed. */
export const AGENT_VISIBLE_STATUSES: Status[] = ["Thinking", "Planned", "Working", "Verification"];

/** Wire format for host ↔ webview messaging. */
export type HostToWebview =
  | { type: "init"; issues: Issue[]; settings: Settings }
  | { type: "issues"; issues: Issue[] }
  | { type: "focusSearch" }
  | { type: "settings"; settings: Settings }
  | { type: "showNewIssue" }
  // Sidebar dragstart broadcast: the board uses this to enter a "pick a
  // lane" mode (lanes/drawers highlight as click targets) since native
  // HTML5 drag cannot cross VSCode webview boundaries reliably. The state
  // is cleared by the board itself (overlay click or Esc); there is no
  // matching end event because the sidebar's `dragend` fires too early —
  // before VSCode restores pointer events on the board iframe.
  | { type: "externalDragStart"; issueId: string }
  // Host's reply to `pickAttachmentForStaging` / `stageAttachmentByUri`.
  // Carries the bytes the new-issue modal should add to its local staging
  // list; nothing has been written to disk yet — the actual write happens
  // after the modal submits and the host expands these into appendAttachment
  // calls against the freshly-created ticket.
  | { type: "attachmentStaged"; name: string; mimeType: string; bytes: number[] }
  // Broadcast from the host telling open webviews to surface a particular
  // ticket's IssueDetail. Originates from a graph node click; the host
  // routes it back to sidebar (open the detail overlay) and board (scroll
  // to the lane + open the detail).
  | { type: "revealTicket"; id: string };

export type WebviewToHost =
  | { type: "ready" }
  | {
      type: "createIssue";
      partial: Omit<Issue, "id" | "number" | "createdAt" | "statusHistory" | "tasks" | "resolvedAt" | "record" | "attachments" | "links"> & {
        tasks?: Task[];
        // Inline attachments staged in the new-issue modal. The host loops
        // these through the regular appendAttachment chokepoint after upserting
        // the new ticket, so the size cap and workspace precondition still
        // apply uniformly.
        attachments?: Array<{ name: string; mimeType: string; bytes: number[] }>;
        // Inline links staged in the new-issue modal. Host validates against
        // the store (dropping unknown targetIds and self-links) before
        // persisting alongside the freshly-created ticket.
        links?: TicketLink[];
        // Inverse relationships staged in the modal (e.g. "new ticket is
        // blocked by DS-042"). Single-source storage means these are written
        // as forward links on the *source* ticket after the new ticket gets
        // its id: host appends `{ targetId: <newId>, kind }` to each source.
        inboundLinks?: Array<{ sourceId: string; kind: LinkKind }>;
      };
    }
  | { type: "updateIssue"; issue: Issue }
  | { type: "deleteIssue"; id: string }
  | { type: "openBoard" }
  | { type: "importJson" }
  | { type: "exportJson" }
  | { type: "openSettings" }
  | { type: "externalDragStart"; issueId: string }
  | { type: "openLink"; url: string }
  // Webview-initiated upload via the host file picker. Host opens a
  // `showOpenDialog` and reads bytes itself — keeps large files off the
  // webview IPC channel.
  | { type: "pickAttachment"; issueId: string }
  // Drag-drop upload: webview already has the bytes (from DataTransfer.files)
  // and ships them to the host. Bounded by `MAX_ATTACHMENT_BYTES` at both
  // ends.
  | { type: "addAttachmentBytes"; issueId: string; name: string; mimeType: string; bytes: number[] }
  // Drag-drop fallback for environments (notably Remote-WSL when files originate
  // from the Windows host) where the webview's `DataTransfer.files` is empty
  // but `text/uri-list` carries the file URI. Host resolves the URI and reads
  // bytes via `vscode.workspace.fs.readFile`, which transparently crosses the
  // remote/local boundary.
  | { type: "addAttachmentByUri"; issueId: string; uri: string }
  | { type: "deleteAttachment"; issueId: string; attachmentId: string }
  // Open a non-image attachment in VSCode via its on-disk URI.
  | { type: "openAttachment"; issueId: string; attachmentId: string }
  // New-issue modal staging: open the host file picker without an issueId,
  // read each picked file, and reply with one `attachmentStaged` per file.
  | { type: "pickAttachmentForStaging" }
  // New-issue modal staging fallback for Remote-WSL URI drops. Host reads the
  // URI and replies with `attachmentStaged`.
  | { type: "stageAttachmentByUri"; uri: string }
  // Webview-initiated request to surface a ticket's IssueDetail across all
  // open webviews. Originates from a graph node click; host re-broadcasts as
  // a `revealTicket` HostToWebview message.
  | { type: "revealTicket"; id: string }
  // Sidebar/board toolbar button — routes through the registered
  // `dostuff.openGraph` command on the host.
  | { type: "openGraph" };

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
