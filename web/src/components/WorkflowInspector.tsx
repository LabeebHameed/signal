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

function FunnelOverview({ counts }: { counts: FunnelCounts }) {
  return (
    <>
      <div className="card-header">
        <h2>Funnel overview</h2>
      </div>
      <p className="hint">Click any node in the graph to see exactly what happened at that step and why.</p>
      <div className="stat-grid wf-overview-stats">
        <div className="stat-card">
          <span className="stat-value">{counts.total}</span>
          <span className="stat-label">Extracted</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{counts.pending}</span>
          <span className="stat-label">Awaiting screening</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{counts.matched}</span>
          <span className="stat-label">Matched</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{counts.filtered}</span>
          <span className="stat-label">Filtered</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{counts.notified}</span>
          <span className="stat-label">Notified</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{counts.pendingNotify}</span>
          <span className="stat-label">Queued</span>
        </div>
      </div>
    </>
  );
}

function SourcePanel({ pageId, label, pages }: { pageId: string; label: string; pages: WatchedPage[] }) {
  const page = pages.find((p) => p.id === pageId);
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "source", pageId],
    queryFn: () => api.listPostings({ pageId, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
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
      <PostingRoster
        items={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
        emptyLabel="No postings from this source yet."
      />
    </>
  );
}

function ScreenPanel({ counts }: { counts: FunnelCounts }) {
  const [tab, setTab] = useState<"filtered" | "matched" | "all">("filtered");
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "screen", tab],
    queryFn: () =>
      tab === "all"
        ? api.listPostings({ screened: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" })
        : api.listPostings({ status: tab, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  return (
    <>
      <div className="card-header">
        <h2>Screen &amp; Score</h2>
      </div>
      <p className="hint">
        The AI judge's verdict on every screened posting — the exact stored reason (dealbreaker, off-target title,
        or per-dimension fit), never a fresh explanation.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "filtered", label: `Failed (${counts.filtered})` },
          { value: "matched", label: `Passed (${counts.matched})` },
          { value: "all", label: "All" },
        ]}
      />
      <PostingRoster
        items={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
        emptyLabel="Nothing here yet."
        viewAllHref={tab === "all" ? undefined : `/postings?status=${tab}`}
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
        Postings the judge rejected
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
    case "screen":
      return <ScreenPanel counts={counts} />;
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
