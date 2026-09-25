// In-browser ticket store for the GitHub Pages demo. Stands in for
// `IssueStore` (sql.js + disk), with the same mutation semantics the webview
// can observe: upsert stamps `updatedAt`/`guid`/per-task `updatedAt`, remove
// scrubs inbound links, list is newest-first, numbers never repeat. Persists
// the whole board as one JSON blob in localStorage.

import { randomUUID } from "node:crypto";
import { validateImportList } from "../src/issueRules";
import type { Issue, Task } from "../src/types";

/** Wire shape for one change — the same split `StoreChange` carries. */
export interface DemoChange {
  issues: Issue[];
  upserted: Issue[];
  removed: string[];
  reset: boolean;
}

/** The localStorage slot, abstracted so tests (and blocked storage) work. */
export interface DemoKv {
  read(): string | null;
  /** Returns false when the value could not be stored (quota, blocked). */
  write(value: string): boolean;
}

export const STORAGE_KEY = "dostuff-demo:v1";

/** A KV over `window.localStorage` that degrades to memory-only when storage
 *  is blocked (private windows, disabled site data): the demo still runs,
 *  edits just don't survive a reload. */
export function localStorageKv(key = STORAGE_KEY): DemoKv {
  return {
    read() {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        globalThis.localStorage.setItem(key, value);
        return true;
      } catch {
        // Quota or blocked storage — keep running in memory.
        return false;
      }
    },
  };
}

export function memoryKv(initial: string | null = null): DemoKv & { value: string | null } {
  const kv = {
    value: initial,
    read: () => kv.value,
    write: (v: string) => {
      kv.value = v;
      return true;
    },
  };
  return kv;
}

/** Keep a task's stamp when its text/done are unchanged; stamp `now` otherwise. */
function stampTasks(tasks: Task[], prior: Task[] | undefined, now: string): Task[] {
  const byId = new Map((prior ?? []).map((t) => [t.id, t]));
  return tasks.map((t) => {
    const p = byId.get(t.id);
    const unchanged = p && p.text === t.text && p.done === t.done;
    return { ...t, updatedAt: unchanged ? (p.updatedAt ?? now) : now };
  });
}

export class DemoStore {
  private cache: Issue[] = [];
  private reserved = 0;
  private readonly listeners = new Set<(c: DemoChange) => void>();

  constructor(
    private readonly kv: DemoKv,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Load the saved board, or `seed()` when there is none or it doesn't parse.
   * Saved data goes back through `validateImportList` — the same normalizer
   * the extension's JSON import uses — so a blob written by an older demo
   * build still loads. An intentionally emptied board stays empty.
   */
  load(seed: () => Issue[]): { seeded: boolean } {
    const raw = this.kv.read();
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { issues?: unknown };
        if (Array.isArray(parsed?.issues)) {
          this.cache = validateImportList(parsed.issues).valid;
          this.bumpReserved();
          return { seeded: false };
        }
      } catch {
        // fall through to the seed
      }
    }
    this.cache = seed();
    this.bumpReserved();
    this.persist();
    return { seeded: true };
  }

  onChange(listener: (c: DemoChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Newest-first by `createdAt`, matching `IssueStoreCore.list()`. */
  list(): Issue[] {
    return this.cache
      .map((issue, index) => ({ issue, index, key: Date.parse(issue.createdAt) || 0 }))
      .sort((a, b) => b.key - a.key || a.index - b.index)
      .map((k) => k.issue);
  }

  get(id: string): Issue | undefined {
    return this.cache.find((i) => i.id === id);
  }

  /** Reserve the next ticket number; never reused, even if creation aborts. */
  nextNumber(): number {
    const fromCache = this.cache.reduce((m, i) => (i.number > m ? i.number : m), 0);
    this.reserved = Math.max(fromCache, this.reserved) + 1;
    return this.reserved;
  }

  async upsert(issue: Issue): Promise<void> {
    const prior = this.get(issue.id);
    const now = this.now();
    const next: Issue = {
      ...issue,
      guid: issue.guid || prior?.guid || randomUUID(),
      updatedAt: now,
      tasks: stampTasks(issue.tasks, prior?.tasks, now),
    };
    const idx = this.cache.findIndex((i) => i.id === next.id);
    if (idx >= 0) this.cache[idx] = next;
    else this.cache.unshift(next);
    this.persist();
    this.fire({ upserted: [next], removed: [], reset: false });
  }

  async remove(id: string): Promise<void> {
    const existed = this.cache.some((i) => i.id === id);
    const scrubbed: Issue[] = [];
    this.cache = this.cache
      .filter((i) => i.id !== id)
      .map((i) => {
        if (!i.links.some((l) => l.targetId === id)) return i;
        const next = { ...i, links: i.links.filter((l) => l.targetId !== id) };
        scrubbed.push(next);
        return next;
      });
    this.persist();
    this.fire({ upserted: scrubbed, removed: existed ? [id] : [], reset: false });
  }

  async replaceAll(issues: Issue[]): Promise<void> {
    this.cache = [...issues];
    this.bumpReserved();
    this.persist();
    this.fire({ upserted: [], removed: [], reset: true });
  }

  async mergeAll(issues: Issue[]): Promise<void> {
    const byId = new Map(this.cache.map((i) => [i.id, i]));
    for (const i of issues) byId.set(i.id, i);
    this.cache = [...byId.values()];
    this.bumpReserved();
    this.persist();
    this.fire({ upserted: [], removed: [], reset: true });
  }

  private bumpReserved(): void {
    for (const i of this.cache) if (i.number > this.reserved) this.reserved = i.number;
  }

  private persist(): void {
    this.kv.write(JSON.stringify({ version: 1, issues: this.cache }));
  }

  private fire(change: Omit<DemoChange, "issues">): void {
    const full = { issues: this.list(), ...change };
    for (const l of this.listeners) l(full);
  }
}
