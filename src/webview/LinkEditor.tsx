// Outbound-link editor. Typeahead that searches existing tickets by id or
// title + a kind selector. Mirrors TagEditor's local-mirror state so rapid
// commits survive the host round-trip (see TagEditor's long comment).

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { type Issue, type LinkKind, type TicketLink } from "../types";
import { Icon, STATUS_META, TYPE_ICON } from "./Icons";
import { OutboundLinkChip, LINK_KIND_COLOR } from "./Links";
import {
  RELATIONSHIP_OPTIONS,
  relationshipOption,
  searchIssuesForLink,
  sortLinks,
  type RelLabel,
} from "./linkModel";

// Upper bound on rendered typeahead rows. The visible area is capped at ~20
// rows in CSS (`.ds-link-results`) and scrolls; this just bounds the DOM so an
// empty query in a large workspace can't render thousands of nodes. Narrow the
// query to reach anything past this.
const MAX_RESULTS = 50;

interface LinkEditorProps {
  /** The current ticket's outbound (forward) links. */
  value: TicketLink[];
  /** Called with the new outbound list when a *forward* relationship is added
   *  or removed. */
  onChange: (next: TicketLink[]) => void;
  /** Called when an *inverse* relationship is added (e.g. "blocked by X"). The
   *  caller stores the forward link on the target ticket. Required for inverse
   *  options to be offered. */
  onAddInverse?: (targetId: string, storedKind: LinkKind) => void;
  allIssues: Issue[];
  /** The ticket being edited — excluded from results so it can't self-link.
   *  Omit in the new-issue modal (no id yet). */
  currentIssueId?: string;
}

export function LinkEditor({
  value,
  onChange,
  onAddInverse,
  allIssues,
  currentIssueId,
}: LinkEditorProps) {
  const [local, setLocal] = useState(value);
  const [draft, setDraft] = useState("");
  const [rel, setRel] = useState<RelLabel>("relates-to");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inverse kinds need a place to store the back-link; offer them only when
  // the caller handles inverse adds.
  const offerInverse = !!onAddInverse;
  const options = useMemo(
    () => RELATIONSHIP_OPTIONS.filter((o) => offerInverse || !o.inverse),
    [offerInverse],
  );
  const opt = relationshipOption(rel);

  const byId = useMemo(() => new Map(allIssues.map((i) => [i.id, i] as const)), [allIssues]);
  // Exclude targets already linked with the selected forward kind so the
  // dropdown can't produce an exact duplicate. (Inverse picks aren't excluded
  // here — the host de-dupes on the target side.)
  const excludedIds = useMemo(() => {
    const s = new Set<string>();
    if (!opt.inverse) {
      for (const l of local) if (l.kind === opt.storedKind) s.add(l.targetId);
    }
    return s;
  }, [local, opt]);

  const results = useMemo(
    () => searchIssuesForLink(draft, allIssues, currentIssueId, excludedIds).slice(0, MAX_RESULTS),
    [draft, allIssues, currentIssueId, excludedIds],
  );

  const emit = (next: TicketLink[]) => {
    setLocal(next);
    onChange(next);
  };

  const commit = (target: Issue) => {
    setDraft("");
    setOpen(false);
    if (opt.inverse) {
      // Stored on the target ticket as a forward link back to current.
      onAddInverse?.(target.id, opt.storedKind);
      return;
    }
    // Forward link on the current ticket. A given (target, kind) pair is
    // unique; coerceLinks dedupes on the host anyway, but guard here so the
    // chip list doesn't visually double up.
    if (local.some((l) => l.targetId === target.id && l.kind === opt.storedKind)) return;
    emit([...local, { targetId: target.id, kind: opt.storedKind }]);
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
          value={rel}
          onChange={(e) => setRel(e.target.value as RelLabel)}
          aria-label="Link kind"
          style={{ borderColor: LINK_KIND_COLOR[opt.storedKind] }}
        >
          {options.map((o) => (
            <option key={o.rel} value={o.rel}>
              {o.label}
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
