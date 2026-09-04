// dostuff-server — headless DoStuff ticket server (dist/server.cjs).
//
// Serves the same loopback MCP HTTP API as the VSCode extension, against the
// same <workspace>/.vscode/dostuff/dostuff.db, registered in the same
// ~/.config/dostuff/instances.json — so the agent skill's `dostuff.sh
// discover` finds it with zero changes and every client goes through the one
// write path (storageCore + mcpServer gates).
//
//   node dist/server.cjs serve [--workspace PATH] [--port N]
//                              [--storage-dir PATH] [--takeover] [--no-sync]
//                              [--print-config]
//   node dist/server.cjs status
//
// Config resolution, most-specific wins:
//   flags > DOSTUFF_* env > <workspace>/.vscode/settings.json dostuff.* keys > defaults
//
// The settings-file parse is what keeps one workspace behaving identically
// under both hosts (same lane cap, same record limit) without a second
// config file. Tolerant JSONC: comments and trailing commas are stripped;
// a file that still fails to parse means defaults + a warning, never a crash.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  coercePreferredPort,
  coerceRecordLimit,
  DEFAULT_RECORD_LIMIT,
  type Logger,
  type McpConfig,
} from "./mcpHost";
import { ACTIVE_LANE_CAP } from "./types";
import { isPidAlive, loadRegistry, normalizeWorkspacePath } from "./mcpRegistry";

// ─── CLI parsing ──────────────────────────────────────────────────────────

export interface CliOptions {
  command: "serve" | "status" | "help";
  workspace: string;
  port?: number;
  storageDir?: string;
  takeover: boolean;
  noSync: boolean;
  printConfig: boolean;
}

export function parseArgs(argv: string[]): CliOptions | { error: string } {
  const opts: CliOptions = {
    command: "help",
    workspace: process.cwd(),
    takeover: false,
    noSync: false,
    printConfig: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    switch (arg) {
      case "--workspace": {
        const v = needsValue();
        if (v === null) return { error: "--workspace requires a path" };
        opts.workspace = path.resolve(v);
        break;
      }
      case "--port": {
        const v = needsValue();
        if (v === null || !/^\d+$/.test(v)) return { error: "--port requires a number" };
        opts.port = parseInt(v, 10);
        break;
      }
      case "--storage-dir": {
        const v = needsValue();
        if (v === null) return { error: "--storage-dir requires a path" };
        opts.storageDir = path.resolve(v);
        break;
      }
      case "--takeover":
        opts.takeover = true;
        break;
      case "--no-sync":
        opts.noSync = true;
        break;
      case "--print-config":
        opts.printConfig = true;
        break;
      case "--help":
      case "-h":
        return { ...opts, command: "help" };
      default:
        if (arg.startsWith("--")) return { error: `Unknown flag: ${arg}` };
        positional.push(arg);
    }
  }
  const cmd = positional[0];
  if (cmd === "serve" || cmd === "status") opts.command = cmd;
  else if (cmd !== undefined) return { error: `Unknown command: ${cmd}` };
  return opts;
}

export const USAGE = `dostuff-server — headless DoStuff ticket server

Usage:
  dostuff-server serve [--workspace PATH] [--port N] [--storage-dir PATH]
                       [--takeover] [--no-sync] [--print-config]
  dostuff-server status

serve      Serve the loopback MCP HTTP API for a workspace (default: cwd).
status     Print the instance registry (who serves which workspace).

Config resolution (most specific wins): flags > DOSTUFF_MCP_PORT /
DOSTUFF_STORAGE_DIR / DOSTUFF_ACTIVE_LANE_CAP / DOSTUFF_MCP_RECORD_LIMIT /
DOSTUFF_MCP_INSTRUCTIONS env > <workspace>/.vscode/settings.json "dostuff.*"
keys > defaults. --print-config shows the resolved values and where each
came from, then exits.

Exit codes: 0 ok, 1 error, 2 bad usage, 3 workspace already served
(another live process; use --takeover to start anyway).
`;

// ─── tolerant JSONC ───────────────────────────────────────────────────────

/**
 * Strip // and /* *\/ comments plus trailing commas, string-aware — the two
 * VSCode-isms that break JSON.parse on real settings.json files. Anything
 * fancier (unquoted keys, single quotes) is out of scope: parse failure
 * downstream degrades to defaults + warning.
 */
export function stripJsonc(text: string): string {
  // Pass 1: strip comments (string-aware). Must run before the trailing-comma
  // pass, or a comma followed by a comment then `}` survives both passes.
  let noComments = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      noComments += ch;
      if (ch === "\\" && i + 1 < text.length) {
        noComments += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    noComments += ch;
    i += 1;
  }

  // Pass 2: drop trailing commas (string-aware).
  let out = "";
  i = 0;
  inString = false;
  while (i < noComments.length) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < noComments.length) {
        out += noComments[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j += 1;
      if (noComments[j] === "}" || noComments[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Read the `dostuff.*` keys from `<workspace>/.vscode/settings.json`.
 * Supports both spellings VSCode accepts: flat dotted keys
 * (`"dostuff.mcp.port": 4001`) and a nested `"dostuff"` object. Returns
 * dotted keys without the `dostuff.` prefix (e.g. `mcp.port`).
 */
export function readWorkspaceSettings(
  workspace: string,
  logger?: Logger,
): Record<string, unknown> {
  const file = path.join(workspace, ".vscode", "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch (e) {
    logger?.warn(
      `Could not parse ${file} (${(e as Error).message}); using defaults for dostuff.* settings.`,
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, unknown> = {};
  const flatten = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        flatten(v as Record<string, unknown>, key);
      } else {
        out[key] = v;
      }
    }
  };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === "dostuff" && v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, "");
    } else if (k.startsWith("dostuff.")) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        flatten(v as Record<string, unknown>, k.slice("dostuff.".length));
      } else {
        out[k.slice("dostuff.".length)] = v;
      }
    }
  }
  return out;
}

// ─── config resolution ────────────────────────────────────────────────────

export interface ResolvedServerConfig {
  workspace: string;
  storageDir: string;
  mcp: McpConfig;
  syncEnabled: boolean;
  /** Where each value came from — printed by --print-config. */
  provenance: Record<string, string>;
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  return parseInt(v, 10);
}

/**
 * Resolve the effective config for a serve run. Called per read (the MCP
 * server's config provider), so a live edit to settings.json applies to the
 * next request without a restart — same behavior as the extension host.
 */
export function resolveServerConfig(opts: CliOptions, logger?: Logger): ResolvedServerConfig {
  const settings = readWorkspaceSettings(opts.workspace, logger);
  const provenance: Record<string, string> = {};

  const pick = <T>(
    key: string,
    flag: T | undefined,
    env: { name: string; value: T | undefined },
    setting: unknown,
    fallback: T,
  ): T => {
    if (flag !== undefined) {
      provenance[key] = "flag";
      return flag;
    }
    if (env.value !== undefined) {
      provenance[key] = `env ${env.name}`;
      return env.value;
    }
    if (setting !== undefined) {
      provenance[key] = "settings.json";
      return setting as T;
    }
    provenance[key] = "default";
    return fallback;
  };

  const port = pick(
    "port",
    opts.port,
    { name: "DOSTUFF_MCP_PORT", value: envInt("DOSTUFF_MCP_PORT") },
    settings["mcp.port"],
    0,
  );
  const storageRelOrAbs = pick(
    "storageDir",
    opts.storageDir,
    { name: "DOSTUFF_STORAGE_DIR", value: process.env.DOSTUFF_STORAGE_DIR },
    settings["storagePath"],
    ".vscode/dostuff",
  );
  const storageDir = path.isAbsolute(storageRelOrAbs)
    ? storageRelOrAbs
    : path.join(opts.workspace, storageRelOrAbs);
  const activeLaneCap = pick(
    "activeLaneCap",
    undefined,
    { name: "DOSTUFF_ACTIVE_LANE_CAP", value: envInt("DOSTUFF_ACTIVE_LANE_CAP") },
    settings["activeLaneCap"],
    ACTIVE_LANE_CAP,
  );
  const recordLimit = pick(
    "recordLimit",
    undefined,
    { name: "DOSTUFF_MCP_RECORD_LIMIT", value: envInt("DOSTUFF_MCP_RECORD_LIMIT") },
    settings["mcp.recordLimit"],
    DEFAULT_RECORD_LIMIT,
  );
  const instructions = pick<string | undefined>(
    "instructions",
    undefined,
    { name: "DOSTUFF_MCP_INSTRUCTIONS", value: process.env.DOSTUFF_MCP_INSTRUCTIONS },
    settings["mcp.instructions"],
    undefined,
  );
  const syncEnabled = pick<boolean | undefined>(
    "syncEnabled",
    opts.noSync ? false : undefined,
    { name: "", value: undefined },
    settings["sync.enabled"],
    false,
  );

  return {
    workspace: opts.workspace,
    storageDir,
    mcp: {
      // `serve` means serve: the extension's mcp.enabled toggle governs the
      // extension's server, not an explicitly launched headless one.
      enabled: true,
      preferredPort: coercePreferredPort(port),
      instructions,
      activeLaneCap: typeof activeLaneCap === "number" ? activeLaneCap : ACTIVE_LANE_CAP,
      recordLimit: coerceRecordLimit(recordLimit),
    },
    syncEnabled: syncEnabled === true,
    provenance,
  };
}

// ─── singleton gate ───────────────────────────────────────────────────────

/**
 * Refuse to serve a workspace that a live process already serves — two
 * writers of a wholesale-rewrite DB clobber each other (sync off). Returns
 * the conflicting entry, or null when the workspace is free.
 */
export function findLiveConflict(
  workspace: string,
): { workspacePath: string; port: number; pid: number } | null {
  const normalized = normalizeWorkspacePath(workspace);
  for (const e of loadRegistry()) {
    if (!isPidAlive(e.pid)) continue;
    if (e.pid === process.pid) continue;
    if (normalizeWorkspacePath(e.workspacePath) === normalized) return e;
  }
  return null;
}

// ─── wiring ───────────────────────────────────────────────────────────────

export function stderrLogger(): Logger {
  const stamp = () => new Date().toISOString();
  return {
    info: (m) => process.stderr.write(`[${stamp()}] ${m}\n`),
    warn: (m) => process.stderr.write(`[${stamp()}] WARN: ${m}\n`),
    error: (m) => process.stderr.write(`[${stamp()}] ERROR: ${m}\n`),
  };
}

/** dist/server.cjs sits next to sql-wasm.wasm; dev/test runs resolve node_modules. */
export function resolveWasmPath(): string {
  const dir =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(dir, "sql-wasm.wasm"),
    path.join(dir, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(dir, "..", "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`sql-wasm.wasm not found near ${dir}`);
}

async function runServe(opts: CliOptions): Promise<number> {
  const logger = stderrLogger();
  const resolved = resolveServerConfig(opts, logger);

  if (opts.printConfig) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  }

  if (!fs.existsSync(resolved.workspace)) {
    logger.error(`Workspace does not exist: ${resolved.workspace}`);
    return 1;
  }

  const conflict = findLiveConflict(resolved.workspace);
  if (conflict && !opts.takeover) {
    logger.error(
      `Workspace ${resolved.workspace} is already served by pid ${conflict.pid} ` +
        `on port ${conflict.port}. Point your agent at that instance, or pass ` +
        `--takeover if it is a zombie.`,
    );
    return 3;
  }

  const { IssueStoreCore } = await import("./storageCore");
  const { DoStuffMcpServer } = await import("./mcpServer");

  const wasmPath = resolveWasmPath();
  const store = new IssueStoreCore({
    storageDir: () => resolveServerConfig(opts).storageDir,
    wasmBinary: async () => fs.readFileSync(wasmPath),
    logger,
  });
  await store.init();
  logger.info(`Store ready: ${resolved.storageDir} (${store.list().length} tickets)`);

  // Git ticket sync — same controller the extension runs, `Logger` as the
  // notification surface. With sync on, a headless server and an open VSCode
  // window on the same clone reconcile through the ref like two windows do.
  let sync: { dispose(): void } | null = null;
  if (resolved.syncEnabled && !opts.noSync) {
    const { GitSyncController, clampSyncInterval } = await import("./gitSync");
    const settings = readWorkspaceSettings(resolved.workspace, logger);
    const controller = new GitSyncController(store, () => resolved.workspace, {
      remote: typeof settings["sync.remote"] === "string" ? (settings["sync.remote"] as string) : "origin",
      ref: typeof settings["sync.ref"] === "string" ? (settings["sync.ref"] as string) : "refs/dostuff/state",
      intervalMinutes: clampSyncInterval(settings["sync.intervalMinutes"] ?? 5),
      activeLaneCap: resolved.mcp.activeLaneCap,
      syncAttachments: settings["sync.syncAttachments"] !== false,
      maxAttachmentSyncBytes:
        typeof settings["sync.maxAttachmentSyncBytes"] === "number"
          ? (settings["sync.maxAttachmentSyncBytes"] as number)
          : undefined,
      notify: (kind, message) =>
        kind === "warn" ? logger.warn(`sync: ${message}`) : logger.info(`sync: ${message}`),
    });
    controller.onStatusChange((s) =>
      logger.info(`sync status: ${s.state}${s.detail ? ` (${s.detail})` : ""}`),
    );
    controller.start();
    sync = controller;
  }

  const workspaceId = () => ({
    path: resolved.workspace,
    name: path.basename(resolved.workspace) || resolved.workspace,
  });
  const server = new DoStuffMcpServer(store, workspaceId, {
    // Live provider: settings.json edits apply on the next request,
    // matching the extension host's behavior.
    config: () => resolveServerConfig(opts).mcp,
    logger,
  });
  await server.reconcile();
  if (!server.status.running) {
    logger.error("Server failed to start; see log above.");
    sync?.dispose();
    await store.close();
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ port: server.status.port, workspace: resolved.workspace })}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — shutting down.`);
    sync?.dispose();
    try {
      await server.stop();
    } catch {}
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // The HTTP listener keeps the event loop alive from here.
  return 0;
}

function runStatus(): number {
  const entries = loadRegistry();
  if (entries.length === 0) {
    process.stdout.write("No registered DoStuff instances.\n");
    return 0;
  }
  for (const e of entries) {
    const alive = isPidAlive(e.pid) ? "live" : "dead";
    process.stdout.write(
      `${e.workspacePath}\tport ${e.port}\tpid ${e.pid} (${alive})\tsince ${e.startedAt}\n`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  switch (parsed.command) {
    case "serve":
      return runServe(parsed);
    case "status":
      return runStatus();
    default:
      process.stdout.write(USAGE);
      return 0;
  }
}

// Entry point when run directly (dist/server.cjs); inert under `import` in tests.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    // `serve` returns 0 while the listener keeps the process alive — only
    // exit eagerly on non-zero (errors) or for the one-shot commands.
    if (code !== 0) process.exit(code);
    if (process.argv[2] !== "serve" || process.argv.includes("--print-config")) process.exit(0);
  });
}
