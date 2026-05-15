import { useEffect, useState } from "react";
import {
  PRIORITIES,
  STATUSES,
  TYPES,
  canMoveToActiveLane,
  type Issue,
  type IssueType,
  type Priority,
  type Status,
} from "../types";
import { Icon, PRIORITY_META, STATUS_META, TYPE_ICON } from "./Icons";
import { newTaskId, postDeleteIssue, postUpdateIssue, useIssues } from "./messaging";

export function relTime(iso: string | null | undefined): string {
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

export function absTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface IssueDetailProps {
  issue: Issue;
}

export function IssueDetail({ issue }: IssueDetailProps) {
  const { issues } = useIssues();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [editingVerify, setEditingVerify] = useState(false);
  const [titleDraft, setTitleDraft] = useState(issue.title);
  const [descDraft, setDescDraft] = useState(issue.description);
  const [verifyDraft, setVerifyDraft] = useState(issue.verifyCriteria);
  const [statusWarning, setStatusWarning] = useState<string | null>(null);

  useEffect(() => { setTitleDraft(issue.title); }, [issue.id, issue.title]);
  useEffect(() => { setDescDraft(issue.description); }, [issue.id, issue.description]);
  useEffect(() => { setVerifyDraft(issue.verifyCriteria); }, [issue.id, issue.verifyCriteria]);
  useEffect(() => { setStatusWarning(null); }, [issue.id, issue.status]);

  const commitTitle = () => {
    const v = titleDraft.trim();
    if (v && v !== issue.title) postUpdateIssue({ ...issue, title: v });
    else setTitleDraft(issue.title);
    setEditingTitle(false);
  };
  const commitDesc = () => {
    if (descDraft !== issue.description) postUpdateIssue({ ...issue, description: descDraft });
    setEditingDesc(false);
  };
  const commitVerify = () => {
    if (verifyDraft !== issue.verifyCriteria) postUpdateIssue({ ...issue, verifyCriteria: verifyDraft });
    setEditingVerify(false);
  };

  const setStatus = (newStatus: Status) => {
    if (newStatus === issue.status) return;
    const guard = canMoveToActiveLane(issues, newStatus, issue.id);
    if (guard !== true) {
      setStatusWarning(guard);
      return;
    }
    setStatusWarning(null);
    postUpdateIssue({ ...issue, status: newStatus });
  };

  const setPriority = (p: Priority) => postUpdateIssue({ ...issue, priority: p });
  const setType = (t: IssueType) => postUpdateIssue({ ...issue, type: t });

  const toggleTask = (taskId: string) => {
    postUpdateIssue({
      ...issue,
      tasks: issue.tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)),
    });
  };
  const addTask = () => {
    postUpdateIssue({
      ...issue,
      tasks: [...issue.tasks, { id: newTaskId(), text: "", done: false }],
    });
  };
  const updateTaskText = (taskId: string, text: string) => {
    postUpdateIssue({
      ...issue,
      tasks: issue.tasks.map((t) => (t.id === taskId ? { ...t, text } : t)),
    });
  };
  const removeTask = (taskId: string) => {
    postUpdateIssue({ ...issue, tasks: issue.tasks.filter((t) => t.id !== taskId) });
  };

  const onDelete = () => postDeleteIssue(issue.id);

  return (
    <div className="ds-detail" onClick={(e) => e.stopPropagation()}>
      <div className="ds-d-ref" title={issue.id}>
        #{issue.number}
        <span className="ds-d-ref-id">{issue.id}</span>
      </div>

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
              if (e.key === "Escape") {
                setTitleDraft(issue.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <h3 className="ds-d-title" onClick={() => setEditingTitle(true)} title="Click to edit">
            {issue.title}
            <Icon name="edit" size={11} style={{ opacity: 0.35, marginLeft: 6 }} />
          </h3>
        )}
        <span style={{ display: "inline-flex", color: STATUS_META[issue.status].color }} title={issue.type}>
          <Icon name={TYPE_ICON[issue.type]} size={14} />
        </span>
        <button className="ds-d-delete" onClick={onDelete} title="Delete" aria-label="Delete issue">
          <Icon name="trash" size={12} />
        </button>
      </div>

      <div className="ds-d-grid">
        <label className="ds-d-label">Status</label>
        <select
          className="ds-d-select"
          value={issue.status}
          onChange={(e) => setStatus(e.target.value as Status)}
          style={{ borderLeftColor: STATUS_META[issue.status].color }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {statusWarning && <div className="ds-d-warning">{statusWarning}</div>}

        <label className="ds-d-label">Priority</label>
        <select
          className="ds-d-select"
          value={issue.priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          style={{ borderLeftColor: PRIORITY_META[issue.priority].color }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label className="ds-d-label">Type</label>
        <select
          className="ds-d-select"
          value={issue.type}
          onChange={(e) => setType(e.target.value as IssueType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label className="ds-d-label">Created</label>
        <div className="ds-d-value" title={absTime(issue.createdAt)}>
          <Icon name="calendar" size={11} style={{ opacity: 0.5, marginRight: 6 }} />
          {absTime(issue.createdAt)}
        </div>

        <label className="ds-d-label">Resolved</label>
        <div className="ds-d-value">
          {issue.resolvedAt ? (
            <>
              <Icon name="check" size={11} style={{ opacity: 0.7, color: STATUS_META.Complete.color, marginRight: 6 }} />
              {absTime(issue.resolvedAt)}
            </>
          ) : (
            <span style={{ opacity: 0.4 }}>—</span>
          )}
        </div>
      </div>

      <div>
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
          <div className="ds-d-prose" onClick={() => setEditingDesc(true)} title="Click to edit">
            {issue.description || <span style={{ opacity: 0.4 }}>No description. Click to add.</span>}
          </div>
        )}
      </div>

      <div>
        <div className="ds-d-section-h">
          Tasks
          <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>
            {issue.tasks.filter((t) => t.done).length}/{issue.tasks.length}
          </span>
          <button className="ds-d-add-task" onClick={addTask} title="Add task" aria-label="Add task">
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
              <button className="ds-task-rm" onClick={() => removeTask(task.id)} title="Remove" aria-label="Remove task">
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
          {issue.tasks.length === 0 && <div className="ds-d-empty">No tasks yet.</div>}
        </div>
      </div>

      <div>
        <div className="ds-d-section-h">How to verify</div>
        {editingVerify ? (
          <textarea
            className="ds-d-textarea"
            value={verifyDraft}
            autoFocus
            onChange={(e) => setVerifyDraft(e.target.value)}
            onBlur={commitVerify}
            rows={Math.max(2, verifyDraft.split("\n").length)}
          />
        ) : (
          <div
            className="ds-d-prose ds-d-verify"
            onClick={() => setEditingVerify(true)}
            title="Click to edit"
          >
            {issue.verifyCriteria || <span style={{ opacity: 0.4 }}>No criteria yet. Click to add.</span>}
          </div>
        )}
      </div>

      <div>
        <div className="ds-d-section-h">
          Record
          <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>
            {(issue.record || []).length}
          </span>
          <span className="ds-d-record-hint">append-only · agent + you</span>
        </div>
        <div className="ds-d-record">
          {(issue.record || []).length === 0 ? (
            <div className="ds-d-empty">
              No entries yet. Agents working this ticket via MCP will log progress here.
            </div>
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
                    <span className="ds-rec-when" title={absTime(r.at)}>
                      {relTime(r.at)}
                    </span>
                  </div>
                  <div className="ds-rec-text">{r.text}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <div className="ds-d-section-h">State history</div>
        <div className="ds-d-history">
          {issue.statusHistory.map((h, i) => (
            <div key={i} className="ds-hist-row">
              <span className="ds-hist-dot" style={{ background: STATUS_META[h.status].color }} />
              <span className="ds-hist-status">{h.status}</span>
              <span className="ds-hist-when" title={absTime(h.at)}>
                {relTime(h.at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
