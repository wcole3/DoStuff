// Storage layer for the DoStuff extension.
//
// One .json per issue under <workspace>/<settings.storagePath>/ (default `.vscode/dostuff`).
// When no workspace is open we fall back to ExtensionContext.globalState under
// the key STATE_KEY_FALLBACK. SQLite is explicitly out of scope for v1.

import * as vscode from "vscode";
import {
  isPriority,
  isStatus,
  isType,
  type Issue,
  type Settings,
} from "./types";

const STATE_KEY_FALLBACK = "dostuff.issues.v1";

/**
 * Forward-compat: stamp missing fields on issues loaded from older versions.
 * Enum fields are coerced to safe defaults when the persisted value is invalid;
 * the caller is responsible for surfacing the coercion (e.g. via the output
 * channel) since this is a pure function.
 */
export function normalize(issue: Issue): { issue: Issue; coerced: string[] } {
  const numFromId = parseInt(String(issue.id || "").replace(/^DS-/, ""), 10);
  const coerced: string[] = [];

  let status = issue.status;
  if (!isStatus(status)) {
    coerced.push(`status="${String((issue as any).status)}" → "Thinking"`);
    status = "Thinking";
  }
  let priority = issue.priority;
  if (!isPriority(priority)) {
    coerced.push(`priority="${String((issue as any).priority)}" → "Regular"`);
    priority = "Regular";
  }
  let type = issue.type;
  if (!isType(type)) {
    coerced.push(`type="${String((issue as any).type)}" → "Chore"`);
    type = "Chore";
  }

  return {
    issue: {
      ...issue,
      status,
      priority,
      type,
      number: Number.isFinite((issue as any).number)
        ? (issue as any).number
        : (Number.isFinite(numFromId) ? numFromId : 0),
      record: Array.isArray((issue as any).record) ? (issue as any).record : [],
      statusHistory: Array.isArray(issue.statusHistory) ? issue.statusHistory : [],
      tasks: Array.isArray(issue.tasks) ? issue.tasks : [],
      resolvedAt: issue.resolvedAt ?? null,
    },
    coerced,
  };
}

export class IssueStore {
  private cache: Issue[] = [];
  private reservedNumber: number = 0;
  private readonly emitter = new vscode.EventEmitter<Issue[]>();
  public readonly onChange = this.emitter.event;
  private readonly output: vscode.OutputChannel;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("DoStuff Storage");
  }

  // ─── public API ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.cache = await this.loadAll();
    this.reservedNumber = this.cache.reduce(
      (max, i) => (Number.isFinite(i.number) && i.number > max ? i.number : max),
      0,
    );
    this.emitter.fire(this.cache);
  }

  /**
   * Re-read from disk. Used when the user changes `dostuff.storagePath` at
   * runtime so the in-memory cache picks up the new folder.
   */
  async reload(): Promise<void> {
    this.cache = [];
    this.reservedNumber = 0;
    await this.init();
  }

  /** Append a line to the "DoStuff Storage" output channel. */
  appendLog(line: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`);
  }

  list(): Issue[] {
    return [...this.cache].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
    );
  }

  get(id: string): Issue | undefined {
    return this.cache.find((i) => i.id === id);
  }

  async upsert(issue: Issue): Promise<void> {
    const idx = this.cache.findIndex((i) => i.id === issue.id);
    if (idx >= 0) this.cache[idx] = issue;
    else this.cache.unshift(issue);
    await this.persistOne(issue);
    this.emitter.fire(this.cache);
  }

  async remove(id: string): Promise<void> {
    this.cache = this.cache.filter((i) => i.id !== id);
    await this.deleteOne(id);
    this.emitter.fire(this.cache);
  }

  async replaceAll(issues: Issue[]): Promise<void> {
    await this.wipe();
    this.cache = [...issues];
    this.bumpReserved(this.cache);
    if (this.folderUri()) {
      await Promise.all(issues.map((i) => this.writeFile(i)));
    } else {
      await this.persistState();
    }
    this.emitter.fire(this.cache);
  }

  async mergeAll(issues: Issue[]): Promise<void> {
    const byId = new Map(this.cache.map((i) => [i.id, i]));
    for (const i of issues) byId.set(i.id, i);
    this.cache = [...byId.values()];
    this.bumpReserved(this.cache);
    if (this.folderUri()) {
      await Promise.all(issues.map((i) => this.writeFile(i)));
    } else {
      await this.persistState();
    }
    this.emitter.fire(this.cache);
  }

  /** Generate next monotonic ID (DS-001, DS-002, ...). */
  nextId(): string {
    return `DS-${String(this.nextNumber()).padStart(3, "0")}`;
  }

  /**
   * Reserve the next monotonic ticket number (1, 2, 3, ...).
   *
   * Race-safe via a monotonic in-memory counter. Each call increments the
   * counter, so two concurrent `nextNumber()` calls cannot collide. The
   * counter rises whether or not the caller follows through with `upsert`, so
   * a user opening then cancelling "New Issue" leaves a gap — that is the
   * intentional trade-off versus collisions on simultaneous creation.
   */
  nextNumber(): number {
    const fromCache = this.cache.reduce(
      (max, i) => (Number.isFinite(i.number) && i.number > max ? i.number : max),
      0,
    );
    const candidate = Math.max(fromCache, this.reservedNumber) + 1;
    this.reservedNumber = candidate;
    return candidate;
  }

  /** Raise the reserved counter so it stays ahead of any imported numbers. */
  private bumpReserved(set: Issue[]): void {
    for (const i of set) {
      if (Number.isFinite(i.number) && i.number > this.reservedNumber) {
        this.reservedNumber = i.number;
      }
    }
  }

  // ─── settings ───────────────────────────────────────────────────────────

  private get settings(): Settings {
    const c = vscode.workspace.getConfiguration("dostuff");
    return {
      storagePath: c.get<string>("storagePath", ".vscode/dostuff"),
      autoSave:    c.get<boolean>("autoSave", true),
    };
  }

  private folderUri(): vscode.Uri | null {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    return vscode.Uri.joinPath(root.uri, this.settings.storagePath);
  }

  // ─── JSON-file backend ──────────────────────────────────────────────────

  private async loadFromFiles(dir: vscode.Uri): Promise<Issue[]> {
    try { await vscode.workspace.fs.createDirectory(dir); } catch {}
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch { return []; }
    const out: Issue[] = [];
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
      try {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
        const txt = new TextDecoder().decode(buf);
        const obj = JSON.parse(txt) as Issue;
        if (obj && obj.id && obj.title) {
          const { issue, coerced } = normalize(obj);
          if (coerced.length) {
            this.appendLog(`Coerced fields on ${issue.id} (${name}): ${coerced.join(", ")}`);
          }
          out.push(issue);
        }
      } catch (e) {
        this.appendLog(`Failed to parse ${name}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private async writeFile(issue: Issue): Promise<void> {
    const dir = this.folderUri();
    if (!dir) return;
    try { await vscode.workspace.fs.createDirectory(dir); } catch {}
    const file = vscode.Uri.joinPath(dir, `${issue.id}.json`);
    const bytes = new TextEncoder().encode(JSON.stringify(issue, null, 2));
    await vscode.workspace.fs.writeFile(file, bytes);
  }

  private async deleteFile(id: string): Promise<void> {
    const dir = this.folderUri();
    if (!dir) return;
    const file = vscode.Uri.joinPath(dir, `${id}.json`);
    try { await vscode.workspace.fs.delete(file); } catch {}
  }

  private async wipeFiles(): Promise<void> {
    const dir = this.folderUri();
    if (!dir) return;
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, kind] of entries) {
        if (kind === vscode.FileType.File && name.endsWith(".json")) {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
        }
      }
    } catch {}
  }

  // ─── globalState fallback ───────────────────────────────────────────────

  private loadFromState(): Issue[] {
    const raw = this.ctx.globalState.get<Issue[]>(STATE_KEY_FALLBACK, []);
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
      const { issue, coerced } = normalize(entry);
      if (coerced.length) {
        this.appendLog(`Coerced fields on ${issue.id} (globalState): ${coerced.join(", ")}`);
      }
      return issue;
    });
  }

  private async persistState(): Promise<void> {
    await this.ctx.globalState.update(STATE_KEY_FALLBACK, this.cache);
  }

  // ─── dispatch ───────────────────────────────────────────────────────────

  private async loadAll(): Promise<Issue[]> {
    const dir = this.folderUri();
    if (!dir) return this.loadFromState();
    return this.loadFromFiles(dir);
  }

  private async persistOne(issue: Issue): Promise<void> {
    if (this.folderUri()) {
      await this.writeFile(issue);
    } else {
      await this.persistState();
    }
  }

  private async deleteOne(id: string): Promise<void> {
    if (this.folderUri()) {
      await this.deleteFile(id);
    } else {
      await this.persistState();
    }
  }

  private async wipe(): Promise<void> {
    if (this.folderUri()) {
      await this.wipeFiles();
    } else {
      await this.ctx.globalState.update(STATE_KEY_FALLBACK, []);
    }
  }

  dispose() {
    this.emitter.dispose();
    this.output.dispose();
  }
}
