import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Settings, WatchedPage } from "../api";
import { StatusPill } from "./StatusPill";

/** Which node is selected in the graph, and enough context to fetch that
 * node's roster. Shared between the graph (click targets) and the
 * inspector (which panel to render). */
export type InspectorState =
  | { kind: "overview" }
  | { kind: "source"; pageId: string; label: string }
  | { kind: "screen" }
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
}

const MAX_VISIBLE_SOURCES = 8;

function selectedKey(state: InspectorState): string {
  if (state.kind === "overview") return "";
  if (state.kind === "source") return `source:${state.pageId}`;
  return state.kind;
}

/**
 * Static pipeline diagram: Sources → Screen & Score → Company Qualify →
 * Notify / Filtered & Archived. Node positions are plain CSS flex columns;
 * connector lines are a measured SVG overlay (getBoundingClientRect on each
 * node, redrawn on resize) — not a graph-layout algorithm, since the
 * pipeline shape never changes.
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
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paths, setPaths] = useState<Array<{ id: string; d: string }>>([]);

  const activePages = pages.filter((p) => p.active);
  const visibleSources = activePages.slice(0, MAX_VISIBLE_SOURCES);
  const overflowCount = activePages.length - visibleSources.length;
  const sourceIdsKey = visibleSources.map((p) => p.id).join(",");
  const companyActive = Boolean(settings?.company_filter_enabled && settings?.has_tavily_api_key);

  const registerNode = (id: string) => (el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  useLayoutEffect(() => {
    const recompute = () => {
      const container = containerRef.current;
      if (!container) return;
      const cRect = container.getBoundingClientRect();
      const rectOf = (id: string) => nodeRefs.current.get(id)?.getBoundingClientRect();
      const connect = (fromId: string, toId: string): { id: string; d: string } | null => {
        const a = rectOf(fromId);
        const b = rectOf(toId);
        if (!a || !b) return null;
        const x1 = a.right - cRect.left;
        const y1 = a.top + a.height / 2 - cRect.top;
        const x2 = b.left - cRect.left;
        const y2 = b.top + b.height / 2 - cRect.top;
        const mx = (x1 + x2) / 2;
        return { id: `${fromId}->${toId}`, d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` };
      };
      const next: Array<{ id: string; d: string }> = [];
      for (const p of visibleSources) {
        const e = connect(`source:${p.id}`, "screen");
        if (e) next.push(e);
      }
      const screenToCompany = connect("screen", "company");
      if (screenToCompany) next.push(screenToCompany);
      const screenToFiltered = connect("screen", "filtered");
      if (screenToFiltered) next.push(screenToFiltered);
      const companyToNotify = connect("company", "notified");
      if (companyToNotify) next.push(companyToNotify);
      setPaths(next);
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdsKey, overflowCount, companyActive]);

  const isSelected = (id: string) => selectedKey(selected) === id;

  return (
    <div className="wf-graph" ref={containerRef}>
      <svg className="wf-connectors">
        {paths.map((p) => (
          <path key={p.id} d={p.d} />
        ))}
      </svg>

      <div className="wf-col">
        <div className="wf-col-label">Sources</div>
        {visibleSources.map((p) => (
          <div
            key={p.id}
            ref={registerNode(`source:${p.id}`)}
            className={`wf-node${isSelected(`source:${p.id}`) ? " selected" : ""}`}
            onClick={() => onSelect({ kind: "source", pageId: p.id, label: p.label || p.url })}
          >
            <div className="wf-node-title">{p.label || p.url}</div>
            <div className="wf-node-badge">
              {p.last_error ? (
                <StatusPill tone="error" title={p.last_error}>
                  error
                </StatusPill>
              ) : p.first_crawl_done ? (
                <StatusPill tone="ok">ok</StatusPill>
              ) : (
                <StatusPill tone="pending">pending first crawl</StatusPill>
              )}
            </div>
          </div>
        ))}
        {overflowCount > 0 && (
          <Link to="/sources" className="wf-node wf-node-more">
            +{overflowCount} more — see Sources →
          </Link>
        )}
        {activePages.length === 0 && <p className="muted">No active sources.</p>}
      </div>

      <div className="wf-col">
        <div className="wf-col-label">Screen &amp; Score</div>
        <div
          ref={registerNode("screen")}
          className={`wf-node${isSelected("screen") ? " selected" : ""}`}
          onClick={() => onSelect({ kind: "screen" })}
        >
          <div className="wf-node-title">AI judge</div>
          <div className="wf-node-badge muted">
            {counts.matched} passed · {counts.filtered} failed
            {counts.pending > 0 ? ` · ${counts.pending} pending` : ""}
          </div>
        </div>
      </div>

      <div className="wf-col">
        <div className="wf-col-label">Company Qualify</div>
        <div
          ref={registerNode("company")}
          className={`wf-node${isSelected("company") ? " selected" : ""}${companyActive ? "" : " disabled"}`}
          onClick={() => onSelect({ kind: "company" })}
        >
          <div className="wf-node-title">Company research</div>
          <div className="wf-node-badge muted">
            {companyActive ? `${counts.companyWarned} warned · ${counts.companyPending} pending` : "Off — enable in Settings"}
          </div>
        </div>
      </div>

      <div className="wf-col">
        <div className="wf-col-label">Outcome</div>
        <div
          ref={registerNode("notified")}
          className={`wf-node${isSelected("notified") ? " selected" : ""}`}
          onClick={() => onSelect({ kind: "notified" })}
        >
          <div className="wf-node-title">Notify</div>
          <div className="wf-node-badge muted">
            {counts.notified} sent · {counts.pendingNotify} queued
          </div>
        </div>
        <div
          ref={registerNode("filtered")}
          className={`wf-node${isSelected("filtered") ? " selected" : ""}`}
          onClick={() => onSelect({ kind: "filtered" })}
        >
          <div className="wf-node-title">Filtered &amp; Archived</div>
          <div className="wf-node-badge muted">{counts.notSent} total</div>
        </div>
      </div>
    </div>
  );
}
