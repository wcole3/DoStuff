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
 *  (e.g. an outbound `blocks` surfaces as `blocked-by`). */
export interface InboundLink {
  sourceId: string;
  sourceTitle: string;
  kind: InverseLinkLabel;
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
        });
      }
    }
  }
  return out;
}

/** A node in the graph view: an issue that participates in at least one link
 *  (either as source or target). */
export interface GraphNode {
  id: string;
  number: number;
  title: string;
  status: Issue["status"];
  type: Issue["type"];
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
    });
  }
  // Stable ordering keeps the d3-force layout deterministic across renders.
  nodes.sort((a, b) => a.number - b.number);
  return { nodes, edges };
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
