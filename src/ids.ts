// Shared id minting. Deliberately free of `vscode` and of any node builtin so
// both bundles can import it: the extension host (CommonJS) and the webview
// (browser IIFE).

/**
 * Mint a task id.
 *
 * Task ids are opaque strings — nothing validates their shape, and they are
 * compared by equality only (including as the per-element LWW merge key in
 * `syncMerge`). This is the format the webview has always minted, so tickets
 * created in the UI already carry it; the MCP tools used to mint
 * `t-${randomUUID()}` instead (38 chars, echoed back on every read and every
 * progress call). Converging on the shorter format retires that cost without
 * touching any id already persisted — old ids keep resolving unchanged.
 */
export function newTaskId(): string {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
