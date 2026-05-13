// App root — VSCode chrome + Sidebar + Editor area (Welcome / Board tab)

const { useState: useStateA, useEffect: useEffectA, useMemo: useMemoA } = React;
const { Icon: IconA, STATUS_META: STM_A } = window.DS_ICONS;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#0078d4",
  "theme": "dark",
  "laneStyle": "card",
  "tileStyle": "flat",
  "density": "comfy"
}/*EDITMODE-END*/;

const ACCENTS = ["#0078d4", "#1f8a5b", "#c586c0", "#e2c08d", "#f48771", "#75beff"];

// ─── VSCode chrome ────────────────────────────────────────────────────────
const ActivityBar = ({ active, onPick }) => {
  const items = [
    { id: "explorer", icon: "files", label: "Explorer" },
    { id: "search",   icon: "search", label: "Search" },
    { id: "dostuff",  icon: "list",   label: "DoStuff: Issues" },
    { id: "settings", icon: "settings", label: "Settings" },
  ];
  return (
    <div className="vs-activitybar">
      <div className="vs-act-top">
        {items.slice(0, 3).map((it) => (
          <button
            key={it.id}
            className={`vs-act-btn ${active === it.id ? "is-active" : ""}`}
            onClick={() => onPick(it.id)}
            title={it.label}
          >
            <IconA name={it.icon} size={20} />
            {it.id === "dostuff" && (
              <span className="vs-act-badge">{/* unread issue count could go here */}</span>
            )}
          </button>
        ))}
      </div>
      <div className="vs-act-bot">
        <button className="vs-act-btn" title="Settings"><IconA name="settings" size={20} /></button>
      </div>
    </div>
  );
};

const TabBar = ({ tabs, activeId, onActivate, onClose }) => (
  <div className="vs-tabbar">
    {tabs.map((t) => (
      <div
        key={t.id}
        className={`vs-tab ${activeId === t.id ? "is-active" : ""}`}
        onClick={() => onActivate(t.id)}
      >
        <IconA name={t.icon} size={13} style={{ opacity: .85 }} />
        <span className="vs-tab-label">{t.label}</span>
        <button
          className="vs-tab-close"
          onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
        >
          <IconA name="close" size={10} />
        </button>
      </div>
    ))}
  </div>
);

const StatusBar = ({ issues, settings }) => {
  const counts = useMemoA(() => {
    const c = { Thinking: 0, Planned: 0, Working: 0, Testing: 0, Complete: 0 };
    issues.forEach((i) => c[i.status]++);
    return c;
  }, [issues]);
  const mcp = settings.mcp || { enabled: false, port: 3947 };
  const servable = counts.Planned + counts.Working + counts.Testing;
  return (
    <div className="vs-statusbar">
      <span className="vs-sb-item"><IconA name="board" size={11} />main</span>
      <span className="vs-sb-item">{issues.length} issues</span>
      <span className="vs-sb-item" style={{ color: STM_A.Working.color }}>● {counts.Working} working</span>
      <span className="vs-sb-item" style={{ color: STM_A.Testing.color }}>● {counts.Testing} testing</span>
      <span
        className={`vs-sb-item vs-sb-mcp ${mcp.enabled ? "is-on" : "is-off"}`}
        title={
          mcp.enabled
            ? `MCP server on :${mcp.port}\nServing ${servable} tickets to local agents`
            : "MCP server disabled"
        }
      >
        <span className="vs-sb-mcp-dot" />
        MCP {mcp.enabled ? `:${mcp.port}` : "off"}
        {mcp.enabled && <span className="vs-sb-mcp-count">{servable}</span>}
      </span>
      <span className="vs-sb-spacer" />
      <span className="vs-sb-item">{settings.storageMode === "sqlite" ? "SQLite" : "JSON files"}</span>
      <span className="vs-sb-item">{settings.autoSave ? "Auto-save: on" : "Auto-save: off"}</span>
      <span className="vs-sb-item">UTF-8</span>
      <span className="vs-sb-item">DoStuff v1.0.0</span>
    </div>
  );
};

const WelcomeView = ({ onOpenBoard, issues }) => (
  <div className="vs-welcome">
    <div className="vs-welcome-inner">
      <div className="vs-welcome-mark">
        <IconA name="board" size={28} />
      </div>
      <h1>DoStuff</h1>
      <p>A lightweight issue tracker that lives in your editor.</p>
      <div className="vs-welcome-actions">
        <button className="ds-btn ds-btn-primary" onClick={onOpenBoard}>
          <IconA name="board" size={12} />Open Board
        </button>
        <a className="ds-btn ds-btn-ghost" href="#" onClick={(e) => e.preventDefault()}>
          New Issue (Ctrl+Shift+I)
        </a>
        <a className="ds-btn ds-btn-ghost" href="#" onClick={(e) => e.preventDefault()}>
          Import JSON…
        </a>
      </div>
      <div className="vs-welcome-stats">
        <div><strong>{issues.length}</strong><span>Total</span></div>
        <div><strong style={{ color: STM_A.Working.color }}>{issues.filter(i => i.status === "Working").length}</strong><span>Working</span></div>
        <div><strong style={{ color: STM_A.Testing.color }}>{issues.filter(i => i.status === "Testing").length}</strong><span>Testing</span></div>
        <div><strong style={{ color: STM_A.Complete.color }}>{issues.filter(i => i.status === "Complete").length}</strong><span>Complete</span></div>
      </div>
      <div className="vs-welcome-hint">
        Tip: drag cards between lanes on the Board to change status. Every status change is logged to the issue's history.
      </div>
    </div>
  </div>
);

// ─── Command palette (Ctrl/Cmd+Shift+P) ──────────────────────────────────
const CommandPalette = ({ commands, onClose }) => {
  const [q, setQ] = useStateA("");
  const [sel, setSel] = useStateA(0);
  const inputRef = React.useRef(null);

  useEffectA(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemoA(() => {
    const n = q.trim().toLowerCase();
    if (!n) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(n) || c.id.toLowerCase().includes(n));
  }, [commands, q]);

  useEffectA(() => { setSel(0); }, [q]);

  useEffectA(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[sel];
        if (cmd) { onClose(); cmd.run(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, sel, onClose]);

  return (
    <div className="vs-cmdp-backdrop" onClick={onClose}>
      <div className="vs-cmdp" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="vs-cmdp-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command name…"
        />
        <div className="vs-cmdp-list">
          {filtered.length === 0 ? (
            <div className="vs-cmdp-empty">No matching commands</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                className={`vs-cmdp-item ${i === sel ? "is-active" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => { onClose(); c.run(); }}
              >
                <span className="vs-cmdp-title">{c.title}</span>
                {c.kbd && <span className="vs-cmdp-kbd">{c.kbd}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

// ─── App root ─────────────────────────────────────────────────────────────
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Load issues — first time uses SAMPLE_ISSUES
  const [issues, setIssues] = useStateA(() => {
    const loaded = window.DS_STORAGE.loadIssues();
    const list = loaded ?? window.DS_DATA.SAMPLE_ISSUES;
    // Backfill forward-compat fields for older localStorage payloads.
    return list.map((i) => ({
      ...i,
      number: Number.isFinite(i.number)
        ? i.number
        : parseInt(String(i.id || "").replace(/^DS-/, ""), 10) || 0,
      record: Array.isArray(i.record) ? i.record : [],
    }));
  });
  const [settings, setSettings] = useStateA(() => window.DS_STORAGE.loadSettings());

  // Persist
  useEffectA(() => { window.DS_STORAGE.saveIssues(issues); }, [issues]);
  useEffectA(() => { window.DS_STORAGE.saveSettings(settings); }, [settings]);

  // VSCode chrome state
  const [activeAct, setActiveAct] = useStateA("dostuff");
  const [sidebarOpen, setSidebarOpen] = useStateA(true);
  const [sidebarWidth, setSidebarWidth] = useStateA(340);
  const [tabs, setTabs] = useStateA([]);
  const [activeTab, setActiveTab] = useStateA(null);

  // Modals
  const [modal, setModal] = useStateA(null); // 'add' | 'import' | 'export' | 'settings' | {kind:'delete', issue}

  // Mutators
  const updateIssue = (next) => setIssues((arr) => arr.map((i) => i.id === next.id ? next : i));
  const deleteIssue = (id) => setIssues((arr) => arr.filter((i) => i.id !== id));
  const createIssue = (partial) => {
    const number = window.DS_STORAGE.makeNumber(issues);
    const id = `DS-${String(number).padStart(3, "0")}`;
    const now = new Date().toISOString();
    const issue = {
      id,
      number,
      title: partial.title,
      type: partial.type,
      priority: partial.priority,
      status: partial.status,
      description: partial.description,
      tasks: [],
      verifyCriteria: partial.verifyCriteria,
      createdAt: now,
      resolvedAt: partial.status === "Complete" ? now : null,
      statusHistory: [{ status: partial.status, at: now }],
      record: [],
    };
    setIssues((arr) => [issue, ...arr]);
  };
  const importIssues = (incoming, mode) => {
    if (mode === "replace") setIssues(incoming);
    else {
      // merge by id
      setIssues((arr) => {
        const byId = new Map(arr.map((i) => [i.id, i]));
        incoming.forEach((i) => byId.set(i.id, i));
        return Array.from(byId.values()).sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
      });
    }
  };
  const resetAll = () => {
    if (!confirm("Reset all issues and settings? This can't be undone.")) return;
    localStorage.removeItem(window.DS_STORAGE.STORAGE_KEY);
    localStorage.removeItem(window.DS_STORAGE.SETTINGS_KEY);
    setIssues(window.DS_DATA.SAMPLE_ISSUES);
    setSettings(window.DS_STORAGE.DEFAULT_SETTINGS);
    setModal(null);
  };

  // Tabs
  const openBoard = () => {
    if (!tabs.some((t) => t.id === "board")) {
      setTabs((arr) => [...arr, { id: "board", label: "DoStuff: Board", icon: "board" }]);
    }
    setActiveTab("board");
  };
  const closeTab = (id) => {
    setTabs((arr) => arr.filter((t) => t.id !== id));
    if (activeTab === id) setActiveTab(null);
  };

  // Apply theme + tweaks to body
  useEffectA(() => {
    document.body.dataset.theme = t.theme;
    document.body.dataset.density = t.density;
    document.body.dataset.laneStyle = t.laneStyle;
    document.body.dataset.tileStyle = t.tileStyle;
    document.body.style.setProperty("--accent", t.accent);
  }, [t.theme, t.density, t.laneStyle, t.tileStyle, t.accent]);

  // Keyboard shortcut: ctrl/cmd+shift+i = new issue
  useEffectA(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setModal("add");
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Command palette
  const [paletteOpen, setPaletteOpen] = useStateA(false);
  const commands = useMemoA(() => [
    { id: "dostuff.openBoard",            title: "DoStuff: Show Board",                       run: openBoard, kbd: "" },
    { id: "dostuff.newIssue",             title: "DoStuff: New Issue…",                       run: () => setModal("add"), kbd: "⇧⌘I" },
    { id: "dostuff.exportJson",           title: "DoStuff: Export Issues (JSON)…",            run: () => setModal("export"), kbd: "" },
    { id: "dostuff.importJson",           title: "DoStuff: Import Issues (JSON)…",            run: () => setModal("import"), kbd: "" },
    { id: "dostuff.focusSearch",          title: "DoStuff: Focus Search",                     run: () => {}, kbd: "⇧⌘F" },
    { id: "dostuff.mcp.toggle",           title: "DoStuff: Toggle MCP Server",                run: () => setSettings({ ...settings, mcp: { ...settings.mcp, enabled: !settings.mcp.enabled } }), kbd: "" },
    { id: "dostuff.mcp.editInstructions", title: "DoStuff: Edit MCP Workflow Instructions…", run: () => setModal("settings"), kbd: "" },
  ], [openBoard, settings]);

  // Welcome view stays visible if no tab is open
  const showWelcome = !activeTab;

  return (
    <div className="vs-root" data-screen-label="01 VSCode Window">
      {/* Title bar */}
      <div className="vs-titlebar">
        <div className="vs-tb-menus">
          <span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span>
        </div>
        <div className="vs-tb-title">DoStuff — Visual Studio Code</div>
        <div className="vs-tb-window">
          <span className="vs-tb-mini" />
          <span className="vs-tb-max" />
          <span className="vs-tb-close" />
        </div>
      </div>

      <div className="vs-main">
        <ActivityBar
          active={activeAct}
          onPick={(id) => {
            if (id === activeAct) setSidebarOpen(!sidebarOpen);
            else { setActiveAct(id); setSidebarOpen(true); }
          }}
        />

        {sidebarOpen && activeAct === "dostuff" && (
          <Sidebar
            issues={issues}
            onUpdate={updateIssue}
            onDelete={(id) => {
              const issue = issues.find((i) => i.id === id);
              if (issue) setModal({ kind: "delete", issue });
            }}
            onAdd={() => setModal("add")}
            onOpenBoard={openBoard}
            onImport={() => setModal("import")}
            onExport={() => setModal("export")}
            onSettings={() => setModal("settings")}
            width={sidebarWidth}
            onResize={setSidebarWidth}
          />
        )}

        {sidebarOpen && activeAct !== "dostuff" && (
          <aside className="ds-sidebar" style={{ width: sidebarWidth }}>
            <div className="ds-sb-titlebar"><span className="ds-sb-title">{activeAct === "explorer" ? "EXPLORER" : activeAct === "search" ? "SEARCH" : "SETTINGS"}</span></div>
            <div className="ds-sb-list" style={{ padding: 16, fontSize: 12, opacity: .6 }}>
              <p>(This is a DoStuff prototype — switch to the DoStuff icon in the activity bar to see the extension.)</p>
            </div>
            <div className="ds-sb-resize" onMouseDown={(e) => {
              e.preventDefault();
              const sx = e.clientX, sw = sidebarWidth;
              const m = (ev) => setSidebarWidth(Math.max(220, Math.min(560, sw + (ev.clientX - sx))));
              const u = () => { window.removeEventListener("mousemove", m); window.removeEventListener("mouseup", u); };
              window.addEventListener("mousemove", m); window.addEventListener("mouseup", u);
            }} />
          </aside>
        )}

        <div className="vs-editor">
          <TabBar
            tabs={tabs}
            activeId={activeTab}
            onActivate={setActiveTab}
            onClose={closeTab}
          />
          <div className="vs-editor-body">
            {showWelcome ? (
              <WelcomeView onOpenBoard={openBoard} issues={issues} />
            ) : activeTab === "board" ? (
              <div data-screen-label="02 Kanban Board" style={{ height: "100%" }}>
                <Board issues={issues} onUpdate={updateIssue} onDelete={(id) => {
                  const issue = issues.find((i) => i.id === id);
                  if (issue) setModal({ kind: "delete", issue });
                }} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <StatusBar issues={issues} settings={settings} />

      {/* Modals */}
      {modal === "add" && <AddIssueModal onClose={() => setModal(null)} onCreate={createIssue} />}
      {modal === "export" && <ExportModal issues={issues} onClose={() => setModal(null)} />}
      {modal === "import" && <ImportModal onClose={() => setModal(null)} onImport={importIssues} currentIssues={issues} />}
      {modal === "settings" && (
        <SettingsModal
          settings={settings}
          onSave={setSettings}
          onClose={() => setModal(null)}
          onClearAll={resetAll}
        />
      )}
      {modal?.kind === "delete" && (
        <DeleteConfirmModal
          issue={modal.issue}
          onClose={() => setModal(null)}
          onConfirm={deleteIssue}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio
          label="Color theme"
          value={t.theme}
          options={["dark", "light"]}
          onChange={(v) => setTweak("theme", v)}
        />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={ACCENTS}
          onChange={(v) => setTweak("accent", v)}
        />

        <TweakSection label="Sidebar" />
        <TweakRadio
          label="Density"
          value={t.density}
          options={["compact", "comfy"]}
          onChange={(v) => setTweak("density", v)}
        />

        <TweakSection label="Board" />
        <TweakSelect
          label="Lane style"
          value={t.laneStyle}
          options={[
            { value: "card", label: "Card (boxed)" },
            { value: "column", label: "Column (subtle)" },
            { value: "header", label: "Header only" },
          ]}
          onChange={(v) => setTweak("laneStyle", v)}
        />
        <TweakSelect
          label="Tile style"
          value={t.tileStyle}
          options={[
            { value: "flat", label: "Flat" },
            { value: "bevel", label: "Beveled" },
            { value: "outline", label: "Outline" },
            { value: "accent", label: "Left-accent" },
          ]}
          onChange={(v) => setTweak("tileStyle", v)}
        />

        <TweakSection label="Data" />
        <TweakButton label="New issue" onClick={() => setModal("add")} />
        <TweakButton label="Import JSON…" onClick={() => setModal("import")} />
        <TweakButton label="Export JSON…" onClick={() => setModal("export")} />
        <TweakButton label="Reset all data" onClick={resetAll} secondary />
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
