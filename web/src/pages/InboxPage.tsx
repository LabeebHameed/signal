import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, profileHasContent } from "../api";
import { PostingVerdictDetail } from "../components/PostingVerdictDetail";
import { StatusPill } from "../components/StatusPill";
import { timeAgo } from "../lib/format";

const PAGE_SIZE = 20;

/**
 * The payoff surface: only the postings that came out of the filter, as
 * cards, each carrying the judge's reasoning and the researched company
 * background. Nothing here is ever hidden by the company layer — a shady
 * company is simply shown as that.
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
  const noProfile = Boolean(settings) && !profileHasContent(settings!.filter_profile);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Inbox</h1>
          <p className="page-subtitle">{total} posting{total === 1 ? "" : "s"} that fit your profile.</p>
        </div>
      </header>

      {noProfile && (
        <p className="hint banner">
          No profile yet, so every new posting is notified as-is. Describe what you're looking for on the{" "}
          <Link to="/profile">Profile page</Link>.
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
                <StatusPill tone={p.filter_verdict.verdict === "match" ? "ok" : "pending"}>
                  {p.filter_verdict.verdict === "match" ? "match" : "maybe"}
                </StatusPill>
              )}
            </header>
            <p className="match-meta muted">
              {[p.companies?.display_name || p.company, p.location, p.compensation, p.posted_text || p.posted_at]
                .filter(Boolean)
                .join(" · ") || "—"}
            </p>
            <PostingVerdictDetail posting={p} />
            <footer className="match-foot muted">
              from {p.watched_pages?.label || p.watched_pages?.url || "—"} · seen {timeAgo(p.first_seen_at)}
              {p.notified_at ? " · sent to Telegram" : ""}
            </footer>
          </article>
        ))}
      </div>

      {items.length === 0 && !isLoading && !noProfile && (
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
