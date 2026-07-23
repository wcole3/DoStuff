// Pure sync/merge module for git-native ticket sync
// (docs/plans/ticket-sync/02-merge-spec.md).
//
// HARD CONSTRAINT: no `vscode` imports, no git, no I/O, no `Date.now()`
// outside explicit parameters. Everything in this module must be a
// deterministic function of its inputs so that two machines merging the same
// pair of states produce byte-identical results. The merge is a join in a
// semilattice — commutative, associative, idempotent — which is what lets the
// sync protocol skip merge-base computation entirely. `storage.ts` imports
// from here (this direction keeps the module vscode-free and avoids a cycle).

import { createHash } from "node:crypto";
import {
  coerceAttachments,
  coercePendingClose,
  coerceTags,
  isLinkKind,
  isPriority,
  isStatus,
  isType,
  type Attachment,
  type Issue,
  type IssueType,
  type LinkKind,
  type PendingClose,
  type Priority,
  type RecordEntry,
  type Status,
  type StatusEvent,
  type Task,
  type TicketLink,
} from "./types";

// ─── phase-1 primitives ───────────────────────────────────────────────────

/**
 * Deterministic guid for tickets that predate the `guid` field. uuid-v5-style
 * formatting of sha1("dostuff-guid:" + id + "|" + createdAt).
 *
 * Deterministic (rather than `randomUUID()` at load) so that:
 * 1. Pre-shared exports dedupe — tickets previously copied between clones via
 *    JSON export/import derive the *same* guid on both sides, so the first
 *    sync merges them instead of doubling the board.
 * 2. Downgrade-safe — an older build rewriting a row NULLs the `guid` column;
 *    re-derivation restores the identical identity, so no split-brain after
 *    an upgrade→downgrade→upgrade round trip.
 */
export function deriveGuid(id: string, createdAt: string): string {
  const h = createHash("sha1").update(`dostuff-guid:${id}|${createdAt}`).digest("hex");
  // Format as 8-4-4-4-12; stamp version nibble 5 and variant bits 10xx for a
  // well-formed uuid.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "5" + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * Canonical JSON: recursively key-sorted objects, arrays in given order,
 * 2-space indent, trailing newline. Used for every blob written to the ref
 * tree — identical logical state → identical bytes → identical git OIDs,
 * which buys free no-op detection, cross-commit blob dedup, and a stable
 * input for the LWW tiebreak hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // undefined is not representable in JSON
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * How long ticket/element tombstones are retained, relative to the newest
 * timestamp in the merged state (never the wall clock — determinism). A
 * replica offline longer than this can resurrect a deleted ticket; accepted
 * trade (docs/plans/ticket-sync/00-overview.md §risks).
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;

/**
 * Ids that sync turns into filesystem path components (ticket ids, guids,
 * attachment/task ids) must be a single safe path segment: no separators, no
 * `.`/`..`, no whitespace or control characters. Everything this extension
 * mints (DS-NNN, uuids, `t-<uuid>`) passes; anything that could traverse out
 * of the attachments root — or smuggle a `\t`/`\n` into a mktree entry line —
 * fails. Shared by the wire coercer, the import validator, and the storage
 * attachment helpers so every input path is gated identically.
 */
export function isSafePathSegment(value: string): boolean {
  return /^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(value);
}

/** Wire ticket ids are exactly what the store mints: DS-<digits>. The digit
 *  cap keeps the parsed number well inside safe-integer renumber range. */
const WIRE_ID_RE = /^DS-\d{1,9}$/;

/**
 * Derive a safe on-disk extension from an attachment display name. The name
 * is remote-controlled (wire metadata / webview message), so the result must
 * never contain a path separator: keep only `[A-Za-z0-9.]`, cap the length,
 * drop the rest. Empty string when the name has no usable extension.
 */
export function sanitizeExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = name.slice(dot).replace(/[^A-Za-z0-9.]/g, "");
  if (ext.length < 2 || ext.length > 16 || !ext.startsWith(".")) return "";
  return ext;
}

// ─── wire model ───────────────────────────────────────────────────────────

export interface WireLink {
  targetGuid: string; // NOT targetId — renumber-immune by construction
  kind: LinkKind;
}

export interface WireTask {
  id: string;
  text: string;
  done: boolean;
  /** REQUIRED on wire — `toWire` fills missing (legacy) with ticket createdAt. */
  updatedAt: string;
}

export interface ElementTombstone {
  id: string;
  deletedAt: string;
}

export interface WireTicket {
  guid: string;
  id: string; // DS-NNN at time of writing; renumber pass may re-project
  number: number;
  title: string;
  description: string;
  verifyCriteria: string;
  type: IssueType;
  priority: Priority;
  status: Status;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  tags: string[];
  tasks: WireTask[];
  attachments: Attachment[]; // metadata only; bytes live in the ref tree (05)
  links: WireLink[];
  statusHistory: StatusEvent[];
  record: RecordEntry[];
  pendingClose: PendingClose | null;
  /** Element deletion witnesses (docs/plans/ticket-sync/01 §6). */
  deletedTasks: ElementTombstone[];
  deletedAttachments: ElementTombstone[];
}

export interface Tombstone {
  guid: string;
  deletedAt: string;
  lastId: string;
}

export interface SyncState {
  tickets: Map<string, WireTicket>; // keyed by guid
  tombstones: Map<string, Tombstone>; // keyed by guid
}

// ─── converters ───────────────────────────────────────────────────────────

/**
 * Project a local Issue onto the wire. `idToGuid` resolves link targets —
 * links whose target has no known guid are dropped (they point at tickets
 * that don't exist locally, which validateLinks should already prevent).
 * `elementTombstones` comes from `store.getSyncTombstones()`; the controller
 * fetches and passes it so this module stays pure.
 */
export function toWire(
  issue: Issue,
  idToGuid: Map<string, string>,
  elementTombstones?: { tasks: ElementTombstone[]; attachments: ElementTombstone[] },
): WireTicket {
  const links: WireLink[] = [];
  for (const l of issue.links) {
    const targetGuid = idToGuid.get(l.targetId);
    if (targetGuid) links.push({ targetGuid, kind: l.kind });
  }
  return {
    guid: issue.guid,
    id: issue.id,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    verifyCriteria: issue.verifyCriteria,
    type: issue.type,
    priority: issue.priority,
    status: issue.status,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    resolvedAt: issue.resolvedAt,
    tags: [...issue.tags],
    tasks: issue.tasks.map((t) => ({
      id: t.id,
      text: t.text,
      done: t.done,
      updatedAt: t.updatedAt ?? issue.createdAt,
    })),
    attachments: issue.attachments.map((a) => ({ ...a })),
    links,
    statusHistory: issue.statusHistory.map((h) => ({ ...h })),
    record: issue.record.map((r) => ({ ...r })),
    pendingClose: issue.pendingClose ? { ...issue.pendingClose } : null,
    deletedTasks: (elementTombstones?.tasks ?? []).map((t) => ({ ...t })),
    deletedAttachments: (elementTombstones?.attachments ?? []).map((t) => ({ ...t })),
  };
}

/**
 * Project a wire ticket back into a local Issue. `guidToId` resolves link
 * targets after renumbering settles; links to tombstoned/unknown guids are
 * dropped (mirrors `remove()`'s inbound-link scrub). The merged result must
 * still pass `normalize()` before touching the store.
 */
export function fromWire(wire: WireTicket, guidToId: Map<string, string>): Issue {
  const links: TicketLink[] = [];
  const seen = new Set<string>();
  for (const l of wire.links) {
    const targetId = guidToId.get(l.targetGuid);
    if (!targetId || targetId === wire.id) continue;
    const key = `${targetId}|${l.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetId, kind: l.kind });
  }
  return {
    id: wire.id,
    number: wire.number,
    title: wire.title,
    description: wire.description,
    verifyCriteria: wire.verifyCriteria,
    type: wire.type,
    priority: wire.priority,
    status: wire.status,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    resolvedAt: wire.resolvedAt,
    tags: [...wire.tags],
    tasks: wire.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done, updatedAt: t.updatedAt })),
    attachments: wire.attachments.map((a) => ({ ...a })),
    links,
    statusHistory: wire.statusHistory.map((h) => ({ ...h })),
    record: wire.record.map((r) => ({ ...r })),
    pendingClose: wire.pendingClose ? { ...wire.pendingClose } : null,
    guid: wire.guid,
  };
}

// ─── inbound hardening ────────────────────────────────────────────────────

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

/**
 * Harden a ticket read from a fetched tree. Applying remote state is NOT an
 * agent write — MCP status gating does not apply (a remote human may
 * legitimately have moved a ticket to Complete, and a remote agent may have
 * promoted/demoted within the non-terminal set) — but nothing malformed may
 * enter the cache. Returns null (skip the entry) when required identity
 * fields are missing; coerces everything else to safe values. Never throws.
 */
export function coerceWireTicket(raw: unknown): WireTicket | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Identity fields become filesystem path components (attachment dirs, tree
  // entry names) on every replica — reject anything that is not exactly the
  // shape this extension mints. No legitimate build ever wrote other shapes,
  // so this loses no data; it only refuses hostile blobs.
  if (typeof r.guid !== "string" || !isSafePathSegment(r.guid)) return null;
  if (typeof r.id !== "string" || !WIRE_ID_RE.test(r.id)) return null;
  if (typeof r.title !== "string") return null;
  if (!isIso(r.createdAt)) return null;
  const createdAt = r.createdAt;

  // Last-wins dedupe by id — duplicate ids in a crafted blob would otherwise
  // emit duplicate elements from the per-element merge.
  const tasksById = new Map<string, WireTask>();
  if (Array.isArray(r.tasks)) {
    for (const t of r.tasks) {
      if (!t || typeof t !== "object") continue;
      const tt = t as Record<string, unknown>;
      if (typeof tt.id !== "string" || !isSafePathSegment(tt.id) || typeof tt.text !== "string") {
        continue;
      }
      tasksById.set(tt.id, {
        id: tt.id,
        text: tt.text,
        done: tt.done === true,
        updatedAt: isIso(tt.updatedAt) ? tt.updatedAt : createdAt,
      });
    }
  }
  const tasks = [...tasksById.values()];

  const links: WireLink[] = [];
  if (Array.isArray(r.links)) {
    const seen = new Set<string>();
    for (const l of r.links) {
      if (!l || typeof l !== "object") continue;
      const ll = l as Record<string, unknown>;
      if (typeof ll.targetGuid !== "string" || !isSafePathSegment(ll.targetGuid) || !isLinkKind(ll.kind)) {
        continue;
      }
      const key = `${ll.targetGuid}|${ll.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ targetGuid: ll.targetGuid, kind: ll.kind });
    }
  }

  const statusHistory: StatusEvent[] = [];
  if (Array.isArray(r.statusHistory)) {
    for (const h of r.statusHistory) {
      if (!h || typeof h !== "object") continue;
      const hh = h as Record<string, unknown>;
      if (!isStatus(hh.status) || !isIso(hh.at)) continue;
      statusHistory.push({
        status: hh.status,
        at: hh.at,
        by: hh.by === "agent" ? "agent" : "user",
      });
    }
  }

  const record: RecordEntry[] = [];
  if (Array.isArray(r.record)) {
    for (const e of r.record) {
      if (!e || typeof e !== "object") continue;
      const ee = e as Record<string, unknown>;
      if (!isIso(ee.at) || typeof ee.text !== "string") continue;
      record.push({
        at: ee.at,
        author: ee.author === "agent" ? "agent" : "user",
        ...(typeof ee.source === "string" ? { source: ee.source } : {}),
        text: ee.text,
      });
    }
  }

  // The id regex caps digits at 9, so the id-derived number is always a safe
  // renumber input; an explicit `number` must be equally sane or it could
  // blow up `bumpReserved`/renumber on every replica.
  const numberFromId = Number.parseInt(r.id.slice(3), 10);
  const number =
    typeof r.number === "number" && Number.isSafeInteger(r.number) && r.number > 0 && r.number <= 999_999_999
      ? r.number
      : numberFromId;

  return {
    guid: r.guid,
    id: r.id,
    number,
    title: r.title,
    description: typeof r.description === "string" ? r.description : "",
    verifyCriteria: typeof r.verifyCriteria === "string" ? r.verifyCriteria : "",
    type: isType(r.type) ? r.type : "Chore",
    priority: isPriority(r.priority) ? r.priority : "Regular",
    status: isStatus(r.status) ? r.status : "Thinking",
    createdAt,
    updatedAt: isIso(r.updatedAt) ? r.updatedAt : createdAt,
    resolvedAt: isIso(r.resolvedAt) ? r.resolvedAt : null,
    tags: coerceTags(r.tags),
    tasks,
    // Attachment ids name blobs in the ref tree and files on disk — same
    // safe-segment bar as the ticket identity fields.
    attachments: coerceAttachments(r.attachments).filter((a) => isSafePathSegment(a.id)),
    links,
    statusHistory,
    record,
    pendingClose: coercePendingClose(r.pendingClose),
    deletedTasks: coerceElementTombstones(r.deletedTasks),
    deletedAttachments: coerceElementTombstones(r.deletedAttachments),
  };
}

function coerceElementTombstones(input: unknown): ElementTombstone[] {
  if (!Array.isArray(input)) return [];
  const out: ElementTombstone[] = [];
  const seen = new Set<string>();
  for (const e of input) {
    if (!e || typeof e !== "object") continue;
    const ee = e as Record<string, unknown>;
    if (typeof ee.id !== "string" || !isSafePathSegment(ee.id) || !isIso(ee.deletedAt)) continue;
    if (seen.has(ee.id)) continue;
    seen.add(ee.id);
    out.push({ id: ee.id, deletedAt: ee.deletedAt });
  }
  return out;
}

// ─── merge ────────────────────────────────────────────────────────────────

/** sha1 of canonical JSON — the deterministic LWW tiebreak. */
function contentHash(value: unknown): string {
  return createHash("sha1").update(canonicalJson(value)).digest("hex");
}

/**
 * LWW comparison tuple `(updatedAt, sha1(canonicalJson(x)))`. ISO timestamps
 * sort chronologically under string compare; the content hash breaks
 * exact-timestamp ties identically on both machines. Returns a's-tuple minus
 * b's-tuple in sign.
 *
 * Nuance: on an exact-timestamp tie the hash compares *merged* content
 * against an input, so re-merging can flip the winner once (a merged ticket
 * hashes differently from either input). The state space is finite and the
 * pick deterministic, so replicas still converge — absorption is only
 * approximate under exact-ms ties, never divergent.
 */
function compareTuple(aTs: string, aHash: string, bTs: string, bHash: string): number {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1;
  if (aHash !== bHash) return aHash < bHash ? -1 : 1;
  return 0;
}

/**
 * State-level merge: a join in a semilattice (commutative / associative /
 * idempotent). Per-ticket rules (02-merge-spec §4):
 * - one-sided presence + no tombstone → created there, keep;
 * - tombstone vs tombstone → max deletedAt;
 * - tombstone vs ticket → tombstone wins iff `deletedAt > updatedAt`, else
 *   the ticket survives AND the tombstone is dropped (tie → ticket);
 * - ticket vs ticket → field merge (§5) with per-element task/attachment
 *   LWW + element tombstones.
 * Ends with the deterministic tombstone GC pass (§5).
 */
export function mergeStates(a: SyncState, b: SyncState): SyncState {
  const guids = new Set<string>([
    ...a.tickets.keys(),
    ...b.tickets.keys(),
    ...a.tombstones.keys(),
    ...b.tombstones.keys(),
  ]);

  const tickets = new Map<string, WireTicket>();
  const tombstones = new Map<string, Tombstone>();

  for (const guid of [...guids].sort()) {
    const ta = a.tickets.get(guid);
    const tb = b.tickets.get(guid);
    const sa = a.tombstones.get(guid);
    const sb = b.tombstones.get(guid);

    let tomb: Tombstone | null = null;
    if (sa && sb) tomb = sa.deletedAt >= sb.deletedAt ? sa : sb;
    else tomb = sa ?? sb ?? null;

    let ticket: WireTicket | null = null;
    if (ta && tb) ticket = mergeTickets(ta, tb);
    else ticket = ta ?? tb ?? null;

    if (ticket && tomb) {
      if (tomb.deletedAt > ticket.updatedAt) {
        // Delete is newer than every edit we know of → tombstone wins.
        tombstones.set(guid, tomb);
      } else {
        // Ticket survives; drop the beaten tombstone so it can't re-kill the
        // ticket on a later merge.
        tickets.set(guid, ticket);
      }
    } else if (ticket) {
      tickets.set(guid, ticket);
    } else if (tomb) {
      tombstones.set(guid, tomb);
    }
  }

  return gcTombstones({ tickets, tombstones });
}

/** Ticket-vs-ticket field merge (02-merge-spec §5). */
function mergeTickets(x: WireTicket, y: WireTicket): WireTicket {
  const cmp = compareTuple(x.updatedAt, contentHash(x), y.updatedAt, contentHash(y));
  const w = cmp >= 0 ? x : y; // winner
  const l = cmp >= 0 ? y : x; // loser

  const tasks = mergeElements(
    w.tasks,
    l.tasks,
    w.deletedTasks,
    l.deletedTasks,
    (t) => t.updatedAt,
  );
  const attachments = mergeElements(
    w.attachments,
    l.attachments,
    w.deletedAttachments,
    l.deletedAttachments,
    (a) => a.addedAt,
  );

  return {
    // Scalar fields + tags + links + pendingClose: from the winner wholesale.
    ...w,
    // number/id from W provisionally; the renumber pass may override.
    createdAt: x.createdAt <= y.createdAt ? x.createdAt : y.createdAt,
    // max of inputs, never now() — the merge must not look newer than its
    // inputs or echoes would win future LWW rounds.
    updatedAt: x.updatedAt >= y.updatedAt ? x.updatedAt : y.updatedAt,
    tags: [...w.tags],
    links: w.links.map((li) => ({ ...li })),
    tasks: tasks.elements,
    deletedTasks: tasks.tombstones,
    attachments: attachments.elements,
    deletedAttachments: attachments.tombstones,
    statusHistory: mergeStatusHistory(x.statusHistory, y.statusHistory),
    record: mergeRecord(x.record, y.record),
    pendingClose: w.pendingClose ? { ...w.pendingClose } : null,
  };
}

/**
 * Per-element merge with tombstones (02-merge-spec §5). For each element id
 * in the union: the newest tombstone for the id is gathered across both
 * sides; the element survives iff no tombstone exists or
 * `elementTs >= tombstone.deletedAt` (tie → element survives); a beaten
 * tombstone is dropped. Ids present on both sides resolve per-element LWW on
 * `(elementTs, sha1(canonicalJson(element)))`. Order: winner's order first,
 * then loser-only survivors in the loser's relative order.
 */
function mergeElements<T extends { id: string }>(
  winnerEls: T[],
  loserEls: T[],
  winnerTombs: ElementTombstone[],
  loserTombs: ElementTombstone[],
  tsOf: (el: T) => string,
): { elements: T[]; tombstones: ElementTombstone[] } {
  const tombById = new Map<string, string>(); // id → max deletedAt
  for (const t of [...winnerTombs, ...loserTombs]) {
    const prev = tombById.get(t.id);
    if (!prev || t.deletedAt > prev) tombById.set(t.id, t.deletedAt);
  }

  const loserById = new Map(loserEls.map((e) => [e.id, e]));
  const winnerIds = new Set(winnerEls.map((e) => e.id));

  const pickBoth = (we: T, le: T): T => {
    const c = compareTuple(tsOf(we), contentHash(we), tsOf(le), contentHash(le));
    return c >= 0 ? we : le;
  };

  const elements: T[] = [];
  const beatenTombs = new Set<string>();
  const consider = (el: T) => {
    const deletedAt = tombById.get(el.id);
    if (deletedAt !== undefined && tsOf(el) < deletedAt) return; // tombstone wins
    if (deletedAt !== undefined) beatenTombs.add(el.id); // element survives → tombstone dies
    elements.push(el);
  };

  for (const we of winnerEls) {
    const le = loserById.get(we.id);
    consider(le ? pickBoth(we, le) : we);
  }
  for (const le of loserEls) {
    if (!winnerIds.has(le.id)) consider(le);
  }

  const tombstones: ElementTombstone[] = [...tombById.entries()]
    .filter(([id]) => !beatenTombs.has(id))
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { elements, tombstones };
}

/** Union keyed (status, at, by), sorted ascending by at (tiebreak: status, then by). */
function mergeStatusHistory(a: StatusEvent[], b: StatusEvent[]): StatusEvent[] {
  const byKey = new Map<string, StatusEvent>();
  for (const h of [...a, ...b]) {
    byKey.set(`${h.status}|${h.at}|${h.by ?? "user"}`, h);
  }
  return [...byKey.values()].sort((x, y) => {
    if (x.at !== y.at) return x.at < y.at ? -1 : 1;
    if (x.status !== y.status) return x.status < y.status ? -1 : 1;
    const xb = x.by ?? "user";
    const yb = y.by ?? "user";
    return xb < yb ? -1 : xb > yb ? 1 : 0;
  });
}

/** Union keyed (at, author, text), sorted ascending by at (tiebreak: author, then text). */
function mergeRecord(a: RecordEntry[], b: RecordEntry[]): RecordEntry[] {
  const byKey = new Map<string, RecordEntry>();
  for (const r of [...a, ...b]) {
    byKey.set(`${r.at}|${r.author}|${r.text}`, r);
  }
  return [...byKey.values()].sort((x, y) => {
    if (x.at !== y.at) return x.at < y.at ? -1 : 1;
    if (x.author !== y.author) return x.author < y.author ? -1 : 1;
    return x.text < y.text ? -1 : x.text > y.text ? 1 : 0;
  });
}

/**
 * Deterministic tombstone GC (02-merge-spec §5): drop any ticket or element
 * tombstone with `deletedAt < maxTs − TOMBSTONE_TTL_MS`, where maxTs is the
 * max over every updatedAt/deletedAt in the merged state. Pure function of
 * the inputs → both machines prune identically.
 */
function gcTombstones(state: SyncState): SyncState {
  let maxTs = "";
  const bump = (ts: string) => {
    if (ts > maxTs) maxTs = ts;
  };
  for (const t of state.tickets.values()) {
    bump(t.updatedAt);
    for (const task of t.tasks) bump(task.updatedAt);
    for (const d of t.deletedTasks) bump(d.deletedAt);
    for (const d of t.deletedAttachments) bump(d.deletedAt);
  }
  for (const t of state.tombstones.values()) bump(t.deletedAt);
  if (!maxTs) return state;

  const cutoffMs = Date.parse(maxTs) - TOMBSTONE_TTL_MS;
  if (Number.isNaN(cutoffMs)) return state;
  const alive = (deletedAt: string) => {
    const ms = Date.parse(deletedAt);
    return Number.isNaN(ms) || ms >= cutoffMs;
  };

  const tombstones = new Map<string, Tombstone>();
  for (const [guid, t] of state.tombstones) {
    if (alive(t.deletedAt)) tombstones.set(guid, t);
  }
  const tickets = new Map<string, WireTicket>();
  for (const [guid, t] of state.tickets) {
    const deletedTasks = t.deletedTasks.filter((d) => alive(d.deletedAt));
    const deletedAttachments = t.deletedAttachments.filter((d) => alive(d.deletedAt));
    tickets.set(
      guid,
      deletedTasks.length === t.deletedTasks.length &&
        deletedAttachments.length === t.deletedAttachments.length
        ? t
        : { ...t, deletedTasks, deletedAttachments },
    );
  }
  return { tickets, tombstones };
}

// ─── renumbering ──────────────────────────────────────────────────────────

/**
 * Deterministic DS-NNN renumbering (02-merge-spec §6). Where more than one
 * guid claims a number, the ticket with the oldest createdAt keeps it
 * (tiebreak: lexicographically smaller guid); losers, sorted by
 * (createdAt, guid), receive sequential numbers past the pre-assignment max.
 * Both machines assign identical numbers independently. Local consequences
 * (link re-projection, attachment dir rename, old-row removal) belong to the
 * controller, not this module.
 */
export function renumber(state: SyncState): {
  state: SyncState;
  renames: Array<{ guid: string; oldId: string; newId: string }>;
} {
  const byNumber = new Map<number, WireTicket[]>();
  let maxNumber = 0;
  for (const t of state.tickets.values()) {
    const group = byNumber.get(t.number);
    if (group) group.push(t);
    else byNumber.set(t.number, [t]);
    if (Number.isFinite(t.number) && t.number > maxNumber) maxNumber = t.number;
  }

  const losers: WireTicket[] = [];
  for (const group of byNumber.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.guid < b.guid ? -1 : 1;
    });
    losers.push(...sorted.slice(1));
  }
  if (losers.length === 0) return { state, renames: [] };

  losers.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.guid < b.guid ? -1 : 1;
  });

  const renames: Array<{ guid: string; oldId: string; newId: string }> = [];
  const tickets = new Map(state.tickets);
  let next = maxNumber;
  for (const t of losers) {
    next += 1;
    const newId = `DS-${String(next).padStart(3, "0")}`;
    renames.push({ guid: t.guid, oldId: t.id, newId });
    tickets.set(t.guid, { ...t, number: next, id: newId });
  }
  return { state: { tickets, tombstones: state.tombstones }, renames };
}
