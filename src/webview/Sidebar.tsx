import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { STATUSES, type Issue, type Status } from "../types";
import { Icon, PRIORITY_META, STATUS_META, TYPE_ICON } from "./Icons";
import { IssueDetail, absTime, relTime } from "./IssueDetail";
import { postExternalDragEnd, postExternalDragStart, useIssues } from "./messaging";
import { AddIssueModal, DeleteConfirmModal } from "./Modals";

/**
 * Fixed slot size per row. Sized to fit a two-line title plus the meta line
 * within the row's padding. Keep in sync with `.ds-row-title` line-height /
 * clamp in styles.css.
 */
const ROW_HEIGHT = 64;

interface RowData {
  filtered: Issue[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onContextMenu: (id: string) => void;
}

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
          // Best-effort native cross-webview drag: if VSCode allows the drop
          // to reach the board iframe, the board's existing onDrop handler
          // picks up the ID. Either way, we also post a host message so the
          // board can light up lanes as click targets.
          e.dataTransfer.setData("text/plain", issue.id);
          e.dataTransfer.effectAllowed = "move";
          postExternalDragStart(issue.id);
        }}
        onDragEnd={() => postExternalDragEnd()}
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
            <span className="ds-row-dot">·</span>
            <span className="ds-row-date" title={absTime(issue.createdAt)}>
              {relTime(issue.createdAt)}
            </span>
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
  const [showCompleted, setShowCompleted] = useState(false);
  const [modal, setModal] = useState<"add" | { kind: "delete"; issue: Issue } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [listRef, listSize] = useParentSize();

  useEffect(() => {
    const handler = () => setModal("add");
    window.addEventListener("dostuff:showNewIssue", handler);
    return () => window.removeEventListener("dostuff:showNewIssue", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues
      .filter((i) => {
        if (statusFilter !== "All") return i.status === statusFilter;
        if (i.status === "Complete") return showCompleted;
        return VISIBLE_BY_DEFAULT.includes(i.status);
      })
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
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [issues, query, statusFilter, showCompleted]);

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
    () => ({ filtered, expandedId, onToggle, onContextMenu }),
    [filtered, expandedId, onToggle, onContextMenu],
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
