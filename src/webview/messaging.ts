import { useSyncExternalStore } from "react";
import type { HostToWebview, Issue, Settings, WebviewToHost } from "../types";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __DOSTUFF_MODE__?: "sidebar" | "board";
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
  issues: Issue[];
  settings: Settings | null;
  initialized: boolean;
  externalDragIssueId: string | null;
}

const listeners = new Set<() => void>();
let state: StoreState = {
  issues: [],
  settings: null,
  initialized: false,
  externalDragIssueId: null,
};

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
        setState({ issues: msg.issues, settings: msg.settings, initialized: true });
        break;
      case "issues":
        setState({ issues: msg.issues });
        break;
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
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        console.warn("[dostuff] Unknown host message:", msg);
      }
    }
  });
  vscodeApi.postMessage({ type: "ready" });
}

export function useIssues(): { issues: Issue[]; settings: Settings | null; initialized: boolean } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

export function postUpdateIssue(issue: Issue): void {
  vscodeApi.postMessage({ type: "updateIssue", issue });
}

export function postDeleteIssue(id: string): void {
  vscodeApi.postMessage({ type: "deleteIssue", id });
}

export function postCreateIssue(
  partial: Extract<WebviewToHost, { type: "createIssue" }>["partial"],
): void {
  vscodeApi.postMessage({ type: "createIssue", partial });
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

export function newTaskId(): string {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
