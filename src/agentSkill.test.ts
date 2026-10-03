// Tests for the Claude Code agent skill (skills/dostuff-tickets/).
//
// The skill is an alternative MCP *client*: SKILL.md + scripts/dostuff.sh let
// an agent drive the ticket queue over bare loopback HTTP without registering
// the server. These tests are the drift guard: tool coverage is derived from
// the real `registerMcpTools`, field caps from FIELD_LIMITS, and the script is
// exercised end-to-end against a live HTTP server.

import * as http from "node:http";
import * as net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMcpTools, type DoStuffMcpServer } from "./mcpServer";
import { FIELD_LIMITS } from "./mcpLimits";
import { PRIORITIES, STATUSES, TYPES } from "./types";
import { DEFAULT_WORKFLOW_PROMPT } from "./workflowPrompt";
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
const SKILL_BODY_BYTE_BUDGET = 8_000;

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

// The static tests below are drift guards, not prose pins: each derives its
// expectation from code (the registered tools and their schemas, FIELD_LIMITS,
// the enums in types.ts, the workflow prompt, the script's own command table)
// or from a structural rule in Anthropic's skill-authoring guide (contents
// map, one-level-deep references). A test that only re-reads a sentence the
// doc author just wrote does not belong here.

const REFERENCES_DIR = nodePath.join(SKILL_DIR, "references");
const referenceFiles = fs.readdirSync(REFERENCES_DIR).filter((f) => f.endsWith(".md"));
const referenceText = Object.fromEntries(
  referenceFiles.map((f) => [f, fs.readFileSync(nodePath.join(REFERENCES_DIR, f), "utf8")]),
);

// A reference file long enough that a partial read (head -100) would miss
// sections needs a contents map up top (skill-authoring guide).
const CONTENTS_MAP_LINE_THRESHOLD = 100;

interface ToolShape {
  name: string;
  params: string[];
  readOnly: boolean;
}

async function registeredTools(): Promise<ToolShape[]> {
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
    return res.tools.map((t) => ({
      name: t.name,
      params: Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      readOnly: t.annotations?.readOnlyHint === true,
    }));
  } finally {
    restoreMcpConfig();
  }
}

// Subcommands the script actually dispatches — parsed from its final `case`.
function scriptSubcommands(): string[] {
  const tail = script.slice(script.lastIndexOf('case "$cmd" in'));
  return [...tail.matchAll(/^\s+([a-z]+)\)\s/gm)].map((m) => m[1]!);
}

describe("agent skill: static shape", async () => {
  test("script is valid sh", () => {
    expect(Bun.spawnSync(["sh", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("frontmatter names the installed skill and grants the tools the script needs", () => {
    // The name is the install directory (skillInstall.ts) and the plugin id;
    // Bash(sh:*) runs the script, Bash(curl:*) is the manual fallback.
    const fm = frontmatter();
    expect(fm.name).toBe("dostuff-tickets");
    expect(fm["allowed-tools"]).toContain("Bash(curl:*)");
    expect(fm["allowed-tools"]).toContain("Bash(sh:*)");
  });

  test("name + description fit the listing budget and carry trigger phrases", () => {
    const fm = frontmatter();
    expect(`${fm.name}: ${fm.description}`.length).toBeLessThanOrEqual(SKILL_LISTING_CHAR_BUDGET);
    expect(fm.description).toMatch(/ticket/i);
    expect(fm.description).toContain("DS-");
    expect(fm.description).toMatch(/DoStuff/);
  });

  test("SKILL.md fits its byte budget", () => {
    expect(Buffer.byteLength(skillMd, "utf8")).toBeLessThanOrEqual(SKILL_BODY_BYTE_BUDGET);
  });

  test("SKILL.md opens with a contents map; long reference files carry one too", () => {
    // The map must precede the first instructional section so a partial read
    // still shows the whole scope of the skill.
    const firstSection = skillMd.indexOf("\n## ");
    const contents = skillMd.indexOf("\n## Contents");
    expect(contents).toBeGreaterThan(-1);
    expect(contents).toBe(firstSection);
    for (const [file, text] of Object.entries(referenceText)) {
      if (text.split("\n").length > CONTENTS_MAP_LINE_THRESHOLD) {
        expect(text, `${file} exceeds ${CONTENTS_MAP_LINE_THRESHOLD} lines and needs a ## Contents map`)
          .toContain("\n## Contents");
      }
    }
  });

  test("every reference file is linked from SKILL.md and none links to another", () => {
    // One level deep: Claude partially reads files reached via a second hop.
    expect(referenceFiles.length).toBeGreaterThan(0);
    for (const file of referenceFiles) {
      expect(skillMd, `SKILL.md never mentions references/${file}`).toContain(`references/${file}`);
      for (const [other, text] of Object.entries(referenceText)) {
        if (other !== file) {
          expect(text, `${other} links to ${file}; references must be one level deep`).not.toContain(file);
        }
      }
    }
  });

  test("the contents map in SKILL.md names every section", () => {
    const sections = [...skillMd.matchAll(/^## (.+)$/gm)].map((m) => m[1]!).filter((s) => s !== "Contents");
    const map = skillMd.slice(skillMd.indexOf("## Contents"), skillMd.indexOf("\n## ", skillMd.indexOf("## Contents") + 1));
    for (const s of sections) expect(map, `contents map omits section "${s}"`).toContain(s);
  });

  test("every registered tool is documented, with its parameters and read-only marking", async () => {
    const tools = await registeredTools();
    expect(tools.length).toBeGreaterThanOrEqual(9);
    for (const t of tools) {
      // SKILL.md: one table row per tool.
      expect(skillMd).toMatch(new RegExp(`^\\| \`${t.name}\` \\|`, "m"));
      // tools.md: a heading, every schema property, and the read-only flag
      // that lets Claude Code dispatch it concurrently.
      // Two request tools share one heading, so match the name anywhere on it.
      const hm = toolsMd.match(new RegExp(`^## .*\\b${t.name}\\b.*$`, "m"));
      expect(hm, `tools.md has no section for ${t.name}`).toBeTruthy();
      const heading = hm!.index!;
      const headingLine = toolsMd.slice(heading, toolsMd.indexOf("\n", heading));
      if (t.readOnly) expect(headingLine, `${t.name} is readOnlyHint but not marked`).toContain("read-only");
      else expect(headingLine).not.toContain("read-only");
      const next = toolsMd.indexOf("\n## ", heading + 1);
      const section = toolsMd.slice(heading, next === -1 ? undefined : next);
      for (const p of t.params) {
        expect(section, `tools.md section for ${t.name} omits param ${p}`).toContain(`\`${p}\``);
      }
    }
  });

  test("tools.md lists every enum value the schemas accept", () => {
    for (const v of [...STATUSES, ...PRIORITIES, ...TYPES]) expect(toolsMd).toContain(v);
    // SKILL.md must name the terminal states: the human-only rule is about them.
    for (const s of STATUSES) expect(skillMd).toContain(s);
  });

  test("the skill's write-terse rule matches the workflow prompt's", () => {
    // Agents reach the rule through either surface; the two must not drift.
    const m = DEFAULT_WORKFLOW_PROMPT.match(/~\d+ words/);
    expect(m).toBeTruthy();
    expect(skillMd).toContain(m![0]);
    expect(skillMd).toMatch(/only a human/i);
    expect(skillMd).toMatch(/mcp__dostuff__/); // coexistence with a registered server
  });

  test("plugin manifest version tracks the extension version", () => {
    const root = nodePath.resolve(import.meta.dir, "..");
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(nodePath.join(root, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.version).toBe(pkg.version);
  });

  test("does not hardcode the active lane cap", () => {
    // The cap tracks the dostuff.activeLaneCap setting.
    for (const text of [skillMd, ...Object.values(referenceText)]) {
      expect(text).not.toMatch(/cap(ped)?\s*(at|of)?\s*\d/i);
    }
  });

  test("docs only invoke subcommands and env vars the script implements", () => {
    const subs = scriptSubcommands();
    expect(subs).toEqual(expect.arrayContaining(["discover", "call", "resource"]));
    const docs = [skillMd, ...Object.values(referenceText)].join("\n");
    for (const m of docs.matchAll(/dostuff\.sh\s+([a-z]+)/g)) {
      expect(subs, `docs invoke unknown subcommand "${m[1]}"`).toContain(m[1]!);
    }
    // $DOSTUFF_SERVER_JS is a user placeholder in the headless-server snippet,
    // not a variable the script reads.
    const envInDocs = new Set([...skillMd.matchAll(/DOSTUFF_[A-Z_]+/g)].map((m) => m[0]));
    for (const v of envInDocs) expect(script, `SKILL.md documents ${v} but the script never reads it`).toContain(v);
  });

  test("the failure table is keyed to the script's real stderr", () => {
    // Each symptom an agent is told to match must be a string the script emits.
    for (const phrase of ["Nothing is listening", "did not answer within", "exceeds", "busy", "No registry"]) {
      expect(script).toContain(phrase);
      expect(skillMd, `SKILL.md failure table lost symptom "${phrase}"`).toContain(phrase);
    }
  });

  test("tools.md carries every FIELD_LIMITS number", () => {
    for (const [k, v] of Object.entries(FIELD_LIMITS)) {
      if (k === "commitMinHex" || k === "commitMaxHex") continue;
      expect(toolsMd, `tools.md omits FIELD_LIMITS.${k} = ${v}`).toContain(String(v));
    }
    expect(toolsMd).toContain(`${FIELD_LIMITS.commitMinHex}–${FIELD_LIMITS.commitMaxHex}`);
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

  test("every FIELD_LIMITS cap is enforced locally at cap+1 and let through at cap", async () => {
    // Behavioral mirror of the script's caps_for() table: the string greps this
    // replaced could pass while the jq check silently measured the wrong field.
    // A fake server counts arrivals so "no request sent" is proven, not read
    // off stderr.
    const L = FIELD_LIMITS;
    const cases: Array<{ tool: string; field: string; cap: number; wrap: (v: string) => unknown }> = [
      { tool: "create_ticket", field: "title", cap: L.title, wrap: (v) => v },
      { tool: "create_ticket", field: "description", cap: L.description, wrap: (v) => v },
      { tool: "create_ticket", field: "verifyCriteria", cap: L.verifyCriteria, wrap: (v) => v },
      { tool: "create_ticket", field: "tasks", cap: L.taskText, wrap: (v) => ["ok", v] },
      { tool: "create_ticket", field: "tags", cap: L.tag, wrap: (v) => ["ok", v] },
      { tool: "update_ticket_status", field: "note", cap: L.statusNote, wrap: (v) => v },
      { tool: "update_ticket_progress", field: "recordEntry", cap: L.recordEntry, wrap: (v) => v },
      { tool: "update_ticket_draft", field: "tags", cap: L.tag, wrap: (v) => [v] },
      { tool: "update_ticket_draft", field: "tasks", cap: L.taskText, wrap: (v) => [{ text: "ok" }, { text: v }] },
      { tool: "update_ticket_description", field: "description", cap: L.description, wrap: (v) => v },
      { tool: "update_ticket_description", field: "note", cap: L.note, wrap: (v) => v },
      { tool: "request_ticket_close", field: "note", cap: L.note, wrap: (v) => v },
      { tool: "request_ticket_complete", field: "note", cap: L.note, wrap: (v) => v },
    ];
    let hits = 0;
    const ok = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } });
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { hits++; res.setHeader("Content-Type", "application/json"); res.end(ok); });
    });
    const fakePort = await new Promise<number>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)),
    );
    const base = (tool: string) => (tool === "create_ticket" ? { title: "t" } : tool === "update_ticket_status" ? { id: "DS-001", status: "Working" } : tool === "update_ticket_description" ? { id: "DS-001", description: "d" } : { id: "DS-001" });
    try {
      for (const c of cases) {
        const label = `${c.tool}.${c.field}`;
        const over = await runScript(
          ["call", c.tool, JSON.stringify({ ...base(c.tool), [c.field]: c.wrap("x".repeat(c.cap + 1)) })],
          { env: { DOSTUFF_PORT: String(fakePort) } },
        );
        expect(over.code, label).toBe(2);
        expect(over.stderr, label).toContain(`field ${c.field} exceeds ${c.cap}`);
        expect(over.stderr, label).toContain("No request sent");
        const before = hits;
        const at = await runScript(
          ["call", c.tool, JSON.stringify({ ...base(c.tool), [c.field]: c.wrap("x".repeat(c.cap)) })],
          { env: { DOSTUFF_PORT: String(fakePort) } },
        );
        expect(at.code, label).toBe(0);
        expect(hits, `${label}: a value exactly at the cap must reach the server`).toBe(before + 1);
      }
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  }, 60_000);

  test("commit sha and numeric ranges are validated locally from FIELD_LIMITS", async () => {
    const dead = { env: { DOSTUFF_PORT: "1" } };
    const bad = [
      ["update_ticket_progress", { id: "DS-001", commit: "x".repeat(FIELD_LIMITS.commitMinHex) }, "commit must be"],
      ["update_ticket_progress", { id: "DS-001", commit: "a".repeat(FIELD_LIMITS.commitMaxHex + 1) }, "commit must be"],
      ["get_ticket", { query: "1", recordLimit: FIELD_LIMITS.recordLimitMax + 1 }, `recordLimit must be 0-${FIELD_LIMITS.recordLimitMax}`],
      ["list_issues", { limit: FIELD_LIMITS.listLimitMax + 1 }, `limit must be 1-${FIELD_LIMITS.listLimitMax}`],
      ["list_issues", { limit: 0 }, `limit must be 1-${FIELD_LIMITS.listLimitMax}`],
    ] as const;
    for (const [tool, args, msg] of bad) {
      const r = await runScript(["call", tool, JSON.stringify(args)], dead);
      expect(r.code, `${tool} ${JSON.stringify(args)}`).toBe(2);
      expect(r.stderr).toContain(msg);
      expect(r.stderr).toContain("No request sent");
    }
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

// ----- transport failures name the likely cause ------------------------------
// One "Cannot reach" message for every curl failure sent people chasing a
// stale registry entry when the host was merely busy (a blocked extension
// event loop). The exit code tells them apart: 7 refused, 28 timed out,
// 52 empty reply.
describe("agent skill: transport failure messages", () => {
  test("a closed port says nothing is listening (stale registry / disabled)", async () => {
    const closed = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const r = await runScript(["call", "list_issues", "{}"], { env: { DOSTUFF_PORT: String(closed) } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/nothing is listening/i);
    expect(r.stderr).not.toMatch(/busy|timed out/i);
  });

  test("a port that accepts but never answers says the host is busy, not unreachable", async () => {
    const sockets: net.Socket[] = [];
    const srv = net.createServer((s) => void sockets.push(s));
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)),
    );
    try {
      const r = await runScript(["call", "list_issues", "{}"], {
        env: { DOSTUFF_PORT: String(port), DOSTUFF_TIMEOUT: "2", DOSTUFF_RETRIES: "1" },
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/did not answer within 2s/i);
      expect(r.stderr).toMatch(/busy/i);
      expect(r.stderr).not.toMatch(/stale registry/i);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => srv.close(resolve));
    }
  }, 20_000);
});

describe("agent skill: retries with a stable Idempotency-Key", () => {
  test("a 503 is retried and both attempts carry the same key", async () => {
    const seen: Array<{ key: string | undefined; accept: string | undefined }> = [];
    const result = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } };
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ key: req.headers["idempotency-key"] as string | undefined, accept: req.headers.accept });
        if (seen.length === 1) {
          res.statusCode = 503;
          res.setHeader("Retry-After", "1");
          res.end("busy");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
    });
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)),
    );
    try {
      const r = await runScript(["call", "list_issues", "{}"], { env: { DOSTUFF_PORT: String(port) } });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ ok: true });
      expect(seen).toHaveLength(2);
      expect(seen[0]!.key).toBeTruthy();
      expect(seen[1]!.key).toBe(seen[0]!.key);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  }, 20_000);

  test("a 503 that never clears fails with a busy message after the retry budget", async () => {
    const srv = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end("busy");
    });
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)),
    );
    try {
      const r = await runScript(["call", "list_issues", "{}"], { env: { DOSTUFF_PORT: String(port), DOSTUFF_RETRIES: "2" } });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/busy/i);
      expect(r.stderr).toMatch(/2 attempts/i);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  }, 20_000);
});
