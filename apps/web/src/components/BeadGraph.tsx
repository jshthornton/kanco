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
  onSelectBead?: (id: string) => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 70;

const EDGE_STYLE: Record<BeadDepType, { stroke: string; strokeDasharray?: string }> = {
  blocks: { stroke: "#ef4444" },
  "parent-child": { stroke: "#8b5cf6", strokeDasharray: "6 4" },
  related: { stroke: "#9ca3af" },
  tracks: { stroke: "#3b82f6" },
  "discovered-from": { stroke: "#f59e0b", strokeDasharray: "2 4" },
};

type BeadNodeData = Record<string, unknown> & { bead: BeadSummary };

function BeadNodeCard({ data }: NodeProps<Node<BeadNodeData>>) {
  const b = data.bead as BeadSummary;
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

export function BeadGraph({ spaceId, filter, hiddenEdgeTypes, focusId, onSelectBead }: Props) {
  const rf = useRef<ReactFlowInstance | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ["graph", spaceId, filter?.label, filter?.parent, filter?.q],
    queryFn: () => api.getGraph(spaceId, filter ?? {}),
    refetchInterval: 60_000,
  });

  const laid = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const baseNodes: Node[] = data.nodes.map((b) => ({
      id: b.id,
      type: "bead",
      position: { x: 0, y: 0 },
      data: { bead: b },
    }));
    const visibleEdges = hiddenEdgeTypes
      ? data.edges.filter((e) => !hiddenEdgeTypes.has(e.type))
      : data.edges;
    // Server convention: e.to is the rank-ancestor (parent / blocker / tracked
    // bead), e.from is the dependent. Keep e.to above e.from in dagre.
    const rankPairs = visibleEdges.map((e) => ({ above: e.to, below: e.from }));
    const positions = runDagre(baseNodes, rankPairs);
    const nodes: Node[] = baseNodes.map((n) => ({
      ...n,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
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
      return {
        id: `${e.from}-${e.to}-${e.type}-${i}`,
        source,
        target,
        sourceHandle,
        targetHandle,
        animated: e.type === "blocks",
        style: EDGE_STYLE[e.type] ?? { stroke: "#9ca3af" },
        label: e.type,
        labelStyle: { fontSize: 10, fill: "var(--muted)" },
        labelBgStyle: { fill: "var(--panel)" },
      };
    });
    return { nodes, edges };
  }, [data, hiddenEdgeTypes]);

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
