import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, Settings, WatchedPage } from "../api";
import { timeAgo } from "../lib/format";
import type { FunnelCounts, InspectorState } from "./WorkflowGraph";
import { PostingRoster } from "./PostingRoster";

const ROSTER_LIMIT = 20;

function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="wf-tabs">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? "wf-tab" : "wf-tab secondary"}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const LEGEND: Array<{ color: string; label: string }> = [
  { color: "blue", label: "Source" },
  { color: "amber", label: "Screening" },
  { color: "teal", label: "Agent / Qualify" },
  { color: "purple", label: "Notify" },
  { color: "gray", label: "Output" },
];

function FunnelOverview({ counts }: { counts: FunnelCounts }) {
  const screened = counts.matched + counts.filtered;
  const inPipeline = counts.pending + counts.companyPending + counts.pendingNotify;
  const max = Math.max(counts.total, 1);
  const rows: Array<{ label: string; value: number; color: string }> = [
    { label: "Scanned", value: counts.total, color: "blue" },
    { label: "Screened", value: screened, color: "amber" },
    { label: "Matched", value: counts.matched, color: "teal" },
    { label: "Notified", value: counts.notified, color: "purple" },
    { label: "In pipeline", value: inPipeline, color: "gray" },
  ];
  return (
    <>
      <div className="card-header">
        <h2>Funnel overview</h2>
      </div>
      <p className="hint">Click any node in the canvas to see exactly what happened at that step and why.</p>
      <div className="wf-funnel">
        {rows.map((r) => (
          <div className="wf-funnel-row" key={r.label}>
            <div className="wf-funnel-row-top">
              <span>{r.label}</span>
              <span className="wf-funnel-value">{r.value}</span>
            </div>
            <div className="wf-funnel-bar">
              <div
                className={`wf-funnel-bar-fill wf-funnel-bar-${r.color}`}
                style={{ width: `${Math.min(100, (r.value / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="wf-legend">
        <div className="wf-legend-title">Legend</div>
        {LEGEND.map((l) => (
          <div className="wf-legend-row" key={l.label}>
            <span className={`wf-legend-dot wf-legend-dot-${l.color}`} />
            {l.label}
          </div>
        ))}
      </div>
    </>
  );
}

/** Per-source counts, scoped to one watched page — separate from the
 * page-wide FunnelCounts, which don't break down by source. */
function useSourceCounts(pageId: string) {
  const matched = useQuery({
    queryKey: ["postings", "workflow", "source", pageId, "count", "matched"],
    queryFn: () => api.listPostings({ pageId, limit: 1, status: "matched" }),
  });
  const filtered = useQuery({
    queryKey: ["postings", "workflow", "source", pageId, "count", "filtered"],
    queryFn: () => api.listPostings({ pageId, limit: 1, status: "filtered" }),
  });
  const pending = useQuery({
    queryKey: ["postings", "workflow", "source", pageId, "count", "pending"],
    queryFn: () => api.listPostings({ pageId, limit: 1, status: "pending" }),
  });
  return {
    matched: matched.data?.total ?? 0,
    filtered: filtered.data?.total ?? 0,
    pending: pending.data?.total ?? 0,
  };
}

type SourceTab = "all" | "matched" | "filtered" | "pending";

function SourcePanel({ pageId, label, pages }: { pageId: string; label: string; pages: WatchedPage[] }) {
  const page = pages.find((p) => p.id === pageId);
  const [tab, setTab] = useState<SourceTab>("all");
  const counts = useSourceCounts(pageId);
  // Every fetch here is scoped with pageId, both in the queryKey (so
  // switching sources never shows another source's cached page) and in the
  // request itself (page_id=<this source>) — this node's roster can only
  // ever contain postings that came from this specific watched page.
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "source", pageId, tab],
    queryFn: () =>
      api.listPostings({
        pageId,
        status: tab === "all" ? undefined : tab,
        limit: ROSTER_LIMIT,
        sort: "first_seen_at",
        order: "desc",
      }),
  });
  return (
    <>
      <div className="card-header">
        <h2>{label}</h2>
      </div>
      {page && (
        <p className="hint">
          {page.last_error
            ? `Error: ${page.last_error}`
            : page.first_crawl_done
            ? "Fetching normally"
            : "Awaiting first crawl"}
          {page.fetch_strategy ? ` · strategy: ${page.fetch_strategy}` : ""}
          {page.last_checked_at ? ` · checked ${timeAgo(page.last_checked_at)}` : ""}
        </p>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "all", label: "All" },
          { value: "matched", label: `Matched (${counts.matched})` },
          { value: "filtered", label: `Filtered (${counts.filtered})` },
          { value: "pending", label: `Pending (${counts.pending})` },
        ]}
      />
      <PostingRoster
        items={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
        emptyLabel="No postings from this source yet."
      />
    </>
  );
}

function ScreeningPanel({ counts }: { counts: FunnelCounts }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "screening"],
    queryFn: () => api.listPostings({ status: "filtered", blocked: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  return (
    <>
      <div className="card-header">
        <h2>Screening</h2>
      </div>
      <p className="hint">
        The deterministic blocked-company check — no LLM call, no scoring. A posting rejected here never reaches the
        AI judge.
      </p>
      <PostingRoster
        items={data?.items ?? []}
        total={counts.blocked}
        isLoading={isLoading}
        emptyLabel="Nothing blocked yet."
      />
    </>
  );
}

function JudgePanel({ counts }: { counts: FunnelCounts }) {
  const [tab, setTab] = useState<"failed" | "passed">("failed");
  const failedTotal = Math.max(0, counts.filtered - counts.blocked);
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "judge", tab],
    queryFn: () =>
      tab === "passed"
        ? api.listPostings({ status: "matched", limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" })
        // Fetch extra so filtering out the (rare) blocked-company rows still
        // leaves a full page — screening rejects never reach this node.
        : api.listPostings({ status: "filtered", limit: ROSTER_LIMIT * 2, sort: "first_seen_at", order: "desc" }),
  });
  const items =
    tab === "failed"
      ? (data?.items ?? []).filter((p) => !p.blocked_by_screening).slice(0, ROSTER_LIMIT)
      : data?.items ?? [];
  const total = tab === "failed" ? failedTotal : counts.matched;

  return (
    <>
      <div className="card-header">
        <h2>AI Judge</h2>
      </div>
      <p className="hint">
        The LLM's verdict on every posting that cleared screening — the exact stored reason (dealbreaker, off-target
        title, or per-dimension fit), never a fresh explanation.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "failed", label: `Failed (${failedTotal})` },
          { value: "passed", label: `Passed (${counts.matched})` },
        ]}
      />
      <PostingRoster
        items={items}
        total={total}
        isLoading={isLoading}
        emptyLabel="Nothing here yet."
        viewAllHref={tab === "passed" ? "/postings?status=matched" : "/postings?status=filtered"}
      />
    </>
  );
}

function CompanyQualifyPanel({ counts, companyActive }: { counts: FunnelCounts; companyActive: boolean }) {
  const [tab, setTab] = useState<"warned" | "ok" | "pending">("warned");
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "company", tab],
    queryFn: () => api.listPostings({ companyStatus: tab, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
    enabled: companyActive,
  });
  return (
    <>
      <div className="card-header">
        <h2>Company Qualify</h2>
      </div>
      {!companyActive ? (
        <p className="hint">
          This layer is off. Enable it (and add a Tavily key) in Settings to research matched companies before
          notifying — it never blocks a match, only adds a caution badge.
        </p>
      ) : (
        <>
          <p className="hint">Never blocks a match — the company layer's caution for each matched posting.</p>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "warned", label: `Warned (${counts.companyWarned})` },
              { value: "ok", label: "OK" },
              { value: "pending", label: `Pending (${counts.companyPending})` },
            ]}
          />
          <PostingRoster items={data?.items ?? []} total={data?.total ?? 0} isLoading={isLoading} emptyLabel="Nothing here yet." />
        </>
      )}
    </>
  );
}

function NotifiedPanel({ counts }: { counts: FunnelCounts }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "notified"],
    queryFn: () => api.listPostings({ notified: true, limit: ROSTER_LIMIT, sort: "notified_at", order: "desc" }),
  });
  return (
    <>
      <div className="card-header">
        <h2>Notify</h2>
      </div>
      <p className="hint">
        Every posting actually sent to Telegram
        {counts.pendingNotify > 0 ? ` — ${counts.pendingNotify} more queued for the next run` : ""}.
      </p>
      <PostingRoster items={data?.items ?? []} total={data?.total ?? 0} isLoading={isLoading} emptyLabel="Nothing notified yet." />
    </>
  );
}

function FilteredPanel({ counts }: { counts: FunnelCounts }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "filtered"],
    queryFn: () => api.listPostings({ notSent: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  const duplicateCount = Math.max(0, counts.notSent - counts.filtered);
  return (
    <>
      <div className="card-header">
        <h2>Filtered &amp; Archived</h2>
      </div>
      <p className="hint">
        Postings rejected by screening or the AI judge
        {duplicateCount > 0 ? `, plus ${duplicateCount} repost${duplicateCount === 1 ? "" : "s"} suppressed as a duplicate of an already-notified job` : ""}.
      </p>
      <PostingRoster
        items={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
        emptyLabel="Nothing filtered yet."
        viewAllHref="/postings?status=filtered"
      />
    </>
  );
}

export function WorkflowInspector({
  state,
  counts,
  pages,
  settings,
}: {
  state: InspectorState;
  counts: FunnelCounts;
  pages: WatchedPage[];
  settings: Settings | undefined;
}) {
  switch (state.kind) {
    case "overview":
      return <FunnelOverview counts={counts} />;
    case "source":
      return <SourcePanel pageId={state.pageId} label={state.label} pages={pages} />;
    case "screening":
      return <ScreeningPanel counts={counts} />;
    case "judge":
      return <JudgePanel counts={counts} />;
    case "company":
      return (
        <CompanyQualifyPanel
          counts={counts}
          companyActive={Boolean(settings?.company_filter_enabled && settings?.has_tavily_api_key)}
        />
      );
    case "notified":
      return <NotifiedPanel counts={counts} />;
    case "filtered":
      return <FilteredPanel counts={counts} />;
  }
}
