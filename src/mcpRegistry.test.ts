// Tests for the user-global MCP instance registry. Uses DOSTUFF_REGISTRY_PATH
// to point at a fresh tmpdir per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadRegistry,
  normalizeWorkspacePath,
  pruneRegistry,
  registerEntry,
  registryFilePath,
  saveRegistry,
  unregisterEntry,
  type RegistryEntry,
} from "./mcpRegistry";

let tmpDir = "";
const originalRegistryPath = process.env.DOSTUFF_REGISTRY_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-registry-"));
  process.env.DOSTUFF_REGISTRY_PATH = path.join(tmpDir, "instances.json");
});

afterEach(() => {
  if (originalRegistryPath === undefined) delete process.env.DOSTUFF_REGISTRY_PATH;
  else process.env.DOSTUFF_REGISTRY_PATH = originalRegistryPath;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: "/tmp/proj-a",
    port: 12345,
    pid: process.pid,
    name: "proj-a",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("registryFilePath", () => {
  test("honors DOSTUFF_REGISTRY_PATH override", () => {
    expect(registryFilePath()).toBe(path.join(tmpDir, "instances.json"));
  });
});

describe("loadRegistry", () => {
  test("returns [] when file does not exist", () => {
    expect(loadRegistry()).toEqual([]);
  });

  test("returns [] for corrupt JSON", () => {
    fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
    fs.writeFileSync(registryFilePath(), "{not valid json");
    expect(loadRegistry()).toEqual([]);
  });

  test("returns [] when JSON root is not an array", () => {
    fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
    fs.writeFileSync(registryFilePath(), JSON.stringify({ foo: "bar" }));
    expect(loadRegistry()).toEqual([]);
  });

  test("filters out malformed entries", () => {
    fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
    fs.writeFileSync(
      registryFilePath(),
      JSON.stringify([
        makeEntry(),
        { workspacePath: "/x", port: "not-a-number" },
        null,
        "string",
      ]),
    );
    const result = loadRegistry();
    expect(result).toHaveLength(1);
    expect(result[0].workspacePath).toBe("/tmp/proj-a");
  });
});

describe("saveRegistry + loadRegistry round-trip", () => {
  test("persists entries", () => {
    const entries = [makeEntry({ pid: 1 }), makeEntry({ pid: 2, port: 999 })];
    saveRegistry(entries);
    expect(loadRegistry()).toEqual(entries);
  });

  test("creates parent directory if missing", () => {
    const nested = path.join(tmpDir, "a", "b", "c", "instances.json");
    process.env.DOSTUFF_REGISTRY_PATH = nested;
    saveRegistry([makeEntry()]);
    expect(fs.existsSync(nested)).toBe(true);
  });

  test("ignores leftover tmp files matching the rename pattern", () => {
    const dir = path.dirname(registryFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "instances.json.99999.abc.tmp"), "garbage");
    saveRegistry([makeEntry()]);
    expect(loadRegistry()).toHaveLength(1);
  });
});

describe("registerEntry", () => {
  test("adds a new entry", () => {
    registerEntry(makeEntry());
    const live = loadRegistry();
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(process.pid);
  });

  test("replaces an existing entry with the same pid", () => {
    registerEntry(makeEntry({ port: 100 }));
    registerEntry(makeEntry({ port: 200 }));
    const live = loadRegistry();
    expect(live).toHaveLength(1);
    expect(live[0].port).toBe(200);
  });

  test("prunes dead pids while registering", () => {
    saveRegistry([
      makeEntry({ pid: 0x7ffffffe, port: 1 }), // dead
      makeEntry({ pid: process.pid, port: 2 }), // alive, will be replaced
    ]);
    registerEntry(makeEntry({ pid: process.pid, port: 3 }));
    const live = loadRegistry();
    expect(live).toHaveLength(1);
    expect(live[0].port).toBe(3);
  });

  test("normalizes workspace path", () => {
    registerEntry(makeEntry({ workspacePath: "/tmp/proj-a/../proj-a" }));
    const live = loadRegistry();
    expect(live[0].workspacePath).toBe(normalizeWorkspacePath("/tmp/proj-a"));
  });
});

describe("unregisterEntry", () => {
  test("removes entry by pid", () => {
    saveRegistry([makeEntry({ pid: 111 }), makeEntry({ pid: 222 })]);
    unregisterEntry(111);
    const live = loadRegistry();
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(222);
  });

  test("is a no-op when pid is absent", () => {
    saveRegistry([makeEntry({ pid: 111 })]);
    unregisterEntry(999);
    expect(loadRegistry()).toHaveLength(1);
  });
});

describe("pruneRegistry", () => {
  test("removes dead pid entries", () => {
    saveRegistry([
      makeEntry({ pid: process.pid, port: 1 }),
      makeEntry({ pid: 0x7ffffffe, port: 2 }), // virtually certain to be dead
    ]);
    const live = pruneRegistry();
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(process.pid);
  });
});

describe("normalizeWorkspacePath", () => {
  test("resolves relative paths", () => {
    const result = normalizeWorkspacePath("/tmp/proj/../proj-b");
    expect(result).toBe(path.resolve("/tmp/proj-b"));
  });

  test("collapses redundant separators", () => {
    const result = normalizeWorkspacePath("/tmp//proj-a/");
    expect(result).toBe(path.resolve("/tmp/proj-a"));
  });
});
