import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import {
  PRIORITIES,
  STATUSES,
  TYPES,
  type Issue,
  type IssueType,
  type Priority,
  type Status,
} from "../types";
import { Icon, PRIORITY_META, STATUS_META, TYPE_ICON } from "./Icons";
import { IssueDetail, absTime, relTime } from "./IssueDetail";
import { TagStrip } from "./Tags";
import { postExternalDragStart, useIssues } from "./messaging";
import { AddIssueModal, DeleteConfirmModal } from "./Modals";
import { DEFAULT_SORT, SORT_KEYS, SORT_LABELS, sortIssues, type SortKey } from "./sort";

/**
 * Fixed slot size per row. Sized to fit a two-line title plus the meta line
 * within the row's padding. Keep in sync with `.ds-row-title` line-height /
 * clamp in styles.css.
 */
const ROW_HEIGHT = 74;

interface RowData {
  filtered: Issue[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onContextMenu: (id: string) => void;
  width: number;
}

/** Below this list width the date is dropped from the meta line so chips fit. */
const DATE_HIDE_WIDTH = 240;

const Row = memo(function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const issue = data.filtered[index];
  const expanded = data.expandedId === issue.id;
  const meta = STATUS_META[issue.status];
  const pri = PRIORITY_META[issue.priority];

  return (
    <div style={style}>
      <div
        className={`ds-row ${expanded ? "is-expanded" : ""}`}
        draggable
        onDragStart={(e) => {
          // Arms cross-webview pick mode: the board webview lights up lanes
          // and drawers as click targets (`bd-pick-overlay`). Native drop
          // can't reach the board iframe because VSCode forces
          // `pointer-events: none` on it during any window-level drag
          // (microsoft/vscode#96967), so the user releases the mouse and
          // then clicks an overlay to commit the move.
          //
          // We intentionally do NOT clear the pick state on `dragend`. If we
          // did, the overlay would vanish at the exact moment the user
          // becomes able to click it (the drag has to end first for the
          // board iframe's pointer events to come back). The board clears
          // the state itself after a successful overlay click, and Esc
          // cancels.
          e.dataTransfer.setData("text/plain", issue.id);
          e.dataTransfer.effectAllowed = "move";
          postExternalDragStart(issue.id);
        }}
        onClick={() => data.onToggle(issue.id)}
        onContextMenu={(e) => { e.preventDefault(); data.onContextMenu(issue.id); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            data.onToggle(issue.id);
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        aria-label={`Issue ${issue.id}: ${issue.title}`}
      >
        <button
          className="ds-row-chev"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(issue.id);
          }}
          title={expanded ? "Collapse" : "Expand"}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        <div className="ds-row-icon" title={issue.type}>
          <Icon name={TYPE_ICON[issue.type]} size={13} />
        </div>
        <div className="ds-row-body">
          <div className="ds-row-title" title={issue.title}>{issue.title}</div>
          <div className="ds-row-meta">
            <span
              title={issue.priority}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                color: pri.color,
              }}
            >
              <Icon name={pri.icon} size={12} />
            </span>
            <span className="ds-row-id" title={issue.id}>
              #{issue.number}
            </span>
            <span className="ds-row-dot">·</span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 10.5,
                color: "var(--vsc-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: ".04em",
                fontWeight: 500,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: meta.color,
                  boxShadow: `0 0 0 2px ${meta.color}22`,
                }}
              />
              {meta.label}
            </span>
            {data.width >= DATE_HIDE_WIDTH && (
              <>
                <span className="ds-row-dot">·</span>
                <span className="ds-row-date" title={absTime(issue.createdAt)}>
                  {relTime(issue.createdAt)}
                </span>
              </>
            )}
            {issue.tags.length > 0 && (
              <>
                <span className="ds-row-dot">·</span>
                <TagStrip tags={issue.tags} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/** Tracks the host's offsetHeight so the FixedSizeList knows how tall to be. */
function useParentSize(): [RefObject<HTMLDivElement>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

type StatusFilter = "All" | Status;

const VISIBLE_BY_DEFAULT: Status[] = ["Thinking", "Planned", "Working", "Verification"];

export function Sidebar() {
  const { issues, initialized } = useIssues();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [typeFilter, setTypeFilter] = useState<IssueType | "All">("All");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "All">("All");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const [showCompleted, setShowCompleted] = useState(false);
  const [modal, setModal] = useState<"add" | { kind: "delete"; issue: Issue } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [listRef, listSize] = useParentSize();

  useEffect(() => {
    const handler = () => setModal("add");
    window.addEventListener("dostuff:showNewIssue", handler);
    return () => window.removeEventListener("dostuff:showNewIssue", handler);
  }, []);

  // Open a ticket's detail when the host broadcasts revealTicket (e.g. a graph
  // node click or a link-chip click). expandedIssue is derived from the full
  // issue list, so this surfaces the detail even if the ticket is filtered out.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (typeof id === "string") setExpandedId(id);
    };
    window.addEventListener("dostuff:revealTicket", handler);
    return () => window.removeEventListener("dostuff:revealTicket", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = issues
      .filter((i) => {
        if (statusFilter !== "All") return i.status === statusFilter;
        // "All" hides Closed entirely (only visible by selecting the Closed
        // chip) and hides Complete unless the user has opted in.
        if (i.status === "Closed") return false;
        if (i.status === "Complete") return showCompleted;
        return VISIBLE_BY_DEFAULT.includes(i.status);
      })
      .filter((i) => typeFilter === "All" || i.type === typeFilter)
      .filter((i) => priorityFilter === "All" || i.priority === priorityFilter)
      .filter((i) => {
        if (!q) return true;
        return (
          i.title.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.type.toLowerCase().includes(q) ||
          i.priority.toLowerCase().includes(q) ||
          i.status.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q))
        );
      });
    return sortIssues(matched, sortKey);
  }, [issues, query, statusFilter, typeFilter, priorityFilter, sortKey, showCompleted]);

  const expandedIssue = expandedId ? issues.find((i) => i.id === expandedId) ?? null : null;

  useEffect(() => {
    if (expandedId && !issues.find((i) => i.id === expandedId)) {
      setExpandedId(null);
    }
  }, [issues, expandedId]);

  const onToggle = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  const onContextMenu = useCallback((id: string) => {
    const issue = issues.find((i) => i.id === id);
    if (issue) setModal({ kind: "delete", issue });
  }, [issues]);

  const rowData = useMemo<RowData>(
    () => ({ filtered, expandedId, onToggle, onContextMenu, width: listSize.width }),
    [filtered, expandedId, onToggle, onContextMenu, listSize.width],
  );

  return (
    <aside className="ds-sidebar">
      <div className="ds-sb-search">
        <Icon name="search" size={12} style={{ opacity: 0.5 }} />
        <input
          ref={searchRef}
          data-search="dostuff"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search issues…"
        />
        {query && (
          <button className="ds-sb-clear" onClick={() => setQuery("")} title="Clear" aria-label="Clear search">
            <Icon name="close" size={10} />
          </button>
        )}
      </div>

      <div className="ds-sb-filters">
        {(["All", ...STATUSES] as StatusFilter[]).map((s) => {
          const count = s === "All" ? issues.length : issues.filter((i) => i.status === s).length;
          const active = statusFilter === s;
          return (
            <button
              key={s}
              className={`ds-chip ${active ? "is-active" : ""}`}
              onClick={() => {
                setStatusFilter(s);
                if (s === "Complete") setShowCompleted(true);
              }}
            >
              {s !== "All" && (
                <span className="ds-chip-dot" style={{ background: STATUS_META[s].color }} />
              )}
              {s} <span className="ds-chip-count">{count}</span>
            </button>
          );
        })}
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10.5,
            color: "var(--vsc-fg-muted)",
            marginLeft: "auto",
            cursor: "pointer",
          }}
          title="Toggle visibility of Complete tickets"
        >
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            style={{ margin: 0 }}
          />
          Show completed
        </label>
      </div>

      <div className="ds-sb-controls">
        <select
          className="ds-sb-select"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as IssueType | "All")}
          title="Filter by type"
        >
          <option value="All">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="ds-sb-select"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as Priority | "All")}
          title="Filter by priority"
        >
          <option value="All">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="ds-sb-select ds-sb-sort"
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

      <div className="ds-sb-list-wrap">
        <div ref={listRef} className="ds-sb-list">
          {!initialized ? (
            <div className="ds-sb-empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="ds-sb-empty">
              {query ? `No issues match "${query}"` : "No issues yet."}
            </div>
          ) : listSize.height > 0 ? (
            <FixedSizeList
              className="ds-vlist"
              style={{ width: "100%" }}
              height={listSize.height}
              width={listSize.width}
              itemCount={filtered.length}
              itemSize={ROW_HEIGHT}
              itemData={rowData}
              itemKey={(index, data) => data.filtered[index].id}
              overscanCount={4}
            >
              {Row}
            </FixedSizeList>
          ) : null}
        </div>

        {expandedIssue && <IssueDetail issue={expandedIssue} />}
      </div>

      {modal === "add" && <AddIssueModal onClose={() => setModal(null)} />}
      {modal && typeof modal === "object" && modal.kind === "delete" && (
        <DeleteConfirmModal issue={modal.issue} onClose={() => setModal(null)} />
      )}
    </aside>
  );
}
