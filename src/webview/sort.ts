// Shared sort options for the sidebar list and board drawers. Kept in its
// own module so both UIs use the same labels + comparator.

import { PRIORITIES, TYPES, type Issue, type Priority, type IssueType } from "../types";

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

const tsAsc = (a: Issue, b: Issue) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
const tsDesc = (a: Issue, b: Issue) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

export function sortIssues(issues: Issue[], key: SortKey): Issue[] {
  const copy = [...issues];
  switch (key) {
    case "first-added":
      return copy.sort(tsDesc);
    case "last-added":
      return copy.sort(tsAsc);
    case "alphabetical":
      return copy.sort(
        (a, b) => a.title.localeCompare(b.title) || tsDesc(a, b),
      );
    case "by-type":
      return copy.sort(
        (a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || tsDesc(a, b),
      );
    case "by-priority":
      return copy.sort(
        (a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || tsDesc(a, b),
      );
  }
}
