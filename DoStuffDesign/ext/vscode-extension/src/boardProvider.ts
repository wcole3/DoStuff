// Board panel — full editor-tab Kanban view.
//
// Singleton: opening twice reveals the existing panel instead of creating a duplicate.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import type { Issue, WebviewToHost } from "./types";

export class BoardPanel {
  public static readonly viewType = "dostuff.board";
  private static current: BoardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static showOrCreate(extensionUri: vscode.Uri, store: IssueStore) {
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

    BoardPanel.current = new BoardPanel(panel, extensionUri, store);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: IssueStore
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");

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

  private broadcast(issues: Issue[]) {
    this.panel.webview.postMessage({ type: "issues", issues });
  }

  private async handleMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.panel.webview.postMessage({
          type: "init",
          issues: this.store.list(),
          settings: vscode.workspace.getConfiguration("dostuff") as any,
        });
        break;
      case "updateIssue":
        await this.store.upsert(msg.issue);
        break;
      case "deleteIssue":
        await this.store.remove(msg.id);
        break;
      case "importJson":
        vscode.commands.executeCommand("dostuff.importJson");
        break;
      case "exportJson":
        vscode.commands.executeCommand("dostuff.exportJson");
        break;
    }
  }

  dispose() {
    BoardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
