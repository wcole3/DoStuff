// Host seam for the MCP server — the boundary that keeps `mcpServer.ts`
// vscode-free so a headless CLI (dist/server.cjs) can serve the same API.
//
// The extension adapts VSCode settings/OutputChannel onto these interfaces in
// `mcpHostVscode.ts`; tests stub them in `testSupport.ts`; the headless entry
// point resolves them from flags/env/settings-file. Coercion of raw config
// values (ports, record limits, prompt fallback) lives HERE, once, so every
// host feeds the server through the same validation.

import { ACTIVE_LANE_CAP } from "./types";
import { buildDefaultWorkflowPrompt } from "./workflowPrompt";
import { FIELD_LIMITS } from "./mcpLimits";

// Newest record entries served by default. The log is append-only and
// union-merged by sync, so it only grows; three entries carry the thread far
// enough to resume after a context loss, and `recordLimit` is the escape hatch.
export const DEFAULT_RECORD_LIMIT = 3;
export const MAX_RECORD_LIMIT = FIELD_LIMITS.recordLimitMax;

/** Which workspace this server instance fronts (registry identity). */
export interface WorkspaceIdentity {
  path: string;
  name: string;
}

/**
 * Raw MCP-relevant configuration as a host resolved it. Values are accepted
 * as-is from the host and coerced at the point of use (`coercePreferredPort`,
 * `coerceRecordLimit`, `resolveWorkflowPrompt`) so a sloppy host cannot skip
 * validation.
 */
export interface McpConfig {
  enabled: boolean;
  /** Preferred TCP port; 0 = OS-assigned. Coerced via `coercePreferredPort`. */
  preferredPort: number;
  /** Custom workflow-instructions override; undefined/blank = built-in default. */
  instructions?: string;
  activeLaneCap: number;
  /** Default record window for reads. Coerced via `coerceRecordLimit`. */
  recordLimit: number;
}

/** Live config source — called per read so setting changes apply without restart. */
export type McpConfigProvider = () => McpConfig;

export function defaultMcpConfig(): McpConfig {
  return {
    enabled: true,
    preferredPort: 0,
    instructions: undefined,
    activeLaneCap: ACTIVE_LANE_CAP,
    recordLimit: DEFAULT_RECORD_LIMIT,
  };
}

/** Minimal logging sink. VSCode: OutputChannel. Headless: stderr. Tests: silent. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  dispose?(): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Coerce a raw preferred-port value. Returns 0 (let the OS pick) when the
 * value is missing, out of range, or non-integer. Ports 1–1023 are coerced to
 * 0 to avoid surprises with privileged ports.
 */
export function coercePreferredPort(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return 0;
  if (raw === 0) return 0;
  if (raw < 1024 || raw > 65535) return 0;
  return raw;
}

/**
 * Back-compat shim for the config-object form: reads `mcp.port` off anything
 * shaped like a VSCode `WorkspaceConfiguration` and coerces it.
 */
export function readPreferredPort(cfg: {
  get<T>(section: string, defaultValue: T): T;
}): number {
  return coercePreferredPort(cfg.get<number>("mcp.port", 0));
}

/** Clamp a raw record-limit config value; non-integer/negative → default. */
export function coerceRecordLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_RECORD_LIMIT;
  }
  return Math.min(raw, MAX_RECORD_LIMIT);
}

/** Custom instructions when non-blank, else the default prompt at the live cap. */
export function resolveWorkflowPrompt(cfg: Pick<McpConfig, "instructions" | "activeLaneCap">): string {
  if (cfg.instructions && cfg.instructions.trim()) return cfg.instructions;
  return buildDefaultWorkflowPrompt(cfg.activeLaneCap);
}

/**
 * What the tool/resource handlers need from the host at request time. Pure
 * handlers take this as an optional argument and default to `DEFAULT_TOOL_HOST`
 * (no workspace, built-in caps) so direct calls in tests stay one-liners.
 */
export interface ToolHost {
  /** Workspace stamped into responses; null when no workspace is open. */
  workspace(): { name: string; rootPath: string } | null;
  /** Default record window for reads (already coerced). */
  recordLimit(): number;
  /** Live active-lane cap. */
  activeLaneCap(): number;
  /** Resolved workflow instructions (custom override or live-cap default). */
  workflowPrompt(): string;
}

export const DEFAULT_TOOL_HOST: ToolHost = {
  workspace: () => null,
  recordLimit: () => DEFAULT_RECORD_LIMIT,
  activeLaneCap: () => ACTIVE_LANE_CAP,
  workflowPrompt: () => buildDefaultWorkflowPrompt(ACTIVE_LANE_CAP),
};

/** Bind a live config provider + workspace callback into a ToolHost. */
export function makeToolHost(
  config: McpConfigProvider,
  workspaceId: () => WorkspaceIdentity | null,
): ToolHost {
  return {
    workspace: () => {
      const ws = workspaceId();
      return ws ? { name: ws.name, rootPath: ws.path } : null;
    },
    recordLimit: () => coerceRecordLimit(config().recordLimit),
    activeLaneCap: () => config().activeLaneCap,
    workflowPrompt: () => resolveWorkflowPrompt(config()),
  };
}
