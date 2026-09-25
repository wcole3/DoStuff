// Page shell for the GitHub Pages demo: owns the DemoStore + DemoHost, relays
// messages between them and the three webview iframes (sidebar, board,
// graph), and draws the VSCode-ish chrome — tabs, toasts, a quick pick, the
// theme toggle and Reset. Bundled by scripts/build-demo.ts into shell.js.

import { DemoHost, FRAME_MODES, type DemoUi, type FrameMode } from "./demoHost";
import { DemoStore, localStorageKv } from "./demoStore";
import { buildSeed, SEED_COMMITS } from "./seed";
import type { HostToWebview, WebviewToHost } from "../src/types";

type Pane = "sidebar" | "board" | "graph";
type Theme = "dark" | "light";

const THEME_KEY = "dostuff-demo:theme";
const SIDEBAR_W_KEY = "dostuff-demo:sidebar-width";
const NARROW = window.matchMedia("(max-width: 820px)");
const TARGET_ORIGIN = location.origin === "null" ? "*" : location.origin;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const workbench = $<HTMLDivElement>("workbench");
const frames: Record<FrameMode, HTMLIFrameElement> = {
  sidebar: $("frame-sidebar"),
  board: $("frame-board"),
  graph: $("frame-graph"),
};
/** Frames whose webview has mounted and sent `ready`; earlier posts are dropped
 *  (the `init` reply carries the full board anyway). */
const readyFrames = new Set<FrameMode>();

// ─── Panes / tabs ─────────────────────────────────────────────────────

function showPane(pane: Pane): void {
  workbench.dataset.pane = pane;
  if (pane !== "sidebar") workbench.dataset.main = pane;
  const selected = NARROW.matches ? pane : workbench.dataset.main;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.pane === selected));
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => showPane(tab.dataset.pane as Pane));
}
NARROW.addEventListener("change", () => showPane(workbench.dataset.pane as Pane));

// ─── Theme ────────────────────────────────────────────────────────────

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  for (const f of Object.values(frames)) {
    try {
      if (f.contentDocument) f.contentDocument.documentElement.dataset.theme = theme;
    } catch {
      // not yet navigated — view.html reads the parent's theme on load
    }
  }
  const toggle = $<HTMLButtonElement>("theme-toggle");
  toggle.textContent = theme === "dark" ? "Light theme" : "Dark theme";
}

$("theme-toggle").addEventListener("click", () => {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // theme just won't persist
  }
  applyTheme(next);
});
applyTheme(currentTheme());

// ─── Toasts ───────────────────────────────────────────────────────────

/** `durationMs: 0` keeps the toast until dismissed. */
function notify(kind: "info" | "warning" | "error", text: string, durationMs?: number): void {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const dot = document.createElement("span");
  dot.className = "toast-dot";
  const body = document.createElement("span");
  body.className = "toast-text";
  body.textContent = text;
  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => el.remove());
  el.append(dot, body, close);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  const ms = durationMs ?? (kind === "info" ? 6000 : 9000);
  if (ms > 0) setTimeout(() => el.remove(), ms);
}

// ─── Quick pick ───────────────────────────────────────────────────────

interface PickOption<T> {
  value: T;
  label: string;
  detail?: string;
}

function quickPick<T>(title: string, options: PickOption<T>[]): Promise<T | null> {
  const backdrop = $<HTMLDivElement>("quickpick");
  const list = $<HTMLDivElement>("quickpick-options");
  $("quickpick-title").textContent = title;
  list.replaceChildren();
  return new Promise((resolve) => {
    const done = (value: T | null) => {
      backdrop.hidden = true;
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === backdrop) done(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(null);
    };
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qp-option";
      btn.textContent = opt.label;
      if (opt.detail) {
        const d = document.createElement("span");
        d.className = "qp-detail";
        d.textContent = opt.detail;
        btn.append(d);
      }
      btn.addEventListener("click", () => done(opt.value));
      list.append(btn);
    }
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    backdrop.hidden = false;
    list.querySelector<HTMLButtonElement>("button")?.focus();
  });
}

// ─── Files ────────────────────────────────────────────────────────────

function pickImportFile(): Promise<string | null> {
  const input = $<HTMLInputElement>("import-file");
  input.value = "";
  return new Promise((resolve) => {
    const finish = async () => {
      input.removeEventListener("change", finish);
      input.removeEventListener("cancel", finish);
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
    };
    input.addEventListener("change", finish);
    input.addEventListener("cancel", finish);
    input.click();
  });
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ─── Host wiring ──────────────────────────────────────────────────────

const ui: DemoUi = {
  post(to: FrameMode, msg: HostToWebview) {
    if (!readyFrames.has(to)) return;
    frames[to].contentWindow?.postMessage(msg, TARGET_ORIGIN);
  },
  notify: (kind, text) => notify(kind, text),
  showMain: (view) => showPane(view),
  revealed: () => {
    if (NARROW.matches) showPane("sidebar");
  },
  openExternal: (url) => window.open(url, "_blank", "noopener"),
  pickImportFile,
  chooseImportMode: (count) =>
    quickPick(`Import ${count} issues — how?`, [
      { value: "merge" as const, label: "Merge by id", detail: "Imported tickets replace ones with the same id; the rest stay." },
      { value: "replace" as const, label: "Replace all (destructive)", detail: "The board becomes exactly the imported file." },
    ]),
  download,
};

const kv = localStorageKv();
const store = new DemoStore({
  read: kv.read,
  write(value) {
    const saved = kv.write(value);
    $("storage-status").textContent = saved
      ? "Saved in this browser"
      : "Browser storage unavailable — edits last until reload";
    return saved;
  },
});
const { seeded } = store.load(() => buildSeed());
const host = new DemoHost(store, ui, SEED_COMMITS);

window.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { __dostuffDemo?: number; mode?: FrameMode; msg?: WebviewToHost } | null;
  if (!data || data.__dostuffDemo !== 1 || !data.msg) return;
  const mode = data.mode;
  if (!mode || !FRAME_MODES.includes(mode) || e.source !== frames[mode].contentWindow) return;
  if (data.msg.type === "ready") readyFrames.add(mode);
  host.handle(mode, data.msg).catch((err) => notify("error", `Demo host error: ${String(err)}`));
});

for (const btn of document.querySelectorAll<HTMLButtonElement>(".view-action")) {
  btn.addEventListener("click", async () => {
    const name = btn.dataset.command;
    if (name === "clearAll") {
      const ok = await quickPick("Delete all issues? This cannot be undone.", [
        { value: true, label: "Clear All" },
      ]);
      if (ok) {
        await host.reset([]);
        notify("info", "DoStuff: All issues cleared.");
      }
      return;
    }
    if (name === "newIssue" || name === "importJson" || name === "exportJson") {
      if (name === "newIssue") showPane("sidebar");
      await host.command(name);
    }
  });
}

if (seeded) {
  notify(
    "info",
    "Welcome! This is the real DoStuff UI running in your browser — edits are saved locally. Open #16 “Start here” for a tour.",
    0,
  );
}

$("reset-demo").addEventListener("click", async () => {
  const choice = await quickPick("Reset the demo? Your edits in this browser are discarded.", [
    { value: "seed" as const, label: "Restore the sample project" },
    { value: "empty" as const, label: "Start with an empty board" },
  ]);
  if (!choice) return;
  await host.reset(choice === "seed" ? buildSeed() : []);
  notify("info", choice === "seed" ? "Sample project restored." : "Board cleared.");
});

// ─── Sidebar resize ───────────────────────────────────────────────────

const sash = $<HTMLDivElement>("sash");
const MIN_W = 240;
const maxWidth = () => Math.max(MIN_W, Math.min(640, window.innerWidth - 420));

function setSidebarWidth(px: number, persist = false): void {
  const w = Math.round(Math.min(maxWidth(), Math.max(MIN_W, px)));
  workbench.style.setProperty("--sidebar-w", `${w}px`);
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(w));
    } catch {
      // width just won't persist
    }
  }
}

try {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (saved > 0) setSidebarWidth(saved);
} catch {
  // default width
}

sash.addEventListener("pointerdown", (e) => {
  sash.setPointerCapture(e.pointerId);
  sash.classList.add("is-dragging");
  workbench.classList.add("is-resizing");
  const left = sash.getBoundingClientRect().left - frames.sidebar.getBoundingClientRect().width;
  const move = (ev: PointerEvent) => setSidebarWidth(ev.clientX - left);
  const up = (ev: PointerEvent) => {
    setSidebarWidth(ev.clientX - left, true);
    sash.classList.remove("is-dragging");
    workbench.classList.remove("is-resizing");
    sash.removeEventListener("pointermove", move);
    sash.removeEventListener("pointerup", up);
    sash.removeEventListener("pointercancel", up);
  };
  sash.addEventListener("pointermove", move);
  sash.addEventListener("pointerup", up);
  sash.addEventListener("pointercancel", up);
});
sash.addEventListener("keydown", (e) => {
  const current = frames.sidebar.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") setSidebarWidth(current - 16, true);
  else if (e.key === "ArrowRight") setSidebarWidth(current + 16, true);
});

showPane("board");
