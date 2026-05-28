import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  MAX_ATTACHMENT_BYTES,
  PRIORITIES,
  TYPES,
  type Issue,
  type IssueType,
  type Priority,
  type Task,
  type TicketLink,
} from "../types";
import { LinkEditor } from "./LinkEditor";
import { Icon } from "./Icons";
import {
  newTaskId,
  postCreateIssue,
  postDeleteIssue,
  postPickAttachmentForStaging,
  postStageAttachmentByUri,
  useIssues,
} from "./messaging";
import { TagEditor } from "./Tags";

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface PendingAttachment {
  tempId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

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
  const { issues, settings } = useIssues();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<IssueType>("Bug");
  const [priority, setPriority] = useState<Priority>("Regular");
  const [description, setDescription] = useState("");
  const [verifyCriteria, setVerifyCriteria] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attDragOver, setAttDragOver] = useState(false);
  const newTaskInputRef = useRef<HTMLInputElement>(null);
  const attachmentsDisabled = settings?.attachmentsBaseUri == null;

  // Host's reply to pickAttachmentForStaging / stageAttachmentByUri arrives as
  // a CustomEvent dispatched by the message bridge.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string; mimeType: string; bytes: number[] }>).detail;
      if (!detail) return;
      setPendingAttachments((prev) => [
        ...prev,
        {
          tempId: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: detail.name,
          mimeType: detail.mimeType,
          bytes: new Uint8Array(detail.bytes),
        },
      ]);
    };
    window.addEventListener("dostuff:attachmentStaged", handler);
    return () => window.removeEventListener("dostuff:attachmentStaged", handler);
  }, []);

  const stageBytes = (name: string, mimeType: string, bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return;
    setPendingAttachments((prev) => [
      ...prev,
      {
        tempId: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        mimeType: mimeType || "application/octet-stream",
        bytes,
      },
    ]);
  };

  const removePending = (tempId: string) =>
    setPendingAttachments((prev) => prev.filter((a) => a.tempId !== tempId));

  const handleAttDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (attachmentsDisabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!attDragOver) setAttDragOver(true);
  };
  const handleAttDragLeave = () => setAttDragOver(false);
  const handleAttDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setAttDragOver(false);
    if (attachmentsDisabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    let handledViaFiles = false;
    for (const f of files) {
      handledViaFiles = true;
      if (f.size > MAX_ATTACHMENT_BYTES) continue;
      const buf = await f.arrayBuffer();
      stageBytes(f.name, f.type || "application/octet-stream", new Uint8Array(buf));
    }
    if (handledViaFiles) return;
    // Remote-WSL fallback: bytes weren't surfaced, ship the URI to the host
    // and let it read + return them.
    const uriList = e.dataTransfer.getData("text/uri-list");
    if (!uriList) return;
    const uris = uriList
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("#"));
    for (const uri of uris) postStageAttachmentByUri(uri);
  };

  // Unique tags across every ticket, sorted alphabetically — feeds the
  // TagEditor datalist so the user picks an existing tag instead of
  // typo-introducing a near-duplicate.
  const tagSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const i of issues) {
      for (const t of i.tags) {
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [issues]);

  const addTask = () => {
    setTasks((prev) => [...prev, { id: newTaskId(), text: "", done: false }]);
    // focus the new row after render
    setTimeout(() => newTaskInputRef.current?.focus(), 0);
  };

  const updateTask = (id: string, text: string) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, text } : t)));

  const removeTask = (id: string) =>
    setTasks((prev) => prev.filter((t) => t.id !== id));

  const submit = () => {
    if (!title.trim()) return;
    postCreateIssue({
      title: title.trim(),
      type,
      priority,
      description,
      verifyCriteria,
      status: "Thinking",
      tasks: tasks.filter((t) => t.text.trim()).map((t) => ({ ...t, text: t.text.trim() })),
      tags,
      links: links.length ? links : undefined,
      attachments: pendingAttachments.length
        ? pendingAttachments.map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            // JSON-serialise via plain number[]; the host re-wraps as Uint8Array.
            bytes: Array.from(a.bytes),
          }))
        : undefined,
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
        <div className="ds-form-row">
          <span>Tags</span>
          <TagEditor tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>
        <div className="ds-form-row">
          <span>Links</span>
          <LinkEditor value={links} onChange={setLinks} allIssues={issues} />
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
        <div className="ds-form-row">
          <div className="ds-d-section-head">
            <span>Tasks</span>
            <button className="ds-d-add-task" onClick={addTask} title="Add task" aria-label="Add task">
              <Icon name="plus" size={12} />
            </button>
          </div>
          {tasks.length > 0 && (
            <div className="ds-d-tasks">
              {tasks.map((task, i) => (
                <div className="ds-task ds-task--no-check" key={task.id}>
                  <input
                    className="ds-task-text"
                    ref={i === tasks.length - 1 ? newTaskInputRef : undefined}
                    value={task.text}
                    placeholder="Task description"
                    onChange={(e) => updateTask(task.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addTask(); }
                      if (e.key === "Backspace" && task.text === "") {
                        e.preventDefault();
                        removeTask(task.id);
                      }
                    }}
                  />
                  <button
                    className="ds-task-rm"
                    onClick={() => removeTask(task.id)}
                    title="Remove"
                    aria-label="Remove task"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="ds-form-row">
          <div className="ds-d-section-head">
            <span>Attachments</span>
            <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>
              {pendingAttachments.length}
            </span>
            <button
              className="ds-d-add-task"
              onClick={postPickAttachmentForStaging}
              title={attachmentsDisabled ? "Open a folder to attach files" : "Attach a file"}
              aria-label="Attach a file"
              disabled={attachmentsDisabled}
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
          <div
            className={`ds-attachments ${attDragOver ? "is-drag-over" : ""} ${attachmentsDisabled ? "is-disabled" : ""}`}
            onDragOver={handleAttDragOver}
            onDragLeave={handleAttDragLeave}
            onDrop={handleAttDrop}
          >
            {pendingAttachments.length === 0 ? (
              <div className="ds-att-empty">
                {attachmentsDisabled
                  ? "Open a workspace folder to attach files."
                  : "Drop files here or click + to attach."}
              </div>
            ) : (
              pendingAttachments.map((att) => (
                <PendingAttachmentChip
                  key={att.tempId}
                  attachment={att}
                  onRemove={() => removePending(att.tempId)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

interface PendingAttachmentChipProps {
  attachment: PendingAttachment;
  onRemove: () => void;
}

function PendingAttachmentChip({ attachment, onRemove }: PendingAttachmentChipProps) {
  const image = isImageMime(attachment.mimeType);
  // Build a blob URL for image previews; revoke on unmount or when bytes change
  // so the modal doesn't leak object URLs while it's open.
  const previewUrl = useMemo(() => {
    if (!image) return null;
    return URL.createObjectURL(
      new Blob([attachment.bytes as BlobPart], { type: attachment.mimeType }),
    );
  }, [image, attachment.bytes, attachment.mimeType]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div className={`ds-att-chip ${image ? "is-image" : ""}`}>
      <span className="ds-att-chip-main" aria-disabled>
        {image && previewUrl ? (
          <img
            className="ds-att-thumb"
            src={previewUrl}
            alt={attachment.name}
            loading="lazy"
          />
        ) : (
          <span className="ds-att-icon" aria-hidden="true">
            <Icon name="files" size={14} />
          </span>
        )}
        <span className="ds-att-meta">
          <span className="ds-att-name" title={attachment.name}>{attachment.name}</span>
          <span className="ds-att-size">{formatBytes(attachment.bytes.byteLength)}</span>
        </span>
      </span>
      <button
        type="button"
        className="ds-att-delete"
        onClick={onRemove}
        title="Remove attachment"
        aria-label="Remove attachment"
      >
        <Icon name="close" size={10} />
      </button>
    </div>
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
