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
  /** ISO 8601 — when this task's `text`/`done` last changed. Server-stamped in
   *  `IssueStore.upsert` by diffing against the prior ticket (webview/MCP input
   *  is never honored). Optional so untouched payloads stay type-valid; when
   *  missing, the sync wire boundary defaults it to the ticket's `createdAt`.
   *  Additive — legacy tickets load without it. */
  updatedAt?: string;
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
 * A commit reported against a ticket while implementing it. Only the sha and
 * the report time are stored — the subject line and touched files are derived
 * lazily from the workspace repo at render time (see `commitDetails.ts`), so a
 * sha that no longer resolves (rebase, different machine) degrades to
 * "not found" without breaking the ticket.
 */
export interface TicketCommit {
  /** Lowercase hex, 7–40 chars, stored exactly as reported (after lowercasing). */
  sha: string;
  /** ISO 8601 — when the commit was reported via MCP. */
  at: string;
}

/** Valid stored commit-sha shape. Inputs are lowercased before testing. */
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Lazily-derived display data for one `TicketCommit`, resolved by the
 * extension host against the workspace git repo. `found: false` means the sha
 * doesn't resolve to a commit here (rebased away, not fetched, no repo).
 */
export interface CommitDetail {
  sha: string;
  found: boolean;
  /** First line of the commit message; empty when not found. */
  subject: string;
  /** Repo-relative paths touched by the commit; empty when not found. */
  files: string[];
}

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

/** Terminal state an agent's pending request resolves to on approval. */
export const PENDING_CLOSE_TARGETS = ["Closed", "Complete"] as const;
export type PendingCloseTarget = (typeof PENDING_CLOSE_TARGETS)[number];

/**
 * An agent's pending request to move a ticket to a terminal state, awaiting a
 * human verdict. Two distinct flows share this flag, distinguished by
 * `target`:
 * - `"Closed"` (the default when absent — legacy rows keep their meaning):
 *   the ticket is OBE / no longer needed. Set by MCP `request_ticket_close`.
 * - `"Complete"`: the work is done and ready for acceptance. Set by MCP
 *   `request_ticket_complete` (Verification only).
 * Cleared when a human approves (status → `target`) or denies via the host
 * `resolveClose` handler. Additive field — legacy tickets load with
 * `pendingClose: null`.
 */
export interface PendingClose {
  /** Who requested it. Agents set "agent"; kept as a union for a possible
   *  future human-initiated request flow. */
  by: "agent";
  /** Optional rationale supplied by the requesting agent. */
  note?: string;
  /** ISO 8601 — when the request was filed. */
  at: string;
  /** Terminal state on approval. Absent = "Closed" (pre-target rows). */
  target?: PendingCloseTarget;
}

/** Canonical DS-NNN ticket-id shape. Exported so validators don't re-inline it. */
export const DS_ID_RE = /^DS-\d+$/;

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
  /** Non-null when an agent has requested closure via MCP and a human has not
   *  yet approved or denied it. Cleared on either verdict; approval also sets
   *  status to `Closed`. Additive — legacy tickets default to null. */
  pendingClose: PendingClose | null;
  /** Canonical cross-writer identity for git-native sync. Server-derived:
   *  minted `randomUUID()` at creation, backfilled deterministically via
   *  `deriveGuid(id, createdAt)` for legacy data (`normalize()` /
   *  `hydrateFromDb`). Webview/MCP input is never honored. Additive. */
  guid: string;
  /** ISO 8601 — last mutation. Server-stamped in `IssueStore.upsert`; sync
   *  apply preserves remote values (`preserveTimestamps`). Legacy data
   *  defaults to `createdAt`. Additive. */
  updatedAt: string;
  /** Append-only list of commits reported while implementing this ticket.
   *  Server-derived: appended only by MCP `update_ticket_progress` (webview
   *  input is never honored — `mergeIssueUpdate` carries it from prior).
   *  Deduped by sha, sorted by (at, sha); sync merges by union (never LWW).
   *  Additive — legacy tickets load with []. */
  commits: TicketCommit[];
}

/** Statuses an MCP-connected agent is allowed to set via update_ticket_status.
 *  All non-terminal states: agents may promote a Thinking draft into an active
 *  lane, shuffle the active lanes, or demote a ticket back to Thinking.
 *  Complete and Closed remain human-only in both directions. */
export const AGENT_WRITABLE_STATUSES: Status[] = ["Thinking", "Planned", "Working", "Verification"];

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
  | { type: "revealTicket"; id: string }
  // Host's reply to `fetchCommitDetails`: lazily-derived subject + files for
  // each of the ticket's stored commit shas. `pathPrefix` is the posix
  // relative path from the workspace root to the repo root ("." when equal)
  // so the webview can compose openLink-able file paths.
  | { type: "commitDetails"; issueId: string; pathPrefix: string; details: CommitDetail[] };

export type WebviewToHost =
  | { type: "ready" }
  | {
      type: "createIssue";
      // `guid`/`updatedAt`/`commits` are server-derived like `pendingClose` —
      // the webview never supplies them (see `buildCreatedIssue` / `IssueStore.upsert`).
      partial: Omit<Issue, "id" | "number" | "createdAt" | "statusHistory" | "tasks" | "resolvedAt" | "record" | "attachments" | "links" | "pendingClose" | "guid" | "updatedAt" | "commits"> & {
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
  | { type: "openGraph" }
  // Human verdict on an agent's pending close request (see `PendingClose`).
  // Routed through the registered `dostuff.resolveClose` command → the host
  // `resolveClose` handler, which applies `Closed` (approve) or clears the
  // request (deny).
  | { type: "resolveClose"; id: string; verdict: "approve" | "deny" }
  // Ask the host to derive commit subjects + touched files for the ticket's
  // stored shas. The webview never supplies shas — the host reads them from
  // the store — so no sha crosses the webview trust boundary. Reply:
  // `commitDetails`.
  | { type: "fetchCommitDetails"; issueId: string };

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

/**
 * Total order for `TicketCommit` lists: ascending (at, sha). Shared by
 * `coerceCommits`, the MCP append, and the sync union merge so identical
 * logical states serialize byte-identically on every replica (stable
 * canonical-JSON hashes for the LWW tiebreak).
 */
export function compareCommits(a: TicketCommit, b: TicketCommit): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
}

/**
 * Validate + dedupe a raw `commits` value into a clean `TicketCommit[]`.
 * Mirrors the other coercers: forgiving (returns `[]` on bad shapes), never
 * throws. Shas are lowercased and must be 7–40 hex chars; duplicate shas keep
 * the earliest `at` (matching the sync union merge). Output sorted (at, sha).
 */
export function coerceCommits(input: unknown): TicketCommit[] {
  if (!Array.isArray(input)) return [];
  const bySha = new Map<string, TicketCommit>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const sha = typeof r.sha === "string" ? r.sha.toLowerCase() : "";
    if (!COMMIT_SHA_RE.test(sha)) continue;
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) continue;
    const prev = bySha.get(sha);
    if (!prev || r.at < prev.at) bySha.set(sha, { sha, at: r.at });
  }
  return Array.from(bySha.values()).sort(compareCommits);
}

/**
 * Validate a raw `pendingClose` value into a clean `PendingClose | null`.
 * Mirrors the other coercers: forgiving (returns `null` on any bad or missing
 * shape) and never throws, so a legacy ticket lacking the field loads as null.
 */
export function coercePendingClose(input: unknown): PendingClose | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.by !== "agent") return null;
  if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return null;
  const out: PendingClose = { by: "agent", at: r.at };
  if (typeof r.note === "string") out.note = r.note;
  // Unrecognized target values are dropped, not failed: the request degrades
  // to the legacy meaning (Closed) instead of vanishing.
  if ((PENDING_CLOSE_TARGETS as readonly unknown[]).includes(r.target)) {
    out.target = r.target as PendingCloseTarget;
  }
  return out;
}

/**
 * The lane a pending close/complete request resolves to. An absent `target`
 * is the legacy wire shape and means `Closed` (OBE) — this is the one place
 * that rule lives; readers must not re-apply the default themselves.
 */
export function effectiveCloseTarget(pc: PendingClose): PendingCloseTarget {
  return pc.target ?? "Closed";
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
