import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
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
// Minimum pixels moved before a pointerdown is promoted to a drag. Below this
// threshold the gesture is treated as a click so card-open still works.
const DRAG_THRESHOLD_PX = 5;

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

/**
 * Pointer-event drag is used in place of native HTML5 DnD because VSCode
 * wraps each webview in an `<iframe>` and sets `pointer-events: none` on it
 * for the duration of any window-level drag (see microsoft/vscode#96967).
 * That makes lane drop targets go dead if the cursor ever leaves and re-enters
 * the panel. Synthesizing our own drag with pointer events keeps the gesture
 * contained inside the webview where VSCode never disables it.
 */
interface PointerDragState {
  beginDrag: (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => void;
  dragId: string | null;
  ghost: { x: number; y: number; title: string } | null;
  hoverStatus: Status | null;
  justDraggedRef: React.MutableRefObject<boolean>;
}

function statusFromPoint(x: number, y: number): Status | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const target = (el as Element).closest("[data-drop-status]");
  if (!target) return null;
  const raw = target.getAttribute("data-drop-status");
  return raw as Status | null;
}

function usePointerDrag(
  onDrop: (id: string, status: Status) => void,
): PointerDragState {
  const [dragId, setDragId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null);
  const [hoverStatus, setHoverStatus] = useState<Status | null>(null);
  const justDraggedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down any in-flight listeners if the component unmounts mid-drag.
  useEffect(() => () => cleanupRef.current?.(), []);

  const beginDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY };
      const issueId = issue.id;
      const issueTitle = issue.title;
      let active = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!active) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          active = true;
          setDragId(issueId);
          document.body.style.userSelect = "none";
        }
        setGhost({ x: ev.clientX, y: ev.clientY, title: issueTitle });
        setHoverStatus(statusFromPoint(ev.clientX, ev.clientY));
      };

      const finish = (ev: PointerEvent | null) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        document.body.style.userSelect = "";
        cleanupRef.current = null;
        if (active) {
          justDraggedRef.current = true;
          // Reset on the next tick so the synthetic click that fires after
          // pointerup (on the original element) gets swallowed, but a fresh
          // user click on the next gesture still works.
          window.setTimeout(() => {
            justDraggedRef.current = false;
          }, 0);
          if (ev) {
            const status = statusFromPoint(ev.clientX, ev.clientY);
            if (status) onDrop(issueId, status);
          }
        }
        setDragId(null);
        setGhost(null);
        setHoverStatus(null);
      };

      const onUp = (ev: PointerEvent) => finish(ev);
      const onCancel = () => finish(null);

      cleanupRef.current?.();
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [onDrop],
  );

  return { beginDrag, dragId, ghost, hoverStatus, justDraggedRef };
}

interface BoardCardProps {
  issue: Issue;
  onOpen: (issue: Issue) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
  dragging: boolean;
}

const BoardCard = memo(function BoardCard({
  issue,
  onOpen,
  onPointerDown,
  justDraggedRef,
  dragging,
}: BoardCardProps) {
  const meta = STATUS_META[issue.status];
  const pri = PRIORITY_META[issue.priority];
  return (
    <div
      className={`bd-card ${dragging ? "is-dragging" : ""}`}
      onPointerDown={(e) => onPointerDown(e, issue)}
      onClick={() => {
        if (justDraggedRef.current) return;
        onOpen(issue);
      }}
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
  hoverStatus: Status | null;
  externalPickId: string | null;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
  onDropIssue: (id: string, status: Status) => void;
  onOpen: (issue: Issue) => void;
}

function Lane({
  status,
  issues,
  cap,
  dragId,
  hoverStatus,
  externalPickId,
  onPointerDown,
  justDraggedRef,
  onDropIssue,
  onOpen,
}: LaneProps) {
  const meta = STATUS_META[status];
  const count = issues.length;
  const isFull = count >= cap;
  const dragOver = hoverStatus === status && dragId !== null;
  const dragBlocked = isFull && dragOver && issues.every((i) => i.id !== dragId);

  return (
    <div
      data-drop-status={status}
      className={`bd-lane ${dragOver ? "is-drag-over" : ""} ${isFull ? "is-full" : ""} ${
        dragBlocked ? "is-drag-blocked" : ""
      } ${externalPickId ? "is-pick-target" : ""}`}
      style={{ ["--lane-accent" as string]: meta.color } as CSSProperties}
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
              onPointerDown={onPointerDown}
              justDraggedRef={justDraggedRef}
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
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
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
        onPointerDown={(e) => data.onPointerDown(e, issue)}
        onClick={(e) => {
          if (data.justDraggedRef.current) return;
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
  dragId: string | null;
  hoverStatus: Status | null;
  externalPickId: string | null;
  onToggle: () => void;
  onDropIssue: (id: string, status: Status) => void;
  onOpen: (issue: Issue) => void;
  onPickToBoard?: (id: string) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, issue: Issue) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
}

function Drawer({
  status,
  issues,
  side,
  open,
  dragId,
  hoverStatus,
  externalPickId,
  onToggle,
  onDropIssue,
  onOpen,
  onPickToBoard,
  onPointerDown,
  justDraggedRef,
}: DrawerProps) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<IssueType | "All">("All");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "All">("All");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const meta = STATUS_META[status];
  const listWrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const dragOver = hoverStatus === status && dragId !== null;

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

  const rowData = useMemo<DrawerCardRowData>(
    () => ({ issues: displayedIssues, onOpen, onPickToBoard, status, onPointerDown, justDraggedRef }),
    [displayedIssues, onOpen, onPickToBoard, status, onPointerDown, justDraggedRef],
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
      data-drop-status={status}
      className={`bd-drawer bd-drawer-${side} ${dragOver ? "is-drag-over" : ""} ${
        open ? "is-open" : ""
      } ${externalPickId ? "is-pick-target" : ""}`}
      style={{ ["--drawer-accent" as string]: meta.color } as CSSProperties}
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

interface DragGhostProps {
  ghost: { x: number; y: number; title: string } | null;
}

function DragGhost({ ghost }: DragGhostProps) {
  if (!ghost) return null;
  return (
    <div
      className="bd-drag-ghost"
      style={{
        position: "fixed",
        left: ghost.x + 12,
        top: ghost.y + 12,
        pointerEvents: "none",
        zIndex: 9999,
      }}
    >
      {ghost.title}
    </div>
  );
}

export function Board() {
  const { issues, settings, initialized } = useIssues();
  const externalPickId = useExternalDragIssueId();
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

  const { beginDrag, dragId, ghost, hoverStatus, justDraggedRef } = usePointerDrag(setStatus);
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
        dragId={dragId}
        hoverStatus={hoverStatus}
        externalPickId={externalPickId}
        onToggle={() => setLeftOpen((v) => !v)}
        issues={byStatus.Thinking}
        onDropIssue={setStatus}
        onPickToBoard={(id) => setStatus(id, "Planned")}
        onOpen={onOpen}
        onPointerDown={beginDrag}
        justDraggedRef={justDraggedRef}
      />

      <div className="bd-lanes">
        {ACTIVE_LANES.map((s) => (
          <Lane
            key={s}
            status={s}
            issues={byStatus[s]}
            cap={cap}
            dragId={dragId}
            hoverStatus={hoverStatus}
            externalPickId={externalPickId}
            onPointerDown={beginDrag}
            justDraggedRef={justDraggedRef}
            onDropIssue={setStatus}
            onOpen={onOpen}
          />
        ))}
      </div>

      <Drawer
        status="Complete"
        side="right"
        open={rightOpen}
        dragId={dragId}
        hoverStatus={hoverStatus}
        externalPickId={externalPickId}
        onToggle={() => setRightOpen((v) => !v)}
        issues={byStatus.Complete}
        onDropIssue={setStatus}
        onOpen={onOpen}
        onPointerDown={beginDrag}
        justDraggedRef={justDraggedRef}
      />

      <FocusOverlay issue={focused} onClose={() => setFocusId(null)} />

      <DragGhost ghost={ghost} />

      {toast && <div className="bd-toast">{toast.text}</div>}
    </div>
  );
}
