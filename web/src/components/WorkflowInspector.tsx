import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, Settings, WatchedPage } from "../api";
import { timeAgo } from "../lib/format";
import type { FunnelCounts, InspectorState } from "./WorkflowGraph";
import { PostingRoster } from "./PostingRoster";
import { Button } from "@/components/ui/button";

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
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={o.value === value ? "default" : "outline"}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

const LEGEND: Array<{ color: string; label: string }> = [
  { color: "blue", label: "Source" },
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
      <h2 className="font-heading text-base font-medium">Funnel overview</h2>
      <p className="text-sm text-muted-foreground">Click any node in the canvas to see exactly what happened at that step and why.</p>
      <div className="wf-funnel flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1.5 flex justify-between text-sm">
              <span>{r.label}</span>
              <span className="font-medium tabular-nums">{r.value}</span>
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
      <div className="wf-legend border-t pt-4">
        <div className="mb-2.5 text-xs tracking-wide text-muted-foreground uppercase">Legend</div>
        {LEGEND.map((l) => (
          <div className="mb-2 flex items-center gap-2 text-sm" key={l.label}>
            <span className={`size-2.5 shrink-0 rounded-full wf-legend-dot-${l.color}`} />
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
      <h2 className="font-heading text-base font-medium">{label}</h2>
      {page && (
        <p className="text-sm text-muted-foreground">
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

function JudgePanel({ counts }: { counts: FunnelCounts }) {
  const [tab, setTab] = useState<"failed" | "passed">("failed");
  const judgeFailed = counts.filtered - counts.keywordFiltered - counts.negativeKeywordFiltered;
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "judge", tab],
    queryFn: () =>
      tab === "passed"
        ? api.listPostings({ status: "matched", limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" })
        // keywordFiltered:false / negativeKeywordFiltered:false exclude
        // postings the deterministic gates already rejected before the
        // judge ever ran on them — this roster is the judge's own calls only.
        : api.listPostings({
          status: "filtered",
          keywordFiltered: false,
          negativeKeywordFiltered: false,
          limit: ROSTER_LIMIT,
          sort: "first_seen_at",
          order: "desc",
        }),
  });
  const items = data?.items ?? [];
  const total = tab === "failed" ? judgeFailed : counts.matched;

  return (
    <>
      <h2 className="font-heading text-base font-medium">AI Judge</h2>
      <p className="text-sm text-muted-foreground">
        The LLM's verdict on every posting that passed the keyword filter — the exact stored reason
        (off-target title, or the judge's summary), never a fresh explanation.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "failed", label: `Failed (${judgeFailed})` },
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

function KeywordFilterPanel({ counts, settings }: { counts: FunnelCounts; settings: Settings | undefined }) {
  const profile = settings?.filter_profile;
  const keywords = (profile?.title_keywords ?? "").trim();
  const include = profile?.locations_include ?? [];
  const exclude = profile?.locations_exclude ?? [];
  const payFloor = (profile?.compensation ?? "").trim();
  const hasPayFloor = (profile?.compensation_min ?? 0) > 0;
  const active = keywords !== "" || include.length > 0 || exclude.length > 0 || hasPayFloor;
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "keywordFilter"],
    queryFn: () =>
      api.listPostings({ keywordFiltered: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
    enabled: active,
  });
  return (
    <>
      <h2 className="font-heading text-base font-medium">Keyword Filter</h2>
      {!active ? (
        <p className="text-sm text-muted-foreground">
          This gate is off — the profile declares no title keywords, locations, or pay floor. Set any of them on the
          Profile page to reject postings before they ever reach the AI judge.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Runs before the AI judge, for every source. Everything it rejects is deterministic — no LLM call spent:
          </p>
          <ul className="text-sm text-muted-foreground">
            {keywords !== "" && (
              <li>
                Title contains none of <strong>{keywords}</strong>. This is the hard backstop for cases the judge
                itself has gotten wrong even with full context (e.g. scoring an unrelated "Android Developer"
                posting as a match).
              </li>
            )}
            {exclude.length > 0 && (
              <li>
                Location matches an excluded place — <strong>{exclude.join(", ")}</strong> — even when an included
                one also matches.
              </li>
            )}
            {include.length > 0 && (
              <li>
                Location is stated and isn't one of <strong>{include.join(", ")}</strong>. A posting that states no
                location at all still passes.
              </li>
            )}
            {hasPayFloor && (
              <li>
                Stated pay provably tops out below <strong>{payFloor}</strong>, in the same currency. Postings that
                don't disclose pay — the large majority — always pass.
              </li>
            )}
          </ul>
          <PostingRoster
            items={data?.items ?? []}
            total={counts.keywordFiltered}
            isLoading={isLoading}
            emptyLabel="Nothing rejected by the keyword filter yet."
          />
        </>
      )}
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
      <h2 className="font-heading text-base font-medium">Company Qualify</h2>
      {!companyActive ? (
        <p className="text-sm text-muted-foreground">
          This layer is off. Enable it (and add a Tavily key) in Settings to research matched companies before
          notifying — it never blocks a match, only adds a caution badge.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Never blocks a match — the company layer's caution for each matched posting.</p>
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

function DuplicatesPanel({ counts }: { counts: FunnelCounts }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "duplicates"],
    queryFn: () => api.listPostings({ duplicate: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  return (
    <>
      <h2 className="font-heading text-base font-medium">Duplicate Checker</h2>
      <p className="text-sm text-muted-foreground">
        Right after a posting matches, it's checked against everything already notified from another source in the
        last 14 days — before spending any company research on it. A recognized repost is suppressed here, never
        sent twice.
      </p>
      <PostingRoster
        items={data?.items ?? []}
        total={counts.duplicates}
        isLoading={isLoading}
        emptyLabel="Nothing suppressed as a duplicate yet."
      />
    </>
  );
}

function NotifiedPanel({ counts }: { counts: FunnelCounts }) {
  const [tab, setTab] = useState<"sent" | "queued">("sent");
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "notified", tab],
    queryFn: () =>
      tab === "sent"
        ? api.listPostings({ notified: true, limit: ROSTER_LIMIT, sort: "notified_at", order: "desc" })
        : api.listPostings({ pendingNotify: true, limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  return (
    <>
      <h2 className="font-heading text-base font-medium">Notify</h2>
      <p className="text-sm text-muted-foreground">Sent = actually delivered to Telegram. Queued = matched, cleared, waiting on the next poll run to send.</p>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "sent", label: `Sent (${counts.notified})` },
          { value: "queued", label: `Queued (${counts.pendingNotify})` },
        ]}
      />
      <PostingRoster
        items={data?.items ?? []}
        total={tab === "sent" ? counts.notified : counts.pendingNotify}
        isLoading={isLoading}
        emptyLabel={tab === "sent" ? "Nothing notified yet." : "Nothing queued right now."}
      />
    </>
  );
}

function FilteredPanel({ counts }: { counts: FunnelCounts }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "workflow", "filtered"],
    queryFn: () => api.listPostings({ status: "filtered", limit: ROSTER_LIMIT, sort: "first_seen_at", order: "desc" }),
  });
  return (
    <>
      <h2 className="font-heading text-base font-medium">Filtered &amp; Archived</h2>
      <p className="text-sm text-muted-foreground">Postings rejected by the keyword filter or the AI judge.</p>
      <PostingRoster
        items={data?.items ?? []}
        total={counts.filtered}
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
    case "keywordFilter":
      return <KeywordFilterPanel counts={counts} settings={settings} />;
    case "judge":
      return <JudgePanel counts={counts} />;
    case "company":
      return (
        <CompanyQualifyPanel
          counts={counts}
          companyActive={Boolean(settings?.company_filter_enabled && settings?.has_tavily_api_key)}
        />
      );
    case "duplicates":
      return <DuplicatesPanel counts={counts} />;
    case "notified":
      return <NotifiedPanel counts={counts} />;
    case "filtered":
      return <FilteredPanel counts={counts} />;
  }
}
