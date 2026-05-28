// Graph panel — full editor-tab view of the ticket-link network.
//
// Singleton, mirroring BoardPanel. Read-mostly: it renders nodes/edges and
// posts `revealTicket` (node click) + `openBoard`/`openGraph` chrome. It does
// not mutate issues, so it needs no applyUpdate / attachment handlers.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import type { Issue, Settings, WebviewToHost } from "./types";

const ID_RE = /^DS-\d+$/;

function readSettings(webview: vscode.Webview, store: IssueStore): Settings {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  const attachmentsDir = store.attachmentsDir();
  return {
    storagePath: cfg.get<string>("storagePath", ".vscode/dostuff"),
    autoSave: cfg.get<boolean>("autoSave", true),
    activeLaneCap: cfg.get<number>("activeLaneCap", 6),
    attachmentsBaseUri: attachmentsDir ? webview.asWebviewUri(attachmentsDir).toString() : null,
  };
}

export class GraphPanel {
  public static readonly viewType = "dostuff.graph";
  private static current: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  static showOrCreate(
    extensionUri: vscode.Uri,
    store: IssueStore,
    openLink: (url: string) => void | Promise<void> = () => {},
  ) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(undefined, false);
      return;
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(GraphPanel.viewType, "DoStuff: Graph", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    GraphPanel.current = new GraphPanel(panel, extensionUri, store, openLink);
  }

  /** Re-broadcast current truth to the live graph panel, if any. */
  static broadcast(issues: Issue[]) {
    GraphPanel.current?.broadcast(issues);
  }

  static isOpen(): boolean {
    return GraphPanel.current !== undefined;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly openLink: (url: string) => void | Promise<void> = () => {},
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.output = vscode.window.createOutputChannel("DoStuff Graph");
    this.disposables.push(this.output);

    this.panel.webview.html = getWebviewHtml({
      webview: this.panel.webview,
      extensionUri,
      mode: "graph",
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.disposables.push(store.onChange((issues) => this.broadcast(issues)));
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
          settings: readSettings(this.panel.webview, this.store),
        });
        break;
      case "revealTicket": {
        const id = (msg as { id?: unknown }).id;
        if (typeof id !== "string" || !ID_RE.test(id)) {
          this.output.appendLine(`Rejected revealTicket: bad id (${JSON.stringify(id)})`);
          break;
        }
        vscode.commands.executeCommand("dostuff.revealTicket", id);
        break;
      }
      case "openBoard":
        vscode.commands.executeCommand("dostuff.openBoard");
        break;
      case "openLink": {
        const url = (msg as { url?: unknown }).url;
        if (typeof url === "string" && url.length > 0 && url.length <= 4096) {
          await this.openLink(url);
        }
        break;
      }
      case "importJson":
        vscode.commands.executeCommand("dostuff.importJson");
        break;
      case "exportJson":
        vscode.commands.executeCommand("dostuff.exportJson");
        break;
      // Mutation + attachment messages don't originate from the graph; ignore.
      default:
        this.output.appendLine(`Unhandled webview message in graph: ${JSON.stringify(msg)}`);
    }
  }

  dispose() {
    GraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
