// Board panel — full editor-tab Kanban view.
//
// Singleton: opening twice reveals the existing panel instead of creating a duplicate.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { getWebviewHtml } from "./webviewHtml";
import type { ApplyIssueUpdate, AttachmentHandlers } from "./sidebarProvider";
import type { Issue, Settings, WebviewToHost } from "./types";

const ID_RE = /^DS-\d+$/;

function readSettings(webview: vscode.Webview, store: IssueStore): Settings {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  const attachmentsDir = store.attachmentsDir();
  return {
    storagePath:    cfg.get<string>("storagePath", ".vscode/dostuff"),
    autoSave:       cfg.get<boolean>("autoSave", true),
    activeLaneCap:  cfg.get<number>("activeLaneCap", 6),
    attachmentsBaseUri: attachmentsDir
      ? webview.asWebviewUri(attachmentsDir).toString()
      : null,
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
    openLink: (url: string) => void | Promise<void> = () => {},
    attachments: AttachmentHandlers = {
      onPick: () => {},
      onAddBytes: () => {},
      onAddByUri: () => {},
      onDelete: () => {},
      onOpen: () => {},
      onPickForStaging: async () => [],
      onStageByUri: async () => null,
    },
  ) {
    if (BoardPanel.current) {
      // Reveal in its current column — don't move the panel if the user has
      // an editor focused elsewhere.
      BoardPanel.current.panel.reveal(undefined, false);
      return;
    }

    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const localRoots: vscode.Uri[] = [vscode.Uri.joinPath(extensionUri, "media")];
    const attachmentsDir = store.attachmentsDir();
    if (attachmentsDir) localRoots.push(attachmentsDir);
    const panel = vscode.window.createWebviewPanel(
      BoardPanel.viewType,
      "DoStuff: Board",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: localRoots,
      }
    );

    BoardPanel.current = new BoardPanel(panel, extensionUri, store, applyUpdate, openLink, attachments);
  }

  /** Re-broadcast current truth to the live board panel, if any. */
  static broadcast(issues: Issue[]) {
    BoardPanel.current?.broadcast(issues);
  }

  /**
   * Returns whether a board panel is currently open. Used by extension.ts to
   * decide whether to auto-open the board when the sidebar reports a drag.
   */
  static isOpen(): boolean {
    return BoardPanel.current !== undefined;
  }

  /** Notify the open board that the user is dragging a ticket from the sidebar. */
  static signalExternalDrag(issueId: string): void {
    BoardPanel.current?.panel.webview.postMessage({ type: "externalDragStart", issueId });
  }

  /** Ask the open board (if any) to surface a ticket's detail. No-op when the
   *  board isn't open — the sidebar still handles its own reveal. */
  static revealTicket(id: string): void {
    BoardPanel.current?.panel.webview.postMessage({ type: "revealTicket", id });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly applyUpdate: ApplyIssueUpdate,
    private readonly openLink: (url: string) => void | Promise<void> = () => {},
    private readonly attachments: AttachmentHandlers = {
      onPick: () => {},
      onAddBytes: () => {},
      onAddByUri: () => {},
      onDelete: () => {},
      onOpen: () => {},
      onPickForStaging: async () => [],
      onStageByUri: async () => null,
    },
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
          settings: readSettings(this.panel.webview, this.store),
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
      case "openLink": {
        const url = (msg as { url?: unknown }).url;
        if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
          this.output.appendLine(`Rejected openLink: bad url`);
          break;
        }
        await this.openLink(url);
        break;
      }
      case "pickAttachment": {
        const id = (msg as { issueId?: unknown }).issueId;
        if (typeof id !== "string" || !ID_RE.test(id)) {
          this.output.appendLine(`Rejected pickAttachment: bad id`);
          break;
        }
        this.output.appendLine(`Board received pickAttachment for ${id}`);
        await this.attachments.onPick(id);
        break;
      }
      case "addAttachmentBytes": {
        const m = msg as {
          issueId?: unknown;
          name?: unknown;
          mimeType?: unknown;
          bytes?: unknown;
        };
        if (
          typeof m.issueId !== "string" ||
          !ID_RE.test(m.issueId) ||
          typeof m.name !== "string" ||
          typeof m.mimeType !== "string" ||
          !Array.isArray(m.bytes)
        ) {
          this.output.appendLine(`Rejected addAttachmentBytes: bad payload`);
          break;
        }
        await this.attachments.onAddBytes(
          m.issueId,
          m.name,
          m.mimeType,
          new Uint8Array(m.bytes as number[]),
        );
        break;
      }
      case "addAttachmentByUri": {
        const m = msg as { issueId?: unknown; uri?: unknown };
        if (
          typeof m.issueId !== "string" ||
          !ID_RE.test(m.issueId) ||
          typeof m.uri !== "string" ||
          m.uri.length === 0 ||
          m.uri.length > 4096
        ) {
          this.output.appendLine(`Rejected addAttachmentByUri: bad payload`);
          break;
        }
        await this.attachments.onAddByUri(m.issueId, m.uri);
        break;
      }
      case "deleteAttachment": {
        const m = msg as { issueId?: unknown; attachmentId?: unknown };
        if (
          typeof m.issueId !== "string" ||
          !ID_RE.test(m.issueId) ||
          typeof m.attachmentId !== "string" ||
          m.attachmentId.length === 0
        ) {
          this.output.appendLine(`Rejected deleteAttachment: bad payload`);
          break;
        }
        await this.attachments.onDelete(m.issueId, m.attachmentId);
        break;
      }
      case "openAttachment": {
        const m = msg as { issueId?: unknown; attachmentId?: unknown };
        if (
          typeof m.issueId !== "string" ||
          !ID_RE.test(m.issueId) ||
          typeof m.attachmentId !== "string" ||
          m.attachmentId.length === 0
        ) {
          this.output.appendLine(`Rejected openAttachment: bad payload`);
          break;
        }
        await this.attachments.onOpen(m.issueId, m.attachmentId);
        break;
      }
      case "revealTicket": {
        const id = (msg as { id?: unknown }).id;
        if (typeof id !== "string" || !ID_RE.test(id)) {
          this.output.appendLine(`Rejected revealTicket: bad id (${JSON.stringify(id)})`);
          break;
        }
        vscode.commands.executeCommand("dostuff.revealTicket", id);
        break;
      }
      case "openGraph":
        vscode.commands.executeCommand("dostuff.openGraph");
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
