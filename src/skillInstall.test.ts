import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installAgentSkill, SkillInstallError } from "./skillInstall";

const SKILL_SRC = path.resolve(import.meta.dir, "..", "skills", "dostuff-tickets");

describe("installAgentSkill", () => {
  let tmp = "";

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  function destDir(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-skill-install-"));
    return path.join(tmp, "skills", "dostuff-tickets");
  }

  test("fresh install copies the package and sets the script exec bit", () => {
    const dest = destDir();
    const { copied } = installAgentSkill(SKILL_SRC, dest);
    expect(copied).toContain("SKILL.md");
    expect(copied).toContain(path.join("references", "tools.md"));
    expect(copied).toContain(path.join("scripts", "dostuff.sh"));
    const mode = fs.statSync(path.join(dest, "scripts", "dostuff.sh")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  test("reinstall replaces stale files instead of merging", () => {
    const dest = destDir();
    installAgentSkill(SKILL_SRC, dest);
    fs.writeFileSync(path.join(dest, "stale.md"), "old");
    const { copied } = installAgentSkill(SKILL_SRC, dest);
    expect(fs.existsSync(path.join(dest, "stale.md"))).toBe(false);
    expect(copied).toContain("SKILL.md");
  });

  test("missing source throws SkillInstallError", () => {
    const dest = destDir();
    expect(() => installAgentSkill(path.join(tmp, "nope"), dest)).toThrow(SkillInstallError);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
