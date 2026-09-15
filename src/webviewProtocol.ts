// Host-side glue shared by the sidebar, board and graph providers: how a
// store change becomes a webview message, and the settings snapshot each
// webview gets on init.

import * as vscode from "vscode";
import type { IssueStore } from "./storage";
import type { StoreChange } from "./storageCore";
import { toRow, type HostToWebview, type Settings } from "./types";

/**
 * A reset (init / import / sync merge) re-sends the whole board as rows;
 * anything else is a delta of just the rows that changed. On a 600-ticket
 * board the old full-list broadcast was a multi-MB structured clone to up
 * to three webviews per edit.
 */
export function changeToMessage(
  change: StoreChange,
): Extract<HostToWebview, { type: "issues" | "issuesDelta" }> {
  if (change.reset) return { type: "issues", issues: change.issues.map(toRow) };
  return { type: "issuesDelta", upserted: change.upserted.map(toRow), removed: change.removed };
}

export function readSettings(webview: vscode.Webview, store: IssueStore): Settings {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  const attachmentsDir = store.attachmentsDir();
  return {
    storagePath: cfg.get<string>("storagePath", ".vscode/dostuff"),
    autoSave: cfg.get<boolean>("autoSave", true),
    activeLaneCap: cfg.get<number>("activeLaneCap", 6),
    attachmentsBaseUri: attachmentsDir ? webview.asWebviewUri(attachmentsDir).toString() : null,
  };
}
