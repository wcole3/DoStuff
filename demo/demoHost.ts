// The demo's stand-in for the extension host: answers every `WebviewToHost`
// message the three webviews (sidebar, board, graph) send, using the same
// pure rules the real host runs (`src/issueRules.ts`). Everything that needs
// VSCode or a workspace — attachments, settings, file links, the MCP server —
// degrades to a notice. DOM-free: the page shell supplies `DemoUi`.

import {
  activeLaneOverflow,
  applyInboundLinks,
  buildCreatedIssue,
  planIssueUpdate,
  resolveCloseRequest,
  validateImportList,
} from "../src/issueRules";
import {
  ACTIVE_LANE_CAP,
  DS_ID_RE,
  isPriority,
  isType,
  toRow,
  type CommitDetail,
  type HostToWebview,
  type Issue,
  type Settings,
  type WebviewToHost,
} from "../src/types";
import type { DemoChange, DemoStore } from "./demoStore";

export type FrameMode = "sidebar" | "board" | "graph";
export const FRAME_MODES: readonly FrameMode[] = ["sidebar", "board", "graph"];

/** Side effects the host needs from the page. */
export interface DemoUi {
  /** Deliver a message to one webview frame (dropped if it isn't loaded). */
  post(to: FrameMode, msg: HostToWebview): void;
  notify(kind: "info" | "warning" | "error", text: string): void;
  /** Bring the board or graph view to the front (openBoard / openGraph). */
  showMain(view: "board" | "graph"): void;
  /** A graph node click asked to reveal a ticket (narrow layouts switch to the sidebar). */
  revealed(id: string): void;
  openExternal(url: string): void;
  pickImportFile(): Promise<string | null>;
  chooseImportMode(count: number): Promise<"merge" | "replace" | null>;
  download(filename: string, text: string): void;
}

export const DEMO_SETTINGS: Settings = {
  storagePath: "browser localStorage (demo)",
  autoSave: true,
  activeLaneCap: ACTIVE_LANE_CAP,
  // No workspace, so no attachment directory: the webview disables uploads.
  attachmentsBaseUri: null,
};

const NO_ATTACHMENTS = "Attachments need the VSCode extension — they're off in the browser demo.";

export class DemoHost {
  constructor(
    private readonly store: DemoStore,
    private readonly ui: DemoUi,
    /** Display data for seeded commit shas (the real host asks git). */
    private readonly commitDetails: Record<string, Omit<CommitDetail, "sha" | "found">> = {},
  ) {
    store.onChange((change) => this.broadcast(changeToMessage(change)));
  }

  /** Re-send current truth to every frame, e.g. after a rejected update so
   *  optimistic drag state snaps back. */
  broadcastAll(): void {
    this.broadcast({ type: "issues", issues: this.store.list().map(toRow) });
  }

  async reset(seed: Issue[]): Promise<void> {
    await this.store.replaceAll(seed);
  }

  /** The sidebar's view-title actions (package.json `view/title` menus),
   *  which live in VSCode's chrome rather than the webview. */
  async command(name: "newIssue" | "importJson" | "exportJson"): Promise<void> {
    switch (name) {
      case "newIssue":
        this.ui.post("sidebar", { type: "showNewIssue" });
        return;
      case "importJson":
        return this.importJson();
      case "exportJson":
        return this.exportJson();
    }
  }

  async handle(from: FrameMode, msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ui.post(from, {
          type: "init",
          issues: this.store.list().map(toRow),
          settings: DEMO_SETTINGS,
        });
        return;
      case "fetchIssueDetail": {
        const full = this.store.get(msg.id);
        if (full) this.ui.post(from, { type: "issueDetail", issue: full });
        return;
      }
      case "createIssue":
        return this.createIssue(msg.partial);
      case "updateIssue": {
        if (!isTicketId(msg.issue?.id)) return;
        const planned = planIssueUpdate(this.store.list(), msg.issue, ACTIVE_LANE_CAP);
        if ("error" in planned) {
          this.ui.notify("warning", planned.error);
          this.broadcastAll();
          return;
        }
        await this.store.upsert(planned.next);
        return;
      }
      case "deleteIssue":
        if (isTicketId(msg.id)) await this.store.remove(msg.id);
        return;
      case "resolveClose": {
        if (!isTicketId(msg.id) || (msg.verdict !== "approve" && msg.verdict !== "deny")) return;
        const prior = this.store.get(msg.id);
        const next = prior ? resolveCloseRequest(prior, msg.verdict) : null;
        if (next) await this.store.upsert(next);
        else this.broadcastAll();
        return;
      }
      case "openBoard":
        this.ui.showMain("board");
        return;
      case "openGraph":
        this.ui.showMain("graph");
        return;
      case "externalDragStart":
        if (!isTicketId(msg.issueId)) return;
        this.ui.showMain("board");
        this.ui.post("board", { type: "externalDragStart", issueId: msg.issueId });
        return;
      case "revealTicket":
        if (!isTicketId(msg.id)) return;
        this.ui.post("sidebar", { type: "revealTicket", id: msg.id });
        this.ui.post("board", { type: "revealTicket", id: msg.id });
        this.ui.revealed(msg.id);
        return;
      case "fetchCommitDetails": {
        const issue = isTicketId(msg.issueId) ? this.store.get(msg.issueId) : undefined;
        if (!issue) return;
        const details: CommitDetail[] = issue.commits.map((c) => {
          const known = this.commitDetails[c.sha];
          return known
            ? { sha: c.sha, found: true, ...known }
            : { sha: c.sha, found: false, subject: "", files: [] };
        });
        this.ui.post(from, { type: "commitDetails", issueId: issue.id, pathPrefix: ".", details });
        return;
      }
      case "openLink":
        return this.openLink(msg.url);
      case "exportJson":
        return this.exportJson();
      case "importJson":
        return this.importJson();
      case "openSettings":
        this.ui.notify("info", "Settings live in VSCode (dostuff.*). The demo runs with the defaults.");
        return;
      case "pickAttachment":
      case "addAttachmentBytes":
      case "addAttachmentByUri":
      case "deleteAttachment":
      case "openAttachment":
      case "pickAttachmentForStaging":
      case "stageAttachmentByUri":
        this.ui.notify("info", NO_ATTACHMENTS);
        return;
      default: {
        // A new WebviewToHost variant fails tsc here until the demo handles it.
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  private broadcast(msg: HostToWebview): void {
    for (const mode of FRAME_MODES) this.ui.post(mode, msg);
  }

  /** Mirrors the sidebar provider's `createIssue` handler. */
  private async createIssue(partial: Extract<WebviewToHost, { type: "createIssue" }>["partial"]): Promise<void> {
    if (typeof partial?.title !== "string" || partial.title.length === 0) return;
    if (!isType(partial.type) || !isPriority(partial.priority)) return;
    const knownIds = new Set(this.store.list().map((i) => i.id));
    const { issue } = buildCreatedIssue(partial, {
      number: this.store.nextNumber(),
      now: new Date().toISOString(),
      knownIds,
    });
    await this.store.upsert(issue);
    if (Array.isArray(partial.attachments) && partial.attachments.length > 0) {
      this.ui.notify("info", NO_ATTACHMENTS);
    }
    await applyInboundLinks(this.store, issue.id, partial.inboundLinks);
  }

  private openLink(url: unknown): void {
    if (typeof url !== "string" || url.length === 0 || url.length > 4096) return;
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      this.ui.openExternal(trimmed);
      return;
    }
    this.ui.notify("info", `"${trimmed}" is a workspace file link — it opens in VSCode, not the demo.`);
  }

  private exportJson(): void {
    const issues = this.store.list();
    const payload = { version: 1, exportedAt: new Date().toISOString(), issues };
    const filename = `dostuff-issues-${new Date().toISOString().slice(0, 10)}.json`;
    this.ui.download(filename, JSON.stringify(payload, null, 2));
    this.ui.notify("info", `Exported ${issues.length} issues.`);
  }

  /** Mirrors the extension's `dostuff.importJson` command. */
  private async importJson(): Promise<void> {
    const text = await this.ui.pickImportFile();
    if (text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.ui.notify("error", `Failed to parse JSON: ${(e as Error).message}`);
      return;
    }
    const raw: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { issues?: unknown })?.issues)
        ? ((parsed as { issues: unknown[] }).issues)
        : [];
    if (raw.length === 0) {
      this.ui.notify("error", "Expected a non-empty array or { issues: [...] }.");
      return;
    }
    const { valid, skipped } = validateImportList(raw);
    if (valid.length === 0) {
      this.ui.notify("error", `Import: no valid issues found (skipped ${skipped}). Check schema.`);
      return;
    }
    const mode = await this.ui.chooseImportMode(valid.length);
    if (!mode) return;
    const postSet =
      mode === "replace"
        ? valid
        : [...new Map([...this.store.list(), ...valid].map((i) => [i.id, i])).values()];
    const overflowing = activeLaneOverflow(postSet, ACTIVE_LANE_CAP);
    if (overflowing.length > 0) {
      const summary = overflowing.map(({ lane, count }) => `${lane}: ${count}/${ACTIVE_LANE_CAP}`).join(", ");
      this.ui.notify("error", `Import refused — active-lane cap exceeded (${summary}).`);
      return;
    }
    if (mode === "replace") await this.store.replaceAll(valid);
    else await this.store.mergeAll(valid);
    this.ui.notify(
      "info",
      `${mode === "replace" ? "Replaced with" : "Merged"} ${valid.length} issues${skipped ? ` (skipped ${skipped})` : ""}.`,
    );
  }
}

function isTicketId(v: unknown): v is string {
  return typeof v === "string" && DS_ID_RE.test(v);
}

/** Same split as `webviewProtocol.changeToMessage` (which imports vscode). */
export function changeToMessage(change: DemoChange): Extract<HostToWebview, { type: "issues" | "issuesDelta" }> {
  if (change.reset) return { type: "issues", issues: change.issues.map(toRow) };
  return { type: "issuesDelta", upserted: change.upserted.map(toRow), removed: change.removed };
}
