// Interactive ticket-link graph. d3-force computes the layout; rendering is
// hand-rolled SVG. Supports node drag (reheats the sim), background pan, and
// wheel zoom (the "slippy-map" model). Clicking a node posts `revealTicket`.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type Simulation,
} from "d3-force";
import { LINK_KINDS, type LinkKind } from "../types";
import { Icon, TYPE_ICON } from "./Icons";
import { LINK_KIND_COLOR } from "./Links";
import {
  buildGraphModel,
  graphNodeMatchesQuery,
  visibleGraphNodeIds,
  LINK_KIND_LABEL,
  type GraphEdge,
  type GraphNode,
} from "./linkModel";
import { postOpenBoard, postRevealTicket, useIssues } from "./messaging";

// d3-force mutates node objects in place, stamping x/y/vx/vy. We keep our own
// SimNode shape so TS knows about those fields.
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}
interface SimEdge {
  source: SimNode;
  target: SimNode;
  kind: LinkKind;
}

const NODE_R = 22;
const VIEW_W = 1200;
const VIEW_H = 800;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const DRAG_THRESHOLD = 5;

/**
 * Default force-simulation tuning, surfaced as toolbar sliders. Each value maps
 * to one d3-force parameter in the layout effect; "Reset" restores these.
 */
const DEFAULT_FORCES = {
  /** Target link length — d3 `forceLink.distance`. */
  linkDistance: 120,
  /** Node repulsion magnitude — applied as a negative `forceManyBody.strength`. */
  repulsion: 340,
  /** Extra spacing past `NODE_R` — `forceCollide.radius`. */
  collide: 8,
};
type Forces = typeof DEFAULT_FORCES;

export function Graph() {
  const { issues } = useIssues();
  const model = useMemo(() => buildGraphModel(issues), [issues]);

  // Free-text filter. A node "matches" by id/number/title/tags; visibility is
  // then expanded to whole connected components so a matched ticket keeps its
  // chain/context (see visibleGraphNodeIds).
  const [filter, setFilter] = useState("");
  const filterActive = filter.trim().length > 0;
  const matchedIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of model.nodes) if (graphNodeMatchesQuery(n, filter)) s.add(n.id);
    return s;
  }, [model, filter]);

  // Relationship-type toggles — the legend doubles as a row of checkboxes. An
  // edge whose kind is switched off drops out of the graph entirely, and any
  // node left with no surviving edge drops out with it. Defaults to all shown.
  const [shownKinds, setShownKinds] = useState<Set<LinkKind>>(() => new Set(LINK_KINDS));
  const allKindsShown = shownKinds.size === LINK_KINDS.length;
  const toggleKind = (k: LinkKind) =>
    setShownKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Edges surviving the kind toggles. Drives both the node set and the rendered
  // edges, so hiding a kind also hides nodes whose only links were of that kind.
  const activeEdges = useMemo(
    () => model.edges.filter((e) => shownKinds.has(e.kind)),
    [model.edges, shownKinds],
  );

  // Node visibility = (text filter, chain-preserving) ∩ (kind toggles). With no
  // text filter, every node that still has a surviving edge is shown.
  const visibleIds = useMemo(
    () =>
      filterActive
        ? visibleGraphNodeIds(matchedIds, activeEdges)
        : new Set(activeEdges.flatMap((e) => [e.sourceId, e.targetId])),
    [filterActive, matchedIds, activeEdges],
  );

  // Stable signature: only re-run the layout when the set of nodes/edges
  // actually changes, not on every unrelated issue edit (e.g. a title tweak).
  const signature = useMemo(() => {
    const n = model.nodes.map((x) => x.id).sort().join(",");
    const e = model.edges.map((x) => `${x.sourceId}>${x.targetId}:${x.kind}`).sort().join(",");
    return `${n}|${e}`;
  }, [model]);

  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<SimEdge[]>([]);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);

  // Force-tuning sliders (toolbar). `forcesReady` gates the live-tune effect so
  // it skips its first run and doesn't reheat the freshly-settled mount layout.
  const [forces, setForces] = useState<Forces>(DEFAULT_FORCES);
  const [showForces, setShowForces] = useState(false);
  const forcesReady = useRef(false);
  const titleById = useMemo(
    () => new Map(model.nodes.map((n) => [n.id, `#${n.number} — ${n.title}`])),
    [model],
  );

  // Build + run the simulation whenever the graph shape changes.
  useEffect(() => {
    const simNodes: SimNode[] = model.nodes.map((n, i) => ({
      ...n,
      // Seed on a circle so the initial layout is deterministic-ish and the
      // sim doesn't start with everything stacked at (0,0).
      x: VIEW_W / 2 + Math.cos((i / Math.max(1, model.nodes.length)) * Math.PI * 2) * 200,
      y: VIEW_H / 2 + Math.sin((i / Math.max(1, model.nodes.length)) * Math.PI * 2) * 200,
    }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simEdges: SimEdge[] = model.edges
      .map((e) => ({ source: byId.get(e.sourceId)!, target: byId.get(e.targetId)!, kind: e.kind }))
      .filter((e) => e.source && e.target);

    const sim = forceSimulation(simNodes)
      .force("charge", forceManyBody().strength(-forces.repulsion))
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((n) => n.id)
          .distance(forces.linkDistance)
          .strength(0.5),
      )
      .force("center", forceCenter(VIEW_W / 2, VIEW_H / 2))
      .force("collide", forceCollide(NODE_R + forces.collide))
      .stop();

    // Compute the bulk of the layout synchronously so the first paint is
    // settled (no jarring initial animation), then keep a live handle for
    // drag-time reheating.
    sim.tick(280);
    sim.on("tick", () => {
      // Copy positions into React state on each live tick (drag only).
      setNodes([...simNodes]);
    });
    simRef.current = sim;
    setNodes([...simNodes]);
    setEdges(simEdges);

    return () => {
      sim.stop();
      sim.on("tick", null);
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Live-tune the forces without rebuilding the graph: mutate the running sim's
  // force params in place and gently reheat so nodes resettle from their current
  // positions (preserving manual drags) rather than reseeding on the circle.
  // The first run is skipped so the settled mount layout isn't disturbed.
  useEffect(() => {
    if (!forcesReady.current) {
      forcesReady.current = true;
      return;
    }
    const sim = simRef.current;
    if (!sim) return;
    (sim.force("charge") as ForceManyBody<SimNode> | undefined)?.strength(-forces.repulsion);
    (sim.force("link") as ForceLink<SimNode, SimEdge> | undefined)?.distance(forces.linkDistance);
    (sim.force("collide") as ForceCollide<SimNode> | undefined)?.radius(NODE_R + forces.collide);
    sim.alpha(0.6).restart();
  }, [forces]);

  // ── viewport (pan + zoom) ──────────────────────────────────────────────
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement>(null);

  // Map a client (screen-pixel) point to the SVG's viewBox user space. Uses
  // getScreenCTM().inverse() so it correctly accounts for the viewBox scale
  // AND the preserveAspectRatio letterboxing AND any live resize (e.g. when
  // VSCode panels toggle and the webview iframe changes size). Falls back to
  // a rect-based approximation when the CTM is unavailable (happy-dom tests).
  const clientToUser = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM?.();
    // Preferred path: exact mapping via the inverse screen CTM. Wrapped in
    // try/catch because some non-browser DOMs (happy-dom in tests) expose
    // getScreenCTM + DOMPoint but not DOMPoint.matrixTransform.
    if (svg && ctm && typeof DOMPoint !== "undefined") {
      try {
        const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
      } catch {
        /* fall through to rect-based approximation */
      }
    }
    const rect = svg?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_W,
      y: ((clientY - rect.top) / rect.height) * VIEW_H,
    };
  };

  // viewBox-user point → group-local (node) coordinates by un-applying the
  // current translate(tx,ty) scale(s) view transform.
  const userToLocal = (u: { x: number; y: number }, v = view) => ({
    x: (u.x - v.tx) / v.scale,
    y: (u.y - v.ty) / v.scale,
  });

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const u = clientToUser(e.clientX, e.clientY); // fixed point under cursor (user space)
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      // Keep the user-space point under the cursor stationary across the zoom.
      return {
        scale,
        tx: u.x - k * (u.x - v.tx),
        ty: u.y - k * (u.y - v.ty),
      };
    });
  };

  // ── pointer interactions: distinguish node-drag, background-pan, click ──
  const drag = useRef<
    | {
        kind: "node";
        id: string;
        movedBeyondThreshold: boolean;
        startX: number;
        startY: number;
        // Offset (local units) between the node's anchor and the grab point so
        // the node tracks the cursor from where it was grabbed — no jump.
        offX: number;
        offY: number;
      }
    | { kind: "pan"; startUserX: number; startUserY: number; baseTx: number; baseTy: number }
    | null
  >(null);

  const onNodePointerDown = (e: ReactPointerEvent, node: SimNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const local = userToLocal(clientToUser(e.clientX, e.clientY));
    drag.current = {
      kind: "node",
      id: node.id,
      movedBeyondThreshold: false,
      startX: e.clientX,
      startY: e.clientY,
      offX: node.x - local.x,
      offY: node.y - local.y,
    };
    const sim = simRef.current;
    if (sim) {
      node.fx = node.x;
      node.fy = node.y;
      sim.alphaTarget(0.3).restart();
    }
  };

  const onBackgroundPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const u = clientToUser(e.clientX, e.clientY);
    drag.current = {
      kind: "pan",
      startUserX: u.x,
      startUserY: u.y,
      baseTx: view.tx,
      baseTy: view.ty,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      // Pan delta in viewBox-user units (clientToUser uses the svg CTM, which
      // excludes our transform, so the delta is stable during the drag).
      const u = clientToUser(e.clientX, e.clientY);
      setView((v) => ({ ...v, tx: d.baseTx + (u.x - d.startUserX), ty: d.baseTy + (u.y - d.startUserY) }));
      return;
    }
    // node drag
    const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
    if (dist > DRAG_THRESHOLD) d.movedBeyondThreshold = true;
    const sim = simRef.current;
    const node = sim?.nodes().find((n) => n.id === d.id);
    if (node) {
      const local = userToLocal(clientToUser(e.clientX, e.clientY));
      node.fx = local.x + d.offX;
      node.fy = local.y + d.offY;
    }
  };

  const endDrag = () => {
    const d = drag.current;
    const sim = simRef.current;
    if (d?.kind === "node" && sim) {
      const n = sim.nodes().find((x) => x.id === d.id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      sim.alphaTarget(0);
      // A click (no real movement) reveals the ticket.
      if (!d.movedBeyondThreshold) postRevealTicket(d.id);
    }
    drag.current = null;
  };

  // Reset = fit the *visible* nodes into view (centered, padded). When a filter
  // is active this frames just the matched cluster; otherwise it frames the
  // whole graph. Always reframes — even a small drift produces a visible
  // change, so the button has clear feedback.
  const fitView = () => {
    const all = simRef.current?.nodes() ?? nodes;
    const ns = all.filter((n) => visibleIds.has(n.id));
    if (!ns.length) {
      setView({ tx: 0, ty: 0, scale: 1 });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const pad = NODE_R + 48;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(VIEW_W / w, VIEW_H / h)));
    setView({
      tx: (VIEW_W - scale * (minX + maxX)) / 2,
      ty: (VIEW_H - scale * (minY + maxY)) / 2,
      scale,
    });
  };

  // Reframe to the visible subset whenever the filter query changes, so the
  // matched cluster comes into focus without a manual "Fit to view".
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  if (model.nodes.length === 0) {
    return (
      <div className="ds-graph-empty">
        <p>No linked tickets yet.</p>
        <p className="ds-graph-empty-sub">
          Open a ticket and add a link (blocks / child of / relates to) to see it here.
        </p>
        <button className="ds-btn" onClick={postOpenBoard}>Open the board</button>
      </div>
    );
  }

  return (
    <div className="ds-graph-root">
      <div className="ds-graph-toolbar">
        <input
          className="ds-input ds-graph-filter"
          value={filter}
          placeholder="Filter by #id, title, or tag…"
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter graph"
        />
        <span className="ds-graph-count">
          {filterActive || !allKindsShown
            ? `${visibleIds.size} of ${model.nodes.length} shown`
            : `${model.nodes.length} linked ticket${model.nodes.length === 1 ? "" : "s"} · ${model.edges.length} link${model.edges.length === 1 ? "" : "s"}`}
        </span>
        <div className="ds-graph-legend" role="group" aria-label="Toggle relationship types">
          {LINK_KINDS.map((k) => {
            const shown = shownKinds.has(k);
            return (
              <button
                key={k}
                type="button"
                className={`ds-graph-legend-item ds-graph-legend-toggle${shown ? "" : " is-off"}`}
                aria-pressed={shown}
                onClick={() => toggleKind(k)}
                title={`${shown ? "Hide" : "Show"} ${LINK_KIND_LABEL[k]} relationships`}
              >
                {/* A line sample matching the actual edge (solid, or dashed for
                    relates-to) so the legend reads as the edge coloring. */}
                <svg className="ds-graph-legend-line" width="24" height="8" aria-hidden="true">
                  <line
                    x1="1"
                    y1="4"
                    x2="23"
                    y2="4"
                    stroke={LINK_KIND_COLOR[k]}
                    strokeWidth="2"
                    strokeDasharray={k === "relates-to" ? "4 3" : undefined}
                  />
                </svg>
                {LINK_KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
        <button className="ds-btn ds-graph-reset" onClick={fitView}>
          Fit to view
        </button>
        <button
          className="ds-btn"
          aria-pressed={showForces}
          onClick={() => setShowForces((s) => !s)}
        >
          {showForces ? "Hide forces" : "Forces"}
        </button>
      </div>
      {showForces && (
        <div className="ds-graph-forces">
          <label className="ds-graph-force">
            <span>Link distance</span>
            <input
              type="range"
              min={40}
              max={300}
              step={5}
              value={forces.linkDistance}
              onChange={(e) => setForces((f) => ({ ...f, linkDistance: +e.target.value }))}
              aria-label="Link distance"
            />
            <span className="ds-graph-force-val">{forces.linkDistance}</span>
          </label>
          <label className="ds-graph-force">
            <span>Repulsion</span>
            <input
              type="range"
              min={50}
              max={1200}
              step={10}
              value={forces.repulsion}
              onChange={(e) => setForces((f) => ({ ...f, repulsion: +e.target.value }))}
              aria-label="Repulsion"
            />
            <span className="ds-graph-force-val">{forces.repulsion}</span>
          </label>
          <label className="ds-graph-force">
            <span>Spacing</span>
            <input
              type="range"
              min={0}
              max={60}
              step={2}
              value={forces.collide}
              onChange={(e) => setForces((f) => ({ ...f, collide: +e.target.value }))}
              aria-label="Spacing"
            />
            <span className="ds-graph-force-val">{forces.collide}</span>
          </label>
          <button className="ds-btn" onClick={() => setForces(DEFAULT_FORCES)}>
            Reset
          </button>
        </div>
      )}
      <svg
        ref={svgRef}
        className="ds-graph-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag()}
        onPointerLeave={() => endDrag()}
      >
        <defs>
          {(Object.keys(LINK_KIND_COLOR) as LinkKind[]).map((k) => (
            <marker
              key={k}
              id={`arrow-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={LINK_KIND_COLOR[k]} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {edges
            .filter(
              (e) =>
                shownKinds.has(e.kind) &&
                visibleIds.has(e.source.id) &&
                visibleIds.has(e.target.id),
            )
            .map((e, i) => (
              <Edge key={i} edge={e} />
            ))}
          {nodes
            .filter((n) => visibleIds.has(n.id))
            .map((n) => (
              <NodeView
                key={n.id}
                node={n}
                label={titleById.get(n.id) ?? n.id}
                // When filtering, nodes kept only for chain context (not direct
                // matches) render dimmed so matches stand out.
                dimmed={filterActive && !matchedIds.has(n.id)}
                onPointerDown={(ev) => onNodePointerDown(ev, n)}
                onActivate={() => postRevealTicket(n.id)}
              />
            ))}
        </g>
      </svg>
      {visibleIds.size === 0 && (
        <div className="ds-graph-no-match">
          {filterActive
            ? `No linked tickets match “${filter.trim()}”.`
            : "No relationships of the selected type are shown."}
        </div>
      )}
    </div>
  );
}

function Edge({ edge }: { edge: SimEdge }) {
  const { source, target, kind } = edge;
  // Shorten the line so the arrowhead lands at the node rim, not the center.
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = source.x + ux * NODE_R;
  const y1 = source.y + uy * NODE_R;
  const x2 = target.x - ux * (NODE_R + 6);
  const y2 = target.y - uy * (NODE_R + 6);
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={LINK_KIND_COLOR[kind]}
      strokeWidth={1.6}
      strokeDasharray={kind === "relates-to" ? "4 3" : undefined}
      markerEnd={`url(#arrow-${kind})`}
      opacity={0.85}
    />
  );
}

interface NodeViewProps {
  node: SimNode;
  label: string;
  dimmed?: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onActivate: () => void;
}

function NodeView({ node, label, dimmed, onPointerDown, onActivate }: NodeViewProps) {
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      className={`ds-graph-node${dimmed ? " is-dimmed" : ""}`}
      data-node={node.id}
      data-dimmed={dimmed ? "true" : undefined}
      tabIndex={0}
      role="button"
      aria-label={label}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <circle r={NODE_R} className="ds-graph-node-circle" />
      <g transform="translate(-7 -19)" className="ds-graph-node-icon">
        <Icon name={TYPE_ICON[node.type]} size={14} />
      </g>
      <text className="ds-graph-node-num" textAnchor="middle" dy="4">
        #{node.number}
      </text>
      <text className="ds-graph-node-title" textAnchor="middle" dy={NODE_R + 14}>
        {node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title}
      </text>
    </g>
  );
}
