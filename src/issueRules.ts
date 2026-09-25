// Pure host-side rules for webview-originated ticket writes: the merge
// chokepoint, the close/complete verdict, new-ticket construction, and import
// validation. Split out of extension.ts / sidebarProvider.ts so they carry no
// `vscode` import — the VSCode host and the browser demo (demo/) both run
// them, which is what keeps the demo's lane-cap and approval rules identical
// to the extension's.

import { randomUUID } from "node:crypto";
import { backfillSyncFields, formatIssueId, isIsoTimestamp, isSafePathSegment } from "./syncMerge";
import {
  ACTIVE_LANE_CAP,
  DS_ID_RE,
  coerceAttachments,
  coerceCommits,
  coerceLinks,
  coercePendingClose,
  coerceTags,
  effectiveCloseTarget,
  canMoveToActiveLane,
  isLinkKind,
  isPriority,
  isStatus,
  isType,
  validateLinks,
  type Issue,
  type IssueRow,
  type LinkKind,
  type Status,
  type StatusEvent,
  type TicketLink,
  type WebviewToHost,
} from "./types";

export type UpdateBy = "user" | "agent";

/** The slice of a ticket store these rules write through. `IssueStore` and
 *  the demo's in-browser store both satisfy it structurally. */
export interface IssueWriter {
  get(id: string): Issue | undefined;
  upsert(issue: Issue): Promise<void>;
}

/** The `createIssue` message's `partial` payload (webview → host). */
export type CreateIssuePartial = Extract<WebviewToHost, { type: "createIssue" }>["partial"];

/**
 * Pure merge of a webview-submitted partial update onto a persisted issue.
 *
 * Server-derived fields (`id`, `number`, `createdAt`, `record`, `statusHistory`,
 * `resolvedAt`, `pendingClose`, `guid`, `updatedAt`, `commits`) are NEVER copied
 * from `incoming` — they are reconstructed from `prior` plus this function's own
 * bookkeeping (which, on a human status move into the terminal state a pending
 * agent request already asked for, clears `pendingClose` and appends one derived
 * `record` entry — see the auto-resolve block below) (`updatedAt` and per-task `tasks[].updatedAt` are then re-stamped
 * by `IssueStore.upsert`, which discards any smuggled task stamps by diffing
 * against `prior`). The webview can lie about any of those and we'll ignore it.
 *
 * Returns `{next}` on success or `{error}` if validation fails.
 *
 * Decision: when status transitions out of "Complete" (e.g. user reopens an
 * already-done ticket), `resolvedAt` is cleared. This is intentional — humans
 * can correct mistakes; the MCP layer enforces a stricter contract for agents.
 */
export function mergeIssueUpdate(
  prior: Issue,
  incoming: Partial<Issue>,
  by: UpdateBy,
  now: () => string = () => new Date().toISOString(),
  knownIds?: ReadonlySet<string>,
): { next: Issue } | { error: string } {
  if (incoming.status !== undefined && !isStatus(incoming.status)) {
    return { error: `Invalid status: ${JSON.stringify(incoming.status)}` };
  }
  if (incoming.priority !== undefined && !isPriority(incoming.priority)) {
    return { error: `Invalid priority: ${JSON.stringify(incoming.priority)}` };
  }
  if (incoming.type !== undefined && !isType(incoming.type)) {
    return { error: `Invalid type: ${JSON.stringify(incoming.type)}` };
  }

  // Attachments are reconciled against `prior` so the webview can only ever
  // reorder or remove existing entries — never introduce new attachment
  // metadata. The host-side upload helper appends new entries directly to
  // the persisted issue *after* this merge runs.
  let attachments = prior.attachments;
  if (Array.isArray(incoming.attachments)) {
    const priorById = new Map(prior.attachments.map((a) => [a.id, a]));
    const seen = new Set<string>();
    const next: typeof prior.attachments = [];
    for (const entry of incoming.attachments) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const known = priorById.get(id);
      if (!known) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(known);
    }
    attachments = next;
  }

  // Links: coerce shape first, then drop unknown-id targets + self-links if a
  // knownIds set was supplied. When no knownIds is passed (e.g. unit tests),
  // we skip the cross-issue validation and trust coerceLinks' format check.
  let links = prior.links;
  if (Array.isArray(incoming.links)) {
    const coerced = coerceLinks(incoming.links, prior.id);
    if (knownIds) {
      const { kept } = validateLinks(coerced, prior.id, knownIds);
      links = kept;
    } else {
      links = coerced;
    }
  }

  const next: Issue = {
    ...prior,
    title:          typeof incoming.title === "string" ? incoming.title : prior.title,
    description:    typeof incoming.description === "string" ? incoming.description : prior.description,
    verifyCriteria: typeof incoming.verifyCriteria === "string" ? incoming.verifyCriteria : prior.verifyCriteria,
    tasks:          Array.isArray(incoming.tasks) ? incoming.tasks : prior.tasks,
    tags:           Array.isArray(incoming.tags) ? coerceTags(incoming.tags) : prior.tags,
    attachments,
    links,
    type:           incoming.type ?? prior.type,
    priority:       incoming.priority ?? prior.priority,
    status:         incoming.status ?? prior.status,
  };

  if (next.status !== prior.status) {
    const ts = now();
    const event: StatusEvent = { status: next.status, at: ts, by };
    next.statusHistory = [...prior.statusHistory, event];
    if (next.status === "Complete") {
      next.resolvedAt = ts;
    } else if (prior.status === "Complete") {
      next.resolvedAt = null;
    }

    // A human move into the terminal state an agent already asked for IS the
    // verdict — consume the pending request here instead of leaving it dangling
    // in the "Awaiting decision" filter for the user to resolve later. Mismatched
    // targets (moved to Complete while a Closed/OBE request is pending, or vice
    // versa) are deliberately left alone: the two flows mean different things, so
    // that verdict stays explicit. `effectiveCloseTarget` is the single home for
    // the "absent target means Closed" rule.
    if (
      by === "user" &&
      prior.pendingClose &&
      (next.status === "Complete" || next.status === "Closed") &&
      effectiveCloseTarget(prior.pendingClose) === next.status
    ) {
      const label = next.status === "Complete" ? "Completion" : "Close";
      next.pendingClose = null;
      // Wording is deliberately distinct from `resolveCloseRequest`'s so the
      // record shows which route resolved the request.
      next.record = [
        ...prior.record,
        { at: ts, author: "user", text: `${label} request approved by move to ${next.status}` },
      ];
    }
  }

  return { next };
}

/**
 * Core of the host's webview `updateIssue` handler: merge the row onto the
 * stored ticket via {@link mergeIssueUpdate} (link targets validated against
 * `issues`), then enforce the active-lane cap when the status changed. Returns
 * the ticket to upsert, or the user-facing reason the update was rejected —
 * the caller surfaces it and re-broadcasts so optimistic webview state reverts.
 */
export function planIssueUpdate(
  issues: readonly Issue[],
  incoming: IssueRow,
  cap: number,
  now?: () => string,
): { next: Issue } | { error: string } {
  const prior = issues.find((i) => i.id === incoming.id);
  if (!prior) return { error: `No ticket with id ${incoming.id}.` };
  // Pass knownIds so link targets that don't exist (or self-links) get
  // dropped at the merge chokepoint. The UI picker only offers real tickets,
  // but this guards the import/round-trip + any future programmatic caller.
  const knownIds = new Set(issues.map((i) => i.id));
  const merged = mergeIssueUpdate(prior, incoming, "user", now, knownIds);
  if ("error" in merged) return merged;
  const next = merged.next;
  if (next.status !== prior.status) {
    const check = canMoveToActiveLane(issues, next.status, next.id, cap);
    if (check !== true) return { error: check };
  }
  return { next };
}

/**
 * Pure core of the host `resolveClose` handler (exported for tests). Given a
 * ticket with a pending agent request, returns the next Issue for the human's
 * verdict — approve moves it to the request's `target` (`"Closed"` when
 * absent — the legacy OBE flow; `"Complete"` for the acceptance flow) and
 * clears the flag; deny clears the flag and leaves status unchanged. Returns
 * `null` when there is nothing pending to resolve.
 *
 * `record`/`statusHistory` are appended here (author "user"), which is exactly
 * why this can't route through {@link mergeIssueUpdate} — those fields are
 * server-derived and never taken from an incoming payload. `resolvedAt` is
 * stamped only on the Complete path: it tracks acceptance, and Closed is
 * "won't do".
 */
export function resolveCloseRequest(
  prior: Issue,
  verdict: "approve" | "deny",
  now: () => string = () => new Date().toISOString(),
): Issue | null {
  if (!prior.pendingClose) return null;
  const ts = now();
  const target: Status = effectiveCloseTarget(prior.pendingClose);
  const label = target === "Complete" ? "Completion" : "Close";
  if (verdict === "approve") {
    return {
      ...prior,
      status: target,
      ...(target === "Complete" ? { resolvedAt: ts } : {}),
      pendingClose: null,
      statusHistory: [...prior.statusHistory, { status: target, at: ts, by: "user" }],
      record: [...prior.record, { at: ts, author: "user", text: `${label} request approved` }],
    };
  }
  return {
    ...prior,
    pendingClose: null,
    record: [...prior.record, { at: ts, author: "user", text: `${label} request denied` }],
  };
}

/** Required-field shape check on an imported issue. Coerces missing enum values to defaults. */
export function validateImportList(raw: unknown[]): { valid: Issue[]; skipped: number } {
  const valid: Issue[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      skipped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !DS_ID_RE.test(e.id)) {
      skipped += 1;
      continue;
    }
    if (typeof e.title !== "string" || e.title.length === 0) {
      skipped += 1;
      continue;
    }
    if (typeof e.createdAt !== "string") {
      skipped += 1;
      continue;
    }
    const status: Status = isStatus(e.status) ? e.status : "Thinking";
    const issue: Issue = {
      id: e.id,
      number: Number.isFinite(e.number)
        ? (e.number as number)
        : parseInt(e.id.replace(/^DS-/, ""), 10),
      title: e.title,
      type: isType(e.type) ? e.type : "Chore",
      priority: isPriority(e.priority) ? e.priority : "Regular",
      status,
      description: typeof e.description === "string" ? e.description : "",
      verifyCriteria: typeof e.verifyCriteria === "string" ? e.verifyCriteria : "",
      // Task ids become sync identities (and were historically written into
      // wire trees), so entries without a safe-segment string id are dropped;
      // keep well-formed per-task `updatedAt` (round-trips exported stamps),
      // strip garbage values so nothing invalid enters the store.
      tasks: (Array.isArray(e.tasks) ? (e.tasks as Issue["tasks"]) : [])
        .filter(
          (t) =>
            t &&
            typeof t === "object" &&
            typeof t.id === "string" &&
            isSafePathSegment(t.id) &&
            typeof t.text === "string",
        )
        .map((t) => {
          if ("updatedAt" in t && !isIsoTimestamp(t.updatedAt)) {
            const { updatedAt: _bad, ...rest } = t;
            return rest;
          }
          return t;
        }),
      tags: coerceTags(e.tags),
      // Attachment ids name files on disk and blobs in the sync tree — same
      // safe-segment bar as the sync wire coercer.
      attachments: coerceAttachments(e.attachments).filter((a) => isSafePathSegment(a.id)),
      // Cross-issue validation happens in the caller (after the full set is
      // assembled) so we can drop links whose targets aren't in the import.
      links: coerceLinks(e.links, e.id),
      createdAt: e.createdAt,
      resolvedAt: typeof e.resolvedAt === "string" ? e.resolvedAt : null,
      statusHistory: Array.isArray(e.statusHistory)
        ? (e.statusHistory as Issue["statusHistory"])
        : [{ status, at: e.createdAt, by: "user" }],
      record: Array.isArray(e.record) ? (e.record as Issue["record"]) : [],
      pendingClose: coercePendingClose(e.pendingClose),
      // Round-trips exported commit anchors; garbage entries are dropped.
      commits: coerceCommits(e.commits),
      // Sync fields: keep well-formed provided values (export→import round
      // trip), derive per the normalize() rules when missing. requireSafeGuid:
      // guids name attachment dirs in the sync ref tree, and outbound state
      // is never re-coerced.
      ...backfillSyncFields(e.id, e.createdAt, e.guid, e.updatedAt, { requireSafeGuid: true }),
    };
    valid.push(issue);
  }
  // Drop links to ids that didn't make it into the import set; we don't want
  // dangling references after replaceAll.
  const knownIds = new Set(valid.map((i) => i.id));
  for (const issue of valid) {
    if (issue.links.length === 0) continue;
    const { kept } = validateLinks(issue.links, issue.id, knownIds);
    issue.links = kept;
  }
  return { valid, skipped };
}

/** Lanes that exceed `cap` in the given set. Empty if all within cap. */
export function activeLaneOverflow(set: Issue[], cap = ACTIVE_LANE_CAP): Array<{ lane: Status; count: number }> {
  const out: Array<{ lane: Status; count: number }> = [];
  for (const lane of ["Planned", "Working", "Verification"] as const) {
    const count = set.filter((i) => i.status === lane).length;
    if (count > cap) out.push({ lane, count });
  }
  return out;
}

/**
 * Build the `Issue` for a new ticket from the webview's `createIssue` partial.
 * New tickets always land in `Thinking` (humans or agents may promote them
 * out later). Tags are coerced; inline forward links are coerced + validated
 * against `knownIds` (unknown targets and self-links are dropped and returned
 * in `droppedLinks` so the caller can log). Pure — no store access.
 */
export function buildCreatedIssue(
  partial: CreateIssuePartial,
  opts: { number: number; now: string; knownIds: ReadonlySet<string> },
): { issue: Issue; droppedLinks: TicketLink[] } {
  const id = formatIssueId(opts.number);
  const status: Issue["status"] = "Thinking";
  const { kept, dropped } = validateLinks(
    coerceLinks((partial as { links?: unknown }).links, id),
    id,
    opts.knownIds,
  );
  const issue: Issue = {
    id,
    number: opts.number,
    title: partial.title,
    type: partial.type,
    priority: partial.priority,
    status,
    description: typeof partial.description === "string" ? partial.description : "",
    verifyCriteria: typeof partial.verifyCriteria === "string" ? partial.verifyCriteria : "",
    tasks: (Array.isArray(partial.tasks) ? partial.tasks : []).map((t) => ({
      ...t,
      updatedAt: opts.now,
    })),
    tags: coerceTags((partial as { tags?: unknown }).tags),
    attachments: [],
    links: kept,
    createdAt: opts.now,
    resolvedAt: null,
    pendingClose: null,
    statusHistory: [{ status, at: opts.now, by: "user" }],
    record: [],
    guid: randomUUID(),
    updatedAt: opts.now,
    commits: [],
  };
  return { issue, droppedLinks: dropped };
}

/**
 * Apply inverse links staged in the modal ("new ticket blocked by X"). Each is
 * stored single-source as a forward link on the source ticket X, pointing at
 * the just-minted ticket. Skips entries with a bad/unknown/self source or bad
 * kind; existing identical links are a no-op (deduped). Returns what was
 * applied + the count skipped.
 */
export async function applyInboundLinks(
  store: IssueWriter,
  newIssueId: string,
  raw: unknown,
): Promise<{ applied: Array<{ sourceId: string; kind: LinkKind }>; skipped: number }> {
  const applied: Array<{ sourceId: string; kind: LinkKind }> = [];
  let skipped = 0;
  if (Array.isArray(raw)) {
    for (const inbound of raw) {
      const sourceId = (inbound as { sourceId?: unknown })?.sourceId;
      const kind = (inbound as { kind?: unknown })?.kind;
      if (typeof sourceId !== "string" || !DS_ID_RE.test(sourceId) || sourceId === newIssueId) {
        skipped += 1;
        continue;
      }
      if (!isLinkKind(kind)) {
        skipped += 1;
        continue;
      }
      const source = store.get(sourceId);
      if (!source) {
        skipped += 1;
        continue;
      }
      if (source.links.some((l) => l.targetId === newIssueId && l.kind === kind)) continue;
      await store.upsert({
        ...source,
        links: [...source.links, { targetId: newIssueId, kind }],
      });
      applied.push({ sourceId, kind });
    }
  }
  return { applied, skipped };
}
