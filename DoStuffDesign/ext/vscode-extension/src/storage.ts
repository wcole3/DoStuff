// Storage layer for the DoStuff extension.
//
// Two backends:
//   1. 'json-files' — one .json per issue under <workspace>/<settings.storagePath>/
//   2. 'sqlite'     — a single .db file under context.globalStorageUri (scaffold; requires the
//                     `better-sqlite3` native module to be installed by the host project)
//
// The active backend is chosen by the `dostuff.storageMode` setting and may be changed at runtime.

import * as vscode from "vscode";
import * as path from "path";
import type { Issue, Settings } from "./types";

const STATE_KEY_FALLBACK = "dostuff.issues.v1";

/** Forward-compat: stamp missing fields on issues loaded from older versions. */
function normalize(issue: Issue): Issue {
  const numFromId = parseInt(String(issue.id || "").replace(/^DS-/, ""), 10);
  return {
    ...issue,
    number: Number.isFinite((issue as any).number)
      ? (issue as any).number
      : (Number.isFinite(numFromId) ? numFromId : 0),
    record: Array.isArray((issue as any).record) ? (issue as any).record : [],
    statusHistory: Array.isArray(issue.statusHistory) ? issue.statusHistory : [],
    tasks: Array.isArray(issue.tasks) ? issue.tasks : [],
  };
}

export class IssueStore {
  private cache: Issue[] = [];
  private readonly emitter = new vscode.EventEmitter<Issue[]>();
  public readonly onChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  // ─── public API ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.cache = await this.loadAll();
    this.emitter.fire(this.cache);
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
    for (const issue of issues) await this.persistOne(issue);
    this.emitter.fire(this.cache);
  }

  async mergeAll(issues: Issue[]): Promise<void> {
    const byId = new Map(this.cache.map((i) => [i.id, i]));
    for (const i of issues) byId.set(i.id, i);
    this.cache = [...byId.values()];
    for (const i of issues) await this.persistOne(i);
    this.emitter.fire(this.cache);
  }

  /** Generate next monotonic ID (DS-001, DS-002, ...). */
  nextId(): string {
    return `DS-${String(this.nextNumber()).padStart(3, "0")}`;
  }

  /** Next monotonic ticket number (1, 2, 3, ...). */
  nextNumber(): number {
    const nums = this.cache
      .map((i) => (Number.isFinite((i as any).number)
        ? (i as any).number as number
        : parseInt(i.id.replace(/^DS-/, ""), 10)))
      .filter((n) => Number.isFinite(n));
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }

  // ─── backend selection ──────────────────────────────────────────────────

  private get settings(): Settings {
    const c = vscode.workspace.getConfiguration("dostuff");
    return {
      storageMode: c.get<Settings["storageMode"]>("storageMode", "json-files"),
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

  private async loadFromFiles(): Promise<Issue[]> {
    const dir = this.folderUri();
    if (!dir) return [];
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
        if (obj && obj.id && obj.title) out.push(normalize(obj));
      } catch (e) {
        console.warn("DoStuff: failed to parse", name, e);
      }
    }
    return out;
  }

  private async writeFile(issue: Issue): Promise<void> {
    const dir = this.folderUri();
    if (!dir) {
      // No workspace — fall back to globalState
      await this.ctx.globalState.update(STATE_KEY_FALLBACK,
        this.cache.map((i) => i.id === issue.id ? issue : i));
      return;
    }
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

  // ─── SQLite backend (scaffold) ──────────────────────────────────────────
  // Real impl would use `better-sqlite3`. Wired here so the call sites are stable.

  private sqliteDbPath(): string {
    return path.join(this.ctx.globalStorageUri.fsPath, "dostuff.db");
  }

  private async loadFromSqlite(): Promise<Issue[]> {
    // Lazy require so the extension still activates when the binding is missing.
    try {
      // const Database = require("better-sqlite3");
      // const db = new Database(this.sqliteDbPath());
      // return db.prepare("SELECT data FROM issues").all().map((r: any) => JSON.parse(r.data));
      vscode.window.showWarningMessage(
        "DoStuff: SQLite backend requires `better-sqlite3`. Falling back to JSON files."
      );
      return this.loadFromFiles();
    } catch {
      return this.loadFromFiles();
    }
  }

  // ─── dispatch ───────────────────────────────────────────────────────────

  private async loadAll(): Promise<Issue[]> {
    if (this.settings.storageMode === "sqlite") return this.loadFromSqlite();
    return this.loadFromFiles();
  }

  private async persistOne(issue: Issue): Promise<void> {
    if (this.settings.storageMode === "sqlite") {
      // db.prepare("INSERT OR REPLACE INTO issues(id,data) VALUES (?,?)").run(issue.id, JSON.stringify(issue))
      await this.writeFile(issue);
    } else {
      await this.writeFile(issue);
    }
  }

  private async deleteOne(id: string): Promise<void> {
    await this.deleteFile(id);
  }

  private async wipe(): Promise<void> {
    await this.wipeFiles();
  }

  dispose() {
    this.emitter.dispose();
  }
}
