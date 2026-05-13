// Kanban board — Thinking (left drawer) | Planned | Working | Testing | Complete (right drawer)
// Drag-and-drop between lanes changes status and logs to history.

const { useState: useStateB, useRef: useRefB, useEffect: useEffectB } = React;
const { Icon: IconB, TYPE_ICON: TYPE_ICON_B, PRIORITY_META: PRI_B, STATUS_META: STM_B } = window.DS_ICONS;

const ACTIVE_LANES = ["Planned", "Working", "Testing"];

// Card on the board
const BoardCard = ({ issue, onDragStart, onDragEnd, onOpen, dragging, tileStyle }) => {
  return (
    <div
      className={`bd-card ${dragging ? "is-dragging" : ""} bd-tile-${tileStyle}`}
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(issue)}
      style={{
        "--card-accent": STM_B[issue.status].color,
      }}
    >
      <div className="bd-card-top">
        <span className="bd-card-id" title={issue.id}>#{issue.number}</span>
        <span className="bd-card-type" title={issue.type}>
          <IconB name={TYPE_ICON_B[issue.type]} size={11} />
        </span>
        <span className="bd-card-spacer" />
        <span className="bd-card-pri" style={{ color: PRI_B[issue.priority].color }} title={`${issue.priority} priority`}>
          <IconB name={PRI_B[issue.priority].icon} size={12} />
        </span>
      </div>
      <div className="bd-card-title">{issue.title}</div>
      <div className="bd-card-foot">
        {issue.tasks.length > 0 && (
          <span className="bd-card-tasks" title="Tasks done / total">
            <IconB name="check" size={10} />
            {issue.tasks.filter((t) => t.done).length}/{issue.tasks.length}
          </span>
        )}
        <span className="bd-card-date">{relTime(issue.createdAt)}</span>
      </div>
    </div>
  );
};

// Lane (active)
const Lane = ({ status, issues, onDropIssue, onOpen, dragState, setDragState, laneStyle, tileStyle, accent }) => {
  const [dragOver, setDragOver] = useStateB(false);

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!dragOver) setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onDropIssue(id, status);
  };

  const meta = STM_B[status];

  return (
    <div
      className={`bd-lane bd-lane-${laneStyle} ${dragOver ? "is-drag-over" : ""}`}
      style={{ "--lane-accent": meta.color }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="bd-lane-head">
        <span className="bd-lane-dot" style={{ background: meta.color }} />
        <span className="bd-lane-title">{status}</span>
        <span className="bd-lane-count">{issues.length}</span>
      </div>
      <div className="bd-lane-body">
        {issues.length === 0 ? (
          <div className="bd-lane-empty">Drop here</div>
        ) : (
          issues.map((issue) => (
            <BoardCard
              key={issue.id}
              issue={issue}
              dragging={dragState?.id === issue.id}
              tileStyle={tileStyle}
              onOpen={onOpen}
              onDragStart={(e, i) => {
                e.dataTransfer.setData("text/plain", i.id);
                e.dataTransfer.effectAllowed = "move";
                setDragState({ id: i.id });
              }}
              onDragEnd={() => setDragState(null)}
            />
          ))
        )}
      </div>
    </div>
  );
};

// Drawer (Thinking + Complete)
const Drawer = ({ status, issues, onDropIssue, onOpen, side, onPickToBoard, onOpenInline }) => {
  const [dragOver, setDragOver] = useStateB(false);
  const [open, setOpen] = useStateB(false);

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!dragOver) setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onDropIssue(id, status);
  };

  const meta = STM_B[status];

  return (
    <div
      className={`bd-drawer bd-drawer-${side} ${dragOver ? "is-drag-over" : ""} ${open ? "is-open" : ""}`}
      style={{ "--drawer-accent": meta.color }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button className="bd-drawer-head" onClick={() => setOpen(!open)}>
        <span className="bd-drawer-rot">
          <span className="bd-lane-dot" style={{ background: meta.color }} />
          <span className="bd-drawer-title">{status}</span>
          <span className="bd-drawer-count">{issues.length}</span>
        </span>
      </button>

      {open && (
        <div className="bd-drawer-body">
          <div className="bd-drawer-help">
            {status === "Thinking"
              ? "Ideas not yet on the board. Click an issue to promote it to Planned."
              : "Completed issues. Drop here to mark complete, or open to review."}
          </div>
          {issues.length === 0 ? (
            <div className="bd-lane-empty">No {status.toLowerCase()} issues</div>
          ) : (
            issues.map((issue) => (
              <div
                key={issue.id}
                className="bd-drawer-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", issue.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => {
                  if (status === "Thinking") onPickToBoard(issue.id);
                  else onOpen(issue);
                }}
                title={status === "Thinking" ? "Click to promote to Planned" : "Open"}
              >
                <div className="bd-drawer-card-top">
                  <IconB name={TYPE_ICON_B[issue.type]} size={11} style={{ opacity: .7 }} />
                  <span className="bd-card-id" title={issue.id}>#{issue.number}</span>
                  <span className="bd-card-spacer" />
                  <IconB name={PRI_B[issue.priority].icon} size={11} style={{ color: PRI_B[issue.priority].color }} />
                </div>
                <div className="bd-drawer-card-title">{issue.title}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// Modal-style focus overlay when card is opened on board
const BoardIssueFocus = ({ issue, onClose, onUpdate, onDelete }) => {
  if (!issue) return null;
  return (
    <div className="bd-focus-backdrop" onClick={onClose}>
      <div className="bd-focus" onClick={(e) => e.stopPropagation()}>
        <button className="bd-focus-close" onClick={onClose}><IconB name="close" size={12} /></button>
        <IssueDetail issue={issue} onUpdate={onUpdate} onDelete={(id) => { onDelete(id); onClose(); }} />
      </div>
    </div>
  );
};

const Board = ({ issues, onUpdate, onDelete }) => {
  const [dragState, setDragState] = useStateB(null);
  const [focusIssue, setFocusIssue] = useStateB(null);

  // Pull tweak values from CSS vars for lane/tile style — read from data attrs on body
  const [laneStyle, setLaneStyle] = useStateB(() => document.body.dataset.laneStyle || "card");
  const [tileStyle, setTileStyle] = useStateB(() => document.body.dataset.tileStyle || "flat");
  useEffectB(() => {
    const mo = new MutationObserver(() => {
      setLaneStyle(document.body.dataset.laneStyle || "card");
      setTileStyle(document.body.dataset.tileStyle || "flat");
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-lane-style", "data-tile-style"] });
    return () => mo.disconnect();
  }, []);

  const setStatus = (id, newStatus) => {
    const issue = issues.find((i) => i.id === id);
    if (!issue || issue.status === newStatus) return;
    const now = new Date().toISOString();
    onUpdate({
      ...issue,
      status: newStatus,
      statusHistory: [...issue.statusHistory, { status: newStatus, at: now }],
      resolvedAt: newStatus === "Complete" ? now : (newStatus !== "Complete" && issue.resolvedAt ? null : issue.resolvedAt),
    });
  };

  const PRI_ORDER = { Critical: 0, High: 1, Regular: 2, Low: 3 };
  const byStatus = (s) => {
    const list = issues.filter((i) => i.status === s);
    if (s === "Complete") {
      return list.sort((a, b) => {
        const ra = a.resolvedAt ? new Date(a.resolvedAt) : new Date(a.createdAt);
        const rb = b.resolvedAt ? new Date(b.resolvedAt) : new Date(b.createdAt);
        return rb - ra;
      });
    }
    return list.sort((a, b) => {
      const pa = PRI_ORDER[a.priority] ?? 99;
      const pb = PRI_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  };

  const focused = focusIssue ? issues.find((i) => i.id === focusIssue) : null;

  return (
    <div className="bd-root">
      <Drawer
        status="Thinking"
        side="left"
        issues={byStatus("Thinking")}
        onDropIssue={setStatus}
        onPickToBoard={(id) => setStatus(id, "Planned")}
        onOpen={(i) => setFocusIssue(i.id)}
      />

      <div className="bd-lanes">
        {ACTIVE_LANES.map((s) => (
          <Lane
            key={s}
            status={s}
            issues={byStatus(s)}
            onDropIssue={setStatus}
            onOpen={(i) => setFocusIssue(i.id)}
            dragState={dragState}
            setDragState={setDragState}
            laneStyle={laneStyle}
            tileStyle={tileStyle}
          />
        ))}
      </div>

      <Drawer
        status="Complete"
        side="right"
        issues={byStatus("Complete")}
        onDropIssue={setStatus}
        onOpen={(i) => setFocusIssue(i.id)}
      />

      <BoardIssueFocus
        issue={focused}
        onClose={() => setFocusIssue(null)}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    </div>
  );
};

Object.assign(window, { Board });
