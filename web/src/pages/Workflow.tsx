import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type WatchedPage } from "../api";
import { WorkflowGraph, type FunnelCounts, type InspectorState, type SourceStats } from "../components/WorkflowGraph";
import { WorkflowInspector } from "../components/WorkflowInspector";

/** limit:1 — only .total is read, same count-only query pattern Dashboard.tsx
 * uses. Kept as separate small queries (not one combined endpoint) so each
 * bucket independently benefits from react-query's cache/refetch/invalidate
 * behavior when a posting's status changes elsewhere in the app. */
function useFunnelCounts(): FunnelCounts {
  const total = useQuery({
    queryKey: ["postings", "workflow", "count", "all"],
    queryFn: () => api.listPostings({ limit: 1 }),
  });
  const pending = useQuery({
    queryKey: ["postings", "workflow", "count", "pending"],
    queryFn: () => api.listPostings({ limit: 1, status: "pending" }),
  });
  const matched = useQuery({
    queryKey: ["postings", "workflow", "count", "matched"],
    queryFn: () => api.listPostings({ limit: 1, status: "matched" }),
  });
  const filtered = useQuery({
    queryKey: ["postings", "workflow", "count", "filtered"],
    queryFn: () => api.listPostings({ limit: 1, status: "filtered" }),
  });
  const skipped = useQuery({
    queryKey: ["postings", "workflow", "count", "skipped"],
    queryFn: () => api.listPostings({ limit: 1, status: "skipped" }),
  });
  const notified = useQuery({
    queryKey: ["postings", "workflow", "count", "notified"],
    queryFn: () => api.listPostings({ limit: 1, notified: true }),
  });
  const pendingNotify = useQuery({
    queryKey: ["postings", "workflow", "count", "pendingNotify"],
    queryFn: () => api.listPostings({ limit: 1, pendingNotify: true }),
  });
  const duplicates = useQuery({
    queryKey: ["postings", "workflow", "count", "duplicates"],
    queryFn: () => api.listPostings({ limit: 1, duplicate: true }),
  });
  const companyWarned = useQuery({
    queryKey: ["postings", "workflow", "count", "companyWarned"],
    queryFn: () => api.listPostings({ limit: 1, companyStatus: "warned" }),
  });
  const companyPending = useQuery({
    queryKey: ["postings", "workflow", "count", "companyPending"],
    queryFn: () => api.listPostings({ limit: 1, companyStatus: "pending" }),
  });
  const keywordFiltered = useQuery({
    queryKey: ["postings", "workflow", "count", "keywordFiltered"],
    queryFn: () => api.listPostings({ limit: 1, keywordFiltered: true }),
  });

  return {
    total: total.data?.total ?? 0,
    pending: pending.data?.total ?? 0,
    matched: matched.data?.total ?? 0,
    filtered: filtered.data?.total ?? 0,
    skipped: skipped.data?.total ?? 0,
    notified: notified.data?.total ?? 0,
    pendingNotify: pendingNotify.data?.total ?? 0,
    duplicates: duplicates.data?.total ?? 0,
    companyWarned: companyWarned.data?.total ?? 0,
    companyPending: companyPending.data?.total ?? 0,
    keywordFiltered: keywordFiltered.data?.total ?? 0,
  };
}

/** Matched/filtered counts scoped to each active source page, for the
 * graph's per-source node badges. Same queryKey shape as SourcePanel's own
 * per-source counts (WorkflowInspector.tsx), so selecting a source the graph
 * already aggregated hits a warm cache instead of refetching. */
function useSourceStats(pages: WatchedPage[]): SourceStats {
  const activePages = pages.filter((p) => p.active);
  const matchedQueries = useQueries({
    queries: activePages.map((p) => ({
      queryKey: ["postings", "workflow", "source", p.id, "count", "matched"],
      queryFn: () => api.listPostings({ pageId: p.id, limit: 1, status: "matched" as const }),
    })),
  });
  const filteredQueries = useQueries({
    queries: activePages.map((p) => ({
      queryKey: ["postings", "workflow", "source", p.id, "count", "filtered"],
      queryFn: () => api.listPostings({ pageId: p.id, limit: 1, status: "filtered" as const }),
    })),
  });
  const stats: SourceStats = {};
  activePages.forEach((p, i) => {
    stats[p.id] = {
      matched: matchedQueries[i]?.data?.total ?? 0,
      filtered: filteredQueries[i]?.data?.total ?? 0,
    };
  });
  return stats;
}

export default function Workflow() {
  const [selected, setSelected] = useState<InspectorState>({ kind: "overview" });
  const { data: pages = [] } = useQuery({ queryKey: ["pages"], queryFn: api.listPages });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const counts = useFunnelCounts();
  const sourceStats = useSourceStats(pages);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workflow</h1>
          <p className="page-subtitle">
            How postings move through the pipeline — click a step to see exactly what passed, what failed, and why.
          </p>
        </div>
      </header>

      <div className="workflow-split">
        <section className="card wf-canvas-card">
          <WorkflowGraph
            pages={pages}
            settings={settings}
            counts={counts}
            sourceStats={sourceStats}
            selected={selected}
            onSelect={setSelected}
          />
        </section>
        <aside className="card wf-sidebar">
          {selected.kind !== "overview" && (
            <button className="secondary wf-back" onClick={() => setSelected({ kind: "overview" })}>
              ← Back to overview
            </button>
          )}
          <WorkflowInspector state={selected} counts={counts} pages={pages} settings={settings} />
        </aside>
      </div>
    </div>
  );
}
