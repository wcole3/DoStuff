import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  installAgentSkill,
  maybeUpdateAgentSkill,
  MARKER_FILE,
  SkillInstallError,
} from "./skillInstall";

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

  test("install writes a marker with version and per-file hashes", () => {
    const dest = destDir();
    const { copied } = installAgentSkill(SKILL_SRC, dest, "2.0.0");
    const marker = JSON.parse(fs.readFileSync(path.join(dest, MARKER_FILE), "utf8"));
    expect(marker.version).toBe("2.0.0");
    expect(Object.keys(marker.files).sort()).toEqual(
      copied.map((c) => c.split(path.sep).join("/")).sort(),
    );
    expect(copied).not.toContain(MARKER_FILE);
  });
});

describe("maybeUpdateAgentSkill", () => {
  let tmp = "";

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  function destDir(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dostuff-skill-update-"));
    return path.join(tmp, "skills", "dostuff-tickets");
  }

  test("not-installed and unmanaged dirs are left alone", () => {
    const dest = destDir();
    expect(maybeUpdateAgentSkill(SKILL_SRC, dest, "2.1.0")).toEqual({ action: "not-installed" });

    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "manual copy");
    expect(maybeUpdateAgentSkill(SKILL_SRC, dest, "2.1.0")).toEqual({ action: "unmanaged" });
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("manual copy");
  });

  test("same version is current; newer version with pristine files auto-updates", () => {
    const dest = destDir();
    installAgentSkill(SKILL_SRC, dest, "2.0.0");
    expect(maybeUpdateAgentSkill(SKILL_SRC, dest, "2.0.0")).toEqual({
      action: "current",
      version: "2.0.0",
    });

    const r = maybeUpdateAgentSkill(SKILL_SRC, dest, "2.1.0");
    expect(r).toEqual({ action: "updated", from: "2.0.0", to: "2.1.0" });
    const marker = JSON.parse(fs.readFileSync(path.join(dest, MARKER_FILE), "utf8"));
    expect(marker.version).toBe("2.1.0");
  });

  test("locally edited install reports modified and is not touched", () => {
    const dest = destDir();
    installAgentSkill(SKILL_SRC, dest, "2.0.0");
    fs.appendFileSync(path.join(dest, "SKILL.md"), "\nlocal tweak\n");
    const r = maybeUpdateAgentSkill(SKILL_SRC, dest, "2.1.0");
    expect(r).toEqual({ action: "modified", from: "2.0.0", to: "2.1.0" });
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("local tweak");
  });

  test("extra user files count as local edits", () => {
    const dest = destDir();
    installAgentSkill(SKILL_SRC, dest, "2.0.0");
    fs.writeFileSync(path.join(dest, "my-notes.md"), "keep");
    const r = maybeUpdateAgentSkill(SKILL_SRC, dest, "2.1.0");
    expect(r).toEqual({ action: "modified", from: "2.0.0", to: "2.1.0" });
    expect(fs.existsSync(path.join(dest, "my-notes.md"))).toBe(true);
  });
});
