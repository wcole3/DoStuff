// Outbound-link editor. Typeahead that searches existing tickets by id or
// title + a kind selector. Mirrors TagEditor's local-mirror state so rapid
// commits survive the host round-trip (see TagEditor's long comment).

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LINK_KINDS, type Issue, type LinkKind, type TicketLink } from "../types";
import { Icon, STATUS_META, TYPE_ICON } from "./Icons";
import { OutboundLinkChip, LINK_KIND_COLOR } from "./Links";
import { LINK_KIND_LABEL, searchIssuesForLink, sortLinks } from "./linkModel";

interface LinkEditorProps {
  value: TicketLink[];
  onChange: (next: TicketLink[]) => void;
  allIssues: Issue[];
  /** The ticket being edited — excluded from results so it can't self-link.
   *  Omit in the new-issue modal (no id yet). */
  currentIssueId?: string;
}

export function LinkEditor({ value, onChange, allIssues, currentIssueId }: LinkEditorProps) {
  const [local, setLocal] = useState(value);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<LinkKind>("relates-to");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const byId = useMemo(() => new Map(allIssues.map((i) => [i.id, i] as const)), [allIssues]);
  const linkedIds = useMemo(() => new Set(local.map((l) => l.targetId)), [local]);

  const results = useMemo(
    () => searchIssuesForLink(draft, allIssues, currentIssueId, linkedIds).slice(0, 8),
    [draft, allIssues, currentIssueId, linkedIds],
  );

  const emit = (next: TicketLink[]) => {
    setLocal(next);
    onChange(next);
  };

  const commit = (target: Issue) => {
    // A given (target, kind) pair is unique; coerceLinks dedupes on the host
    // anyway, but guard here so the chip list doesn't visually double up.
    if (local.some((l) => l.targetId === target.id && l.kind === kind)) {
      setDraft("");
      setOpen(false);
      return;
    }
    emit([...local, { targetId: target.id, kind }]);
    setDraft("");
    setOpen(false);
  };

  const remove = (link: TicketLink) =>
    emit(local.filter((l) => !(l.targetId === link.targetId && l.kind === link.kind)));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (results.length > 0) commit(results[0]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && draft === "" && local.length) {
      e.preventDefault();
      emit(local.slice(0, -1));
    }
  };

  const sorted = useMemo(() => sortLinks(local, byId), [local, byId]);

  return (
    <div className="ds-link-edit">
      {sorted.length > 0 && (
        <div className="ds-link-chip-row">
          {sorted.map((l) => (
            <OutboundLinkChip
              key={`${l.targetId}|${l.kind}`}
              kind={l.kind}
              target={byId.get(l.targetId)}
              targetId={l.targetId}
              onRemove={() => remove(l)}
            />
          ))}
        </div>
      )}
      <div className="ds-link-edit-controls">
        <select
          className="ds-input ds-link-kind-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as LinkKind)}
          aria-label="Link kind"
          style={{ borderColor: LINK_KIND_COLOR[kind] }}
        >
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {LINK_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <div className="ds-link-typeahead">
          <input
            className="ds-input ds-link-search"
            value={draft}
            placeholder="Link a ticket by #id or title…"
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            onBlur={() => {
              // Delay close so a click on a result row registers first.
              blurTimer.current = setTimeout(() => setOpen(false), 120);
            }}
          />
          {open && results.length > 0 && (
            <ul className="ds-link-results" role="listbox">
              {results.map((i) => (
                <li key={i.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="ds-link-result"
                    // onMouseDown (not onClick) so it fires before the input's
                    // onBlur tears the list down.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (blurTimer.current) clearTimeout(blurTimer.current);
                      commit(i);
                    }}
                  >
                    <Icon name={TYPE_ICON[i.type]} size={12} />
                    <span className="ds-link-result-num">#{i.number}</span>
                    <span className="ds-link-result-title">{i.title}</span>
                    <span
                      className="ds-link-status-dot"
                      style={{ background: STATUS_META[i.status].color }}
                      title={i.status}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
