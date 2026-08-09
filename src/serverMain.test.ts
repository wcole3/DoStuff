// Tests for the headless server entry point.
//
// Unit: CLI parsing, tolerant JSONC, settings flattening, config precedence,
// singleton gate. E2E: build dist/server.cjs with the real esbuild config
// (which doubles as the vscode-free build guard), spawn it against a temp
// workspace + temp registry, drive it over raw HTTP, and assert parity with
// the in-process extension-hosted server.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import esbuild from "esbuild";
import {
  findLiveConflict,
  parseArgs,
  readWorkspaceSettings,
  resolveServerConfig,
  stripJsonc,
  type CliOptions,
} from "./serverMain";
import { DEFAULT_RECORD_LIMIT } from "./mcpHost";
import { ACTIVE_LANE_CAP } from "./types";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SERVER_CJS = path.join(REPO_ROOT, "dist", "server.cjs");

let tmpDirs: string[] = [];
function tempDir(prefix = "dostuff-headless-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function serveOpts(workspace: string, extra: Partial<CliOptions> = {}): CliOptions {
  return {
    command: "serve",
    workspace,
    takeover: false,
    noSync: false,
    printConfig: false,
    ...extra,
  };
}

// ─── unit: CLI parsing ────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("serve with flags", () => {
    const r = parseArgs(["serve", "--workspace", "/tmp/x", "--port", "4001", "--takeover"]);
    expect(r).toMatchObject({
      command: "serve",
      workspace: path.resolve("/tmp/x"),
      port: 4001,
      takeover: true,
    });
  });

  test("status, bare help, and error cases", () => {
    expect(parseArgs(["status"])).toMatchObject({ command: "status" });
    expect(parseArgs([])).toMatchObject({ command: "help" });
    expect(parseArgs(["frobnicate"])).toEqual({ error: "Unknown command: frobnicate" });
    expect(parseArgs(["serve", "--port"])).toEqual({ error: "--port requires a number" });
    expect(parseArgs(["serve", "--port", "abc"])).toEqual({ error: "--port requires a number" });
    expect(parseArgs(["serve", "--wat"])).toEqual({ error: "Unknown flag: --wat" });
  });
});

// ─── unit: JSONC + settings ───────────────────────────────────────────────

describe("stripJsonc", () => {
  test("strips comments and trailing commas but not inside strings", () => {
    const src = `{
      // line comment
      "url": "https://example.com/path", /* block */
      "note": "a // not-comment /* still-not */ b",
      "list": [1, 2, 3,],
      "last": true, // trailing comma hidden behind a comment
    }`;
    const parsed = JSON.parse(stripJsonc(src));
    expect(parsed.url).toBe("https://example.com/path");
    expect(parsed.note).toBe("a // not-comment /* still-not */ b");
    expect(parsed.list).toEqual([1, 2, 3]);
    expect(parsed.last).toBe(true);
  });
});

describe("readWorkspaceSettings", () => {
  test("flat dotted keys, nested dostuff object, and JSONC all resolve", () => {
    const ws = tempDir();
    fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".vscode", "settings.json"),
      `{
        // flat spelling
        "dostuff.activeLaneCap": 4,
        "dostuff.mcp.port": 4200,
        // nested spelling
        "dostuff": { "mcp": { "recordLimit": 7 }, "storagePath": "custom/dir" },
        "editor.fontSize": 14,
      }`,
    );
    const settings = readWorkspaceSettings(ws);
    expect(settings["activeLaneCap"]).toBe(4);
    expect(settings["mcp.port"]).toBe(4200);
    expect(settings["mcp.recordLimit"]).toBe(7);
    expect(settings["storagePath"]).toBe("custom/dir");
    expect(settings["editor.fontSize"]).toBeUndefined();
  });

  test("missing or unparsable settings.json degrades to empty, never throws", () => {
    const ws = tempDir();
    expect(readWorkspaceSettings(ws)).toEqual({});
    fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".vscode", "settings.json"), "{ not json at all");
    expect(readWorkspaceSettings(ws)).toEqual({});
  });
});

describe("resolveServerConfig precedence", () => {
  test("flags > env > settings.json > defaults, with provenance", () => {
    const ws = tempDir();
    fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".vscode", "settings.json"),
      JSON.stringify({
        "dostuff.mcp.port": 4111,
        "dostuff.activeLaneCap": 9,
        "dostuff.mcp.recordLimit": 2,
      }),
    );

    process.env.DOSTUFF_ACTIVE_LANE_CAP = "5";
    try {
      const r = resolveServerConfig(serveOpts(ws, { port: 4999 }));
      expect(r.mcp.preferredPort).toBe(4999);
      expect(r.provenance.port).toBe("flag");
      expect(r.mcp.activeLaneCap).toBe(5);
      expect(r.provenance.activeLaneCap).toBe("env DOSTUFF_ACTIVE_LANE_CAP");
      expect(r.mcp.recordLimit).toBe(2);
      expect(r.provenance.recordLimit).toBe("settings.json");
      expect(r.provenance.instructions).toBe("default");
    } finally {
      delete process.env.DOSTUFF_ACTIVE_LANE_CAP;
    }
  });

  test("defaults when nothing is configured; storagePath resolves under the workspace", () => {
    const ws = tempDir();
    const r = resolveServerConfig(serveOpts(ws));
    expect(r.mcp.preferredPort).toBe(0);
    expect(r.mcp.activeLaneCap).toBe(ACTIVE_LANE_CAP);
    expect(r.mcp.recordLimit).toBe(DEFAULT_RECORD_LIMIT);
    expect(r.storageDir).toBe(path.join(ws, ".vscode", "dostuff"));
    expect(r.syncEnabled).toBe(false);
  });
});

// ─── e2e: spawn dist/server.cjs ───────────────────────────────────────────

interface SpawnedServer {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
}

const liveServers: SpawnedServer[] = [];

async function readFirstLine(stream: ReadableStream<Uint8Array>, timeoutMs = 10_000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!buf.includes("\n")) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for output; got: ${buf}`);
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
  return buf.split("\n")[0];
}

function spawnServer(args: string[], registryPath: string) {
  return Bun.spawn(["node", SERVER_CJS, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DOSTUFF_REGISTRY_PATH: registryPath },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function startServer(workspace: string, registryPath: string, extra: string[] = []): Promise<SpawnedServer> {
  const proc = spawnServer(["serve", "--workspace", workspace, ...extra], registryPath);
  const line = await readFirstLine(proc.stdout as ReadableStream<Uint8Array>);
  const parsed = JSON.parse(line) as { port: number };
  const server = { proc, port: parsed.port };
  liveServers.push(server);
  return server;
}

async function stopAll(): Promise<void> {
  for (const s of liveServers.splice(0)) {
    s.proc.kill("SIGTERM");
    await s.proc.exited;
  }
}

/** Raw JSON-RPC POST via node:http (avoids the happy-dom fetch/Response patch). */
function mcpJsonRpc(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result?: unknown; error?: { message: string } }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const sseMatch = data.match(/data:\s*(\{[\s\S]*?\})\s*$/m);
            resolve(JSON.parse(sseMatch ? sseMatch[1] : data));
          } catch (e) {
            reject(new Error(`bad response (${res.statusCode}): ${data.slice(0, 300)}: ${e}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function toolText(rpc: { result?: unknown }): string {
  const content = (rpc.result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? "";
}

describe("headless server e2e", () => {
  beforeAll(async () => {
    // Build the real target — this is also the vscode-free guard: a `vscode`
    // import anywhere in the server's module graph fails right here.
    const { serverConfig } = await import("../scripts/esbuild.config");
    await esbuild.build({ ...serverConfig, logLevel: "silent" });
    fs.mkdirSync(path.join(REPO_ROOT, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      path.join(REPO_ROOT, "dist", "sql-wasm.wasm"),
    );
  });

  afterAll(async () => {
    await stopAll();
  });

  afterEach(async () => {
    await stopAll();
  });

  test("serve → create/list over HTTP → DB on disk → SIGTERM unregisters", async () => {
    const ws = tempDir();
    const registry = path.join(tempDir(), "instances.json");
    const server = await startServer(ws, registry);
    expect(server.port).toBeGreaterThan(0);

    // Registry entry present while running.
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as Array<{ port: number }>;
    expect(entries.some((e) => e.port === server.port)).toBe(true);

    const created = await mcpJsonRpc(server.port, "tools/call", {
      name: "create_ticket",
      arguments: { title: "headless e2e", tasks: ["one"] },
    });
    expect(JSON.parse(toolText(created))).toMatchObject({ id: "DS-001", status: "Thinking" });

    const listed = await mcpJsonRpc(server.port, "tools/call", {
      name: "list_issues",
      arguments: {},
    });
    const listBody = JSON.parse(toolText(listed)) as { count: number; workspace: { rootPath: string } };
    expect(listBody.count).toBe(1);
    expect(listBody.workspace.rootPath).toBe(ws);

    // Same DB location the extension would use.
    expect(fs.existsSync(path.join(ws, ".vscode", "dostuff", "dostuff.db"))).toBe(true);

    server.proc.kill("SIGTERM");
    await server.proc.exited;
    liveServers.length = 0;
    const after = JSON.parse(fs.readFileSync(registry, "utf8")) as Array<{ port: number }>;
    expect(after.some((e) => e.port === server.port)).toBe(false);
  });

  test("agent write boundaries hold headless: no create into active lanes, terminal targets rejected", async () => {
    const ws = tempDir();
    const registry = path.join(tempDir(), "instances.json");
    const server = await startServer(ws, registry);

    await mcpJsonRpc(server.port, "tools/call", {
      name: "create_ticket",
      arguments: { title: "gate check" },
    });
    const res = await mcpJsonRpc(server.port, "tools/call", {
      name: "update_ticket_status",
      arguments: { id: "DS-001", status: "Complete" },
    });
    expect((res.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(res)).toContain("Only a human");
  });

  test("singleton gate: second serve exits 3; --takeover starts anyway", async () => {
    const ws = tempDir();
    const registry = path.join(tempDir(), "instances.json");
    await startServer(ws, registry);

    const second = spawnServer(["serve", "--workspace", ws], registry);
    const code = await second.exited;
    expect(code).toBe(3);
    const errText = await new Response(second.stderr as ReadableStream<Uint8Array>).text();
    expect(errText).toContain("already served");
    expect(errText).toContain("--takeover");

    const third = await startServer(ws, registry, ["--takeover"]);
    expect(third.port).toBeGreaterThan(0);
  });

  test("initialize instructions and tools/list are byte-identical to the extension-hosted server", async () => {
    const ws = tempDir();
    const registry = path.join(tempDir(), "instances.json");
    const headless = await startServer(ws, registry);

    const { makeTestStore, bootServer, restoreMcpConfig } = await import("./testSupport");
    const store = await makeTestStore();
    const hosted = await bootServer(store);
    try {
      const init = (p: number) =>
        mcpJsonRpc(p, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "parity", version: "0" },
        });
      const [initA, initB] = await Promise.all([init(headless.port), init(hosted.port)]);
      const instrA = (initA.result as { instructions?: string }).instructions;
      const instrB = (initB.result as { instructions?: string }).instructions;
      expect(instrA).toBeDefined();
      expect(instrA).toBe(instrB!);

      const [toolsA, toolsB] = await Promise.all([
        mcpJsonRpc(headless.port, "tools/list", {}),
        mcpJsonRpc(hosted.port, "tools/list", {}),
      ]);
      expect(JSON.stringify((toolsA.result as { tools: unknown }).tools)).toBe(
        JSON.stringify((toolsB.result as { tools: unknown }).tools),
      );
    } finally {
      await hosted.server.stop();
      hosted.server.dispose();
      restoreMcpConfig();
    }
  });

  test("--print-config reports resolved values without starting a server", async () => {
    const ws = tempDir();
    fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".vscode", "settings.json"),
      `{ "dostuff.activeLaneCap": 3, /* jsonc */ }`,
    );
    const registry = path.join(tempDir(), "instances.json");
    const proc = spawnServer(["serve", "--workspace", ws, "--print-config"], registry);
    const code = await proc.exited;
    expect(code).toBe(0);
    const out = JSON.parse(await new Response(proc.stdout as ReadableStream<Uint8Array>).text());
    expect(out.mcp.activeLaneCap).toBe(3);
    expect(out.provenance.activeLaneCap).toBe("settings.json");
    expect(fs.existsSync(registry)).toBe(false);
  });
});

// ─── unit: singleton gate helper ──────────────────────────────────────────

describe("findLiveConflict", () => {
  test("flags a live entry for the same workspace, ignores dead pids and other workspaces", () => {
    const registryDir = tempDir();
    const registry = path.join(registryDir, "instances.json");
    const ws = tempDir();
    const orig = process.env.DOSTUFF_REGISTRY_PATH;
    process.env.DOSTUFF_REGISTRY_PATH = registry;
    try {
      // Live pid (this test process), same workspace → conflict.
      fs.writeFileSync(
        registry,
        JSON.stringify([
          { workspacePath: ws, port: 1111, pid: 999999999, name: "dead", startedAt: "2026-01-01T00:00:00.000Z" },
          { workspacePath: path.join(ws, "other"), port: 2222, pid: process.pid, name: "other", startedAt: "2026-01-01T00:00:00.000Z" },
        ]),
      );
      expect(findLiveConflict(ws)).toBeNull();

      fs.writeFileSync(
        registry,
        JSON.stringify([
          { workspacePath: ws, port: 3333, pid: process.ppid, name: "live", startedAt: "2026-01-01T00:00:00.000Z" },
        ]),
      );
      const conflict = findLiveConflict(ws);
      expect(conflict?.port).toBe(3333);
    } finally {
      if (orig === undefined) delete process.env.DOSTUFF_REGISTRY_PATH;
      else process.env.DOSTUFF_REGISTRY_PATH = orig;
    }
  });
});
