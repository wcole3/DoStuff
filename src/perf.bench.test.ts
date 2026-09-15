// Performance benchmarks for large boards (600 / 1000 / 10000 tickets).
//
// Prints one table row per size for each measurement so scaling is visible
// at a glance; asserts only structural contracts that must not regress
// (spawn counts, persistence writes, message shapes, payload ratio) plus a
// generous stall bound at <= 1000 tickets. The 10000 row is print-only and
// gated behind DOSTUFF_BENCH_SCALE=1 (`bun run bench:scale`) so plain
// `bun test` stays fast. Run alone with `bun test -t PERF`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitSyncController } from "./gitSync";
import { IssueStoreCore, nodeStorageFs, type StorageFs } from "./storageCore";
import { makeIssueFactory } from "./testSupport";
import { toRow, type Issue } from "./types";
import { changeToMessage } from "./webviewProtocol";

const WASM = fs.readFileSync(path.join(import.meta.dir, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"));
const SCALE = process.env.DOSTUFF_BENCH_SCALE === "1";
const SIZES = SCALE ? [600, 1000, 10000] : [600, 1000];
const REF = "refs/dostuff/state";

let tmpRoot = "";
let counter = 0;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-perf-"));
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const makeIssue = makeIssueFactory();
function board(n: number): Issue[] {
  makeIssue.reset();
  const t0 = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) =>
    makeIssue({
      number: i + 1,
      guid: `g-${i + 1}`,
      createdAt: new Date(t0 + i * 60_000).toISOString(),
      updatedAt: new Date(t0 + i * 60_000).toISOString(),
      description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
      tags: ["perf", i % 2 ? "odd" : "even"],
      tasks: [{ id: `t-${i}-1`, text: "first task", done: i % 3 === 0 }, { id: `t-${i}-2`, text: "second task", done: false }],
      record: Array.from({ length: 20 }, (_, r) => ({
        at: new Date(t0 + i * 60_000 + r * 1000).toISOString(),
        author: r % 2 ? "agent" : "user",
        text: `record entry ${r}: did a thing and noted the outcome here`,
      })),
      commits: Array.from({ length: 6 }, (_, c) => ({
        sha: (c + 1).toString(16).padStart(40, "0"),
        at: new Date(t0 + i * 60_000 + c * 500).toISOString(),
      })),
    }),
  );
}

function countingFs(): { fsImpl: StorageFs; counters: { writes: number; renames: number } } {
  const counters = { writes: 0, renames: 0 };
  const fsImpl: StorageFs = {
    ...nodeStorageFs,
    writeFile: async (p, c) => {
      counters.writes += 1;
      return nodeStorageFs.writeFile(p, c);
    },
    rename: async (a, b) => {
      counters.renames += 1;
      return nodeStorageFs.rename(a, b);
    },
  };
  return { fsImpl, counters };
}

async function seededStore(n: number, fsImpl: StorageFs = nodeStorageFs, logs: string[] = []) {
  const dir = path.join(tmpRoot, `store-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new IssueStoreCore({
    storageDir: () => dir,
    wasmBinary: async () => WASM,
    fs: fsImpl,
    logger: { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l) },
  });
  await store.init();
  await store.replaceAll(board(n));
  await store.flush();
  return { store, dir };
}

/** PATH shim around git that appends each subcommand to `logPath`. */
function gitShim(logPath: string): () => void {
  const bin = path.join(tmpRoot, `shim-${++counter}`);
  fs.mkdirSync(bin, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(logPath)}\nexec ${real} "$@"\n`, { mode: 0o755 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior}`;
  return () => void (process.env.PATH = prior);
}
function spawnCounts(logPath: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n") : []) {
    if (line) out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
}

/** Longest gap between 1ms ticks while `fn` runs = worst event-loop stall. */
async function withStallProbe<T>(fn: () => Promise<T>): Promise<{ result: T; maxStallMs: number }> {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 1);
  try {
    const result = await fn();
    return { result, maxStallMs: Math.round(max) };
  } finally {
    clearInterval(timer);
  }
}

const rows: string[] = [];
const row = (bench: string, n: number, cells: Record<string, string | number>) => {
  rows.push(`${bench.padEnd(12)} n=${String(n).padStart(5)}  ${Object.entries(cells).map(([k, v]) => `${k}=${v}`).join("  ")}`);
};
afterAll(() => {
  console.log(`\nPERF (${SCALE ? "with" : "without"} the 10000 row; DOSTUFF_BENCH_SCALE=1 adds it)\n` + rows.join("\n") + "\n");
});

describe("PERF large boards", () => {
  test("sync: one fast-import per commit, no per-ticket spawns, bounded event-loop stall", async () => {
    for (const n of SIZES) {
      const bare = path.join(tmpRoot, `origin-${++counter}.git`);
      fs.mkdirSync(bare, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare"], { cwd: bare });
      const dir = path.join(tmpRoot, `clone-${++counter}`);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
      const logs: string[] = [];
      const store = new IssueStoreCore({
        storageDir: () => path.join(dir, ".vscode", "dostuff"),
        wasmBinary: async () => WASM,
        logger: { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l) },
      });
      await store.init();
      await store.replaceAll(board(n));
      const controller = new GitSyncController(store, () => dir, {
        remote: "origin",
        ref: REF,
        intervalMinutes: 0,
        activeLaneCap: 6,
        debounceMs: 3_600_000,
        tipPollMs: 3_600_000,
        pushFollowUpMs: 3_600_000,
        startupSync: false,
        notify: () => {},
      });
      controller.start();
      const logPath = path.join(tmpRoot, `spawns-${++counter}.log`);
      const restore = gitShim(logPath);
      let firstMs = 0;
      let firstStall = 0;
      let noopMs = 0;
      let noopStall = 0;
      try {
        const t0 = performance.now();
        const first = await withStallProbe(() => controller.syncNow("manual"));
        firstMs = Math.round(performance.now() - t0);
        firstStall = first.maxStallMs;
        const t1 = performance.now();
        const noop = await withStallProbe(() => controller.syncNow("manual"));
        noopMs = Math.round(performance.now() - t1);
        noopStall = noop.maxStallMs;
      } finally {
        restore();
        controller.dispose();
        await store.close();
      }
      const counts = spawnCounts(logPath);
      const failed = logs.filter((l) => l.includes("Sync failed") || l.includes("Sync operation failed"));
      if (failed.length) throw new Error(`sync failed at n=${n}: ${failed.join(" | ")}`);
      const writeLine = logs.find((l) => l.includes("committed")) ?? "";
      const writeMs = Number(/in (\d+)ms/.exec(writeLine)?.[1] ?? 0);
      row("sync", n, {
        firstMs,
        writeStateMs: writeMs,
        restMs: firstMs - writeMs,
        noopMs,
        stallMs: Math.max(firstStall, noopStall),
        "fast-import": counts.get("fast-import") ?? 0,
        "hash-object": counts.get("hash-object") ?? 0,
        mktree: counts.get("mktree") ?? 0,
      });
      expect(counts.get("hash-object") ?? 0).toBe(0);
      // One tree write per cycle: the first commits, the no-op re-checks.
      expect(counts.get("fast-import") ?? 0).toBeLessThanOrEqual(3);
      if (n <= 1000) expect(Math.max(firstStall, noopStall)).toBeLessThan(500);
    }
  }, 600_000);

  test("persistence: a burst of edits is one DB write; upsert latency stays flat", async () => {
    for (const n of SIZES) {
      const { fsImpl, counters } = countingFs();
      const { store } = await seededStore(n, fsImpl);
      const renamesBefore = counters.renames;
      const lat: number[] = [];
      const ids = store.list().slice(0, 30).map((i) => i.id);
      for (const id of ids) {
        const t0 = performance.now();
        await store.upsert({ ...store.get(id)!, status: "Complete" });
        lat.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 20));
      }
      const burstRenames = counters.renames - renamesBefore; // timer may have fired mid-burst
      await store.close();
      lat.sort((a, b) => a - b);
      row("persist", n, {
        upsertP50ms: lat[15]!.toFixed(2),
        upsertMaxMs: lat[29]!.toFixed(2),
        renamesDuringBurst: burstRenames,
        renamesTotal: counters.renames - renamesBefore,
      });
      // 30 edits over ~600ms with a 250ms trailing window: at most a few writes, never 30.
      expect(counters.renames - renamesBefore).toBeLessThanOrEqual(4);
    }
  }, 600_000);

  test("list(): memoized sort makes repeated reads cheap", async () => {
    for (const n of SIZES) {
      const { store } = await seededStore(n);
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) store.list();
      const ms = performance.now() - t0;
      await store.close();
      row("list()", n, { "1000callsMs": ms.toFixed(1), perCallUs: ((ms / 1000) * 1000).toFixed(1) });
      if (n <= 1000) expect(ms).toBeLessThan(500);
    }
  }, 600_000);

  test("payload: rows are a fraction of full issues; per-key breakdown", () => {
    for (const n of SIZES) {
      const issues = board(n);
      const full = JSON.stringify(issues).length;
      const rowsBytes = JSON.stringify(issues.map(toRow)).length;
      const perKey: Record<string, number> = {};
      for (const i of issues) {
        for (const [k, v] of Object.entries(i)) perKey[k] = (perKey[k] ?? 0) + JSON.stringify(v).length;
      }
      const top = Object.entries(perKey)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}:${Math.round((100 * v) / full)}%`)
        .join(",");
      row("payload", n, { fullKB: Math.round(full / 1024), rowsKB: Math.round(rowsBytes / 1024), rowsPct: Math.round((100 * rowsBytes) / full), top });
      expect(rowsBytes).toBeLessThan(full * 0.5);
    }
  });

  test("protocol: 30 status moves produce 30 small deltas and no full-list message", async () => {
    for (const n of SIZES) {
      const { store } = await seededStore(n);
      const sizes: number[] = [];
      let fullLists = 0;
      const sub = store.onChange((c) => {
        const msg = changeToMessage(c);
        if (msg.type === "issues") fullLists += 1;
        else sizes.push(JSON.stringify(msg).length);
      });
      const ids = store.list().slice(0, 30).map((i) => i.id);
      for (const id of ids) await store.upsert({ ...store.get(id)!, status: "Complete" });
      sub.dispose();
      await store.close();
      row("protocol", n, { deltas: sizes.length, fullLists, maxDeltaKB: (Math.max(...sizes) / 1024).toFixed(1) });
      expect(sizes).toHaveLength(30);
      expect(fullLists).toBe(0);
      expect(Math.max(...sizes)).toBeLessThan(8 * 1024);
    }
  }, 600_000);
});
