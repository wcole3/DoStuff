import { useEffect, useState, type ReactNode } from "react";
import {
  PRIORITIES,
  TYPES,
  type Issue,
  type IssueType,
  type Priority,
} from "../types";
import { Icon } from "./Icons";
import { postCreateIssue, postDeleteIssue } from "./messaging";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  panelStyle?: boolean;
}

function Modal({ title, onClose, children, footer, width = 480, panelStyle }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`ds-modal-backdrop${panelStyle ? " ds-panel-style" : ""}`} onClick={onClose}>
      <div className="ds-modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-head">
          <span className="ds-modal-title">{title}</span>
          <button className="ds-modal-close" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="ds-modal-body">{children}</div>
        {footer && <div className="ds-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface AddIssueModalProps {
  onClose: () => void;
}

export function AddIssueModal({ onClose }: AddIssueModalProps) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<IssueType>("Bug");
  const [priority, setPriority] = useState<Priority>("Regular");
  const [description, setDescription] = useState("");
  const [verifyCriteria, setVerifyCriteria] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    postCreateIssue({
      title: title.trim(),
      type,
      priority,
      description,
      verifyCriteria,
      status: "Thinking",
    });
    onClose();
  };

  return (
    <Modal
      title="New Issue"
      onClose={onClose}
      width={520}
      panelStyle
      footer={
        <>
          <button className="ds-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ds-btn ds-btn-primary"
            disabled={!title.trim()}
            onClick={submit}
          >
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) submit();
            }}
          />
        </label>
        <div className="ds-form-grid-2">
          <label className="ds-form-row">
            <span>Priority</span>
            <select
              className="ds-input"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="ds-form-row">
            <span>Type</span>
            <select
              className="ds-input"
              value={type}
              onChange={(e) => setType(e.target.value as IssueType)}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
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
}

interface DeleteConfirmModalProps {
  issue: Issue;
  onClose: () => void;
}

export function DeleteConfirmModal({ issue, onClose }: DeleteConfirmModalProps) {
  const confirm = () => {
    postDeleteIssue(issue.id);
    onClose();
  };
  return (
    <Modal
      title="Delete issue?"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="ds-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ds-btn ds-btn-danger" onClick={confirm}>
            Delete
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Permanently delete <strong>#{issue.number}</strong>{" "}
        <span style={{ opacity: 0.55 }}>({issue.id})</span> — "{issue.title}"?
      </p>
      <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.65 }}>
        This can't be undone. State history and tasks will be lost.
      </p>
    </Modal>
  );
}
