// Modals: Add issue, Delete confirm, Import JSON, Export JSON, Settings

const { useState: useStateM, useRef: useRefM, useEffect: useEffectM } = React;
const { Icon: IconM } = window.DS_ICONS;

const Modal = ({ title, onClose, children, footer, width = 480 }) => {
  useEffectM(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ds-modal-backdrop" onClick={onClose}>
      <div className="ds-modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-head">
          <span className="ds-modal-title">{title}</span>
          <button className="ds-modal-close" onClick={onClose}><IconM name="close" size={12} /></button>
        </div>
        <div className="ds-modal-body">{children}</div>
        {footer && <div className="ds-modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

// ─── Add Issue ────────────────────────────────────────────────────────────
const AddIssueModal = ({ onClose, onCreate }) => {
  const [title, setTitle] = useStateM("");
  const [type, setType] = useStateM("Bug");
  const [priority, setPriority] = useStateM("Regular");
  const [description, setDescription] = useStateM("");
  const [verifyCriteria, setVerifyCriteria] = useStateM("");
  const [status, setStatus] = useStateM("Thinking");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({ title: title.trim(), type, priority, description, verifyCriteria, status });
    onClose();
  };

  return (
    <Modal
      title="New Issue"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="ds-btn" onClick={onClose}>Cancel</button>
          <button className="ds-btn ds-btn-primary" disabled={!title.trim()} onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <div className="ds-form">
        <label className="ds-form-row">
          <span>Title</span>
          <input
            className="ds-input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary…"
            onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) submit(); }}
          />
        </label>
        <div className="ds-form-grid-3">
          <label className="ds-form-row">
            <span>Status</span>
            <select className="ds-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {window.DS_DATA.STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="ds-form-row">
            <span>Priority</span>
            <select className="ds-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {window.DS_DATA.PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label className="ds-form-row">
            <span>Type</span>
            <select className="ds-input" value={type} onChange={(e) => setType(e.target.value)}>
              {window.DS_DATA.ISSUE_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        </div>
        <label className="ds-form-row">
          <span>Description</span>
          <textarea
            className="ds-input ds-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What's going on?"
          />
        </label>
        <label className="ds-form-row">
          <span>How to verify</span>
          <textarea
            className="ds-input ds-textarea"
            value={verifyCriteria}
            onChange={(e) => setVerifyCriteria(e.target.value)}
            rows={2}
            placeholder="How will we know this is done?"
          />
        </label>
      </div>
    </Modal>
  );
};

// ─── Delete confirm ──────────────────────────────────────────────────────
const DeleteConfirmModal = ({ issue, onClose, onConfirm }) => (
  <Modal
    title="Delete issue?"
    onClose={onClose}
    width={420}
    footer={
      <>
        <button className="ds-btn" onClick={onClose}>Cancel</button>
        <button className="ds-btn ds-btn-danger" onClick={() => { onConfirm(issue.id); onClose(); }}>
          Delete
        </button>
      </>
    }
  >
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
      Permanently delete <strong>#{issue.number}</strong> <span style={{ opacity: .55 }}>({issue.id})</span> — “{issue.title}”?
    </p>
    <p style={{ margin: "10px 0 0", fontSize: 12, opacity: .65 }}>
      This can't be undone. State history and tasks will be lost.
    </p>
  </Modal>
);

// ─── Export ───────────────────────────────────────────────────────────────
const ExportModal = ({ issues, onClose }) => {
  const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), issues }, null, 2);
  const [copied, setCopied] = useStateM(false);
  const taRef = useRefM(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      taRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dostuff-issues-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      title="Export issues"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="ds-btn" onClick={onClose}>Close</button>
          <button className="ds-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy JSON"}</button>
          <button className="ds-btn ds-btn-primary" onClick={download}>
            <IconM name="download" size={11} />Download .json
          </button>
        </>
      }
    >
      <p style={{ margin: "0 0 10px", fontSize: 12, opacity: .7 }}>
        {issues.length} issues · {(json.length / 1024).toFixed(1)} KB
      </p>
      <textarea
        ref={taRef}
        className="ds-input ds-textarea ds-mono"
        readOnly
        value={json}
        style={{ height: 280 }}
        onFocus={(e) => e.target.select()}
      />
    </Modal>
  );
};

// ─── Import ───────────────────────────────────────────────────────────────
const ImportModal = ({ onClose, onImport, currentIssues }) => {
  const [text, setText] = useStateM("");
  const [mode, setMode] = useStateM("merge"); // 'merge' | 'replace'
  const [error, setError] = useStateM(null);
  const [preview, setPreview] = useStateM(null);
  const fileRef = useRefM(null);

  const parse = (val) => {
    try {
      const parsed = JSON.parse(val);
      const list = Array.isArray(parsed) ? parsed : parsed.issues;
      if (!Array.isArray(list)) throw new Error("Expected an array or {issues: [...]}");
      // Light validation
      list.forEach((it, idx) => {
        if (!it.id || !it.title) throw new Error(`Item ${idx}: missing id or title`);
      });
      setError(null);
      setPreview(list);
    } catch (e) {
      setError(e.message);
      setPreview(null);
    }
  };

  const onChangeText = (v) => {
    setText(v);
    if (v.trim()) parse(v);
    else { setError(null); setPreview(null); }
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => onChangeText(r.result);
    r.readAsText(file);
  };

  const doImport = () => {
    if (!preview) return;
    onImport(preview, mode);
    onClose();
  };

  return (
    <Modal
      title="Import issues"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="ds-btn" onClick={onClose}>Cancel</button>
          <button
            className="ds-btn ds-btn-primary"
            disabled={!preview}
            onClick={doImport}
          >
            {mode === "merge" ? `Merge ${preview?.length || 0} issues` : `Replace all (${preview?.length || 0})`}
          </button>
        </>
      }
    >
      <div className="ds-form">
        <div className="ds-form-row">
          <span>Source</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="ds-btn" onClick={() => fileRef.current?.click()}>
              <IconM name="upload" size={11} />Choose file…
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={onFile} />
            <span style={{ fontSize: 11, opacity: .6 }}>…or paste JSON below</span>
          </div>
        </div>
        <label className="ds-form-row">
          <span>JSON</span>
          <textarea
            className="ds-input ds-textarea ds-mono"
            value={text}
            placeholder='{"version":1,"issues":[ ... ]}'
            onChange={(e) => onChangeText(e.target.value)}
            style={{ height: 200 }}
          />
        </label>
        {error && (
          <div className="ds-banner ds-banner-error">
            <IconM name="close" size={11} />{error}
          </div>
        )}
        {preview && (
          <div className="ds-banner ds-banner-ok">
            <IconM name="check" size={11} />
            Parsed {preview.length} issues. Current workspace has {currentIssues.length}.
          </div>
        )}
        <div className="ds-form-row">
          <span>Mode</span>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} />
              Merge (by id)
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
              Replace all
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
};

// ─── Settings ─────────────────────────────────────────────────────────────
const DEFAULT_WORKFLOW_PROMPT = `You are an engineering agent working through the DoStuff issue queue.

Workflow contract:
  1. Tickets are addressed by their number (e.g. "42") or their id ("DS-042").
     Use get_ticket to fetch one by number, id, or a substring of its title
     when the user says "get ticket 42 and begin work" or "start on the OAuth ticket".
  2. Read dostuff://tickets to discover work. Only Planned / Working / Testing
     tickets are visible — Thinking tickets are drafts the human is still shaping,
     and Complete tickets are done.
  3. When you start a ticket, call update_ticket_status to move it to "Working".
     When you believe it's ready for verification, move it to "Testing".
  4. You cannot mark a ticket "Complete". A human reviews Testing tickets and
     decides. If your verification fails, move it back to "Working".
  5. As you make progress, call update_ticket_progress to tick tasks off and
     append a short note to the ticket's record. Be terse and factual.
  6. If you discover follow-up work, call create_ticket to file it. New tickets
     land in "Thinking" so the human can triage them.

You may NOT modify a ticket's title, description, priority, type, or verify
criteria via the MCP server.`;

const SettingsModal = ({ settings, onSave, onClose, onClearAll }) => {
  const [draft, setDraft] = useStateM(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const mcp = draft.mcp || { enabled: true, port: 3947, instructions: "" };
  const setMcp = (patch) => setDraft({ ...draft, mcp: { ...mcp, ...patch } });
  const promptIsCustom = !!(mcp.instructions && mcp.instructions.trim());
  const portOk = Number.isInteger(mcp.port) && mcp.port >= 1024 && mcp.port <= 65535;

  return (
    <Modal
      title="DoStuff settings"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="ds-btn ds-btn-danger" onClick={onClearAll} style={{ marginRight: "auto" }}>
            Reset all data…
          </button>
          <button className="ds-btn" onClick={onClose}>Cancel</button>
          <button
            className="ds-btn ds-btn-primary"
            disabled={!dirty || !portOk}
            onClick={() => { onSave(draft); onClose(); }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="ds-form">
        <div className="ds-form-row">
          <span>Storage backend</span>
          <div className="ds-radio-grid">
            <label className={`ds-radio-card ${draft.storageMode === "json-files" ? "is-active" : ""}`}>
              <input type="radio" checked={draft.storageMode === "json-files"} onChange={() => setDraft({ ...draft, storageMode: "json-files" })} />
              <IconM name="files" size={16} />
              <div>
                <div className="ds-radio-title">JSON files</div>
                <div className="ds-radio-sub">One file per issue in your workspace. Git-friendly. Easy to inspect.</div>
              </div>
            </label>
            <label className={`ds-radio-card ${draft.storageMode === "sqlite" ? "is-active" : ""}`}>
              <input type="radio" checked={draft.storageMode === "sqlite"} onChange={() => setDraft({ ...draft, storageMode: "sqlite" })} />
              <IconM name="database" size={16} />
              <div>
                <div className="ds-radio-title">SQLite</div>
                <div className="ds-radio-sub">Single .db in extension storage. Faster search on large workspaces.</div>
              </div>
            </label>
          </div>
        </div>
        <label className="ds-form-row">
          <span>Storage path</span>
          <input
            className="ds-input ds-mono"
            value={draft.storagePath}
            onChange={(e) => setDraft({ ...draft, storagePath: e.target.value })}
          />
        </label>
        <div className="ds-form-row">
          <span>Auto-save</span>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={draft.autoSave}
              onChange={(e) => setDraft({ ...draft, autoSave: e.target.checked })}
            />
            Save changes automatically on edit
          </label>
        </div>

        {/* ── MCP server ─────────────────────────────────────────────── */}
        <div className="ds-settings-divider">
          <span>MCP server</span>
          <span className="ds-settings-divider-sub">
            Lets local agents work the active ticket queue
          </span>
        </div>

        <div className="ds-form-row">
          <span>Server</span>
          <label className="ds-mcp-toggle">
            <input
              type="checkbox"
              checked={!!mcp.enabled}
              onChange={(e) => setMcp({ enabled: e.target.checked })}
            />
            <span>{mcp.enabled ? "Enabled" : "Disabled"}</span>
            {mcp.enabled && (
              <code className="ds-mcp-url">http://127.0.0.1:{portOk ? mcp.port : "—"}/mcp</code>
            )}
          </label>
        </div>

        <label className="ds-form-row">
          <span>Port</span>
          <input
            className={`ds-input ds-mono ${portOk ? "" : "ds-input-error"}`}
            style={{ maxWidth: 120 }}
            value={mcp.port}
            type="number"
            min={1024}
            max={65535}
            disabled={!mcp.enabled}
            onChange={(e) => setMcp({ port: parseInt(e.target.value, 10) || 0 })}
          />
        </label>

        <div className="ds-form-row">
          <span>Workflow prompt</span>
          <div className="ds-mcp-prompt">
            <div className="ds-mcp-prompt-head">
              <span className={`ds-mcp-prompt-badge ${promptIsCustom ? "is-custom" : ""}`}>
                {promptIsCustom ? "Custom" : "Built-in default"}
              </span>
              <span className="ds-mcp-prompt-help">
                Served alongside every ticket and as a standalone resource. System-level setting.
              </span>
              {promptIsCustom && (
                <button
                  className="ds-link-btn"
                  onClick={() => setMcp({ instructions: "" })}
                  title="Revert to built-in default"
                >
                  Reset to default
                </button>
              )}
            </div>
            <textarea
              className="ds-input ds-textarea ds-mono"
              value={promptIsCustom ? mcp.instructions : DEFAULT_WORKFLOW_PROMPT}
              placeholder="(using built-in default — start typing to customize)"
              disabled={!mcp.enabled}
              onChange={(e) => setMcp({ instructions: e.target.value })}
              rows={10}
              spellCheck={false}
            />
          </div>
        </div>

        <div className="ds-mcp-tools">
          <div className="ds-mcp-tools-title">Tools exposed to agents</div>
          <ul>
            <li><code>get_ticket</code> — fetch a ticket by <code>#number</code>, <code>DS-id</code>, or a title substring. Returns Planned/Working/Testing only.</li>
            <li><code>create_ticket</code> — files a new ticket in Thinking for human triage.</li>
            <li><code>update_ticket_status</code> — Planned ↔ Working ↔ Testing. Cannot mark Complete.</li>
            <li><code>update_ticket_progress</code> — toggle tasks and append to record. Cannot edit title, description, priority, type, or verify criteria.</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
};

Object.assign(window, { Modal, AddIssueModal, DeleteConfirmModal, ExportModal, ImportModal, SettingsModal });
