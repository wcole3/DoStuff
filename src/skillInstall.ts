// Copy the bundled Claude Code agent skill (skills/dostuff-tickets/, shipped
// in the vsix) into a user's skill directory. vscode-free so it can be
// unit-tested directly, like mcpRegistry.ts; the extension command supplies
// the source (context.asAbsolutePath) and destination (~/.claude/skills).

import * as fs from "node:fs";
import * as path from "node:path";

export class SkillInstallError extends Error {}

/**
 * Recursively copy the skill package, replacing any existing install, and
 * restore the execute bit on shell scripts (vsce packaging does not preserve
 * file modes). Returns the copied file paths relative to `destDir`.
 */
export function installAgentSkill(srcDir: string, destDir: string): { copied: string[] } {
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    throw new SkillInstallError(`Skill source not found at ${srcDir} (missing SKILL.md).`);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });

  const copied: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        if (p.endsWith(".sh")) fs.chmodSync(p, 0o755);
        copied.push(path.relative(destDir, p));
      }
    }
  };
  walk(destDir);
  return { copied: copied.sort() };
}
