import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { api, type WatchedPage } from "../api";
import { PageHeader, WidePage } from "@/components/PageShell";
import { WorkflowGraph, type FunnelCounts, type InspectorState, type SourceStats } from "../components/WorkflowGraph";
import { WorkflowInspector } from "../components/WorkflowInspector";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
  const negativeKeywordFiltered = useQuery({
    queryKey: ["postings", "workflow", "count", "negativeKeywordFiltered"],
    queryFn: () => api.listPostings({ limit: 1, negativeKeywordFiltered: true }),
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
    negativeKeywordFiltered: negativeKeywordFiltered.data?.total ?? 0,
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
    <WidePage>
      <PageHeader
        title="Workflow"
        description="How postings move through the pipeline — click a step to see exactly what passed, what failed, and why."
      />

      {/* The canvas takes the full width of the page and the inspector rides
          on top of it as a floating panel, so the graph never gives up
          horizontal room to the sidebar. The overlay only starts at `xl`:
          below that, a 380px panel leaves too little canvas beside it and the
          graph fits itself down to an unreadable zoom, so the panel drops
          back to a normal block underneath instead. */}
      <Card className="relative w-full overflow-hidden py-0">
        <WorkflowGraph
          pages={pages}
          settings={settings}
          counts={counts}
          sourceStats={sourceStats}
          selected={selected}
          onSelect={setSelected}
        />

        <aside
          className={cn(
            "flex flex-col gap-3 border-t border-border p-4",
            "xl:absolute xl:top-4 xl:right-4 xl:bottom-4 xl:z-10 xl:w-[380px] xl:overflow-y-auto",
            "xl:rounded-2xl xl:border-0 xl:bg-popover/90 xl:p-5 xl:shadow-2xl xl:ring-1 xl:ring-foreground/10",
            "xl:supports-backdrop-filter:bg-popover/70 xl:supports-backdrop-filter:backdrop-blur-md",
          )}
        >
          {selected.kind !== "overview" && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setSelected({ kind: "overview" })}
            >
              <ArrowLeftIcon />
              Back to overview
            </Button>
          )}
          <WorkflowInspector state={selected} counts={counts} pages={pages} settings={settings} />
        </aside>
      </Card>
    </WidePage>
  );
}
