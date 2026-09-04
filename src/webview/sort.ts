// Shared sort options for the sidebar list and board drawers. Kept in its
// own module so both UIs use the same labels + comparator.

import { PRIORITIES, TYPES, type IssueRow, type Priority, type IssueType } from "../types";

export const SORT_KEYS = [
  "first-added",
  "last-added",
  "alphabetical",
  "by-type",
  "by-priority",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  "first-added": "First added",
  "last-added": "Last added",
  "alphabetical": "Alphabetical",
  "by-type": "By type",
  "by-priority": "By priority",
};

export const DEFAULT_SORT: SortKey = "first-added";

const TYPE_ORDER: Record<IssueType, number> = Object.fromEntries(
  TYPES.map((t, i) => [t, i]),
) as Record<IssueType, number>;

const PRIORITY_ORDER: Record<Priority, number> = Object.fromEntries(
  PRIORITIES.map((p, i) => [p, i]),
) as Record<Priority, number>;

/**
 * Sort by a per-item key computed ONCE (Schwartzian transform) instead of
 * allocating two `Date`s per comparison — the list re-sorts on every host
 * message, and at 600+ tickets the old comparators dominated render time.
 */
function sortByKey<T>(items: T[], key: (t: T) => number, tiebreak?: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, k: key(item), index }))
    .sort((a, b) => a.k - b.k || (tiebreak ? tiebreak(a.item, b.item) : 0) || a.index - b.index)
    .map((e) => e.item);
}

const created = (i: IssueRow) => Date.parse(i.createdAt) || 0;

export function sortIssues(issues: IssueRow[], key: SortKey): IssueRow[] {
  switch (key) {
    case "first-added":
      return sortByKey(issues, (i) => -created(i));
    case "last-added":
      return sortByKey(issues, created);
    case "alphabetical":
      return sortByKey(issues, () => 0, (a, b) => a.title.localeCompare(b.title) || created(b) - created(a));
    case "by-type":
      return sortByKey(issues, (i) => TYPE_ORDER[i.type], (a, b) => created(b) - created(a));
    case "by-priority":
      return sortByKey(issues, (i) => PRIORITY_ORDER[i.priority], (a, b) => created(b) - created(a));
  }
}
