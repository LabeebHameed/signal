import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CompanyPanel } from "../components/CompanyPanel";
import { BlockCompanyButton, PostingActions } from "../components/PostingActions";
import { StatusPill } from "../components/StatusPill";
import { timeAgo } from "../lib/format";

const PAGE_SIZE = 20;

/** The judge's per-dimension breakdown, collapsed by default — the summary
 * line above already gives the headline; this is for when you want to know
 * exactly why. */
function DimensionBreakdown({ dimensions }: { dimensions: Array<{ name: string; fit: string; note: string }> }) {
  const [open, setOpen] = useState(false);
  if (dimensions.length === 0) return null;
  return (
    <div className="dim-expander">
      <button type="button" className="link-toggle" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? " open" : ""}`}>▸</span> {open ? "Hide" : "Show"} reasoning
      </button>
      {open && (
        <ul className="verdict-dims">
          {dimensions.map((d, i) => (
            <li key={`${d.name}-${i}`}>
              <span className={`dim-fit dim-${d.fit}`}>
                {d.name}: {d.fit}
              </span>
              {d.note && <span className="muted"> — {d.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The payoff surface: only the postings that came out of the filter, as
 * cards, each carrying the judge's reasoning and the researched company
 * background, plus the feedback actions (Interested / Not interested /
 * Applied / Block company) that calibrate future screening. Nothing here is
 * ever hidden by the company layer — a shady company is simply shown as that.
 */
export default function InboxPage() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, error } = useInfiniteQuery({
    queryKey: ["postings", "first_seen_at", "desc", "matched"],
    queryFn: ({ pageParam }) =>
      api.listPostings({ limit: PAGE_SIZE, offset: pageParam, sort: "first_seen_at", order: "desc", status: "matched" }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 30_000,
  });

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const filteringOff = settings?.filter_mode === "off";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Inbox</h1>
          <p className="page-subtitle">
            {total} posting{total === 1 ? "" : "s"} that fit your profile, with the company behind each one.
          </p>
        </div>
      </header>

      {filteringOff && (
        <p className="hint banner">
          Filtering is off, so nothing gets matched — every new posting is notified as-is. Turn it on and describe
          what you're looking for on the <Link to="/profile">Profile page</Link>.
        </p>
      )}
      {error && <p className="error">{error instanceof Error ? error.message : String(error)}</p>}

      <div className="match-grid">
        {items.map((p) => (
          <article key={p.id} className="card match-card">
            <header className="match-head">
              <h3>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </h3>
              {p.filter_verdict && (
                <StatusPill
                  tone={p.filter_verdict.verdict === "match" ? "ok" : "pending"}
                  title={p.filter_verdict.summary}
                >
                  {p.filter_verdict.verdict === "match" ? "match" : "maybe"} · {p.filter_verdict.score}
                </StatusPill>
              )}
            </header>
            <p className="match-meta muted">
              {[
                p.companies?.display_name || p.company,
                p.location,
                p.compensation,
                p.posted_text || p.posted_at,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </p>
            {p.filter_verdict?.summary && <p className="match-summary">{p.filter_verdict.summary}</p>}
            {p.filter_verdict && <DimensionBreakdown dimensions={p.filter_verdict.dimensions} />}
            <CompanyPanel posting={p} />
            {p.duplicate_of && (
              <p className="hint">Also seen on another source — already notified from there, so this one stayed quiet.</p>
            )}
            <div className="match-actions">
              <PostingActions posting={p} />
              <BlockCompanyButton posting={p} />
            </div>
            <footer className="match-foot muted">
              from {p.watched_pages?.label || p.watched_pages?.url || "—"} · seen {timeAgo(p.first_seen_at)}
              {p.notified_at ? " · sent to Telegram" : ""}
            </footer>
          </article>
        ))}
      </div>

      {items.length === 0 && !isLoading && !filteringOff && (
        <section className="card">
          <p className="empty">
            No matches yet. They appear here as soon as a new posting fits the profile you described on the{" "}
            <Link to="/profile">Profile page</Link>.
          </p>
        </section>
      )}

      {hasNextPage && (
        <p className="load-more">
          <button className="secondary" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
            {isFetchingNextPage ? "Loading…" : `Load more (${total - items.length} remaining)`}
          </button>
        </p>
      )}
    </div>
  );
}
