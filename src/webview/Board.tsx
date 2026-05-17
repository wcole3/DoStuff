import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import {
  ACTIVE_LANE_CAP,
  PRIORITIES,
  TYPES,
  canMoveToActiveLane,
  type Issue,
  type IssueType,
  type Priority,
  type Status,
} from "../types";
import { Icon, PRIORITY_META, STATUS_META, TYPE_ICON } from "./Icons";
import { IssueDetail, relTime } from "./IssueDetail";
import { TagStrip } from "./Tags";
import { DEFAULT_SORT, SORT_KEYS, SORT_LABELS, sortIssues, type SortKey } from "./sort";
import {
  clearExternalDragLocal,
  postUpdateIssue,
  useExternalDragIssueId,
  useIssues,
} from "./messaging";

const ACTIVE_LANES: Status[] = ["Planned", "Working", "Verification"];
// Fits the top meta row, the two-line title clamp, the always-present tag
// slot (16px min-height per `.bd-drawer-card-tags`), card padding (7px top
// + 7px bottom), three 5px flex gaps, and the 6px inter-card margin. Pad a
// few px so a chip with a 1px border never gets clipped.
const DRAWER_CARD_HEIGHT = 96;
const TOAST_TTL_MS = 3000;

const PRI_ORDER: Record<string, number> = { Critical: 0, High: 1, Regular: 2, Low: 3 };

/**
 * Pure decision for whether a drop-into-lane should be applied.
 *
 *   - `kind: "noop"`   — same lane (in-place); no host message should be sent.
 *   - `kind: "ok"`     — apply the move; returns the next Issue value.
 *   - `kind: "blocked"` — lane is full; reason is suitable for a toast.
 *   - `kind: "missing"` — id refers to no current issue; caller should ignore.
 *
 * Extracted so DnD outcomes can be unit-tested without simulating an HTML5
 * DataTransfer roundtrip. Mirrors the logic used by `setStatus` below.
 */
export type DropDecision =
  | { kind: "noop"; issue: Issue }
  | { kind: "ok"; next: Issue }
  | { kind: "blocked"; reason: string }
  | { kind: "missing" };

export function decideDrop(
  currentIssues: Issue[],
  id: string,
  targetStatus: Status,
  cap = ACTIVE_LANE_CAP,
): DropDecision {
  const issue = currentIssues.find((i) => i.id === id);
  if (!issue) return { kind: "missing" };
  if (issue.status === targetStatus) return { kind: "noop", issue };
  const guard = canMoveToActiveLane(currentIssues, targetStatus, id, cap);
  if (guard !== true) return { kind: "blocked", reason: guard };
  return { kind: "ok", next: { ...issue, status: targetStatus } };
}

interface BoardCardProps {
  issue: Issue;
  onOpen: (issue: Issue) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, issue: Issue) => void;
  onDragEnd: () => void;
  dragging: boolean;
}

const BoardCard = memo(function BoardCard({
  issue,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: BoardCardProps) {
  const meta = STATUS_META[issue.status];
  const pri = PRIORITY_META[issue.priority];
  return (
    <div
      className={`bd-card ${dragging ? "is-dragging" : ""}`}
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(issue)}
      style={{ ["--card-accent" as string]: meta.color } as CSSProperties}
    >
      <div className="bd-card-top">
        <span className="bd-card-id" title={issue.id}>
          #{issue.number}
        </span>
        <span className="bd-card-type" title={issue.type}>
          <Icon name={TYPE_ICON[issue.type]} size={11} />
        </span>
        <span className="bd-card-spacer" />
        <span
          className="bd-card-pri"
          style={{ color: pri.color }}
          title={`${issue.priority} priority`}
        >
          <Icon name={pri.icon} size={12} />
        </span>
      </div>
      <div className="bd-card-title">{issue.title}</div>
      {issue.tags.length > 0 && <TagStrip tags={issue.tags} maxChips={3} />}
      <div className="bd-card-foot">
        {issue.tasks.length > 0 && (
          <span className="bd-card-tasks" title="Tasks done / total">
            <Icon name="check" size={10} />
            {issue.tasks.filter((t) => t.done).length}/{issue.tasks.length}
          </span>
        )}
        <span className="bd-card-date">{relTime(issue.createdAt)}</span>
      </div>
    </div>
  );
});

interface LaneProps {
  status: Status;
  issues: Issue[];
  cap: number;
  dragId: string | null;
  externalPickId: string | null;
  onDragStart: (e: DragEvent<HTMLDivElement>, issue: Issue) => void;
  onDragEnd: () => void;
  onDropIssue: (id: string, status: Status) => void;
  onOpen: (issue: Issue) => void;
}

function Lane({
  status,
  issues,
  cap,
  dragId,
  externalPickId,
  onDragStart,
  onDragEnd,
  onDropIssue,
  onOpen,
}: LaneProps) {
  const [dragOver, setDragOver] = useState(false);
  const meta = STATUS_META[status];
  const count = issues.length;
  const isFull = count >= cap;
  const dragBlocked = isFull && dragOver && dragId !== null && issues.every((i) => i.id !== dragId);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = dragBlocked ? "none" : "move";
    if (!dragOver) setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onDropIssue(id, status);
  };

  return (
    <div
      className={`bd-lane ${dragOver ? "is-drag-over" : ""} ${isFull ? "is-full" : ""} ${
        dragBlocked ? "is-drag-blocked" : ""
      } ${externalPickId ? "is-pick-target" : ""}`}
      style={{ ["--lane-accent" as string]: meta.color } as CSSProperties}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="bd-lane-head">
        <span className="bd-lane-dot" style={{ background: meta.color }} />
        <span className="bd-lane-title">{status}</span>
        <span className="bd-lane-count" title={`${count} of ${cap} tickets`}>
          {count}/{cap}
        </span>
      </div>
      <div className="bd-lane-body">
        {issues.length === 0 ? (
          <div className="bd-lane-empty">Drop here</div>
        ) : (
          issues.map((issue) => (
            <BoardCard
              key={issue.id}
              issue={issue}
              dragging={dragId === issue.id}
              onOpen={onOpen}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
      {externalPickId && (
        <button
          type="button"
          className="bd-pick-overlay"
          title={`Click to move ticket here (${status})`}
          onClick={(e) => {
            e.stopPropagation();
            onDropIssue(externalPickId, status);
            clearExternalDragLocal();
          }}
        >
          <span className="bd-pick-overlay-label">Move to {status}</span>
        </button>
      )}
    </div>
  );
}

interface DrawerCardRowData {
  issues: Issue[];
  onOpen: (issue: Issue) => void;
  onPickToBoard?: (id: string) => void;
  status: Status;
  onDragStart: (e: DragEvent<HTMLDivElement>, issue: Issue) => void;
  onDragEnd: () => void;
}

const DrawerCardRow = memo(function DrawerCardRow({
  index,
  style,
  data,
}: ListChildComponentProps<DrawerCardRowData>) {
  const issue = data.issues[index];
  const pri = PRIORITY_META[issue.priority];
  const canPromote = data.status === "Thinking" && data.onPickToBoard !== undefined;
  return (
    <div style={style}>
      <div
        className="bd-drawer-card"
        draggable
        onDragStart={(e) => data.onDragStart(e, issue)}
        onDragEnd={data.onDragEnd}
        onClick={(e) => {
          // Thinking drawer: click opens the detail panel; shift-click promotes
          // straight to Planned. The shift-click shortcut is the only way an
          // accidental click won't move a draft onto the board.
          if (canPromote && e.shiftKey) {
            data.onPickToBoard!(issue.id);
            return;
          }
          data.onOpen(issue);
        }}
        title={canPromote ? "Click to view details, Shift+Click to promote to Planned" : "Open"}
      >
        <div className="bd-drawer-card-top">
          <Icon name={TYPE_ICON[issue.type]} size={11} style={{ opacity: 0.7 }} />
          <span className="bd-card-id" title={issue.id}>
            #{issue.number}
          </span>
          <span className="bd-card-spacer" />
          <Icon name={pri.icon} size={11} style={{ color: pri.color }} />
        </div>
        <div className="bd-drawer-card-title">{issue.title}</div>
        {/* Always render the tag slot — even when empty — so every card
            occupies the same vertical space inside its FixedSizeList row.
            Without this, tagged + untagged cards drift vertically and gaps
            appear between siblings (DS-009). */}
        <div className="bd-drawer-card-tags">
          {issue.tags.length > 0 && <TagStrip tags={issue.tags} maxChips={1} />}
        </div>
      </div>
    </div>
  );
});

interface DrawerProps {
  status: Status;
  issues: Issue[];
  side: "left" | "right";
  open: boolean;
  externalPickId: string | null;
  onToggle: () => void;
  onDropIssue: (id: string, status: Status) => void;
  onOpen: (issue: Issue) => void;
  onPickToBoard?: (id: string) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, issue: Issue) => void;
  onDragEnd: () => void;
}

function Drawer({
  status,
  issues,
  side,
  open,
  externalPickId,
  onToggle,
  onDropIssue,
  onOpen,
  onPickToBoard,
  onDragStart,
  onDragEnd,
}: DrawerProps) {
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<IssueType | "All">("All");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "All">("All");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const meta = STATUS_META[status];
  const listWrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setTypeFilter("All");
      setPriorityFilter("All");
      setSortKey(DEFAULT_SORT);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listWrapRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const displayedIssues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = issues.filter((i) => {
      if (typeFilter !== "All" && i.type !== typeFilter) return false;
      if (priorityFilter !== "All" && i.priority !== priorityFilter) return false;
      if (
        q &&
        !i.title.toLowerCase().includes(q) &&
        !i.id.toLowerCase().includes(q) &&
        !i.tags.some((t) => t.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
    return sortIssues(matched, sortKey);
  }, [issues, query, typeFilter, priorityFilter, sortKey]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onDropIssue(id, status);
  };

  const rowData = useMemo<DrawerCardRowData>(
    () => ({ issues: displayedIssues, onOpen, onPickToBoard, status, onDragStart, onDragEnd }),
    [displayedIssues, onOpen, onPickToBoard, status, onDragStart, onDragEnd],
  );

  const headClick = () => {
    if (externalPickId) {
      onDropIssue(externalPickId, status);
      clearExternalDragLocal();
      return;
    }
    onToggle();
  };

  return (
    <div
      className={`bd-drawer bd-drawer-${side} ${dragOver ? "is-drag-over" : ""} ${
        open ? "is-open" : ""
      } ${externalPickId ? "is-pick-target" : ""}`}
      style={{ ["--drawer-accent" as string]: meta.color } as CSSProperties}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        className="bd-drawer-head"
        onClick={headClick}
        title={externalPickId ? `Click to move ticket to ${status}` : undefined}
      >
        <span className="bd-drawer-rot">
          <span className="bd-lane-dot" style={{ background: meta.color }} />
          <span>{status}</span>
          <span className="bd-drawer-count">{issues.length}</span>
        </span>
      </button>

      {open && (
        <div className="bd-drawer-body">
          <div className="bd-drawer-search">
            <input
              className="bd-drawer-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
            />
            <select
              className="bd-drawer-search-select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as IssueType | "All")}
            >
              <option value="All">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              className="bd-drawer-search-select"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as Priority | "All")}
            >
              <option value="All">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              className="bd-drawer-search-select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              title="Sort order"
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="bd-drawer-help">
            {status === "Thinking"
              ? "Ideas not yet on the board. Click an issue to view details; Shift+Click promotes to Planned."
              : "Completed issues. Drop here to mark complete, or open to review."}
          </div>
          {displayedIssues.length === 0 ? (
            <div className="bd-lane-empty">
              {issues.length === 0 ? `No ${status.toLowerCase()} issues` : "No matches"}
            </div>
          ) : (
            <div ref={listWrapRef} className="bd-drawer-list">
              {size.height > 0 && (
                <FixedSizeList
                  className="ds-vlist"
                  height={size.height}
                  width={size.width}
                  itemCount={displayedIssues.length}
                  itemSize={DRAWER_CARD_HEIGHT}
                  itemData={rowData}
                  itemKey={(index, data) => data.issues[index].id}
                  overscanCount={3}
                >
                  {DrawerCardRow}
                </FixedSizeList>
              )}
            </div>
          )}
        </div>
      )}
      {externalPickId && (
        <button
          type="button"
          className="bd-pick-overlay"
          title={`Click to move ticket here (${status})`}
          onClick={(e) => {
            e.stopPropagation();
            onDropIssue(externalPickId, status);
            clearExternalDragLocal();
          }}
        >
          <span className="bd-pick-overlay-label">Move to {status}</span>
        </button>
      )}
    </div>
  );
}

interface FocusOverlayProps {
  issue: Issue | null;
  onClose: () => void;
}

function FocusOverlay({ issue, onClose }: FocusOverlayProps) {
  useEffect(() => {
    if (!issue) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [issue, onClose]);
  if (!issue) return null;
  return (
    <div className="bd-focus-backdrop" onClick={onClose}>
      <div className="bd-focus" onClick={(e) => e.stopPropagation()}>
        <button className="bd-focus-close" onClick={onClose} aria-label="Close issue detail">
          <Icon name="close" size={12} />
        </button>
        <IssueDetail issue={issue} />
      </div>
    </div>
  );
}

export function Board() {
  const { issues, settings, initialized } = useIssues();
  const externalPickId = useExternalDragIssueId();
  const [dragId, setDragId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((text: string) => {
    setToast({ text, seq: ++toastSeq.current });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), TOAST_TTL_MS);
    return () => window.clearTimeout(t);
  }, [toast?.seq]);

  // If the host re-broadcasts mid-drag and removes/reassigns the dragged ticket,
  // onDragEnd may not fire (the source unmounts). Clear stuck dragId defensively.
  useEffect(() => {
    if (dragId === null) return;
    const exists = issues.some((i) => i.id === dragId);
    if (!exists) setDragId(null);
  }, [issues, dragId]);

  // Esc cancels an in-progress sidebar→board drag (the board has no native
  // dragend signal for a cross-webview source).
  useEffect(() => {
    if (!externalPickId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearExternalDragLocal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [externalPickId]);

  const cap = settings?.activeLaneCap ?? ACTIVE_LANE_CAP;

  const setStatus = useCallback(
    (id: string, newStatus: Status) => {
      const issue = issues.find((i) => i.id === id);
      if (!issue || issue.status === newStatus) return;
      const guard = canMoveToActiveLane(issues, newStatus, id, cap);
      if (guard !== true) {
        showToast(guard);
        return;
      }
      postUpdateIssue({ ...issue, status: newStatus });
    },
    [issues, showToast, cap],
  );

  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, issue: Issue) => {
      e.dataTransfer.setData("text/plain", issue.id);
      e.dataTransfer.effectAllowed = "move";
      setDragId(issue.id);
    },
    [],
  );
  const onDragEnd = useCallback(() => setDragId(null), []);
  const onOpen = useCallback((issue: Issue) => setFocusId(issue.id), []);

  const sortLane = useCallback((status: Status, list: Issue[]): Issue[] => {
    if (status === "Complete") {
      return [...list].sort((a, b) => {
        const ra = a.resolvedAt ? new Date(a.resolvedAt).getTime() : new Date(a.createdAt).getTime();
        const rb = b.resolvedAt ? new Date(b.resolvedAt).getTime() : new Date(b.createdAt).getTime();
        return rb - ra;
      });
    }
    return [...list].sort((a, b) => {
      const pa = PRI_ORDER[a.priority] ?? 99;
      const pb = PRI_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, []);

  const byStatus = useMemo(() => {
    // Closed tickets exist in the store but are never rendered on the board
    // (per the workflow rules: Closed lives only in the sidebar). The bucket
    // is present to satisfy the Record<Status, Issue[]> shape.
    const map: Record<Status, Issue[]> = {
      Thinking: [],
      Planned: [],
      Working: [],
      Verification: [],
      Complete: [],
      Closed: [],
    };
    for (const i of issues) map[i.status].push(i);
    (Object.keys(map) as Status[]).forEach((s) => {
      map[s] = sortLane(s, map[s]);
    });
    return map;
  }, [issues, sortLane]);

  const focused = focusId ? issues.find((i) => i.id === focusId) ?? null : null;

  if (!initialized) {
    return <div style={{ padding: 40, color: "var(--vsc-fg-muted)" }}>Loading…</div>;
  }

  return (
    <div className={`bd-root ${leftOpen ? "bd-left-open" : ""} ${rightOpen ? "bd-right-open" : ""}`}>
      <Drawer
        status="Thinking"
        side="left"
        open={leftOpen}
        externalPickId={externalPickId}
        onToggle={() => setLeftOpen((v) => !v)}
        issues={byStatus.Thinking}
        onDropIssue={setStatus}
        onPickToBoard={(id) => setStatus(id, "Planned")}
        onOpen={onOpen}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />

      <div className="bd-lanes">
        {ACTIVE_LANES.map((s) => (
          <Lane
            key={s}
            status={s}
            issues={byStatus[s]}
            cap={cap}
            dragId={dragId}
            externalPickId={externalPickId}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDropIssue={setStatus}
            onOpen={onOpen}
          />
        ))}
      </div>

      <Drawer
        status="Complete"
        side="right"
        open={rightOpen}
        externalPickId={externalPickId}
        onToggle={() => setRightOpen((v) => !v)}
        issues={byStatus.Complete}
        onDropIssue={setStatus}
        onOpen={onOpen}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />

      <FocusOverlay issue={focused} onClose={() => setFocusId(null)} />

      {toast && <div className="bd-toast">{toast.text}</div>}
    </div>
  );
}
