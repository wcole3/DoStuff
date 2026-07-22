// Extension entry point — wires up the sidebar provider, board panel, commands, and storage.

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { deriveGuid } from "./syncMerge";
import { GitSyncController } from "./gitSync";
import { SidebarProvider } from "./sidebarProvider";
import { BoardPanel } from "./boardProvider";
import { GraphPanel } from "./graphProvider";
import { buildDefaultWorkflowPrompt } from "./workflowPrompt";
import type { DoStuffMcpServer } from "./mcpServer";
import {
  ACTIVE_LANE_CAP,
  MAX_ATTACHMENT_BYTES,
  canMoveToActiveLane,
  coerceAttachments,
  coerceLinks,
  coercePendingClose,
  coerceTags,
  isPriority,
  isStatus,
  isType,
  type Attachment,
  type Issue,
  type Status,
  type StatusEvent,
  type TicketLink,
} from "./types";


export type UpdateBy = "user" | "agent";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

/** Best-effort mimeType inference from a filename. Falls back to octet-stream. */
export function inferMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Pure merge of a webview-submitted partial update onto a persisted issue.
 *
 * Server-derived fields (`id`, `number`, `createdAt`, `record`, `statusHistory`,
 * `resolvedAt`, `pendingClose`, `guid`, `updatedAt`) are NEVER copied from
 * `incoming` — they are reconstructed from `prior` plus this function's own
 * bookkeeping (`updatedAt` and per-task `tasks[].updatedAt` are then re-stamped
 * by `IssueStore.upsert`, which discards any smuggled task stamps by diffing
 * against `prior`). The webview can lie about any of those and we'll ignore it.
 *
 * Returns `{next}` on success or `{error}` if validation fails.
 *
 * Decision: when status transitions out of "Complete" (e.g. user reopens an
 * already-done ticket), `resolvedAt` is cleared. This is intentional — humans
 * can correct mistakes; the MCP layer enforces a stricter contract for agents.
 */
/**
 * Drop links whose `targetId` isn't in `knownIds` (issues that don't exist) or
 * that equal `currentIssueId` (self-link). The caller is responsible for
 * coercing the array shape via `coerceLinks` first; this step is the
 * cross-issue validity check that needs store access.
 *
 * Returns `{ kept, dropped }` so the caller can decide whether to log; both
 * arrays preserve the original order.
 */
export function validateLinks(
  links: TicketLink[],
  currentIssueId: string,
  knownIds: ReadonlySet<string>,
): { kept: TicketLink[]; dropped: TicketLink[] } {
  const kept: TicketLink[] = [];
  const dropped: TicketLink[] = [];
  for (const l of links) {
    if (l.targetId === currentIssueId) {
      dropped.push(l);
      continue;
    }
    if (!knownIds.has(l.targetId)) {
      dropped.push(l);
      continue;
    }
    kept.push(l);
  }
  return { kept, dropped };
}

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
  const target: Status = prior.pendingClose.target ?? "Closed";
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
    if (typeof e.id !== "string" || !/^DS-\d+$/.test(e.id)) {
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
    const isIso = (v: unknown): v is string =>
      typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
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
      // Keep well-formed per-task `updatedAt` (round-trips exported stamps);
      // strip garbage values so nothing invalid enters the store.
      tasks: (Array.isArray(e.tasks) ? (e.tasks as Issue["tasks"]) : []).map((t) => {
        if (t && typeof t === "object" && "updatedAt" in t && !isIso(t.updatedAt)) {
          const { updatedAt: _bad, ...rest } = t;
          return rest;
        }
        return t;
      }),
      tags: coerceTags(e.tags),
      attachments: coerceAttachments(e.attachments),
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
      // Sync fields: keep well-formed provided values (export→import round
      // trip), derive per the normalize() rules when missing.
      guid: typeof e.guid === "string" && e.guid ? e.guid : deriveGuid(e.id, e.createdAt),
      updatedAt: isIso(e.updatedAt) ? e.updatedAt : e.createdAt,
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

export function activate(context: vscode.ExtensionContext) {
  const store = new IssueStore(context);
  // Hydrate the store in the background. The webview shows its "Loading…"
  // state until the first store.onChange fires; awaiting here would gate
  // every other activation step on disk I/O for ticket files.
  void store.init().catch((e) => {
    console.error("[DoStuff] store.init failed:", e);
  });

  /**
   * Host-side issue update handler. Single chokepoint for any path that
   * mutates an existing ticket from a webview message. Responsible for:
   *
   *   1. Reconstructing the persisted issue from a small allow-list of mutable
   *      fields (see {@link mergeIssueUpdate}). Server-derived fields like
   *      `statusHistory`, `resolvedAt`, `id`, `number`, `createdAt`, `record`,
   *      `pendingClose` are never trusted from the webview payload (an agent
   *      close request is set via MCP and cleared only by {@link resolveClose}).
   *   2. Enforcing the active-lane cap (Planned/Working/Verification ≤ 6).
   *   3. Note: the UI is allowed to move a ticket out of "Complete" (humans can
   *      correct mis-clicks). The MCP layer enforces a stricter contract.
   *
   * On rejection we re-broadcast the current truth so the optimistic webview
   * state reverts.
   */
  const applyIssueUpdate = async (incoming: Issue): Promise<void> => {
    const prior = store.get(incoming.id);
    if (!prior) {
      vscode.window.showWarningMessage(`DoStuff: No ticket with id ${incoming.id}.`);
      sidebar.broadcast();
      BoardPanel.broadcast(store.list());
      return;
    }

    // Pass knownIds so link targets that don't exist (or self-links) get
    // dropped at the merge chokepoint. The UI picker only offers real tickets,
    // but this guards the import/round-trip + any future programmatic caller.
    const knownIds = new Set(store.list().map((i) => i.id));
    const merged = mergeIssueUpdate(prior, incoming, "user", undefined, knownIds);
    if ("error" in merged) {
      vscode.window.showWarningMessage(`DoStuff: ${merged.error}`);
      sidebar.broadcast();
      BoardPanel.broadcast(store.list());
      GraphPanel.broadcast(store.list());
      return;
    }
    const next = merged.next;

    if (next.status !== prior.status) {
      const cap = vscode.workspace.getConfiguration("dostuff").get<number>("activeLaneCap", ACTIVE_LANE_CAP);
      const check = canMoveToActiveLane(store.list(), next.status, next.id, cap);
      if (check !== true) {
        vscode.window.showWarningMessage(`DoStuff: ${check}`);
        sidebar.broadcast();
        BoardPanel.broadcast(store.list());
        GraphPanel.broadcast(store.list());
        return;
      }
    }

    await store.upsert(next);
  };

  /**
   * Apply a human's verdict on an agent's pending close request. Approve moves
   * the ticket to `Closed` and clears the flag; deny clears the flag. Built
   * directly (not via `applyIssueUpdate`) because it appends a `record` entry,
   * which the merge chokepoint deliberately never accepts from a payload.
   * On a no-op (nothing pending — e.g. already resolved in another window) we
   * re-broadcast so any stale "awaiting close" banner in an open webview clears.
   */
  const resolveClose = async (id: string, verdict: "approve" | "deny"): Promise<void> => {
    const prior = store.get(id);
    const next = prior ? resolveCloseRequest(prior, verdict) : null;
    if (!next) {
      sidebar.broadcast();
      BoardPanel.broadcast(store.list());
      GraphPanel.broadcast(store.list());
      return;
    }
    await store.upsert(next);
  };

  /**
   * Append a new attachment to an issue. Single chokepoint for both the file-
   * picker (`pickAttachment`) and drag-drop (`addAttachmentBytes`) paths.
   *  - Rejects when no workspace folder is open (writes would have nowhere to land).
   *  - Enforces the 10 MB cap before touching disk.
   *  - Mints a fresh attachmentId via `crypto.randomUUID` so duplicate filenames
   *    coexist as distinct entries.
   *  - Writes bytes via the store, appends metadata, persists through `upsert`.
   */
  const appendAttachment = async (
    issueId: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    const prior = store.get(issueId);
    if (!prior) {
      vscode.window.showWarningMessage(`DoStuff: No ticket with id ${issueId}.`);
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage(
        "DoStuff: open a folder first — attachments need a workspace to live in.",
      );
      return;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      vscode.window.showWarningMessage(
        `DoStuff: "${name}" is larger than the 10 MB attachment cap.`,
      );
      return;
    }
    const attachmentId = randomUUID().replace(/-/g, "");
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    try {
      const written = await store.writeAttachment(issueId, attachmentId, ext, bytes);
      if (!written) {
        vscode.window.showWarningMessage("DoStuff: attachment write failed (no workspace).");
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`DoStuff: attachment write failed (${msg}).`);
      return;
    }
    const next: Issue = {
      ...prior,
      attachments: [
        ...prior.attachments,
        {
          id: attachmentId,
          name,
          mimeType: mimeType || "application/octet-stream",
          sizeBytes: bytes.byteLength,
          addedAt: new Date().toISOString(),
        } satisfies Attachment,
      ],
    };
    await store.upsert(next);
  };

  const attachmentHandlers = {
    onPick: async (issueId: string) => {
      // Avoid `defaultUri`: on Remote-WSL the workspace folder URI is a
      // `vscode-remote://wsl+…` URI; passing that to the dialog has been
      // observed to silently no-op on some VSCode versions because the
      // Windows-side renderer can't translate it to a native file-dialog
      // starting path. Letting VSCode pick the default location is safer.
      store.appendLog(`pickAttachment: opening showOpenDialog for ${issueId}`);
      let uris: vscode.Uri[] | undefined;
      try {
        uris = await vscode.window.showOpenDialog({
          title: "Attach files to ticket",
          openLabel: "Attach",
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        store.appendLog(`pickAttachment: showOpenDialog threw: ${msg}`);
        vscode.window.showErrorMessage(`DoStuff: file picker failed (${msg}).`);
        return;
      }
      store.appendLog(`pickAttachment: dialog returned ${uris?.length ?? 0} file(s)`);
      if (!uris?.length) return;
      for (const uri of uris) {
        let bytes: Uint8Array;
        try {
          bytes = await vscode.workspace.fs.readFile(uri);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`DoStuff: could not read ${uri.fsPath} (${msg}).`);
          continue;
        }
        const segments = uri.path.split("/");
        const name = segments[segments.length - 1] || "attachment";
        const mimeType = inferMimeType(name);
        await appendAttachment(issueId, name, mimeType, bytes);
      }
    },
    onAddBytes: async (issueId: string, name: string, mimeType: string, bytes: Uint8Array) => {
      await appendAttachment(issueId, name, mimeType, bytes);
    },
    /**
     * Drop fallback for Remote-WSL (and other environments) where the
     * webview's DataTransfer.files is empty but `text/uri-list` carries the
     * source URI. Parsing through `vscode.Uri.parse` + `workspace.fs.readFile`
     * lets VSCode transparently cross the remote/local boundary to fetch the
     * bytes.
     */
    onAddByUri: async (issueId: string, rawUri: string) => {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(rawUri, /* strict */ true);
      } catch {
        vscode.window.showErrorMessage(`DoStuff: dropped URI is malformed (${rawUri}).`);
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showWarningMessage(
          `DoStuff: couldn't read dropped file (${msg}). Try the + button to pick it through the file dialog instead.`,
        );
        return;
      }
      const segments = uri.path.split("/");
      const name = decodeURIComponent(segments[segments.length - 1] || "attachment");
      const mimeType = inferMimeType(name);
      await appendAttachment(issueId, name, mimeType, bytes);
    },
    onDelete: async (issueId: string, attachmentId: string) => {
      const prior = store.get(issueId);
      if (!prior) return;
      const next: Issue = {
        ...prior,
        attachments: prior.attachments.filter((a) => a.id !== attachmentId),
      };
      await store.upsert(next);
      await store.deleteAttachmentFile(issueId, attachmentId);
    },
    onOpen: async (issueId: string, attachmentId: string) => {
      const uri = await store.findAttachmentUri(issueId, attachmentId);
      if (!uri) {
        vscode.window.showWarningMessage("DoStuff: attachment file is missing.");
        return;
      }
      await vscode.commands.executeCommand("vscode.open", uri);
    },
    /**
     * Staging counterpart to `onPick`. The new-issue modal calls this *before*
     * a ticket exists — the host opens the file picker, reads bytes, and
     * returns them so the webview can hold them in the modal's local state
     * until submit. No disk writes happen here; `appendAttachment` runs later
     * once `createIssue` mints the real ticket id.
     */
    onPickForStaging: async (): Promise<
      Array<{ name: string; mimeType: string; bytes: Uint8Array }>
    > => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          "DoStuff: open a folder first — attachments need a workspace to live in.",
        );
        return [];
      }
      let uris: vscode.Uri[] | undefined;
      try {
        uris = await vscode.window.showOpenDialog({
          title: "Attach files to new ticket",
          openLabel: "Attach",
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`DoStuff: file picker failed (${msg}).`);
        return [];
      }
      if (!uris?.length) return [];
      const out: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = [];
      for (const uri of uris) {
        let bytes: Uint8Array;
        try {
          bytes = await vscode.workspace.fs.readFile(uri);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`DoStuff: could not read ${uri.fsPath} (${msg}).`);
          continue;
        }
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          vscode.window.showWarningMessage(
            `DoStuff: "${uri.fsPath}" is larger than the 10 MB attachment cap.`,
          );
          continue;
        }
        const segments = uri.path.split("/");
        const name = segments[segments.length - 1] || "attachment";
        out.push({ name, mimeType: inferMimeType(name), bytes });
      }
      return out;
    },
    /**
     * Staging counterpart to `onAddByUri`. Same Remote-WSL motivation: host
     * reads the dropped URI via `workspace.fs.readFile` so the modal can hold
     * the bytes locally until submit.
     */
    onStageByUri: async (
      rawUri: string,
    ): Promise<{ name: string; mimeType: string; bytes: Uint8Array } | null> => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          "DoStuff: open a folder first — attachments need a workspace to live in.",
        );
        return null;
      }
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(rawUri, /* strict */ true);
      } catch {
        vscode.window.showErrorMessage(`DoStuff: dropped URI is malformed (${rawUri}).`);
        return null;
      }
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showWarningMessage(
          `DoStuff: couldn't read dropped file (${msg}). Try the + button to pick it through the file dialog instead.`,
        );
        return null;
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        vscode.window.showWarningMessage(
          `DoStuff: dropped file is larger than the 10 MB attachment cap.`,
        );
        return null;
      }
      const segments = uri.path.split("/");
      const name = decodeURIComponent(segments[segments.length - 1] || "attachment");
      return { name, mimeType: inferMimeType(name), bytes };
    },
  };

  const externalDrag = {
    onStart: (issueId: string) => {
      // Open the board if the user starts a drag with no board panel
      // visible — without it there'd be nowhere for the lanes to light up.
      if (!BoardPanel.isOpen()) {
        BoardPanel.showOrCreate(context.extensionUri, store, applyIssueUpdate, openLink, attachmentHandlers);
      }
      BoardPanel.signalExternalDrag(issueId);
    },
  };

  /**
   * Open a description link. Web URLs route to the system browser via
   * `openExternal`. File-scoped URLs and workspace-relative paths open a
   * document in VSCode. Everything else is rejected to avoid exotic URI
   * schemes triggering side effects.
   */
  const openLink = async (url: string): Promise<void> => {
    const trimmed = url.trim();
    if (!trimmed) return;
    let parsed: vscode.Uri;
    try {
      // Workspace-relative shorthand like "./docs/x.md" or "/abs/file.md".
      if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/")) {
        const root = vscode.workspace.workspaceFolders?.[0];
        const base = root?.uri;
        const target = trimmed.startsWith("/")
          ? vscode.Uri.file(trimmed)
          : base
            ? vscode.Uri.joinPath(base, ...trimmed.split("/").filter(Boolean))
            : null;
        if (!target) {
          vscode.window.showWarningMessage(
            "DoStuff: cannot resolve relative link without an open workspace folder.",
          );
          return;
        }
        await vscode.commands.executeCommand("vscode.open", target);
        return;
      }
      parsed = vscode.Uri.parse(trimmed, true);
    } catch {
      vscode.window.showWarningMessage(`DoStuff: not a valid link: ${trimmed}`);
      return;
    }
    const scheme = parsed.scheme.toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      await vscode.env.openExternal(parsed);
      return;
    }
    if (scheme === "file" || scheme === "vscode") {
      await vscode.commands.executeCommand("vscode.open", parsed);
      return;
    }
    vscode.window.showWarningMessage(`DoStuff: link scheme "${scheme}" is not supported.`);
  };

  const sidebar = new SidebarProvider(context.extensionUri, store, applyIssueUpdate, externalDrag, openLink, attachmentHandlers);

  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("dostuff.openBoard", () => {
      BoardPanel.showOrCreate(context.extensionUri, store, applyIssueUpdate, openLink, attachmentHandlers);
    }),

    vscode.commands.registerCommand("dostuff.openGraph", () => {
      GraphPanel.showOrCreate(context.extensionUri, store, openLink);
    }),

    // Single broadcaster for "surface this ticket's detail". Invoked by a
    // link-chip click (sidebar/board IssueDetail) or a graph node click; fans
    // the request out to every open webview so whichever is focused responds.
    vscode.commands.registerCommand("dostuff.revealTicket", (id: unknown) => {
      if (typeof id !== "string" || !/^DS-\d+$/.test(id)) return;
      sidebar.revealTicket(id);
      BoardPanel.revealTicket(id);
    }),

    // Human verdict on an agent's pending close request. Forwarded from the
    // sidebar/board webview `resolveClose` message via executeCommand.
    vscode.commands.registerCommand("dostuff.resolveClose", (arg: unknown) => {
      if (!arg || typeof arg !== "object") return;
      const { id, verdict } = arg as { id?: unknown; verdict?: unknown };
      if (typeof id !== "string" || !/^DS-\d+$/.test(id)) return;
      if (verdict !== "approve" && verdict !== "deny") return;
      void resolveClose(id, verdict);
    }),

    vscode.commands.registerCommand("dostuff.newIssue", () => {
      vscode.commands.executeCommand("workbench.view.extension.dostuff");
      sidebar.showNewIssue();
    }),

    vscode.commands.registerCommand("dostuff.focusSearch", () => {
      sidebar.focusSearch();
    }),

    vscode.commands.registerCommand("dostuff.clearAll", async () => {
      // With sync on, replaceAll([]) records tombstones for every ticket and
      // the deletion propagates to every replica on next sync — say so.
      const syncOn = vscode.workspace
        .getConfiguration("dostuff")
        .get<boolean>("sync.enabled", false);
      const answer = await vscode.window.showWarningMessage(
        syncOn
          ? "Delete all issues? This cannot be undone. This will also delete these tickets for everyone syncing this repo."
          : "Delete all issues? This cannot be undone.",
        { modal: true },
        "Clear All",
      );
      if (answer !== "Clear All") return;
      await store.replaceAll([]);
      vscode.window.showInformationMessage("DoStuff: All issues cleared.");
    }),

    vscode.commands.registerCommand("dostuff.exportJson", async () => {
      const issues = store.list();
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        issues,
      };
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      const filename = `dostuff-issues-${new Date().toISOString().slice(0, 10)}.json`;
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        defaultUri: wsRoot
          ? wsRoot.with({ path: `${wsRoot.path}/${filename}` })
          : vscode.Uri.file(filename),
        saveLabel: "Export",
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(JSON.stringify(payload, null, 2))
      );
      vscode.window.showInformationMessage(`Exported ${issues.length} issues.`);
    }),

    vscode.commands.registerCommand("dostuff.importJson", async () => {
      const picks = await vscode.window.showOpenDialog({
        filters: { JSON: ["json"] },
        canSelectMany: false,
        openLabel: "Import",
      });
      if (!picks || !picks[0]) return;
      let parsed: unknown;
      try {
        const buf = await vscode.workspace.fs.readFile(picks[0]);
        parsed = JSON.parse(new TextDecoder().decode(buf));
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to parse JSON: ${(e as Error).message}`);
        return;
      }
      const raw: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as any)?.issues)
          ? (parsed as any).issues
          : [];
      if (!Array.isArray(raw) || raw.length === 0) {
        vscode.window.showErrorMessage("Expected a non-empty array or { issues: [...] }.");
        return;
      }
      const { valid, skipped } = validateImportList(raw);
      if (skipped > 0) {
        store.appendLog(`Import: skipped ${skipped} malformed entries.`);
      }
      if (valid.length === 0) {
        vscode.window.showErrorMessage(
          `Import: no valid issues found (skipped ${skipped}). Check schema.`,
        );
        return;
      }
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Merge by id", value: "merge" },
          { label: "Replace all (destructive)", value: "replace" },
        ],
        { placeHolder: `Import ${valid.length} issues — how?` }
      );
      if (!mode) return;

      // Compute the post-import set so we can lane-cap-check before persisting.
      const postSet: Issue[] = (() => {
        if (mode.value === "replace") return valid;
        const byId = new Map(store.list().map((i) => [i.id, i]));
        for (const i of valid) byId.set(i.id, i);
        return [...byId.values()];
      })();
      const importCap = vscode.workspace.getConfiguration("dostuff").get<number>("activeLaneCap", ACTIVE_LANE_CAP);
      const overflowing = activeLaneOverflow(postSet, importCap);
      if (overflowing.length > 0) {
        const summary = overflowing
          .map(({ lane, count }) => `${lane}: ${count}/${importCap}`)
          .join(", ");
        vscode.window.showErrorMessage(
          `Import refused — active-lane cap exceeded (${summary}). ` +
            `Clear or move tickets out of those lanes, or re-author the import file.`,
        );
        return;
      }

      if (mode.value === "replace") await store.replaceAll(valid);
      else await store.mergeAll(valid);
      vscode.window.showInformationMessage(
        `${mode.value === "replace" ? "Replaced with" : "Merged"} ${valid.length} issues${
          skipped ? ` (skipped ${skipped})` : ""
        }.`
      );
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("dostuff.storagePath")) {
        vscode.window.showInformationMessage(
          "DoStuff: storage path changed. Reloading from new location.",
        );
        await store.reload();
      }
    }),

    store,
  );

  // ─── MCP server ───────────────────────────────────────────────────────
  // Workspace identity feeds the user-global registry so external agents can
  // discover which ephemeral port serves which workspace. The override setting
  // lets the user pin an explicit path when the auto-pick is wrong.
  const workspaceId = () => {
    const override = vscode.workspace
      .getConfiguration("dostuff")
      .get<string>("mcp.workspaceOverride", "")
      .trim();
    if (override) return { path: override, name: path.basename(override) || override };
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    return { path: root.uri.fsPath, name: root.name };
  };
  // Lazy-construct the MCP server so the heavy SDK + zod module isn't
  // parsed during activate(). First call to reconcileMcp() awaits the
  // dynamic import; subsequent calls reuse the cached instance.
  let mcp: DoStuffMcpServer | null = null;
  let mcpLoadPromise: Promise<DoStuffMcpServer> | null = null;
  const ensureMcp = (): Promise<DoStuffMcpServer> => {
    if (mcp) return Promise.resolve(mcp);
    if (!mcpLoadPromise) {
      mcpLoadPromise = import("./mcpServer").then((m) => {
        const instance = new m.DoStuffMcpServer(store, workspaceId);
        mcp = instance;
        context.subscriptions.push(instance);
        return instance;
      });
    }
    return mcpLoadPromise;
  };

  // Status bar item — reflects MCP enabled/disabled state. Clicking toggles.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "dostuff.mcp.toggle";
  const refreshStatus = () => {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    const enabled = cfg.get<boolean>("mcp.enabled", true);
    const port = mcp?.status.port ?? null;
    if (!enabled) {
      statusItem.text = `$(circle-slash) DoStuff MCP`;
      statusItem.tooltip = `MCP server disabled. Click to enable.`;
    } else if (port) {
      statusItem.text = `$(plug) DoStuff MCP :${port}`;
      statusItem.tooltip = `MCP server listening on 127.0.0.1:${port}. Click to disable.`;
    } else {
      statusItem.text = `$(plug) DoStuff MCP`;
      statusItem.tooltip = `MCP server enabled but not listening (no workspace folder?). Click to disable.`;
    }
    statusItem.show();
  };
  refreshStatus();

  const reconcileMcp = async () => {
    const instance = await ensureMcp();
    await instance.reconcile();
    refreshStatus();
  };
  context.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dostuff.mcp")) void reconcileMcp();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reconcileMcp();
    }),
    vscode.commands.registerCommand("dostuff.mcp.toggle", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const enabled = cfg.get<boolean>("mcp.enabled", true);
      await cfg.update("mcp.enabled", !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`DoStuff MCP server ${!enabled ? "enabled" : "disabled"}.`);
    }),
    vscode.commands.registerCommand("dostuff.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "dostuff");
    }),
    vscode.commands.registerCommand("dostuff.mcp.editInstructions", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const current = cfg.get<string>("mcp.instructions", "");
      const cap = cfg.get<number>("activeLaneCap", ACTIVE_LANE_CAP);
      const liveDefault = buildDefaultWorkflowPrompt(cap);
      const next = await vscode.window.showInputBox({
        prompt: "Edit custom instructions. Clear all text to revert to the built-in default.",
        value: current || liveDefault,
        ignoreFocusOut: true,
      });
      if (next === undefined) return;
      const toSave = next.trim() === liveDefault.trim() ? "" : next;
      await cfg.update("mcp.instructions", toSave, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("dostuff.mcp.pinPort", async () => {
      const port = mcp?.status.port ?? null;
      if (!port) {
        vscode.window.showWarningMessage(
          "DoStuff MCP server is not running -- enable it before pinning.",
        );
        return;
      }
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          "DoStuff: open a folder first -- there is no workspace to pin the port to.",
        );
        return;
      }
      // Write at the Workspace scope so the value shows up in the Workspace
      // tab of the Settings UI (and lands in .vscode/settings.json for a
      // single-folder workspace, or the .code-workspace settings section for
      // a multi-root one).
      try {
        await vscode.workspace
          .getConfiguration("dostuff")
          .update("mcp.port", port, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(
          `DoStuff: pinned MCP port ${port} for this workspace.`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`DoStuff: could not pin port (${msg}).`);
      }
    }),
  );
  // Fire-and-forget so the extension is marked active before the MCP SDK
  // dynamic import + port bind + registry write resolve (~50–200 ms).
  void reconcileMcp();

  // ─── Git ticket sync ──────────────────────────────────────────────────
  // Mirrors the MCP block: a reconcile function reads config and starts or
  // stops the controller; hooked to config + workspace-folder changes. No
  // lazy import needed — gitSync has no heavy deps (04-controller-wiring §3).
  let sync: GitSyncController | null = null;

  const syncStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  syncStatusItem.command = "dostuff.sync.now";
  const refreshSyncStatus = (status?: import("./gitSync").SyncStatus) => {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    if (!cfg.get<boolean>("sync.enabled", false)) {
      syncStatusItem.hide();
      return;
    }
    const s = status ?? sync?.status ?? { state: "disabled" as const };
    const icon =
      s.state === "syncing"
        ? "$(sync~spin)"
        : s.state === "pendingPush" || s.state === "error"
          ? "$(warning)"
          : "$(sync)";
    syncStatusItem.text = `${icon} DoStuff Sync`;
    syncStatusItem.tooltip = [
      `DoStuff git sync: ${s.state}`,
      s.detail ?? "",
      s.lastSyncAt ? `Last sync: ${s.lastSyncAt}` : "",
      "Click to sync now.",
    ]
      .filter(Boolean)
      .join("\n");
    syncStatusItem.show();
  };

  const reconcileSync = () => {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    const enabled = cfg.get<boolean>("sync.enabled", false);
    // Always rebuild on reconcile — settings are few and cheap, and a fresh
    // controller picks up remote/ref/interval changes without diff logic.
    if (sync) {
      sync.dispose();
      sync = null;
    }
    if (!enabled) {
      refreshSyncStatus();
      return;
    }
    const controller = new GitSyncController(
      store,
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      {
        remote: cfg.get<string>("sync.remote", "origin"),
        ref: cfg.get<string>("sync.ref", "refs/dostuff/state"),
        intervalMinutes: cfg.get<number>("sync.intervalMinutes", 5),
        activeLaneCap: cfg.get<number>("activeLaneCap", ACTIVE_LANE_CAP),
        syncAttachments: cfg.get<boolean>("sync.syncAttachments", true),
        maxAttachmentSyncBytes: cfg.get<number>("sync.maxAttachmentSyncBytes", 5242880),
      },
    );
    sync = controller;
    context.subscriptions.push(controller.onStatusChange((s) => refreshSyncStatus(s)));
    controller.start();
    refreshSyncStatus();
  };

  context.subscriptions.push(
    syncStatusItem,
    { dispose: () => sync?.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dostuff.sync") || e.affectsConfiguration("dostuff.activeLaneCap")) {
        reconcileSync();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reconcileSync()),
    vscode.commands.registerCommand("dostuff.sync.now", async () => {
      if (!sync) {
        vscode.window.showWarningMessage(
          "DoStuff git sync is disabled — enable `dostuff.sync.enabled` first.",
        );
        return;
      }
      const result = await sync.syncNow("manual");
      const parts = [
        `${result.applied} applied`,
        result.pushed ? "pushed" : "nothing to push",
        ...(result.renames.length ? [`${result.renames.length} renumbered`] : []),
      ];
      vscode.window.showInformationMessage(`DoStuff sync: ${parts.join(", ")}.`);
    }),
    vscode.commands.registerCommand("dostuff.sync.toggle", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const enabled = cfg.get<boolean>("sync.enabled", false);
      await cfg.update("sync.enabled", !enabled, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(
        `DoStuff git ticket sync ${!enabled ? "enabled" : "disabled"} for this workspace.`,
      );
    }),
  );
  reconcileSync();
}

export function deactivate() {}

// Re-export the lane cap for tests / consumers that want the constant.
export { ACTIVE_LANE_CAP };
