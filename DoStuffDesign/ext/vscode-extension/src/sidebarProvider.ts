// Sidebar provider — the WebviewView shown in the activity bar.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import type { Issue, WebviewToHost } from "./types";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dostuff.sidebar";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: IssueStore
  ) {
    store.onChange((issues) => this.broadcast(issues));
  }

  // ─── WebviewViewProvider ────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    webviewView.webview.html = getWebviewHtml({
      webview: webviewView.webview,
      extensionUri: this.extensionUri,
      mode: "sidebar",
    });

    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.handleMessage(msg)
    );
  }

  // ─── Commands routed through the sidebar ────────────────────────────────

  focusSearch() {
    this.view?.show?.(true);
    this.view?.webview.postMessage({ type: "focusSearch" });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private broadcast(issues: Issue[]) {
    this.view?.webview.postMessage({ type: "issues", issues });
  }

  private async handleMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.view?.webview.postMessage({
          type: "init",
          issues: this.store.list(),
          settings: vscode.workspace.getConfiguration("dostuff") as any,
        });
        break;
      case "createIssue": {
        const now = new Date().toISOString();
        const issue: Issue = {
          id: this.store.nextId(),
          title: msg.partial.title,
          type: msg.partial.type,
          priority: msg.partial.priority,
          status: msg.partial.status,
          description: msg.partial.description ?? "",
          verifyCriteria: msg.partial.verifyCriteria ?? "",
          tasks: msg.partial.tasks ?? [],
          createdAt: now,
          resolvedAt: msg.partial.status === "Complete" ? now : null,
          statusHistory: [{ status: msg.partial.status, at: now }],
        };
        await this.store.upsert(issue);
        break;
      }
      case "updateIssue":
        await this.store.upsert(msg.issue);
        break;
      case "deleteIssue":
        await this.store.remove(msg.id);
        break;
      case "openBoard":
        vscode.commands.executeCommand("dostuff.openBoard");
        break;
      case "importJson":
        vscode.commands.executeCommand("dostuff.importJson");
        break;
      case "exportJson":
        vscode.commands.executeCommand("dostuff.exportJson");
        break;
      case "openSettings":
        vscode.commands.executeCommand("workbench.action.openSettings", "dostuff");
        break;
    }
  }
}
