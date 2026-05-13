// Storage layer for the preview.
// In the real VSCode extension this would be backed by:
//   - vscode.ExtensionContext.workspaceState (or globalState), OR
//   - JSON files under context.storageUri / context.globalStorageUri
// Here we mirror that behavior with localStorage so the preview persists across reloads.

const STORAGE_KEY = "dostuff.issues.v1";
const SETTINGS_KEY = "dostuff.settings.v1";

const DEFAULT_SETTINGS = {
  storageMode: "json-files", // 'json-files' | 'sqlite'
  storagePath: ".vscode/dostuff/",
  autoSave: true,
  mcp: {
    enabled: true,
    port: 3947,
    // Empty = use the built-in default workflow prompt.
    instructions: "",
  },
};

function loadIssues() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIssues(issues) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(issues));
  } catch (e) {
    console.warn("saveIssues failed", e);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mcp: { ...DEFAULT_SETTINGS.mcp, ...(parsed.mcp || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

function makeNumber(existing) {
  const nums = existing
    .map((i) => Number.isFinite(i.number)
      ? i.number
      : parseInt(String(i.id || "").replace(/^DS-/, ""), 10))
    .filter((n) => Number.isFinite(n));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function makeId(existing) {
  return `DS-${String(makeNumber(existing)).padStart(3, "0")}`;
}

window.DS_STORAGE = {
  STORAGE_KEY,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  loadIssues,
  saveIssues,
  loadSettings,
  saveSettings,
  makeId,
  makeNumber,
};
