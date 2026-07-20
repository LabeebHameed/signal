import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PostingStatusPill } from "../components/PostingStatus";
import { useToast } from "../components/Toast";
import { timeAgo, timeUntil } from "../lib/format";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [polling, setPolling] = useState(false);
  const toast = useToast();

  const { data: pages = [], isLoading: pagesLoading } = useQuery({
    queryKey: ["pages"],
    queryFn: api.listPages,
  });
  const { data: recentPage, isLoading: postingsLoading } = useQuery({
    queryKey: ["postings", "recent"],
    queryFn: () => api.listPostings({ limit: 8, sort: "first_seen_at", order: "desc" }),
  });
  // The most recent matches, used both for the "matches today" count and
  // (via .total) how many have ever matched — one query covers both.
  const { data: matchedRecent } = useQuery({
    queryKey: ["postings", "first_seen_at", "desc", "matched", "", "dashboard"],
    queryFn: () => api.listPostings({ limit: 50, sort: "first_seen_at", order: "desc", status: "matched" }),
  });
  // limit: 1 — only the total count is needed, not the rows themselves.
  const { data: pendingQueue } = useQuery({
    queryKey: ["postings", "pending", "count"],
    queryFn: () => api.listPostings({ limit: 1, status: "pending" }),
  });
  const { data: lastNotified } = useQuery({
    queryKey: ["postings", "notified_at", "desc", "", "", "dashboard"],
    queryFn: () => api.listPostings({ limit: 1, sort: "notified_at", order: "desc" }),
  });
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const loading = pagesLoading || postingsLoading || settingsLoading;
  const recent = recentPage?.items ?? [];
  const totalPostings = recentPage?.total ?? 0;

  const checkNow = async () => {
    setPolling(true);
    try {
      const activeCount = pages.filter((p) => p.active).length;
      await api.poll();
      toast.show(
        `Started checking ${activeCount} source${activeCount === 1 ? "" : "s"} — new postings will appear here automatically.`,
      );
      // A background run takes anywhere from a few seconds to a couple
      // minutes depending on page count; a few staggered refetches surface
      // progress sooner than waiting on the normal 20s background interval.
      [5000, 15000, 30000, 60000].forEach((ms) =>
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["pages"] });
          queryClient.invalidateQueries({ queryKey: ["postings"] });
        }, ms)
      );
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setPolling(false);
    }
  };

  const activeCount = pages.filter((p) => p.active).length;
  const errorCount = pages.filter((p) => p.active && p.last_error).length;
  const lastChecked = pages.reduce<string | null>((latest, p) => {
    if (!p.last_checked_at) return latest;
    return !latest || p.last_checked_at > latest ? p.last_checked_at : latest;
  }, null);

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const matchesToday = (matchedRecent?.items ?? []).filter((p) => new Date(p.first_seen_at) >= startOfToday).length;
  const pendingTotal = pendingQueue?.total ?? 0;
  const dueCount = pages.filter((p) => p.active && (!p.next_check_at || new Date(p.next_check_at).getTime() <= now)).length;
  const backingOffCount = pages.filter((p) => p.active && p.failure_count > 0).length;
  const lastNotifiedAt = lastNotified?.items?.[0]?.notified_at ?? null;
  const nextCheckAt = pages
    .filter((p) => p.active && p.next_check_at)
    .map((p) => p.next_check_at as string)
    .sort()[0] ?? null;

  const llmConfigured = Boolean(settings?.llm_provider && settings?.llm_model && settings?.has_llm_api_key);
  const telegramConfigured = Boolean(settings?.has_telegram_bot_token && settings?.telegram_chat_id);
  const showSetupBanner = !loading && settings && (!llmConfigured || !telegramConfigured);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="page-subtitle">
            Last checked {timeAgo(lastChecked)} · next scheduled check {nextCheckAt ? timeUntil(nextCheckAt) : "due now"}
          </p>
        </div>
        <button disabled={polling} onClick={checkNow}>
          {polling ? "Starting…" : "Check now"}
        </button>
      </header>

      {showSetupBanner && (
        <section className="card banner-warning">
          <p>
            {!llmConfigured && "LLM isn't configured yet, so postings can't be extracted. "}
            {!telegramConfigured && "Telegram isn't configured yet, so you won't get notifications. "}
            <Link to="/settings">Finish setup in Settings →</Link>
          </p>
        </section>
      )}

      <section className="stat-grid">
        <Link to="/inbox" className="stat-card">
          <span className="stat-value">{matchesToday}</span>
          <span className="stat-label">Matches today</span>
        </Link>
        <Link to="/postings" className="stat-card">
          <span className="stat-value">{pendingTotal}</span>
          <span className="stat-label">Awaiting screening</span>
        </Link>
        <Link to="/sources" className="stat-card">
          <span className="stat-value">
            {activeCount}
            <span className="stat-of">/{pages.length}</span>
          </span>
          <span className="stat-label">Active sources</span>
          {errorCount > 0 && <span className="stat-flag error">{errorCount} with errors</span>}
        </Link>
        <Link to="/sources" className="stat-card">
          <span className="stat-value">{dueCount}</span>
          <span className="stat-label">Sources due now</span>
        </Link>
        <Link to="/sources" className="stat-card">
          <span className="stat-value">{backingOffCount === 0 ? "✓" : backingOffCount}</span>
          <span className="stat-label">{backingOffCount === 0 ? "No sources backing off" : "Sources backing off"}</span>
          {backingOffCount > 0 && <span className="stat-flag error">repeated failures — checked less often</span>}
        </Link>
        <span className="stat-card">
          <span className="stat-value">{timeAgo(lastNotifiedAt)}</span>
          <span className="stat-label">Last Telegram send</span>
        </span>
        <Link to="/postings" className="stat-card">
          <span className="stat-value">{totalPostings}</span>
          <span className="stat-label">Postings extracted</span>
        </Link>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Recent postings</h2>
          <Link to="/postings" className="link-muted">
            View all →
          </Link>
        </div>
        <ul className="activity-list">
          {recent.map((p) => (
            <li key={p.id}>
              <div className="activity-main">
                <a href={p.url ?? undefined} target="_blank" rel="noreferrer" className="activity-title">
                  {p.title}
                </a>
                <span className="muted">
                  {p.company ?? "—"} · {p.watched_pages?.label || p.watched_pages?.url}
                </span>
              </div>
              <div className="activity-meta">
                <span className="muted">{timeAgo(p.first_seen_at)}</span>
                <PostingStatusPill posting={p} />
              </div>
            </li>
          ))}
          {!loading && recent.length === 0 && <li className="empty">Nothing extracted yet.</li>}
        </ul>
      </section>
    </div>
  );
}
