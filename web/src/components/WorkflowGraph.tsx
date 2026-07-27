import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  useNodesState,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import "@xyflow/react/dist/style.css";
import type { Settings, WatchedPage } from "../api";

/** Matched/filtered counts scoped to one source page, keyed by page id. */
export type SourceStats = Record<string, { matched: number; filtered: number }>;

/** Which node is selected in the graph, and enough context to fetch that
 * node's roster. Shared between the graph (click targets) and the
 * inspector (which panel to render). */
export type InspectorState =
  | { kind: "overview" }
  | { kind: "source"; pageId: string; label: string }
  | { kind: "keywordFilter" }
  | { kind: "judge" }
  | { kind: "company" }
  | { kind: "duplicates" }
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
  /** Matched postings recognized as a repost of an already-notified job
   * from another source — suppressed rather than sent again. */
  duplicates: number;
  companyWarned: number;
  companyPending: number;
  /** Rejected by the deterministic title-keyword gate before the AI judge
   * ever ran — a subset of `filtered`, broken out so the judge node's own
   * stat only reflects what the judge itself rejected. */
  keywordFiltered: number;
  /** Rejected by the seeker's negative-keywords override, ahead of every
   * other gate — a subset of `filtered`, broken out for the same reason as
   * keywordFiltered. */
  negativeKeywordFiltered: number;
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
  copy: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
    </svg>
  ),
  filter: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16l-6.5 8.5v6L10.5 21v-8.5L4 4Z" />
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

function sourceBadgeStat(p: WatchedPage, stats: { matched: number; filtered: number } | undefined): string {
  if (p.last_error) return `⚠ ${p.last_error}`;
  if (!p.first_crawl_done) return "awaiting first crawl";
  const { matched = 0, filtered = 0 } = stats ?? {};
  return `${matched} matched · ${filtered} filtered`;
}

function buildGraph(
  pages: WatchedPage[],
  settings: Settings | undefined,
  counts: FunnelCounts,
  sourceStats: SourceStats,
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
        stat: sourceBadgeStat(p, sourceStats[p.id]),
        icon: "source",
        selected: isSelected(id),
      },
      width: NODE_WIDTH,
    });
    edges.push({
      id: `e-${id}-keywordFilter`,
      source: id,
      sourceHandle: "down",
      target: "keywordFilter",
      type: "pipeline",
    });
  });

  // One node covers all three deterministic checks — title keywords,
  // locations, and the pay floor. They share the keyword_filtered flag
  // backend-side (see poll-pages preFilterVerdict), so they're one stage here
  // too rather than three nodes the seeker has to mentally re-join.
  const profile = settings?.filter_profile;
  const keywordGateActive = Boolean(
    (profile?.title_keywords ?? "").trim() ||
      (profile?.locations_include?.length ?? 0) > 0 ||
      (profile?.locations_exclude?.length ?? 0) > 0 ||
      (profile?.compensation_min ?? 0) > 0,
  );
  nodes.push({
    id: "keywordFilter",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP },
    data: {
      title: "Keyword Filter",
      subtitle: "Deterministic pre-gate",
      badge: "FILTER",
      color: "teal",
      stat: keywordGateActive
        ? `${counts.keywordFiltered} rejected — no LLM spent`
        : "Off — no keywords, locations, or pay floor set",
      icon: "filter",
      disabled: !keywordGateActive,
      selected: isSelected("keywordFilter"),
    },
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
      stat: `${counts.matched} passed · ${
        counts.filtered - counts.keywordFiltered - counts.negativeKeywordFiltered
      } failed${counts.pending > 0 ? ` · ${counts.pending} pending` : ""}`,
      icon: "judge",
      selected: isSelected("judge"),
    },
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "duplicates",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 3 },
    data: {
      title: "Duplicate Checker",
      subtitle: "Cross-source repost check",
      badge: "FILTER",
      color: "teal",
      stat: `${counts.duplicates} suppressed`,
      icon: "copy",
      selected: isSelected("duplicates"),
    },
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "company",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 4 },
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
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "notified",
    type: "pipeline",
    position: { x: spineX, y: ROW_GAP * 5 },
    data: {
      title: "Notify",
      subtitle: "Telegram delivery",
      badge: "ACTION",
      color: "purple",
      stat: `${counts.notified} sent · ${counts.pendingNotify} queued`,
      icon: "bell",
      selected: isSelected("notified"),
    },
    width: NODE_WIDTH,
  });

  nodes.push({
    id: "filtered",
    type: "pipeline",
    position: { x: spineX + NODE_WIDTH + SIDE_GAP, y: ROW_GAP * 3 },
    data: {
      title: "Filtered & Archived",
      subtitle: "Rejected by the keyword gate or the AI judge",
      badge: "OUTPUT",
      color: "gray",
      stat: `${counts.filtered} total`,
      icon: "archive",
      selected: isSelected("filtered"),
    },
    width: NODE_WIDTH,
  });

  edges.push(
    { id: "e-keywordFilter-judge", source: "keywordFilter", sourceHandle: "down", target: "judge", type: "pipeline", data: { label: "pass", tone: "ok" } },
    { id: "e-keywordFilter-filtered", source: "keywordFilter", sourceHandle: "right", target: "filtered", type: "pipeline", data: { label: "no keyword", tone: "skip" } },
    { id: "e-judge-duplicates", source: "judge", sourceHandle: "down", target: "duplicates", type: "pipeline", data: { label: "pass", tone: "ok" } },
    { id: "e-judge-filtered", source: "judge", sourceHandle: "right", target: "filtered", type: "pipeline", data: { label: "fail", tone: "skip" } },
    { id: "e-duplicates-company", source: "duplicates", sourceHandle: "down", target: "company", type: "pipeline", data: { label: "unique", tone: "ok" } },
    { id: "e-duplicates-filtered", source: "duplicates", sourceHandle: "right", target: "filtered", type: "pipeline", data: { label: "duplicate", tone: "skip" } },
    { id: "e-company-notified", source: "company", sourceHandle: "down", target: "notified", type: "pipeline" },
  );

  return { nodes, edges };
}

function ZoomReadout() {
  const { zoom } = useViewport();
  return <div className="wf-zoom-readout">{Math.round(zoom * 100)}%</div>;
}

/** Source pages load asynchronously (react-query), so the node set at
 * mount-time is usually just the fixed pipeline steps — the boolean
 * `fitView` prop only fits once, before source nodes exist, leaving them
 * positioned outside the viewport once they arrive. Re-fitting on every
 * node-set change would also undo a user's manual drag/pan the moment
 * anything refetches, so this only re-fits when the set of node ids
 * actually changes shape (a source added/removed) — not on every data
 * refresh of the same nodes. */
function AutoFitView({ nodeIds }: { nodeIds: string }) {
  const { fitView } = useReactFlow();
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current !== nodeIds) {
      prev.current = nodeIds;
      // Let the new nodes commit to the DOM before measuring their bounds.
      requestAnimationFrame(() => fitView({ duration: 200 }));
    }
  }, [nodeIds, fitView]);
  return null;
}

/**
 * Pannable/zoomable canvas of the processing pipeline — drag empty space to
 * pan, scroll/pinch to zoom, drag a node to reposition it, click a node to
 * inspect it. Node positions are hand-placed by default (the pipeline shape
 * never changes) but every node is user-draggable; a dragged node's
 * position is preserved across data refreshes (counts poll every ~20s) by
 * merging fresh labels/stats onto the existing node state rather than
 * replacing it outright — only genuinely new nodes (e.g. a newly added
 * source) start at their computed layout position.
 */
export function WorkflowGraph({
  pages,
  settings,
  counts,
  sourceStats,
  selected,
  onSelect,
}: {
  pages: WatchedPage[];
  settings: Settings | undefined;
  counts: FunnelCounts;
  sourceStats: SourceStats;
  selected: InspectorState;
  onSelect: (state: InspectorState) => void;
}) {
  const built = useMemo(
    () => buildGraph(pages, settings, counts, sourceStats, selected),
    [pages, settings, counts, sourceStats, selected],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const nodeIds = useMemo(() => built.nodes.map((n) => n.id).sort().join(","), [built]);

  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return built.nodes.map((n) => {
        const existing = byId.get(n.id);
        return existing ? { ...n, position: existing.position } : n;
      });
    });
  }, [built, setNodes]);

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={built.edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        // A two-finger trackpad drag reports as wheel events — panOnScroll
        // treats those as panning (matching the click-drag behavior above);
        // zoomOnScroll off so the same gesture doesn't ALSO zoom. Pinch
        // (ctrl+wheel on trackpads, real pinch on touch) still zooms via
        // zoomOnPinch, matching standard canvas-app conventions.
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("source:")) {
            const pageId = node.id.slice("source:".length);
            const page = pages.find((p) => p.id === pageId);
            onSelect({ kind: "source", pageId, label: page?.label || page?.url || "Source" });
            return;
          }
          switch (node.id) {
            case "keywordFilter":
              return onSelect({ kind: "keywordFilter" });
            case "judge":
              return onSelect({ kind: "judge" });
            case "company":
              return onSelect({ kind: "company" });
            case "duplicates":
              return onSelect({ kind: "duplicates" });
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
        <AutoFitView nodeIds={nodeIds} />
      </ReactFlow>
    </div>
  );
}
