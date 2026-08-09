// Tests for the Claude Code agent skill (skills/dostuff-tickets/).
//
// The skill is an alternative MCP *client*: SKILL.md + scripts/dostuff.sh let
// an agent drive the ticket queue over bare loopback HTTP without registering
// the server. These tests are the drift guard: tool coverage is derived from
// the real `registerMcpTools`, field caps from FIELD_LIMITS, and the script is
// exercised end-to-end against a live HTTP server.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMcpTools, type DoStuffMcpServer } from "./mcpServer";
import { FIELD_LIMITS } from "./mcpLimits";
import {
  bootServer,
  makeTestStore,
  restoreMcpConfig,
  setMcpConfig,
} from "./testSupport";

const SKILL_DIR = nodePath.resolve(import.meta.dir, "..", "skills", "dostuff-tickets");
const SKILL_MD = nodePath.join(SKILL_DIR, "SKILL.md");
const TOOLS_MD = nodePath.join(SKILL_DIR, "references", "tools.md");
const SCRIPT = nodePath.join(SKILL_DIR, "scripts", "dostuff.sh");

// Whole-file ceiling for SKILL.md. Unlike the MCP instructions (2KB, silently
// truncated by Claude Code), a skill body is not hard-cut — but it loads into
// context on every trigger and stays for the session, so it must remain far
// cheaper than the surface it replaces. Cut prose rather than raising this.
const SKILL_BODY_BYTE_BUDGET = 10_000;

// The always-in-context cost: Claude Code truncates the name+description skill
// listing entry at 1,536 chars. Stay well under so trigger phrases survive.
const SKILL_LISTING_CHAR_BUDGET = 1_024;

const skillMd = fs.readFileSync(SKILL_MD, "utf8");
const toolsMd = fs.readFileSync(TOOLS_MD, "utf8");
const script = fs.readFileSync(SCRIPT, "utf8");

function frontmatter(): Record<string, string> {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  expect(m).toBeTruthy();
  const out: Record<string, string> = {};
  let key = "";
  for (const line of m![1].split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2] === ">-" ? "" : kv[2];
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = (out[key] + " " + line.trim()).trim();
    }
  }
  return out;
}

async function registeredToolNames(): Promise<string[]> {
  setMcpConfig({});
  try {
    const store = await makeTestStore([]);
    const mcp = new McpServer({ name: "skill-test", version: "0.0.0" });
    registerMcpTools(mcp, store);
    const client = new Client({ name: "skill-test-client", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcp.connect(st)]);
    const res = await client.listTools();
    await client.close();
    return res.tools.map((t) => t.name);
  } finally {
    restoreMcpConfig();
  }
}

// Async on purpose: several tests call the script against an HTTP server that
// lives in THIS process — a spawnSync would block the event loop and deadlock
// the request until curl's timeout.
async function runScript(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", SCRIPT, ...args], {
    cwd: opts.cwd ?? SKILL_DIR,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// PATH with the tools the script needs but WITHOUT jq, to exercise the raw
// JSON-RPC fallback path.
function makeJqlessPath(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-nojq-"));
  for (const bin of ["sh", "awk", "curl", "grep", "cat", "cut", "sed"]) {
    const p = Bun.which(bin);
    if (p) fs.symlinkSync(p, nodePath.join(dir, bin));
  }
  return dir;
}

describe("agent skill: static shape", async () => {
  test("skill files exist and the script is valid sh", async () => {
    expect(fs.existsSync(SKILL_MD)).toBe(true);
    expect(fs.existsSync(TOOLS_MD)).toBe(true);
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const p = Bun.spawnSync(["sh", "-n", SCRIPT]);
    expect(p.exitCode).toBe(0);
  });

  test("frontmatter parses, names the skill, and scopes tools", async () => {
    const fm = frontmatter();
    expect(fm.name).toBe("dostuff-tickets");
    expect(fm["allowed-tools"]).toContain("Bash(curl:*)");
    expect(fm["allowed-tools"]).toContain("Bash(sh:*)");
  });

  test("name + description fit the listing budget and carry trigger phrases", async () => {
    const fm = frontmatter();
    const listing = `${fm.name}: ${fm.description}`;
    expect(listing.length).toBeLessThanOrEqual(SKILL_LISTING_CHAR_BUDGET);
    expect(fm.description).toMatch(/ticket/i);
    expect(fm.description).toContain("DS-");
    expect(fm.description).toMatch(/DoStuff/);
  });

  test("SKILL.md fits its byte budget", async () => {
    expect(Buffer.byteLength(skillMd, "utf8")).toBeLessThanOrEqual(SKILL_BODY_BYTE_BUDGET);
  });

  test("every registered MCP tool is documented in SKILL.md and references/tools.md", async () => {
    const names = await registeredToolNames();
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      expect(skillMd).toContain(name);
      expect(toolsMd).toContain(name);
    }
  });

  test("carries the human-approval, immutability, write-terse and recordLimit rules", async () => {
    expect(skillMd).toContain("request_ticket_close");
    expect(skillMd).toContain("request_ticket_complete");
    expect(skillMd).toMatch(/only a human/i);
    expect(skillMd).toMatch(/title, priority, type/);
    expect(skillMd).toContain("~15 words");
    expect(skillMd).toContain("recordLimit");
    expect(skillMd).toContain("Verification");
    expect(skillMd).toMatch(/mcp__dostuff__/); // coexistence rule with a registered server
  });

  test("documents the expectedUpdatedAt CAS guard on the replace-shaped writes", () => {
    // Concurrency L3: parallel subagents must know the opt-in stale-write
    // rejection exists, or the one-writer-per-ticket rule is their only tool.
    expect(skillMd).toContain("expectedUpdatedAt");
    expect(toolsMd).toContain("expectedUpdatedAt");
    expect(toolsMd).toMatch(/updatedAt.*from your last read/);
  });

  test("plugin manifest version tracks the extension version", () => {
    // The plugin marketplace channel only picks up skill changes when the
    // plugin version bumps; pin it to package.json so a release can't ship a
    // stale plugin. The extension-copy channel uses the same version for its
    // auto-update marker (skillInstall.ts).
    const root = nodePath.resolve(import.meta.dir, "..");
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8"));
    const plugin = JSON.parse(
      fs.readFileSync(nodePath.join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(plugin.version).toBe(pkg.version);
  });

  test("does not hardcode the active lane cap", async () => {
    // The cap tracks the dostuff.activeLaneCap setting; the skill must describe
    // it, never state a number that would drift.
    expect(skillMd).not.toMatch(/cap(ped)?\s*(at|of)?\s*\d/i);
    expect(toolsMd).not.toMatch(/cap(ped)?\s*(at|of)?\s*\d/i);
  });

  test("script cap table and reference doc stay in sync with FIELD_LIMITS", async () => {
    // Script cap table (field:max pairs, exact spellings).
    expect(script).toContain(`title:${FIELD_LIMITS.title}`);
    expect(script).toContain(`description:${FIELD_LIMITS.description}`);
    expect(script).toContain(`verifyCriteria:${FIELD_LIMITS.verifyCriteria}`);
    expect(script).toContain(`tasks:${FIELD_LIMITS.taskText}`);
    expect(script).toContain(`tags:${FIELD_LIMITS.tag}`);
    expect(script).toContain(`note:${FIELD_LIMITS.statusNote}`);
    expect(script).toContain(`recordEntry:${FIELD_LIMITS.recordEntry}`);
    expect(script).toContain(`note:${FIELD_LIMITS.note}`);
    expect(script).toContain(`{${FIELD_LIMITS.commitMinHex},${FIELD_LIMITS.commitMaxHex}}`);
    expect(script).toContain(`-le ${FIELD_LIMITS.recordLimitMax}`);
    expect(script).toContain(`-le ${FIELD_LIMITS.listLimitMax}`);
    // Reference doc carries the same numbers.
    expect(toolsMd).toContain(`${FIELD_LIMITS.title}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.description}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.statusNote}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.recordEntry}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.tag}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.commitMinHex}–${FIELD_LIMITS.commitMaxHex}`);
    expect(toolsMd).toContain(`${FIELD_LIMITS.listLimitMax}`);
  });
});

describe("agent skill: discovery", async () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  function writeRegistry(entries: object[]): string {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-skill-reg-"));
    const file = nodePath.join(tmpDir, "instances.json");
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
    return file;
  }

  test("picks the longest workspacePath prefix of cwd", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-skill-ws-"));
    const nested = nodePath.join(base, "repo", "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const reg = writeRegistry([
      { workspacePath: base, port: 1111, pid: 1, name: "outer", startedAt: "2026-01-01T00:00:00.000Z" },
      { workspacePath: nodePath.join(base, "repo"), port: 2222, pid: 1, name: "inner", startedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const r = await runScript(["discover"], { env: { DOSTUFF_REGISTRY_PATH: reg }, cwd: nested });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\t")[0]).toBe("2222");
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("breaks prefix ties by newest startedAt", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-skill-ws-"));
    const reg = writeRegistry([
      { workspacePath: base, port: 1111, pid: 1, name: "old", startedAt: "2026-01-01T00:00:00.000Z" },
      { workspacePath: base, port: 2222, pid: 2, name: "new", startedAt: "2026-06-01T00:00:00.000Z" },
    ]);
    const r = await runScript(["discover"], { env: { DOSTUFF_REGISTRY_PATH: reg }, cwd: base });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\t")[0]).toBe("2222");
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("falls back to a single entry when nothing matches, errors otherwise", async () => {
    const reg = writeRegistry([
      { workspacePath: "/nonexistent/elsewhere", port: 3333, pid: 1, name: "only", startedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const one = await runScript(["discover"], { env: { DOSTUFF_REGISTRY_PATH: reg }, cwd: os.tmpdir() });
    expect(one.code).toBe(0);
    expect(one.stdout.trim().split("\t")[0]).toBe("3333");

    fs.writeFileSync(
      nodePath.join(tmpDir, "instances.json"),
      JSON.stringify(
        [
          { workspacePath: "/nonexistent/a", port: 1, pid: 1, name: "a", startedAt: "2026-01-01T00:00:00.000Z" },
          { workspacePath: "/nonexistent/b", port: 2, pid: 2, name: "b", startedAt: "2026-01-01T00:00:00.000Z" },
        ],
        null,
        2,
      ),
    );
    const none = await runScript(["discover"], {
      env: { DOSTUFF_REGISTRY_PATH: nodePath.join(tmpDir, "instances.json") },
      cwd: os.tmpdir(),
    });
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("No DoStuff instance matches");
  });

  test("DOSTUFF_PORT short-circuits discovery", async () => {
    const r = await runScript(["discover"], { env: { DOSTUFF_PORT: "9" } });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\t")[0]).toBe("9");
  });
});

describe("agent skill: live server round-trip", async () => {
  let server: DoStuffMcpServer | null = null;
  let port = 0;
  let tmpRegistryDir = "";
  const origRegistryPath = process.env.DOSTUFF_REGISTRY_PATH;

  beforeAll(async () => {
    tmpRegistryDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dostuff-skill-live-"));
    process.env.DOSTUFF_REGISTRY_PATH = nodePath.join(tmpRegistryDir, "instances.json");
    const store = await makeTestStore([]);
    ({ server, port } = await bootServer(store));
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
      server.dispose();
      server = null;
    }
    restoreMcpConfig();
    if (origRegistryPath === undefined) delete process.env.DOSTUFF_REGISTRY_PATH;
    else process.env.DOSTUFF_REGISTRY_PATH = origRegistryPath;
    fs.rmSync(tmpRegistryDir, { recursive: true, force: true });
  });

  const env = () => ({ DOSTUFF_PORT: String(port) });

  test("create_ticket → Thinking → get_ticket round-trips through the script", async () => {
    const created = await runScript(
      ["call", "create_ticket", JSON.stringify({ title: "Skill e2e ticket", description: "From dostuff.sh." })],
      { env: env() },
    );
    expect(created.code).toBe(0);
    const payload = JSON.parse(created.stdout);
    expect(payload.status).toBe("Thinking");
    expect(payload.id).toMatch(/^DS-\d+$/);

    const fetched = await runScript(["call", "get_ticket", JSON.stringify({ query: payload.id })], { env: env() });
    expect(fetched.code).toBe(0);
    const ticket = JSON.parse(fetched.stdout).ticket;
    expect(ticket.id).toBe(payload.id);
    expect(ticket.title).toBe("Skill e2e ticket");
  });

  test("stdin args (`-`) and resource reads work", async () => {
    const listed = await runScript(["call", "list_issues", "-"], { env: env(), stdin: '{"limit":5}' });
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).count).toBeGreaterThanOrEqual(1);

    const res = await runScript(["resource", "dostuff://tickets"], { env: env() });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).tickets ?? JSON.parse(res.stdout)).toBeTruthy();
  });

  test("server-side rule errors surface as ERROR: with the reason", async () => {
    const r = await runScript(
      ["call", "update_ticket_status", JSON.stringify({ id: "DS-001", status: "Complete" })],
      { env: env() },
    );
    expect(r.stdout).toContain("ERROR:");
  });

  test("over-cap recordEntry is rejected locally with exit 2 and no request", async () => {
    const long = "x".repeat(FIELD_LIMITS.recordEntry + 1);
    // A dead port proves no request was attempted: a network error would exit 1
    // with the connectivity hint, not 2 with the cap message.
    const r = await runScript(
      ["call", "update_ticket_progress", JSON.stringify({ id: "DS-001", recordEntry: long })],
      { env: { DOSTUFF_PORT: "1" } },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`exceeds ${FIELD_LIMITS.recordEntry}`);
    expect(r.stderr).toContain("No request sent");
  });

  test("without jq the same over-cap input reaches the server and is rejected there", async () => {
    const long = "x".repeat(FIELD_LIMITS.recordEntry + 1);
    const jqless = makeJqlessPath();
    try {
      const r = await runScript(
        ["call", "update_ticket_progress", JSON.stringify({ id: "DS-001", recordEntry: long })],
        { env: { ...env(), PATH: jqless } },
      );
      expect(r.code).toBe(0); // raw JSON-RPC passthrough; the error is in the body
      expect(r.stdout).toMatch(/isError|recordEntry|invalid/i);
    } finally {
      fs.rmSync(jqless, { recursive: true, force: true });
    }
  });

  test("without jq a read returns raw JSON-RPC containing the payload", async () => {
    const jqless = makeJqlessPath();
    try {
      const r = await runScript(["call", "list_issues", "{}"], { env: { ...env(), PATH: jqless } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"jsonrpc"');
      expect(r.stdout).toContain("Skill e2e ticket");
    } finally {
      fs.rmSync(jqless, { recursive: true, force: true });
    }
  });

  test("dead port exits non-zero with the enablement hint", async () => {
    // Grab a port that is definitely closed: bind, read, release.
    const net = await import("node:net");
    const freePort = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", async () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const r = await runScript(["call", "list_issues", "{}"], { env: { DOSTUFF_PORT: String(freePort) } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("dostuff.mcp.enabled");
  });
});

describe("agent skill: SSE unwrapping", async () => {
  test("reassembles a payload split across multiple data: lines", async () => {
    const inner = JSON.stringify({ ok: true, blob: "y".repeat(9_000) });
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: inner }] },
    });
    // Split at a whitespace-free boundary; SSE joins data lines with \n, which
    // is valid JSON whitespace only between tokens — mirror of real framing.
    const cut = rpc.indexOf('"result"') - 1;
    const body = `event: message\ndata: ${rpc.slice(0, cut)}\ndata: ${rpc.slice(cut)}\n\n`;
    // node:http, not Bun.serve — the happy-dom test preload replaces the global
    // Response, which Bun.serve handlers cannot return.
    const http = await import("node:http");
    const fake = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(body);
    });
    const fakePort = await new Promise<number>((resolve) => {
      fake.listen(0, "127.0.0.1", () =>
        resolve((fake.address() as { port: number }).port),
      );
    });
    try {
      const r = await runScript(["call", "get_ticket", '{"query":"1"}'], {
        env: { DOSTUFF_PORT: String(fakePort) },
      });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).blob.length).toBe(9_000);
    } finally {
      fake.close();
    }
  });
});
