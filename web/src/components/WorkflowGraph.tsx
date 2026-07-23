import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Settings, WatchedPage } from "../api";

/** Which node is selected in the graph, and enough context to fetch that
 * node's roster. Shared between the graph (click targets) and the
 * inspector (which panel to render). Screening (the deterministic
 * blocked-company check) and the AI judge (the LLM score) are separate
 * stages — a posting rejected by one never reaches, and never appears
 * under, the other. */
export type InspectorState =
  | { kind: "overview" }
  | { kind: "source"; pageId: string; label: string }
  | { kind: "screening" }
  | { kind: "judge" }
  | { kind: "company" }
  | { kind: "notified" }
  | { kind: "filtered" };

/** Aggregate counts driving both the node badges and the overview panel —
 * fetched once in Workflow.tsx and passed down so nothing is fetched twice. */
export interface FunnelCounts {
  total: number;
  pending: number;
  matched: number;
  filtered: number;
  skipped: number;
  notified: number;
  pendingNotify: number;
  notSent: number;
  companyWarned: number;
  companyPending: number;
  /** Filtered specifically by the blocked-company check (a subset of `filtered`). */
  blocked: number;
}

type NodeColor = "blue" | "amber" | "teal" | "purple" | "gray";

interface PipelineNodeData extends Record<string, unknown> {
  title: string;
  subtitle: string;
  badge: string;
  color: NodeColor;
  stat: string;
  icon: string;
  disabled?: boolean;
  selected?: boolean;
}

const ICONS: Record<string, JSX.Element> = {
  source: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.5" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4 6v6c0 4.5 3.2 7.7 8 9 4.8-1.3 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  judge: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4" />
      <path d="M5 10h14l-1.5 9a2 2 0 0 1-2 1.7H8.5a2 2 0 0 1-2-1.7L5 10Z" />
      <path d="M9 6h6l1 4H8l1-4Z" />
    </svg>
  ),
  building: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  archive: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 13h4" />
    </svg>
  ),
};

function PipelineNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  return (
    <div className={`wf-node wf-node-${data.color}${data.selected ? " selected" : ""}${data.disabled ? " disabled" : ""}`}>
      <Handle type="target" position={Position.Top} className="wf-handle" />
      <div className="wf-node-top">
        <span className={`wf-node-icon wf-node-icon-${data.color}`}>{ICONS[data.icon]}</span>
        <div className="wf-node-heading">
          <div className="wf-node-title">{data.title}</div>
          <div className="wf-node-subtitle">{data.subtitle}</div>
        </div>
        <span className={`wf-badge wf-badge-${data.color}`}>{data.badge}</span>
      </div>
      <div className="wf-node-stat">{data.stat}</div>
      <Handle type="source" position={Position.Bottom} id="down" className="wf-handle" />
      <Handle type="source" position={Position.Right} id="right" className="wf-handle" />
    </div>
  );
}

interface PipelineEdgeData extends Record<string, unknown> {
  label?: string;
  tone?: "ok" | "skip";
}

function PipelineEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<Edge<PipelineEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="wf-edge-path" />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`wf-edge-label wf-edge-label-${data.tone ?? "ok"}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { pipeline: PipelineNode };
const edgeTypes = { pipeline: PipelineEdge };

const NODE_WIDTH = 220;
const COL_GAP = 36;
const ROW_GAP = 150;
const SIDE_GAP = 90;

function sourceBadgeStat(p: WatchedPage): string {
  if (p.last_error) return `⚠ ${p.last_error}`;
  if (!p.first_crawl_done) return "awaiting first crawl";
  return "ok";
}

function buildGraph(
  pages: WatchedPage[],
  settings: Settings | undefined,
  counts: FunnelCounts,
  selected: InspectorState,
): { nodes: Node<PipelineNodeData>[]; edges: Edge<PipelineEdgeData>[] } {
  const activePages = pages.filter((p) => p.active);
  const n = Math.max(activePages.length, 1);
  const spineX = ((n - 1) * (NODE_WIDTH + COL_GAP)) / 2;
  const companyActive = Boolean(settings?.company_filter_enabled && settings?.has_tavily_api_key);
  const isSelected = (id: string) =>
    (selected.kind === "source" && id === `source:${selected.pageId}`) || (selected.kind !== "source" && selected.kind !== "overview" && id === selected.kind);

  const nodes: Node<PipelineNodeData>[] = [];
  const edges: Edge<PipelineEdgeData>[] = [];

  activePages.forEach((p, i) => {
    const id = `source:${p.id}`;
    nodes.push({
      id,
      type: "pipeline",
      position: { x: i * (NODE_WIDTH + COL_GAP), y: 0 },
      data: {
        title: p.label || p.url,
        subtitle: "Watched page",
        badge: "SOURCE",
        color: "blue",
        stat: sourceBadgeStat(p),
        icon: "source",
        selected: isSelected(id),
      },
      draggable: false,
      width: NODE_WIDTH,
    });
    edges.push({
      id: `e-${id}-screening`,
      source: id,
      sourceHandle: "down",
      target: "screening",
      type: "pipeline",
    });
  });

  nodes.push({
    id: "screening",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP },
    data: {
      title: "Screening",
      subtitle: "Blocked-company check",
      badge: "FILTER",
      color: "amber",
      stat: `${counts.blocked} blocked`,
      icon: "shield",
      selected: isSelected("screening"),
    },
    draggable: false,
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "judge",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 2 },
    data: {
      title: "AI Judge",
      subtitle: "LLM relevance score",
      badge: "AGENT",
      color: "teal",
      stat: `${counts.matched} passed · ${Math.max(0, counts.filtered - counts.blocked)} failed${counts.pending > 0 ? ` · ${counts.pending} pending` : ""}`,
      icon: "judge",
      selected: isSelected("judge"),
    },
    draggable: false,
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "company",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 3 },
    data: {
      title: "Company Qualify",
      subtitle: "Research & caution",
      badge: "FILTER",
      color: "teal",
      stat: companyActive ? `${counts.companyWarned} warned · ${counts.companyPending} pending` : "Off — enable in Settings",
      icon: "building",
      disabled: !companyActive,
      selected: isSelected("company"),
    },
    draggable: false,
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "notified",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 4 },
    data: {
      title: "Notify",
      subtitle: "Telegram delivery",
      badge: "ACTION",
      color: "purple",
      stat: `${counts.notified} sent · ${counts.pendingNotify} queued`,
      icon: "bell",
      selected: isSelected("notified"),
    },
    draggable: false,
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "filtered",
    type: "pipeline",
    position: { x: spineX + NODE_WIDTH + SIDE_GAP, y: ROW_GAP * 2.5 },
    data: {
      title: "Filtered & Archived",
      subtitle: "Rejected or duplicate",
      badge: "OUTPUT",
      color: "gray",
      stat: `${counts.notSent} total`,
      icon: "archive",
      selected: isSelected("filtered"),
    },
    draggable: false,
    width: NODE_WIDTH,
  });

  edges.push(
    { id: "e-screening-judge", source: "screening", sourceHandle: "down", target: "judge", type: "pipeline", data: { label: "clear", tone: "ok" } },
    { id: "e-screening-filtered", source: "screening", sourceHandle: "right", target: "filtered", type: "pipeline", data: { label: "blocked", tone: "skip" } },
    { id: "e-judge-company", source: "judge", sourceHandle: "down", target: "company", type: "pipeline", data: { label: "pass", tone: "ok" } },
    { id: "e-judge-filtered", source: "judge", sourceHandle: "right", target: "filtered", type: "pipeline", data: { label: "fail", tone: "skip" } },
    { id: "e-company-notified", source: "company", sourceHandle: "down", target: "notified", type: "pipeline" },
  );

  return { nodes, edges };
}

function ZoomReadout() {
  const { zoom } = useViewport();
  return <div className="wf-zoom-readout">{Math.round(zoom * 100)}%</div>;
}

/**
 * Pannable/zoomable canvas of the processing pipeline — drag empty space to
 * pan, scroll/pinch to zoom, click a node to inspect it. Node positions are
 * hand-placed (the pipeline shape never changes), rendered through React
 * Flow so panning/zooming/unlimited node counts all come from the library
 * rather than hand-rolled math.
 */
export function WorkflowGraph({
  pages,
  settings,
  counts,
  selected,
  onSelect,
}: {
  pages: WatchedPage[];
  settings: Settings | undefined;
  counts: FunnelCounts;
  selected: InspectorState;
  onSelect: (state: InspectorState) => void;
}) {
  const { nodes, edges } = buildGraph(pages, settings, counts, selected);

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("source:")) {
            const pageId = node.id.slice("source:".length);
            const page = pages.find((p) => p.id === pageId);
            onSelect({ kind: "source", pageId, label: page?.label || page?.url || "Source" });
            return;
          }
          switch (node.id) {
            case "screening":
              return onSelect({ kind: "screening" });
            case "judge":
              return onSelect({ kind: "judge" });
            case "company":
              return onSelect({ kind: "company" });
            case "notified":
              return onSelect({ kind: "notified" });
            case "filtered":
              return onSelect({ kind: "filtered" });
          }
        }}
      >
        <Background gap={24} size={1} className="wf-canvas-bg" />
        <Controls showInteractive={false} />
        <ZoomReadout />
      </ReactFlow>
    </div>
  );
}
