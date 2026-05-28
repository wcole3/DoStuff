// Pure helpers for the ticket-link feature. Kept independent of React + the
// message bridge so they can be unit-tested in isolation and reused by both
// the IssueDetail "Linked by" section and the Graph webview.

import {
  INVERSE_LINK_KIND,
  type InverseLinkLabel,
  type Issue,
  type LinkKind,
  type TicketLink,
} from "../types";

/** One inbound edge from the target's vantage point. The `kind` is inverted
 *  for display (e.g. an outbound `blocks` surfaces as `blocked-by`), while
 *  `storedKind` is the actual forward kind persisted on the source ticket —
 *  needed to remove the link from the right place. */
export interface InboundLink {
  sourceId: string;
  sourceTitle: string;
  kind: InverseLinkLabel;
  storedKind: LinkKind;
}

/**
 * Scan `allIssues` for every outbound link that points at `targetId` and
 * return them as inbound entries with the kind already inverted via
 * `INVERSE_LINK_KIND`. Skips the target itself so a hypothetical self-link
 * (which `coerceLinks` already drops) never appears as inbound.
 */
export function deriveInbound(targetId: string, allIssues: Issue[]): InboundLink[] {
  const out: InboundLink[] = [];
  for (const i of allIssues) {
    if (i.id === targetId) continue;
    for (const l of i.links) {
      if (l.targetId === targetId) {
        out.push({
          sourceId: i.id,
          sourceTitle: i.title,
          kind: INVERSE_LINK_KIND[l.kind],
          storedKind: l.kind,
        });
      }
    }
  }
  return out;
}

/**
 * A relationship as the user picks it from one ticket's perspective. Forward
 * kinds (`blocks`/`child-of`/`relates-to`) store an outbound link on the
 * current ticket; inverse kinds (`blocked-by`/`parent-of`) instead store the
 * matching forward link on the *target* ticket — that's what lets you define
 * "this ticket is blocked by X" without opening X. `relates-to` is symmetric,
 * so it has no separate inverse option.
 */
export type RelLabel = LinkKind | "blocked-by" | "parent-of";

export interface RelationshipOption {
  rel: RelLabel;
  label: string;
  /** When true, the stored link lives on the *target* ticket, not the current one. */
  inverse: boolean;
  /** The forward kind actually persisted in storage. */
  storedKind: LinkKind;
}

export const RELATIONSHIP_OPTIONS: RelationshipOption[] = [
  { rel: "blocks", label: "blocks", inverse: false, storedKind: "blocks" },
  { rel: "blocked-by", label: "blocked by", inverse: true, storedKind: "blocks" },
  { rel: "child-of", label: "child of", inverse: false, storedKind: "child-of" },
  { rel: "parent-of", label: "parent of", inverse: true, storedKind: "child-of" },
  { rel: "relates-to", label: "relates to", inverse: false, storedKind: "relates-to" },
];

export function relationshipOption(rel: RelLabel): RelationshipOption {
  return RELATIONSHIP_OPTIONS.find((o) => o.rel === rel)!;
}

/** A node in the graph view: an issue that participates in at least one link
 *  (either as source or target). */
export interface GraphNode {
  id: string;
  number: number;
  title: string;
  status: Issue["status"];
  type: Issue["type"];
  tags: string[];
}

/** A directed edge: source --(kind)--> target. */
export interface GraphEdge {
  sourceId: string;
  targetId: string;
  kind: LinkKind;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Build the graph model. Nodes = every ticket that appears in *some* link
 * (either as a source with non-empty outbound, or as the target of someone
 * else's outbound). Tickets with no link connection are excluded.
 *
 * Edges are deduplicated by (sourceId, targetId, kind) — `coerceLinks`
 * already enforces this per source, but defending here keeps the graph layer
 * resilient to any future caller that bypasses the coercer.
 */
export function buildGraphModel(allIssues: Issue[]): GraphModel {
  const nodeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  const byId = new Map(allIssues.map((i) => [i.id, i] as const));

  for (const issue of allIssues) {
    for (const link of issue.links) {
      if (!byId.has(link.targetId)) continue; // skip dangling refs
      const key = `${issue.id}|${link.targetId}|${link.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      nodeIds.add(issue.id);
      nodeIds.add(link.targetId);
      edges.push({ sourceId: issue.id, targetId: link.targetId, kind: link.kind });
    }
  }

  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    const i = byId.get(id);
    if (!i) continue;
    nodes.push({
      id: i.id,
      number: i.number,
      title: i.title,
      status: i.status,
      type: i.type,
      tags: i.tags,
    });
  }
  // Stable ordering keeps the d3-force layout deterministic across renders.
  nodes.sort((a, b) => a.number - b.number);
  return { nodes, edges };
}

/**
 * Does a graph node match a free-text filter query? Empty query matches all.
 * Matches `#<number>` / `<number>`, the DS-id (case-insensitive substring),
 * a title substring, or any tag substring — mirroring the sidebar's search.
 */
export function graphNodeMatchesQuery(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (`#${node.number}` === q || `${node.number}` === q) return true;
  if (node.id.toLowerCase().includes(q)) return true;
  if (node.title.toLowerCase().includes(q)) return true;
  if (node.tags.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

/**
 * Given the ids that directly match a filter, return every node id that should
 * stay visible: the matches PLUS every node reachable from a match through the
 * link graph (treated as undirected). This preserves whole chains/clusters so
 * a matched ticket is never shown stripped of its context.
 */
export function visibleGraphNodeIds(
  matchedIds: ReadonlySet<string>,
  edges: ReadonlyArray<{ sourceId: string; targetId: string }>,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const e of edges) {
    link(e.sourceId, e.targetId);
    link(e.targetId, e.sourceId);
  }
  const visible = new Set<string>(matchedIds);
  const stack = [...matchedIds];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!visible.has(next)) {
        visible.add(next);
        stack.push(next);
      }
    }
  }
  return visible;
}

/**
 * Filter `allIssues` against a user-typed query for the LinkEditor typeahead.
 * Matches by:
 *   - exact ticket number (e.g. "42", "#42")
 *   - exact id ("DS-042", case-insensitive)
 *   - case-insensitive title substring
 * Excludes `currentIssueId` and any id present in `alreadyLinkedIds` so the
 * dropdown can't surface invalid picks. The result is sorted by number ASC.
 */
export function searchIssuesForLink(
  query: string,
  allIssues: Issue[],
  currentIssueId: string | undefined,
  alreadyLinkedIds: ReadonlySet<string>,
): Issue[] {
  const trimmed = query.trim();
  const numberMatch = /^#?(\d+)$/.exec(trimmed);
  const idMatch = /^DS-\d+$/i.exec(trimmed);
  const lower = trimmed.toLowerCase();

  const candidates = allIssues.filter((i) => {
    if (currentIssueId && i.id === currentIssueId) return false;
    if (alreadyLinkedIds.has(i.id)) return false;
    if (!trimmed) return true;
    if (numberMatch && i.number === parseInt(numberMatch[1]!, 10)) return true;
    if (idMatch && i.id.toUpperCase() === trimmed.toUpperCase()) return true;
    if (i.title.toLowerCase().includes(lower)) return true;
    return false;
  });

  return [...candidates].sort((a, b) => a.number - b.number);
}

/** Display labels for kinds used across editor + chips. Kept in one place so
 *  changes to the kind taxonomy require updating exactly one map. */
export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  "blocks": "blocks",
  "child-of": "child of",
  "relates-to": "relates to",
};
export const INVERSE_LINK_KIND_LABEL: Record<InverseLinkLabel, string> = {
  "blocked-by": "blocked by",
  "parent-of": "parent of",
  "relates-to": "relates to",
};

/** Sort outbound links for stable rendering: group by kind, then by target number. */
export function sortLinks(links: TicketLink[], byId: Map<string, Issue>): TicketLink[] {
  return [...links].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    const an = byId.get(a.targetId)?.number ?? 0;
    const bn = byId.get(b.targetId)?.number ?? 0;
    return an - bn;
  });
}
