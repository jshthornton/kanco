import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { api } from "../api";
import type { BeadDepType, BeadStatus, BeadSummary } from "@kanco/shared";
import { STATUS_COLOR } from "../lib/beads-columns";
import { BeadId } from "./BeadId";

interface Props {
  spaceId: string;
  filter?: { label?: string | string[]; parent?: string; q?: string };
  hiddenEdgeTypes?: ReadonlySet<BeadDepType>;
  focusId?: string;
  selectedId?: string;
  isolateSelection?: boolean;
  /**
   * - `default`: dagre over all visible edges (legacy).
   * - `hierarchy`: dagre TB using only parent-child as rank constraints.
   * - `blockers`: LR layered by blocks-chain depth. Column 0 = ready.
   * - `hybrid`: dagre TB using both parent-child (primary) and blocks
   *    (secondary) as rank constraints — blocker sits above blocked
   *    within its parent group.
   */
  orderMode?: "default" | "hierarchy" | "blockers" | "hybrid";
  onSelectBead?: (id: string) => void;
}

export type GraphOrderMode = "default" | "hierarchy" | "blockers" | "hybrid";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 70;

const EDGE_STYLE: Record<BeadDepType, { stroke: string; strokeDasharray?: string }> = {
  blocks: { stroke: "#ef4444" },
  "parent-child": { stroke: "#8b5cf6", strokeDasharray: "6 4" },
  related: { stroke: "#9ca3af" },
  "relates-to": { stroke: "#9ca3af" },
  tracks: { stroke: "#3b82f6" },
  "discovered-from": { stroke: "#f59e0b", strokeDasharray: "2 4" },
};

type BeadNodeData = Record<string, unknown> & { bead: BeadSummary; ready?: boolean };

function BeadNodeCard({ data }: NodeProps<Node<BeadNodeData>>) {
  const b = data.bead as BeadSummary;
  const ready = !!data.ready;
  const handleStyle = { width: 6, height: 6, background: "transparent", border: "none" };
  return (
    <div
      style={{
        background: "var(--panel-2)",
        border: `2px solid ${STATUS_COLOR[b.status as BeadStatus] ?? "#9ca3af"}`,
        borderRadius: 6,
        padding: 6,
        color: "var(--text)",
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        textAlign: "center",
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      <Handle id="t-tgt" type="target" position={Position.Top} style={handleStyle} />
      <Handle id="t-src" type="source" position={Position.Top} style={handleStyle} />
      <Handle id="b-tgt" type="target" position={Position.Bottom} style={handleStyle} />
      <Handle id="b-src" type="source" position={Position.Bottom} style={handleStyle} />
      <Handle id="l-tgt" type="target" position={Position.Left} style={handleStyle} />
      <Handle id="l-src" type="source" position={Position.Left} style={handleStyle} />
      <Handle id="r-tgt" type="target" position={Position.Right} style={handleStyle} />
      <Handle id="r-src" type="source" position={Position.Right} style={handleStyle} />
      {ready && (
        <span
          title="No open blockers — ready to start"
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            background: "#16a34a",
            color: "white",
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 5px",
            borderRadius: 8,
            letterSpacing: 0.4,
          }}
        >
          READY
        </span>
      )}
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{b.title}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>
        <BeadId id={b.id} />
        {b.labels && b.labels.length > 0 && <span> · {b.labels.join(", ")}</span>}
      </div>
    </div>
  );
}

const NODE_TYPES = { bead: BeadNodeCard };

function pickHandles(
  src: { x: number; y: number },
  tgt: { x: number; y: number },
  type: BeadDepType,
): { sourceHandle: string; targetHandle: string } {
  if (type === "blocks") {
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0
        ? { sourceHandle: "r-src", targetHandle: "l-tgt" }
        : { sourceHandle: "l-src", targetHandle: "r-tgt" };
    }
    return dy >= 0
      ? { sourceHandle: "b-src", targetHandle: "t-tgt" }
      : { sourceHandle: "t-src", targetHandle: "b-tgt" };
  }
  return { sourceHandle: "b-src", targetHandle: "t-tgt" };
}

function runDagre(
  nodes: Node[],
  rankPairs: ReadonlyArray<{ above: string; below: string }>,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const p of rankPairs) g.setEdge(p.above, p.below);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const pos = g.node(n.id);
    out.set(n.id, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 });
  }
  return out;
}

export function BeadGraph({
  spaceId,
  filter,
  hiddenEdgeTypes,
  focusId,
  selectedId,
  isolateSelection,
  orderMode,
  onSelectBead,
}: Props) {
  const rf = useRef<ReactFlowInstance | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ["graph", spaceId, filter?.label, filter?.parent, filter?.q],
    queryFn: () => api.getGraph(spaceId, filter ?? {}),
    refetchInterval: 60_000,
  });

  const laid = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const beadById = new Map<string, BeadSummary>();
    for (const b of data.nodes) beadById.set(b.id, b);

    // Readiness: open bead with no open `blocks` predecessor (i.e. all
    // beads it depends on are closed). Edges are "from depends on to".
    const openBlockerIn = new Map<string, number>();
    for (const e of data.edges) {
      if (e.type !== "blocks") continue;
      const target = beadById.get(e.to);
      if (target && target.status !== "closed") {
        openBlockerIn.set(e.from, (openBlockerIn.get(e.from) ?? 0) + 1);
      }
    }
    const ready = (b: BeadSummary) =>
      b.status !== "closed" && (openBlockerIn.get(b.id) ?? 0) === 0;

    // Order-mode level: longest blocks-chain depth (using only open beads
    // for the rank computation; closed beads collapse to level 0 visually).
    const level = new Map<string, number>();
    if (orderMode === "blockers") {
      const blocksOut = new Map<string, string[]>(); // to -> [from]
      for (const e of data.edges) {
        if (e.type !== "blocks") continue;
        if (!blocksOut.has(e.to)) blocksOut.set(e.to, []);
        blocksOut.get(e.to)!.push(e.from);
      }
      const visit = (id: string, seen: Set<string>): number => {
        if (level.has(id)) return level.get(id)!;
        if (seen.has(id)) return 0;
        seen.add(id);
        const b = beadById.get(id);
        if (!b || b.status === "closed") {
          level.set(id, 0);
          return 0;
        }
        // depth = 1 + max over predecessors (beads that block this bead)
        const predecessors = data.edges
          .filter((e) => e.type === "blocks" && e.from === id)
          .map((e) => e.to)
          .filter((p) => {
            const pb = beadById.get(p);
            return pb && pb.status !== "closed";
          });
        const lv = predecessors.length === 0
          ? 0
          : 1 + Math.max(...predecessors.map((p) => visit(p, seen)));
        level.set(id, lv);
        return lv;
      };
      for (const b of data.nodes) visit(b.id, new Set());
    }

    const baseNodes: Node[] = data.nodes.map((b) => ({
      id: b.id,
      type: "bead",
      position: { x: 0, y: 0 },
      data: { bead: b, ready: ready(b) },
    }));
    const visibleEdges = hiddenEdgeTypes
      ? data.edges.filter((e) => !hiddenEdgeTypes.has(e.type))
      : data.edges;
    const focusNode = isolateSelection ? selectedId : undefined;
    const related = new Set<string>();
    if (focusNode) {
      related.add(focusNode);
      for (const e of visibleEdges) {
        if (e.from === focusNode) related.add(e.to);
        else if (e.to === focusNode) related.add(e.from);
      }
    }
    let positions: Map<string, { x: number; y: number }>;
    if (orderMode === "blockers") {
      // LR layered layout: x = level * step, y stacked within level.
      const colStep = NODE_WIDTH + 120;
      const rowStep = NODE_HEIGHT + 30;
      const buckets = new Map<number, BeadSummary[]>();
      for (const b of data.nodes) {
        const lv = level.get(b.id) ?? 0;
        if (!buckets.has(lv)) buckets.set(lv, []);
        buckets.get(lv)!.push(b);
      }
      for (const list of buckets.values()) {
        list.sort((a, b) => {
          // ready first within each column
          const ar = ready(a) ? 0 : 1;
          const br = ready(b) ? 0 : 1;
          if (ar !== br) return ar - br;
          return a.id.localeCompare(b.id);
        });
      }
      positions = new Map();
      for (const [lv, list] of buckets) {
        list.forEach((b, i) => positions!.set(b.id, { x: lv * colStep, y: i * rowStep }));
      }
    } else {
      // Server convention: e.to is the rank-ancestor (parent / blocker / tracked
      // bead), e.from is the dependent. Keep e.to above e.from in dagre.
      const rankSource =
        orderMode === "hierarchy"
          ? visibleEdges.filter((e) => e.type === "parent-child")
          : orderMode === "hybrid"
            ? visibleEdges.filter((e) => e.type === "parent-child" || e.type === "blocks")
            : visibleEdges;
      const rankPairs = rankSource.map((e) => ({ above: e.to, below: e.from }));
      positions = runDagre(baseNodes, rankPairs);
    }
    const nodes: Node[] = baseNodes.map((n) => ({
      ...n,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      style: focusNode && !related.has(n.id) ? { opacity: 0.15 } : undefined,
    }));
    // For parent-child edges, swap source/target so the line exits the bottom
    // of the parent node and enters the top of the child node under TB layout.
    const edges: Edge[] = visibleEdges.map((e, i) => {
      const isParent = e.type === "parent-child";
      const source = isParent ? e.to : e.from;
      const target = isParent ? e.from : e.to;
      const srcPos = positions.get(source) ?? { x: 0, y: 0 };
      const tgtPos = positions.get(target) ?? { x: 0, y: 0 };
      const { sourceHandle, targetHandle } = pickHandles(srcPos, tgtPos, e.type);
      const touches = focusNode ? e.from === focusNode || e.to === focusNode : true;
      const dim = focusNode && !touches;
      const baseStyle = EDGE_STYLE[e.type] ?? { stroke: "#9ca3af" };
      return {
        id: `${e.from}-${e.to}-${e.type}-${i}`,
        source,
        target,
        sourceHandle,
        targetHandle,
        animated: e.type === "blocks" && !dim,
        style: dim ? { ...baseStyle, opacity: 0.08 } : baseStyle,
        label: e.type,
        labelStyle: { fontSize: 10, fill: "var(--muted)", opacity: dim ? 0.15 : 1 },
        labelBgStyle: { fill: "var(--panel)", opacity: dim ? 0.15 : 1 },
      };
    });
    return { nodes, edges };
  }, [data, hiddenEdgeTypes, selectedId, isolateSelection, orderMode]);

  useEffect(() => {
    if (!focusId || !rf.current) return;
    const node = laid.nodes.find((n) => n.id === focusId);
    if (!node) return;
    rf.current.setCenter(
      node.position.x + NODE_WIDTH / 2,
      node.position.y + NODE_HEIGHT / 2,
      { zoom: 1.2, duration: 400 },
    );
  }, [focusId, laid]);

  if (isLoading) return <p className="muted">Loading graph…</p>;
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return <p className="error">{msg}</p>;
  }
  if (!data || data.nodes.length === 0)
    return <p className="muted">No beads match — try clearing filters.</p>;

  return (
    <div className="bead-graph-wrap">
      <ReactFlow
        nodes={laid.nodes}
        edges={laid.edges}
        nodeTypes={NODE_TYPES}
        fitView={!focusId}
        nodesDraggable
        onInit={(inst) => {
          rf.current = inst;
        }}
        onNodeClick={(_, node) => onSelectBead?.(node.id)}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
