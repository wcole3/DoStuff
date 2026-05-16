// User-global registry of running DoStuff MCP server instances.
//
// Each VSCode window writes one entry on activation and removes it on
// deactivation. External agents read this file to discover which port serves
// which workspace. Atomic via temp+rename; pruned on every write.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RegistryEntry {
  workspacePath: string;
  port: number;
  pid: number;
  name: string;
  startedAt: string;
}

const REGISTRY_FILENAME = "instances.json";

export function registryFilePath(): string {
  const override = process.env.DOSTUFF_REGISTRY_PATH;
  if (override && override.length > 0) return override;

  const base =
    process.platform === "win32"
      ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config");
  return path.join(base, "dostuff", REGISTRY_FILENAME);
}

export function normalizeWorkspacePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function loadRegistry(): RegistryEntry[] {
  const file = registryFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function saveRegistry(entries: RegistryEntry[]): void {
  const file = registryFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `${REGISTRY_FILENAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: process exists but we lack permission to signal it.
    return code === "EPERM";
  }
}

export function pruneRegistry(): RegistryEntry[] {
  const live = loadRegistry().filter((e) => isPidAlive(e.pid));
  saveRegistry(live);
  return live;
}

export function registerEntry(entry: RegistryEntry): void {
  const normalized: RegistryEntry = {
    ...entry,
    workspacePath: normalizeWorkspacePath(entry.workspacePath),
  };
  const live = loadRegistry()
    .filter((e) => isPidAlive(e.pid))
    .filter((e) => e.pid !== normalized.pid);
  live.push(normalized);
  saveRegistry(live);
}

export function unregisterEntry(pid: number): void {
  const remaining = loadRegistry().filter((e) => e.pid !== pid);
  saveRegistry(remaining);
}

function isValidEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.workspacePath === "string" &&
    typeof e.port === "number" &&
    typeof e.pid === "number" &&
    typeof e.name === "string" &&
    typeof e.startedAt === "string"
  );
}
