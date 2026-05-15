import { memo, type CSSProperties, type ReactNode } from "react";
import type { IssueType, Priority, Status } from "../types";

export type IconName =
  | "search"
  | "close"
  | "chevronRight"
  | "chevronDown"
  | "chevronUp"
  | "plus"
  | "trash"
  | "filter"
  | "refresh"
  | "more"
  | "board"
  | "list"
  | "flame"
  | "arrowUp"
  | "arrow"
  | "arrowDown"
  | "files"
  | "database"
  | "settings"
  | "download"
  | "upload"
  | "edit"
  | "check"
  | "drag"
  | "bug"
  | "sparkle"
  | "wrench"
  | "broom"
  | "flask"
  | "clock"
  | "calendar"
  | "panelLeft";

const ICON_PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  close: <path d="M3 3l10 10M13 3L3 13" />,
  chevronRight: <path d="M6 3l4 5-4 5" />,
  chevronDown: <path d="M3 6l5 4 5-4" />,
  chevronUp: <path d="M3 10l5-4 5 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  trash: (
    <>
      <path d="M3.5 4.5h9M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5M5 4.5l.5 8.5a1 1 0 001 1h3a1 1 0 001-1l.5-8.5" />
      <path d="M7 7v4M9 7v4" />
    </>
  ),
  filter: <path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5L2 3z" />,
  refresh: (
    <>
      <path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4" />
      <path d="M11 4.5h2v-2M5 11.5H3v2" />
    </>
  ),
  more: (
    <>
      <circle cx="3" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="13" cy="8" r=".9" fill="currentColor" />
    </>
  ),
  board: (
    <>
      <rect x="2" y="3" width="3.5" height="10" rx=".5" />
      <rect x="6.25" y="3" width="3.5" height="7" rx=".5" />
      <rect x="10.5" y="3" width="3.5" height="5" rx=".5" />
    </>
  ),
  list: (
    <>
      <path d="M5 4h9M5 8h9M5 12h9" />
      <circle cx="2.5" cy="4" r=".7" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r=".7" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r=".7" fill="currentColor" stroke="none" />
    </>
  ),
  flame: (
    <path d="M8 14c2.5 0 4-1.7 4-4 0-2-1.2-3-2-4.5 0-1.5-1-2.5-2-3.5-.4 2-2 2.5-3 4.5C4.3 8 4 9 4 10c0 2.3 1.5 4 4 4z" fill="currentColor" stroke="none" />
  ),
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  files: (
    <>
      <path d="M3 2h6l3 3v9H3z" />
      <path d="M9 2v3h3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.5" rx="5" ry="1.5" />
      <path d="M3 3.5v9c0 .8 2.2 1.5 5 1.5s5-.7 5-1.5v-9" />
      <path d="M3 8c0 .8 2.2 1.5 5 1.5s5-.7 5-1.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  download: <path d="M8 2v8M4 7l4 4 4-4M3 13h10" />,
  upload: <path d="M8 11V3M4 6l4-4 4 4M3 13h10" />,
  edit: <path d="M11 2l3 3-8 8H3v-3z" />,
  check: <path d="M3 8l3.5 3.5L13 5" />,
  drag: (
    <>
      <circle cx="6" cy="3.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="3.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12.5" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  bug: (
    <>
      <ellipse cx="8" cy="9" rx="3.5" ry="4" />
      <path d="M8 5V3M5.5 6L4 4.5M10.5 6L12 4.5M4.5 9H2.5M11.5 9h2M5 12.5L3.5 14M11 12.5l1.5 1.5" />
    </>
  ),
  sparkle: (
    <path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z" fill="currentColor" stroke="none" />
  ),
  wrench: (
    <path d="M10.5 2.5a3 3 0 00-3.5 3.8L2 11.3 4.7 14l5-5a3 3 0 003.8-3.5L11 7.5 8.5 5z" />
  ),
  broom: (
    <>
      <path d="M4 13l1-4 6-6 3 3-6 6z" />
      <path d="M3 14l3-3M5 14l3-3" />
    </>
  ),
  flask: (
    <>
      <path d="M6 2h4M6.5 2v4L3.5 12a1 1 0 00.9 1.5h7.2a1 1 0 00.9-1.5L9.5 6V2" />
      <path d="M4.8 9.5h6.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M6 3v10" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}

export const Icon = memo(function Icon({ name, size = 16, style }: IconProps) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >
      {paths}
    </svg>
  );
});

export const TYPE_ICON: Record<IssueType, IconName> = {
  Bug: "bug",
  Feature: "sparkle",
  Refactor: "wrench",
  Chore: "broom",
  Spike: "flask",
};

export const PRIORITY_META: Record<Priority, { icon: IconName; color: string }> = {
  Critical: { icon: "flame", color: "#f48771" },
  High: { icon: "arrowUp", color: "#e2c08d" },
  Regular: { icon: "arrow", color: "#75beff" },
  Low: { icon: "arrowDown", color: "#888888" },
};

export const STATUS_META: Record<Status, { color: string; label: string }> = {
  Thinking: { color: "#a0a0a0", label: "Thinking" },
  Planned: { color: "#75beff", label: "Planned" },
  Working: { color: "#dcdcaa", label: "Working" },
  Testing: { color: "#c586c0", label: "Testing" },
  Complete: { color: "#89d185", label: "Complete" },
};
