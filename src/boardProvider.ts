// Board panel — full editor-tab Kanban view.
//
// Singleton: opening twice reveals the existing panel instead of creating a duplicate.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import type { ApplyIssueUpdate } from "./sidebarProvider";
import type { Issue, Settings, WebviewToHost } from "./types";

const ID_RE = /^DS-\d+$/;

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  return {
    storagePath:    cfg.get<string>("storagePath", ".vscode/dostuff"),
    autoSave:       cfg.get<boolean>("autoSave", true),
    activeLaneCap:  cfg.get<number>("activeLaneCap", 6),
  };
}

export class BoardPanel {
  public static readonly viewType = "dostuff.board";
  private static current: BoardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  static showOrCreate(
    extensionUri: vscode.Uri,
    store: IssueStore,
    applyUpdate: ApplyIssueUpdate,
  ) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (BoardPanel.current) {
      BoardPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BoardPanel.viewType,
      "DoStuff: Board",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    BoardPanel.current = new BoardPanel(panel, extensionUri, store, applyUpdate);
  }

  /** Re-broadcast current truth to the live board panel, if any. */
  static broadcast(issues: Issue[]) {
    BoardPanel.current?.broadcast(issues);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly applyUpdate: ApplyIssueUpdate,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.output = vscode.window.createOutputChannel("DoStuff Board");
    this.disposables.push(this.output);

    this.panel.webview.html = getWebviewHtml({
      webview: this.panel.webview,
      extensionUri,
      mode: "board",
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.handleMessage(msg),
      null,
      this.disposables
    );

    const storeSub = store.onChange((issues) => this.broadcast(issues));
    this.disposables.push(storeSub);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  broadcast(issues: Issue[] = this.store.list()) {
    this.panel.webview.postMessage({ type: "issues", issues });
  }

  private async handleMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.panel.webview.postMessage({
          type: "init",
          issues: this.store.list(),
          settings: readSettings(),
        });
        break;
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
      case "importJson":
        vscode.commands.executeCommand("dostuff.importJson");
        break;
      case "exportJson":
        vscode.commands.executeCommand("dostuff.exportJson");
        break;
      // The board view ignores message types only the sidebar handles
      // (e.g. "createIssue", "openBoard", "openSettings"). Log + drop.
      default: {
        this.output.appendLine(`Unhandled webview message in board: ${JSON.stringify(msg)}`);
      }
    }
  }

  dispose() {
    BoardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
