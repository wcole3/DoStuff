import { useEffect, useSyncExternalStore } from "react";
import type { HostToWebview, Issue, IssueRow, Settings, WebviewToHost } from "../types";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __DOSTUFF_MODE__?: "sidebar" | "board" | "graph";
    __VSCODE_API__?: VsCodeApi;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let cachedApi: VsCodeApi | null = null;

function resolveApi(): VsCodeApi {
  if (cachedApi) return cachedApi;
  if (window.__VSCODE_API__) {
    cachedApi = window.__VSCODE_API__;
    return cachedApi;
  }
  if (typeof window.acquireVsCodeApi === "function") {
    cachedApi = window.acquireVsCodeApi();
    window.__VSCODE_API__ = cachedApi;
    return cachedApi;
  }
  throw new Error("VSCode webview API not available");
}

export const vscodeApi: VsCodeApi = {
  postMessage: (msg) => resolveApi().postMessage(msg),
  getState: () => resolveApi().getState(),
  setState: (s) => resolveApi().setState(s),
};

/** Subscribe to any HostToWebview message; returns unsubscribe. */
export function onHostMessage(handler: (msg: HostToWebview) => void): () => void {
  const wrapped = (e: MessageEvent) => handler(e.data as HostToWebview);
  window.addEventListener("message", wrapped);
  return () => window.removeEventListener("message", wrapped);
}

// ─── Singleton store ──────────────────────────────────────────────────
// All issue/settings reads in the UI go through here. The host owns truth;
// the webview just re-renders when host pushes `{type:"init"}` or `{type:"issues"}`.

interface StoreState {
  /** List rows — the heavy per-ticket fields live in `details`. */
  issues: IssueRow[];
  /** Full bodies fetched on demand, keyed by id. */
  details: Record<string, Issue>;
  /** Ids whose cached detail predates a delta — kept visible, refetched. */
  staleDetails: ReadonlySet<string>;
  settings: Settings | null;
  initialized: boolean;
  externalDragIssueId: string | null;
}

const listeners = new Set<() => void>();
let state: StoreState = {
  issues: [],
  details: {},
  staleDetails: new Set(),
  settings: null,
  initialized: false,
  externalDragIssueId: null,
};
/** Detail fetches posted and not yet answered (dedupes re-renders). */
const detailInFlight = new Set<string>();

function applyDelta(upserted: IssueRow[], removed: string[]): void {
  const byId = new Map(upserted.map((r) => [r.id, r] as const));
  const gone = new Set(removed);
  const next: IssueRow[] = [];
  for (const row of state.issues) {
    if (gone.has(row.id)) continue;
    const fresh = byId.get(row.id);
    if (fresh) {
      next.push(fresh);
      byId.delete(row.id);
    } else {
      next.push(row); // untouched rows keep their identity
    }
  }
  for (const row of byId.values()) next.unshift(row);
  const details = { ...state.details };
  const stale = new Set(state.staleDetails);
  for (const id of gone) {
    delete details[id];
    stale.delete(id);
  }
  for (const r of upserted) if (details[r.id]) stale.add(r.id);
  setState({ issues: next, details, staleDetails: stale });
}

function setState(next: Partial<StoreState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function getSnapshot(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let bridgeStarted = false;

/** Mount the message bridge — must be called once at boot. */
export function startMessageBridge(): void {
  if (bridgeStarted) return;
  bridgeStarted = true;
  onHostMessage((msg) => {
    switch (msg.type) {
      case "init":
        detailInFlight.clear();
        setState({
          issues: msg.issues,
          details: {},
          staleDetails: new Set(),
          settings: msg.settings,
          initialized: true,
        });
        break;
      case "issues":
        // Wholesale reset: every cached body may be out of date.
        setState({
          issues: msg.issues,
          staleDetails: new Set(Object.keys(state.details)),
        });
        break;
      case "issuesDelta":
        applyDelta(msg.upserted, msg.removed);
        break;
      case "issueDetail": {
        detailInFlight.delete(msg.issue.id);
        const stale = new Set(state.staleDetails);
        stale.delete(msg.issue.id);
        setState({ details: { ...state.details, [msg.issue.id]: msg.issue }, staleDetails: stale });
        break;
      }
      case "settings":
        setState({ settings: msg.settings });
        break;
      case "focusSearch": {
        const el = document.querySelector<HTMLInputElement>('input[data-search="dostuff"]');
        if (el) {
          el.focus();
          el.select();
        }
        break;
      }
      case "showNewIssue":
        window.dispatchEvent(new CustomEvent("dostuff:showNewIssue"));
        break;
      case "externalDragStart":
        setState({ externalDragIssueId: msg.issueId });
        break;
      case "attachmentStaged":
        // The new-issue modal listens for this CustomEvent and appends the
        // bytes to its local staging state. Routed through a window event
        // (rather than the React store) because the modal is short-lived and
        // owns the bytes — no other component should see them.
        window.dispatchEvent(
          new CustomEvent("dostuff:attachmentStaged", {
            detail: { name: msg.name, mimeType: msg.mimeType, bytes: msg.bytes },
          }),
        );
        break;
      case "revealTicket":
        // Routed through a window event for the same reason as attachmentStaged:
        // the consumers (Sidebar IssueDetail overlay, Board) own the UX of
        // surfacing the ticket, but the message bridge has no React refs.
        window.dispatchEvent(
          new CustomEvent("dostuff:revealTicket", { detail: { id: msg.id } }),
        );
        break;
      case "commitDetails":
        // Consumed by the CommitsSection of whichever IssueDetail requested
        // it; window event (not the store) because the payload is per-detail
        // ephemeral display data, not shared truth.
        window.dispatchEvent(
          new CustomEvent("dostuff:commitDetails", {
            detail: { issueId: msg.issueId, pathPrefix: msg.pathPrefix, details: msg.details },
          }),
        );
        break;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        console.warn("[dostuff] Unknown host message:", msg);
      }
    }
  });
  vscodeApi.postMessage({ type: "ready" });
}

export function useIssues(): { issues: IssueRow[]; settings: Settings | null; initialized: boolean } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function isFullIssue(row: IssueRow | Issue): row is Issue {
  return "record" in row;
}

export function postFetchIssueDetail(id: string): void {
  vscodeApi.postMessage({ type: "fetchIssueDetail", id });
}

/**
 * The full ticket for a row. A row that already carries the heavy fields
 * (tests seed full issues) is loaded as-is; otherwise the cached detail is
 * used and a `fetchIssueDetail` is posted when nothing is cached or the
 * cache predates a delta. While loading, the heavy fields are empty.
 */
export function useIssueDetail(row: IssueRow): { issue: Issue; loaded: boolean } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cached = snap.details[row.id];
  const full = isFullIssue(row);
  const stale = snap.staleDetails.has(row.id);
  const needsFetch = !full && (!cached || stale);
  useEffect(() => {
    if (!needsFetch || detailInFlight.has(row.id)) return;
    detailInFlight.add(row.id);
    postFetchIssueDetail(row.id);
  }, [needsFetch, row.id]);
  if (full) return { issue: row, loaded: true };
  if (cached) {
    // The row is the fresher list-level truth; the body may be stale.
    return { issue: { ...cached, ...row }, loaded: true };
  }
  return { issue: { ...row, record: [], statusHistory: [], commits: [] }, loaded: false };
}

/**
 * Read-only access to the cross-webview drag state. When non-null, the user
 * has started dragging this issue from the sidebar; the board lights up lanes
 * as click targets to complete the move.
 */
export function useExternalDragIssueId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => state.externalDragIssueId,
    () => state.externalDragIssueId,
  );
}

export function postUpdateIssue(issue: IssueRow): void {
  vscodeApi.postMessage({ type: "updateIssue", issue });
}

/**
 * Optimistic local status move: re-render the card in its target lane
 * immediately instead of waiting for the host's `issues` echo. The host still
 * owns truth — its next broadcast (the accepted update, or the unchanged
 * state after a rejection) replaces this wholesale, so a rejected move snaps
 * back exactly as before. Only `status` is touched; statusHistory and
 * updatedAt arrive with the echo.
 */
export function applyOptimisticStatus(id: string, status: Issue["status"]): void {
  setState({
    issues: state.issues.map((i) => (i.id === id ? { ...i, status } : i)),
  });
}

export function postDeleteIssue(id: string): void {
  vscodeApi.postMessage({ type: "deleteIssue", id });
}

export function postCreateIssue(
  partial: Extract<WebviewToHost, { type: "createIssue" }>["partial"],
): void {
  vscodeApi.postMessage({ type: "createIssue", partial });
}

export function postPickAttachmentForStaging(): void {
  vscodeApi.postMessage({ type: "pickAttachmentForStaging" });
}

export function postRevealTicket(id: string): void {
  vscodeApi.postMessage({ type: "revealTicket", id });
}

export function postOpenGraph(): void {
  vscodeApi.postMessage({ type: "openGraph" });
}

export function postResolveClose(id: string, verdict: "approve" | "deny"): void {
  vscodeApi.postMessage({ type: "resolveClose", id, verdict });
}

export function postStageAttachmentByUri(uri: string): void {
  vscodeApi.postMessage({ type: "stageAttachmentByUri", uri });
}

export function postOpenBoard(): void {
  vscodeApi.postMessage({ type: "openBoard" });
}

export function postImportJson(): void {
  vscodeApi.postMessage({ type: "importJson" });
}

export function postExportJson(): void {
  vscodeApi.postMessage({ type: "exportJson" });
}

export function postOpenSettings(): void {
  vscodeApi.postMessage({ type: "openSettings" });
}

export function postPickAttachment(issueId: string): void {
  vscodeApi.postMessage({ type: "pickAttachment", issueId });
}

export function postAddAttachmentBytes(
  issueId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): void {
  vscodeApi.postMessage({
    type: "addAttachmentBytes",
    issueId,
    name,
    mimeType,
    // JSON-serialise via a plain number[]; the host re-wraps as Uint8Array.
    bytes: Array.from(bytes),
  });
}

export function postAddAttachmentByUri(issueId: string, uri: string): void {
  vscodeApi.postMessage({ type: "addAttachmentByUri", issueId, uri });
}

export function postDeleteAttachment(issueId: string, attachmentId: string): void {
  vscodeApi.postMessage({ type: "deleteAttachment", issueId, attachmentId });
}

export function postOpenAttachment(issueId: string, attachmentId: string): void {
  vscodeApi.postMessage({ type: "openAttachment", issueId, attachmentId });
}

export function postExternalDragStart(issueId: string): void {
  vscodeApi.postMessage({ type: "externalDragStart", issueId });
}

export function postOpenLink(url: string): void {
  vscodeApi.postMessage({ type: "openLink", url });
}

export function postFetchCommitDetails(issueId: string): void {
  vscodeApi.postMessage({ type: "fetchCommitDetails", issueId });
}

/**
 * Clear the local "external drag in progress" state without a host
 * round-trip. Used by the board after committing a move so the lane pick
 * overlays disappear immediately — the sidebar's native dragend may not
 * fire reliably when the drag crosses webview boundaries.
 */
export function clearExternalDragLocal(): void {
  if (state.externalDragIssueId !== null) {
    setState({ externalDragIssueId: null });
  }
}

// Re-exported so existing webview imports keep working; the implementation now
// lives in `src/ids.ts` so the MCP tools mint the same format.
export { newTaskId } from "../ids";
