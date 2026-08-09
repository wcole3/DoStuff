// Copy the bundled Claude Code agent skill (skills/dostuff-tickets/, shipped
// in the vsix) into a user's skill directory, and keep that copy current when
// the extension updates. vscode-free so it can be unit-tested directly, like
// mcpRegistry.ts; the extension supplies the source (context.asAbsolutePath),
// destination (~/.claude/skills) and version (packageJSON.version).
//
// Update contract: installs write a MARKER_FILE recording the extension
// version and a sha-256 per installed file. On activation the extension calls
// maybeUpdateAgentSkill — a version-newer, byte-untouched install is replaced
// silently; a locally-edited one is never overwritten automatically (the
// caller surfaces a "Replace" prompt instead). A directory without a marker
// was not installed by us and is left alone.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export class SkillInstallError extends Error {}

export const MARKER_FILE = ".dostuff-skill.json";

interface SkillMarker {
  version: string;
  installedAt: string;
  /** relative posix path -> sha256 hex of the file as installed */
  files: Record<string, string>;
}

export type SkillUpdateResult =
  | { action: "not-installed" }
  | { action: "unmanaged" } // dir exists but no marker — manual copy, never touch
  | { action: "current"; version: string }
  | { action: "updated"; from: string; to: string }
  | { action: "modified"; from: string; to: string }; // local edits — caller must ask

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function readMarker(destDir: string): SkillMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(destDir, MARKER_FILE), "utf8"));
    if (raw && typeof raw.version === "string" && raw.files && typeof raw.files === "object") {
      return raw as SkillMarker;
    }
  } catch {
    // Missing or corrupt marker — treated as unmanaged.
  }
  return null;
}

/**
 * Recursively copy the skill package, replacing any existing install, restore
 * the execute bit on shell scripts (vsce packaging does not preserve file
 * modes), and write the version/hash marker. Returns the copied file paths
 * relative to `destDir` (marker excluded).
 */
export function installAgentSkill(
  srcDir: string,
  destDir: string,
  version = "0.0.0",
): { copied: string[] } {
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    throw new SkillInstallError(`Skill source not found at ${srcDir} (missing SKILL.md).`);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });

  const files: Record<string, string> = {};
  for (const rel of listFiles(destDir)) {
    const p = path.join(destDir, rel);
    if (rel.endsWith(".sh")) fs.chmodSync(p, 0o755);
    files[rel] = sha256(p);
  }
  const marker: SkillMarker = { version, installedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(destDir, MARKER_FILE), JSON.stringify(marker, null, 2));
  return { copied: Object.keys(files) };
}

/**
 * Reconcile an existing extension-managed install with the bundled skill.
 * Only replaces when the install is byte-identical to what we wrote (no local
 * edits, no extra files) AND the bundled version differs. Never creates a
 * fresh install — that stays an explicit user action (the install command).
 */
export function maybeUpdateAgentSkill(
  srcDir: string,
  destDir: string,
  bundledVersion: string,
): SkillUpdateResult {
  if (!fs.existsSync(destDir)) return { action: "not-installed" };
  const marker = readMarker(destDir);
  if (!marker) return { action: "unmanaged" };
  if (marker.version === bundledVersion) return { action: "current", version: marker.version };

  const present = listFiles(destDir).filter((f) => f !== MARKER_FILE);
  const recorded = Object.keys(marker.files).sort();
  const pristine =
    present.length === recorded.length &&
    present.every(
      (rel, i) => rel === recorded[i] && sha256(path.join(destDir, rel)) === marker.files[rel],
    );
  if (!pristine) return { action: "modified", from: marker.version, to: bundledVersion };

  installAgentSkill(srcDir, destDir, bundledVersion);
  return { action: "updated", from: marker.version, to: bundledVersion };
}
