// VSCode adapter for the MCP host seam (`mcpHost.ts`): maps live workspace
// settings, the workspace folder, and an OutputChannel onto the vscode-free
// interfaces the server consumes. This module is intentionally tiny and
// SDK-free so `extension.ts` can import it eagerly while `mcpServer.ts`
// (MCP SDK + zod) stays a lazy import.

import * as path from "node:path";
import * as vscode from "vscode";
import { ACTIVE_LANE_CAP } from "./types";
import {
  DEFAULT_RECORD_LIMIT,
  type Logger,
  type McpConfig,
  type WorkspaceIdentity,
} from "./mcpHost";

/**
 * Snapshot the `dostuff.*` settings the MCP server consumes. Raw values only —
 * coercion (port ranges, record-limit clamps, prompt fallback) happens in core
 * at the point of use.
 */
export function readVsCodeMcpConfig(): McpConfig {
  const cfg = vscode.workspace.getConfiguration("dostuff");
  return {
    enabled: cfg.get<boolean>("mcp.enabled", true),
    preferredPort: cfg.get<number>("mcp.port", 0),
    instructions: cfg.get<string>("mcp.instructions"),
    activeLaneCap: cfg.get<number>("activeLaneCap", ACTIVE_LANE_CAP),
    recordLimit: cfg.get<number>("mcp.recordLimit", DEFAULT_RECORD_LIMIT),
  };
}

/**
 * Workspace identity for the registry and for the `workspace` field stamped
 * into tool responses. `dostuff.mcp.workspaceOverride` lets the user pin an
 * explicit path when the auto-pick is wrong; otherwise the first workspace
 * folder wins. Null when no folder is open (the server stays stopped).
 */
export function vsCodeWorkspaceId(): WorkspaceIdentity | null {
  const override = vscode.workspace
    .getConfiguration("dostuff")
    .get<string>("mcp.workspaceOverride", "")
    .trim();
  if (override) return { path: override, name: path.basename(override) || override };
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return null;
  return { path: root.uri.fsPath, name: root.name };
}

/** Logger backed by a VSCode OutputChannel. */
export function outputChannelLogger(name: string): Logger {
  const channel = vscode.window.createOutputChannel(name);
  return {
    info: (m) => channel.appendLine(m),
    warn: (m) => channel.appendLine(`WARN: ${m}`),
    error: (m) => channel.appendLine(`ERROR: ${m}`),
    dispose: () => channel.dispose(),
  };
}
