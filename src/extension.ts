// Extension entry point — wires up the sidebar provider, board panel, commands, and storage.

import * as path from "node:path";
import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { SidebarProvider } from "./sidebarProvider";
import { BoardPanel } from "./boardProvider";
import { DEFAULT_WORKFLOW_PROMPT, DoStuffMcpServer } from "./mcpServer";
import {
  ACTIVE_LANE_CAP,
  canMoveToActiveLane,
  isPriority,
  isStatus,
  isType,
  type Issue,
  type Status,
  type StatusEvent,
} from "./types";


export type UpdateBy = "user" | "agent";

/**
 * Pure merge of a webview-submitted partial update onto a persisted issue.
 *
 * Server-derived fields (`id`, `number`, `createdAt`, `record`, `statusHistory`,
 * `resolvedAt`) are NEVER copied from `incoming` — they are reconstructed from
 * `prior` plus this function's own bookkeeping. The webview can lie about any
 * of those and we'll ignore it.
 *
 * Returns `{next}` on success or `{error}` if validation fails.
 *
 * Decision: when status transitions out of "Complete" (e.g. user reopens an
 * already-done ticket), `resolvedAt` is cleared. This is intentional — humans
 * can correct mistakes; the MCP layer enforces a stricter contract for agents.
 */
export function mergeIssueUpdate(
  prior: Issue,
  incoming: Partial<Issue>,
  by: UpdateBy,
  now: () => string = () => new Date().toISOString(),
): { next: Issue } | { error: string } {
  if (incoming.status !== undefined && !isStatus(incoming.status)) {
    return { error: `Invalid status: ${JSON.stringify(incoming.status)}` };
  }
  if (incoming.priority !== undefined && !isPriority(incoming.priority)) {
    return { error: `Invalid priority: ${JSON.stringify(incoming.priority)}` };
  }
  if (incoming.type !== undefined && !isType(incoming.type)) {
    return { error: `Invalid type: ${JSON.stringify(incoming.type)}` };
  }

  const next: Issue = {
    ...prior,
    title:          typeof incoming.title === "string" ? incoming.title : prior.title,
    description:    typeof incoming.description === "string" ? incoming.description : prior.description,
    verifyCriteria: typeof incoming.verifyCriteria === "string" ? incoming.verifyCriteria : prior.verifyCriteria,
    tasks:          Array.isArray(incoming.tasks) ? incoming.tasks : prior.tasks,
    type:           incoming.type ?? prior.type,
    priority:       incoming.priority ?? prior.priority,
    status:         incoming.status ?? prior.status,
  };

  if (next.status !== prior.status) {
    const ts = now();
    const event: StatusEvent = { status: next.status, at: ts, by };
    next.statusHistory = [...prior.statusHistory, event];
    if (next.status === "Complete") {
      next.resolvedAt = ts;
    } else if (prior.status === "Complete") {
      next.resolvedAt = null;
    }
  }

  return { next };
}

/** Required-field shape check on an imported issue. Coerces missing enum values to defaults. */
export function validateImportList(raw: unknown[]): { valid: Issue[]; skipped: number } {
  const valid: Issue[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      skipped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !/^DS-\d+$/.test(e.id)) {
      skipped += 1;
      continue;
    }
    if (typeof e.title !== "string" || e.title.length === 0) {
      skipped += 1;
      continue;
    }
    if (typeof e.createdAt !== "string") {
      skipped += 1;
      continue;
    }
    const status: Status = isStatus(e.status) ? e.status : "Thinking";
    const issue: Issue = {
      id: e.id,
      number: Number.isFinite(e.number)
        ? (e.number as number)
        : parseInt(e.id.replace(/^DS-/, ""), 10),
      title: e.title,
      type: isType(e.type) ? e.type : "Chore",
      priority: isPriority(e.priority) ? e.priority : "Regular",
      status,
      description: typeof e.description === "string" ? e.description : "",
      verifyCriteria: typeof e.verifyCriteria === "string" ? e.verifyCriteria : "",
      tasks: Array.isArray(e.tasks) ? (e.tasks as Issue["tasks"]) : [],
      createdAt: e.createdAt,
      resolvedAt: typeof e.resolvedAt === "string" ? e.resolvedAt : null,
      statusHistory: Array.isArray(e.statusHistory)
        ? (e.statusHistory as Issue["statusHistory"])
        : [{ status, at: e.createdAt, by: "user" }],
      record: Array.isArray(e.record) ? (e.record as Issue["record"]) : [],
    };
    valid.push(issue);
  }
  return { valid, skipped };
}

/** Lanes that exceed `cap` in the given set. Empty if all within cap. */
export function activeLaneOverflow(set: Issue[], cap = ACTIVE_LANE_CAP): Array<{ lane: Status; count: number }> {
  const out: Array<{ lane: Status; count: number }> = [];
  for (const lane of ["Planned", "Working", "Verification"] as const) {
    const count = set.filter((i) => i.status === lane).length;
    if (count > cap) out.push({ lane, count });
  }
  return out;
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new IssueStore(context);
  await store.init();

  /**
   * Host-side issue update handler. Single chokepoint for any path that
   * mutates an existing ticket from a webview message. Responsible for:
   *
   *   1. Reconstructing the persisted issue from a small allow-list of mutable
   *      fields (see {@link mergeIssueUpdate}). Server-derived fields like
   *      `statusHistory`, `resolvedAt`, `id`, `number`, `createdAt`, `record`
   *      are never trusted from the webview payload.
   *   2. Enforcing the active-lane cap (Planned/Working/Verification ≤ 6).
   *   3. Note: the UI is allowed to move a ticket out of "Complete" (humans can
   *      correct mis-clicks). The MCP layer enforces a stricter contract.
   *
   * On rejection we re-broadcast the current truth so the optimistic webview
   * state reverts.
   */
  const applyIssueUpdate = async (incoming: Issue): Promise<void> => {
    const prior = store.get(incoming.id);
    if (!prior) {
      vscode.window.showWarningMessage(`DoStuff: No ticket with id ${incoming.id}.`);
      sidebar.broadcast();
      BoardPanel.broadcast(store.list());
      return;
    }

    const merged = mergeIssueUpdate(prior, incoming, "user");
    if ("error" in merged) {
      vscode.window.showWarningMessage(`DoStuff: ${merged.error}`);
      sidebar.broadcast();
      BoardPanel.broadcast(store.list());
      return;
    }
    const next = merged.next;

    if (next.status !== prior.status) {
      const cap = vscode.workspace.getConfiguration("dostuff").get<number>("activeLaneCap", ACTIVE_LANE_CAP);
      const check = canMoveToActiveLane(store.list(), next.status, next.id, cap);
      if (check !== true) {
        vscode.window.showWarningMessage(`DoStuff: ${check}`);
        sidebar.broadcast();
        BoardPanel.broadcast(store.list());
        return;
      }
    }

    await store.upsert(next);
  };

  const sidebar = new SidebarProvider(context.extensionUri, store, applyIssueUpdate);

  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("dostuff.openBoard", () => {
      BoardPanel.showOrCreate(context.extensionUri, store, applyIssueUpdate);
    }),

    vscode.commands.registerCommand("dostuff.newIssue", () => {
      vscode.commands.executeCommand("workbench.view.extension.dostuff");
      sidebar.showNewIssue();
    }),

    vscode.commands.registerCommand("dostuff.focusSearch", () => {
      sidebar.focusSearch();
    }),

    vscode.commands.registerCommand("dostuff.clearAll", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Delete all issues? This cannot be undone.",
        { modal: true },
        "Clear All",
      );
      if (answer !== "Clear All") return;
      await store.replaceAll([]);
      vscode.window.showInformationMessage("DoStuff: All issues cleared.");
    }),

    vscode.commands.registerCommand("dostuff.exportJson", async () => {
      const issues = store.list();
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        issues,
      };
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      const filename = `dostuff-issues-${new Date().toISOString().slice(0, 10)}.json`;
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        defaultUri: wsRoot
          ? wsRoot.with({ path: `${wsRoot.path}/${filename}` })
          : vscode.Uri.file(filename),
        saveLabel: "Export",
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(JSON.stringify(payload, null, 2))
      );
      vscode.window.showInformationMessage(`Exported ${issues.length} issues.`);
    }),

    vscode.commands.registerCommand("dostuff.importJson", async () => {
      const picks = await vscode.window.showOpenDialog({
        filters: { JSON: ["json"] },
        canSelectMany: false,
        openLabel: "Import",
      });
      if (!picks || !picks[0]) return;
      let parsed: unknown;
      try {
        const buf = await vscode.workspace.fs.readFile(picks[0]);
        parsed = JSON.parse(new TextDecoder().decode(buf));
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to parse JSON: ${(e as Error).message}`);
        return;
      }
      const raw: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as any)?.issues)
          ? (parsed as any).issues
          : [];
      if (!Array.isArray(raw) || raw.length === 0) {
        vscode.window.showErrorMessage("Expected a non-empty array or { issues: [...] }.");
        return;
      }
      const { valid, skipped } = validateImportList(raw);
      if (skipped > 0) {
        store.appendLog(`Import: skipped ${skipped} malformed entries.`);
      }
      if (valid.length === 0) {
        vscode.window.showErrorMessage(
          `Import: no valid issues found (skipped ${skipped}). Check schema.`,
        );
        return;
      }
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Merge by id", value: "merge" },
          { label: "Replace all (destructive)", value: "replace" },
        ],
        { placeHolder: `Import ${valid.length} issues — how?` }
      );
      if (!mode) return;

      // Compute the post-import set so we can lane-cap-check before persisting.
      const postSet: Issue[] = (() => {
        if (mode.value === "replace") return valid;
        const byId = new Map(store.list().map((i) => [i.id, i]));
        for (const i of valid) byId.set(i.id, i);
        return [...byId.values()];
      })();
      const importCap = vscode.workspace.getConfiguration("dostuff").get<number>("activeLaneCap", ACTIVE_LANE_CAP);
      const overflowing = activeLaneOverflow(postSet, importCap);
      if (overflowing.length > 0) {
        const summary = overflowing
          .map(({ lane, count }) => `${lane}: ${count}/${importCap}`)
          .join(", ");
        vscode.window.showErrorMessage(
          `Import refused — active-lane cap exceeded (${summary}). ` +
            `Clear or move tickets out of those lanes, or re-author the import file.`,
        );
        return;
      }

      if (mode.value === "replace") await store.replaceAll(valid);
      else await store.mergeAll(valid);
      vscode.window.showInformationMessage(
        `${mode.value === "replace" ? "Replaced with" : "Merged"} ${valid.length} issues${
          skipped ? ` (skipped ${skipped})` : ""
        }.`
      );
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("dostuff.storagePath")) {
        vscode.window.showInformationMessage(
          "DoStuff: storage path changed. Reloading from new location.",
        );
        await store.reload();
      }
    }),

    store,
  );

  // ─── MCP server ───────────────────────────────────────────────────────
  // Workspace identity feeds the user-global registry so external agents can
  // discover which ephemeral port serves which workspace. The override setting
  // lets the user pin an explicit path when the auto-pick is wrong.
  const workspaceId = () => {
    const override = vscode.workspace
      .getConfiguration("dostuff")
      .get<string>("mcp.workspaceOverride", "")
      .trim();
    if (override) return { path: override, name: path.basename(override) || override };
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    return { path: root.uri.fsPath, name: root.name };
  };
  const mcp = new DoStuffMcpServer(store, workspaceId);

  // Status bar item — reflects MCP enabled/disabled state. Clicking toggles.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "dostuff.mcp.toggle";
  const refreshStatus = () => {
    const cfg = vscode.workspace.getConfiguration("dostuff");
    const enabled = cfg.get<boolean>("mcp.enabled", true);
    const { port } = mcp.status;
    if (!enabled) {
      statusItem.text = `$(circle-slash) DoStuff MCP`;
      statusItem.tooltip = `MCP server disabled. Click to enable.`;
    } else if (port) {
      statusItem.text = `$(plug) DoStuff MCP :${port}`;
      statusItem.tooltip = `MCP server listening on 127.0.0.1:${port}. Click to disable.`;
    } else {
      statusItem.text = `$(plug) DoStuff MCP`;
      statusItem.tooltip = `MCP server enabled but not listening (no workspace folder?). Click to disable.`;
    }
    statusItem.show();
  };
  refreshStatus();

  const reconcileMcp = async () => {
    await mcp.reconcile();
    refreshStatus();
  };
  context.subscriptions.push(
    mcp,
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dostuff.mcp")) void reconcileMcp();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reconcileMcp();
    }),
    vscode.commands.registerCommand("dostuff.mcp.toggle", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const enabled = cfg.get<boolean>("mcp.enabled", true);
      await cfg.update("mcp.enabled", !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`DoStuff MCP server ${!enabled ? "enabled" : "disabled"}.`);
    }),
    vscode.commands.registerCommand("dostuff.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "dostuff");
    }),
    vscode.commands.registerCommand("dostuff.mcp.editInstructions", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const current = cfg.get<string>("mcp.instructions", "");
      const next = await vscode.window.showInputBox({
        prompt: "Edit custom instructions. Clear all text to revert to the built-in default.",
        value: current || DEFAULT_WORKFLOW_PROMPT,
        ignoreFocusOut: true,
      });
      if (next === undefined) return;
      const toSave = next.trim() === DEFAULT_WORKFLOW_PROMPT.trim() ? "" : next;
      await cfg.update("mcp.instructions", toSave, vscode.ConfigurationTarget.Global);
    }),
  );
  await reconcileMcp();
}

export function deactivate() {}

// Re-export the lane cap for tests / consumers that want the constant.
export { ACTIVE_LANE_CAP };
