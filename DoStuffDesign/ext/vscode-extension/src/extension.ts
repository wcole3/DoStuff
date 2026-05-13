// Extension entry point — wires up the sidebar provider, board panel, commands, and storage.

import * as vscode from "vscode";
import { IssueStore } from "./storage";
import { SidebarProvider } from "./sidebarProvider";
import { BoardPanel } from "./boardProvider";
import { SAMPLE_ISSUES } from "./sampleData";
import { DoStuffMcpServer } from "./mcpServer";
import type { Issue } from "./types";

export async function activate(context: vscode.ExtensionContext) {
  const store = new IssueStore(context);
  await store.init();

  // Seed sample data the first time, then never again.
  const SEED_FLAG = "dostuff.seeded.v1";
  if (!context.globalState.get(SEED_FLAG) && store.list().length === 0) {
    for (const issue of SAMPLE_ISSUES) await store.upsert(issue);
    await context.globalState.update(SEED_FLAG, true);
  }

  const sidebar = new SidebarProvider(context.extensionUri, store);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("dostuff.openBoard", () => {
      BoardPanel.showOrCreate(context.extensionUri, store);
    }),

    vscode.commands.registerCommand("dostuff.newIssue", async () => {
      const title = await vscode.window.showInputBox({
        prompt: "Issue title",
        placeHolder: "Short summary…",
      });
      if (!title) return;
      const status = (await vscode.window.showQuickPick(
        ["Thinking", "Planned", "Working", "Testing", "Complete"],
        { placeHolder: "Status" }
      )) as Issue["status"] | undefined;
      if (!status) return;
      const priority = (await vscode.window.showQuickPick(
        ["Critical", "High", "Regular", "Low"],
        { placeHolder: "Priority" }
      )) as Issue["priority"] | undefined;
      if (!priority) return;
      const type = (await vscode.window.showQuickPick(
        ["Bug", "Feature", "Refactor", "Chore", "Spike"],
        { placeHolder: "Type" }
      )) as Issue["type"] | undefined;
      if (!type) return;
      const now = new Date().toISOString();
      const number = store.nextNumber();
      const issue: Issue = {
        id: `DS-${String(number).padStart(3, "0")}`,
        number,
        title, type, priority, status,
        description: "", tasks: [], verifyCriteria: "",
        createdAt: now,
        resolvedAt: status === "Complete" ? now : null,
        statusHistory: [{ status, at: now, by: "user" }],
        record: [],
      };
      await store.upsert(issue);
      vscode.window.showInformationMessage(`Created ${issue.id}: ${title}`);
    }),

    vscode.commands.registerCommand("dostuff.focusSearch", () => {
      sidebar.focusSearch();
    }),

    vscode.commands.registerCommand("dostuff.exportJson", async () => {
      const issues = store.list();
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        issues,
      };
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        defaultUri: vscode.Uri.file(`dostuff-issues-${new Date().toISOString().slice(0, 10)}.json`),
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
      const list: Issue[] = Array.isArray(parsed)
        ? (parsed as Issue[])
        : (parsed as any).issues;
      if (!Array.isArray(list)) {
        vscode.window.showErrorMessage("Expected an array or { issues: [...] }.");
        return;
      }
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Merge by id", value: "merge" },
          { label: "Replace all (destructive)", value: "replace" },
        ],
        { placeHolder: `Import ${list.length} issues — how?` }
      );
      if (!mode) return;
      if (mode.value === "replace") await store.replaceAll(list);
      else await store.mergeAll(list);
      vscode.window.showInformationMessage(
        `${mode.value === "replace" ? "Replaced with" : "Merged"} ${list.length} issues.`
      );
    }),

    store,
  );

  // ─── MCP server ───────────────────────────────────────────────────────
  const mcp = new DoStuffMcpServer(store);
  context.subscriptions.push(
    mcp,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dostuff.mcp")) mcp.reconcile();
    }),
    vscode.commands.registerCommand("dostuff.mcp.toggle", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const enabled = cfg.get<boolean>("mcp.enabled", true);
      await cfg.update("mcp.enabled", !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`DoStuff MCP server ${!enabled ? "enabled" : "disabled"}.`);
    }),
    vscode.commands.registerCommand("dostuff.mcp.editInstructions", async () => {
      const cfg = vscode.workspace.getConfiguration("dostuff");
      const current = cfg.get<string>("mcp.instructions", "");
      const next = await vscode.window.showInputBox({
        prompt: "System workflow instructions served to MCP clients (blank = built-in default)",
        value: current,
        ignoreFocusOut: true,
      });
      if (next === undefined) return;
      await cfg.update("mcp.instructions", next, vscode.ConfigurationTarget.Global);
    }),
  );
  await mcp.reconcile();
}

export function deactivate() {}
