// Sidebar — list of issues with search + expanded inline detail
// In real extension: this is the WebviewView shown in the activity bar

const { useState, useMemo, useRef, useEffect } = React;

// Relative time formatter
function relTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 86400000;
  if (diff < 1) {
    const h = Math.floor(diff * 24);
    if (h < 1) return "just now";
    return `${h}h ago`;
  }
  if (diff < 2) return "yesterday";
  if (diff < 30) return `${Math.floor(diff)}d ago`;
  return d.toLocaleDateString();
}

function absTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const { Icon, TYPE_ICON, PRIORITY_META, STATUS_META } = window.DS_ICONS;

// ─── Priority + Status pills ──────────────────────────────────────────────
const PriorityIcon = ({ priority, size = 12 }) => {
  const meta = PRIORITY_META[priority];
  if (!meta) return null;
  return (
    <span
      title={priority}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 16, height: 16, color: meta.color,
      }}
    >
      <Icon name={meta.icon} size={size} />
    </span>
  );
};

const StatusPill = ({ status }) => {
  const meta = STATUS_META[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 10.5, color: "var(--vsc-fg-muted)",
      textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 500,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 999, background: meta.color,
        boxShadow: `0 0 0 2px ${meta.color}22`,
      }} />
      {meta.label}
    </span>
  );
};

// ─── Issue row (collapsed) ────────────────────────────────────────────────
const IssueRow = ({ issue, expanded, onClick, onExpandToggle }) => {
  return (
    <div
      className={`ds-row ${expanded ? "is-expanded" : ""}`}
      onClick={onClick}
      tabIndex={0}
    >
      <button
        className="ds-row-chev"
        onClick={(e) => { e.stopPropagation(); onExpandToggle(); }}
        title={expanded ? "Collapse" : "Expand"}
      >
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      <div className="ds-row-icon" title={issue.type}>
        <Icon name={TYPE_ICON[issue.type]} size={13} />
      </div>
      <div className="ds-row-body">
        <div className="ds-row-title">{issue.title}</div>
        <div className="ds-row-meta">
          <PriorityIcon priority={issue.priority} />
          <span className="ds-row-id" title={issue.id}>#{issue.number}</span>
          <span className="ds-row-dot">·</span>
          <StatusPill status={issue.status} />
          <span className="ds-row-dot">·</span>
          <span className="ds-row-date" title={absTime(issue.createdAt)}>
            {relTime(issue.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
};

// ─── Expanded detail panel ────────────────────────────────────────────────
const IssueDetail = ({ issue, onUpdate, onDelete }) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [titleDraft, setTitleDraft] = useState(issue.title);
  const [descDraft, setDescDraft] = useState(issue.description);

  useEffect(() => { setTitleDraft(issue.title); }, [issue.id, issue.title]);
  useEffect(() => { setDescDraft(issue.description); }, [issue.id, issue.description]);

  const commitTitle = () => {
    const v = titleDraft.trim();
    if (v && v !== issue.title) onUpdate({ ...issue, title: v });
    else setTitleDraft(issue.title);
    setEditingTitle(false);
  };
  const commitDesc = () => {
    if (descDraft !== issue.description) onUpdate({ ...issue, description: descDraft });
    setEditingDesc(false);
  };

  const setStatus = (newStatus) => {
    if (newStatus === issue.status) return;
    const now = new Date().toISOString();
    const next = {
      ...issue,
      status: newStatus,
      statusHistory: [...issue.statusHistory, { status: newStatus, at: now }],
      resolvedAt: newStatus === "Complete" ? now : (issue.resolvedAt && newStatus !== "Complete" ? null : issue.resolvedAt),
    };
    onUpdate(next);
  };

  const setPriority = (p) => onUpdate({ ...issue, priority: p });
  const setType = (t) => onUpdate({ ...issue, type: t });

  const toggleTask = (taskId) => {
    onUpdate({
      ...issue,
      tasks: issue.tasks.map((t) => t.id === taskId ? { ...t, done: !t.done } : t),
    });
  };

  const addTask = () => {
    const id = `t${Date.now()}`;
    onUpdate({ ...issue, tasks: [...issue.tasks, { id, text: "", done: false }] });
  };

  const updateTaskText = (taskId, text) => {
    onUpdate({
      ...issue,
      tasks: issue.tasks.map((t) => t.id === taskId ? { ...t, text } : t),
    });
  };

  const removeTask = (taskId) => {
    onUpdate({ ...issue, tasks: issue.tasks.filter((t) => t.id !== taskId) });
  };

  return (
    <div className="ds-detail" onClick={(e) => e.stopPropagation()}>
      <div className="ds-d-ref" title={issue.id}>
        #{issue.number}
        <span className="ds-d-ref-id">{issue.id}</span>
      </div>
      {/* Title */}
      <div className="ds-d-title-wrap">
        {editingTitle ? (
          <input
            className="ds-d-title-input"
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") { setTitleDraft(issue.title); setEditingTitle(false); }
            }}
          />
        ) : (
          <h3 className="ds-d-title" onClick={() => setEditingTitle(true)} title="Click to edit">
            {issue.title}
            <Icon name="edit" size={11} style={{ opacity: .35, marginLeft: 6 }} />
          </h3>
        )}
        <button className="ds-d-delete" onClick={() => onDelete(issue.id)} title="Delete">
          <Icon name="trash" size={12} />
        </button>
      </div>

      {/* Meta grid */}
      <div className="ds-d-grid">
        <label className="ds-d-label">Status</label>
        <select
          className="ds-d-select"
          value={issue.status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ borderLeftColor: STATUS_META[issue.status].color }}
        >
          {window.DS_DATA.STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <label className="ds-d-label">Priority</label>
        <select
          className="ds-d-select"
          value={issue.priority}
          onChange={(e) => setPriority(e.target.value)}
          style={{ borderLeftColor: PRIORITY_META[issue.priority].color }}
        >
          {window.DS_DATA.PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <label className="ds-d-label">Type</label>
        <select
          className="ds-d-select"
          value={issue.type}
          onChange={(e) => setType(e.target.value)}
        >
          {window.DS_DATA.ISSUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <label className="ds-d-label">Created</label>
        <div className="ds-d-value" title={absTime(issue.createdAt)}>
          <Icon name="calendar" size={11} style={{ opacity: .5, marginRight: 6 }} />
          {absTime(issue.createdAt)}
        </div>

        <label className="ds-d-label">Resolved</label>
        <div className="ds-d-value">
          {issue.resolvedAt ? (
            <>
              <Icon name="check" size={11} style={{ opacity: .7, color: STATUS_META.Complete.color, marginRight: 6 }} />
              {absTime(issue.resolvedAt)}
            </>
          ) : <span style={{ opacity: .4 }}>—</span>}
        </div>
      </div>

      {/* Description */}
      <div className="ds-d-section">
        <div className="ds-d-section-h">Description</div>
        {editingDesc ? (
          <textarea
            className="ds-d-textarea"
            value={descDraft}
            autoFocus
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={commitDesc}
            rows={Math.max(3, descDraft.split("\n").length)}
          />
        ) : (
          <div
            className="ds-d-prose"
            onClick={() => setEditingDesc(true)}
            title="Click to edit"
          >
            {issue.description || <span style={{ opacity: .4 }}>No description. Click to add.</span>}
          </div>
        )}
      </div>

      {/* Tasks */}
      <div className="ds-d-section">
        <div className="ds-d-section-h">
          Tasks
          <span style={{ opacity: .5, fontWeight: 400, marginLeft: 6 }}>
            {issue.tasks.filter(t => t.done).length}/{issue.tasks.length}
          </span>
          <button className="ds-d-add-task" onClick={addTask} title="Add task">
            <Icon name="plus" size={10} />
          </button>
        </div>
        <div className="ds-d-tasks">
          {issue.tasks.map((task) => (
            <div className={`ds-task ${task.done ? "is-done" : ""}`} key={task.id}>
              <button
                className="ds-task-check"
                onClick={() => toggleTask(task.id)}
                aria-checked={task.done}
                role="checkbox"
              >
                {task.done && <Icon name="check" size={10} />}
              </button>
              <input
                className="ds-task-text"
                value={task.text}
                placeholder="Task description"
                onChange={(e) => updateTaskText(task.id, e.target.value)}
              />
              <button className="ds-task-rm" onClick={() => removeTask(task.id)} title="Remove">
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
          {issue.tasks.length === 0 && (
            <div className="ds-d-empty">No tasks yet.</div>
          )}
        </div>
      </div>

      {/* Verify criteria */}
      <div className="ds-d-section">
        <div className="ds-d-section-h">How to verify</div>
        <div className="ds-d-prose ds-d-verify">
          {issue.verifyCriteria || <span style={{ opacity: .4 }}>No criteria yet.</span>}
        </div>
      </div>

      {/* Record (append-only log; agent-writable via MCP) */}
      <div className="ds-d-section">
        <div className="ds-d-section-h">
          Record
          <span style={{ opacity: .5, fontWeight: 400, marginLeft: 6 }}>
            {(issue.record || []).length}
          </span>
          <span className="ds-d-record-hint">append-only · agent + you</span>
        </div>
        <div className="ds-d-record">
          {(issue.record || []).length === 0 ? (
            <div className="ds-d-empty">No entries yet. Agents working this ticket via MCP will log progress here.</div>
          ) : (
            (issue.record || []).map((r, i) => (
              <div key={i} className={`ds-rec-row ds-rec-${r.author}`}>
                <div className="ds-rec-gutter">
                  <span className={`ds-rec-dot ds-rec-dot-${r.author}`} />
                  {i < issue.record.length - 1 && <span className="ds-rec-line" />}
                </div>
                <div className="ds-rec-body">
                  <div className="ds-rec-meta">
                    <span className="ds-rec-author">{r.author === "agent" ? "Agent" : "You"}</span>
                    {r.source && <span className="ds-rec-source">· {r.source}</span>}
                    <span className="ds-rec-when" title={absTime(r.at)}>{relTime(r.at)}</span>
                  </div>
                  <div className="ds-rec-text">{r.text}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* History */}
      <div className="ds-d-section">
        <div className="ds-d-section-h">State history</div>
        <div className="ds-d-history">
          {issue.statusHistory.map((h, i) => (
            <div key={i} className="ds-hist-row">
              <span className="ds-hist-dot" style={{ background: STATUS_META[h.status]?.color }} />
              <span className="ds-hist-status">{h.status}</span>
              <span className="ds-hist-when" title={absTime(h.at)}>{relTime(h.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── Sidebar root ─────────────────────────────────────────────────────────
const Sidebar = ({
  issues, onUpdate, onDelete, onAdd, onOpenBoard,
  onImport, onExport, onSettings,
  width, onResize,
}) => {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const searchRef = useRef(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues
      .filter((i) => statusFilter === "All" || i.status === statusFilter)
      .filter((i) => {
        if (!q) return true;
        return (
          i.title.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.type.toLowerCase().includes(q) ||
          i.priority.toLowerCase().includes(q) ||
          i.status.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [issues, query, statusFilter]);

  const expandedIssue = expandedId ? issues.find((i) => i.id === expandedId) : null;

  // Resize handle
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const next = Math.max(260, Math.min(560, startW + (ev.clientX - startX)));
      onResize(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside className="ds-sidebar" style={{ width }}>
      {/* Title bar */}
      <div className="ds-sb-titlebar">
        <span className="ds-sb-title">DoStuff: Issues</span>
        <div className="ds-sb-actions">
          <button onClick={onOpenBoard} title="Open Board (full editor)">
            <Icon name="board" size={14} />
          </button>
          <button onClick={onAdd} title="New issue">
            <Icon name="plus" size={14} />
          </button>
          <button onClick={onImport} title="Import JSON">
            <Icon name="upload" size={14} />
          </button>
          <button onClick={onExport} title="Export JSON">
            <Icon name="download" size={14} />
          </button>
          <button onClick={onSettings} title="Settings">
            <Icon name="settings" size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="ds-sb-search">
        <Icon name="search" size={12} style={{ opacity: .5 }} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search issues…"
        />
        {query && (
          <button className="ds-sb-clear" onClick={() => setQuery("")}>
            <Icon name="close" size={10} />
          </button>
        )}
      </div>

      {/* Status filter chips */}
      <div className="ds-sb-filters">
        {["All", ...window.DS_DATA.STATUSES].map((s) => {
          const count = s === "All" ? issues.length : issues.filter(i => i.status === s).length;
          return (
            <button
              key={s}
              className={`ds-chip ${statusFilter === s ? "is-active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s !== "All" && (
                <span className="ds-chip-dot" style={{ background: STATUS_META[s].color }} />
              )}
              {s} <span className="ds-chip-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="ds-sb-list">
        {filtered.length === 0 ? (
          <div className="ds-sb-empty">
            {query ? `No issues match "${query}"` : "No issues yet."}
          </div>
        ) : (
          filtered.map((issue) => (
            <React.Fragment key={issue.id}>
              <IssueRow
                issue={issue}
                expanded={expandedId === issue.id}
                onClick={() => setExpandedId(expandedId === issue.id ? null : issue.id)}
                onExpandToggle={() => setExpandedId(expandedId === issue.id ? null : issue.id)}
              />
              {expandedId === issue.id && (
                <IssueDetail
                  issue={issue}
                  onUpdate={onUpdate}
                  onDelete={(id) => {
                    setExpandedId(null);
                    onDelete(id);
                  }}
                />
              )}
            </React.Fragment>
          ))
        )}
      </div>

      {/* Resize handle */}
      <div className="ds-sb-resize" onMouseDown={startResize} />
    </aside>
  );
};

Object.assign(window, { Sidebar, IssueRow, IssueDetail, PriorityIcon, StatusPill, relTime, absTime });
