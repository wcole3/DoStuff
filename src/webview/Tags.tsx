// Tag display + editor primitives shared by Sidebar rows, Board cards, and
// the IssueDetail panel.

import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { MAX_INLINE_TAG_CHIPS, normalizeTag } from "../types";

// Deterministic per-tag display color. Each unique tag name maps to a fixed
// hue so the visual identity is stable across sessions without any storage.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function tagColor(tag: string): string {
  const hue = hashString(tag.toLowerCase()) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

interface TagStripProps {
  tags: string[];
  /** Render chips up to this many; any leftover render as dots. */
  maxChips?: number;
  className?: string;
}

/** Read-only inline display: chips up to `maxChips`, then colored dots. */
export function TagStrip({ tags, maxChips = MAX_INLINE_TAG_CHIPS, className }: TagStripProps) {
  if (!tags.length) return null;
  const chips = tags.slice(0, maxChips);
  const dots = tags.slice(maxChips);
  return (
    <span className={`ds-tag-row ${className ?? ""}`}>
      {chips.map((tag) => (
        <span
          key={tag}
          className="ds-tag-chip"
          style={{ ["--tag-color" as string]: tagColor(tag) } as CSSProperties}
          title={tag}
        >
          {tag}
        </span>
      ))}
      {dots.map((tag) => (
        <span
          key={tag}
          className="ds-tag-dot"
          style={{ ["--tag-color" as string]: tagColor(tag) } as CSSProperties}
          title={tag}
        />
      ))}
    </span>
  );
}

interface TagEditorProps {
  tags: string[];
  onChange: (next: string[]) => void;
  /**
   * Existing tags from across the workspace to surface as autocomplete
   * options. Already-applied tags are filtered out before rendering. Pass
   * `undefined` (or omit) to disable suggestions.
   */
  suggestions?: string[];
  placeholder?: string;
}

/** Inline editor: existing chips with close buttons + input that adds on Enter or comma. */
export function TagEditor({
  tags,
  onChange,
  suggestions,
  placeholder = "Add tag…",
}: TagEditorProps) {
  const [draft, setDraft] = useState("");
  // useId() returns colon-bearing strings like `:r1:`; sanitise so the id is
  // a valid CSS selector (some test environments / older browsers choke on
  // colons in element ids).
  const listId = `tag-suggest-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const applied = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);
  const filteredSuggestions = useMemo(
    () => (suggestions ?? []).filter((s) => !applied.has(s.toLowerCase())),
    [suggestions, applied],
  );

  const commit = (raw: string) => {
    const next = normalizeTag(raw);
    if (!next) return;
    const lower = next.toLowerCase();
    if (tags.some((t) => t.toLowerCase() === lower)) {
      setDraft("");
      return;
    }
    onChange([...tags, next]);
    setDraft("");
  };

  const remove = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && tags.length) {
      e.preventDefault();
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="ds-tag-edit">
      {tags.map((tag) => (
        <span
          key={tag}
          className="ds-tag-chip ds-tag-chip-edit"
          style={{ ["--tag-color" as string]: tagColor(tag) } as CSSProperties}
        >
          {tag}
          <button
            type="button"
            className="ds-tag-chip-rm"
            onClick={() => remove(tag)}
            aria-label={`Remove tag ${tag}`}
            title={`Remove ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="ds-tag-edit-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit(draft)}
        placeholder={tags.length === 0 ? placeholder : ""}
        list={filteredSuggestions.length > 0 ? listId : undefined}
      />
      {filteredSuggestions.length > 0 && (
        <datalist id={listId}>
          {filteredSuggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
