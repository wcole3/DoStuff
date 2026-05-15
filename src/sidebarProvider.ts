// Sidebar provider — the WebviewView shown in the activity bar.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import { isPriority, isType, type Issue, type Settings, type WebviewToHost } from "./types";

/**
 * Host-supplied handler for "updateIssue" messages. Owns the statusHistory
 * append, resolvedAt management, and lane-cap rejection (see extension.ts).
 * On rejection, the provider re-broadcasts the current truth so the webview
 * reverts whatever optimistic UI state it had applied.
 */
export type ApplyIssueUpdate = (issue: Issue) => Promise<void>;

const ID_RE = /^DS-\d+$/;

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  return {
    storagePath: cfg.get<string>("storagePath", ".vscode/dostuff"),
    autoSave:    cfg.get<boolean>("autoSave", true),
  };
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "dostuff.sidebar";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly applyUpdate: ApplyIssueUpdate,
  ) {
    this.output = vscode.window.createOutputChannel("DoStuff Webview");
    this.disposables.push(this.output);
    this.disposables.push(store.onChange((issues) => this.broadcast(issues)));
  }

  dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
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

  /** Publish a fresh issue list to the webview. */
  broadcast(issues: Issue[] = this.store.list()) {
    this.view?.webview.postMessage({ type: "issues", issues });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async handleMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.view?.webview.postMessage({
          type: "init",
          issues: this.store.list(),
          settings: readSettings(),
        });
        break;
      case "createIssue": {
        const partial = msg.partial;
        if (typeof partial?.title !== "string" || partial.title.length === 0) {
          this.output.appendLine(`Rejected createIssue: bad title`);
          break;
        }
        if (!isType(partial.type) || !isPriority(partial.priority)) {
          this.output.appendLine(`Rejected createIssue: bad type/priority`);
          break;
        }
        const now = new Date().toISOString();
        const number = this.store.nextNumber();
        // New tickets always land in Thinking — humans are the only ones
        // allowed to promote Thinking → Planned (see extension.ts).
        const status: Issue["status"] = "Thinking";
        const issue: Issue = {
          id: `DS-${String(number).padStart(3, "0")}`,
          number,
          title: partial.title,
          type: partial.type,
          priority: partial.priority,
          status,
          description: typeof partial.description === "string" ? partial.description : "",
          verifyCriteria: typeof partial.verifyCriteria === "string" ? partial.verifyCriteria : "",
          tasks: Array.isArray(partial.tasks) ? partial.tasks : [],
          createdAt: now,
          resolvedAt: null,
          statusHistory: [{ status, at: now, by: "user" }],
          record: [],
        };
        await this.store.upsert(issue);
        break;
      }
      case "updateIssue": {
        const issue = (msg as { issue?: unknown }).issue;
        if (!issue || typeof issue !== "object" || !ID_RE.test((issue as Issue).id ?? "")) {
          this.output.appendLine(`Rejected updateIssue: bad id (${JSON.stringify(issue)})`);
          break;
        }
        await this.applyUpdate(issue as Issue);
        break;
      }
      case "deleteIssue": {
        const id = (msg as { id?: unknown }).id;
        if (typeof id !== "string" || !ID_RE.test(id)) {
          this.output.appendLine(`Rejected deleteIssue: bad id (${JSON.stringify(id)})`);
          break;
        }
        await this.store.remove(id);
        break;
      }
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
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        this.output.appendLine(`Unknown webview message: ${JSON.stringify(msg)}`);
      }
    }
  }
}
