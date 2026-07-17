import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Posting, Settings, WatchedPage } from "../api";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { timeAgo } from "../lib/format";

export default function Dashboard() {
  const [pages, setPages] = useState<WatchedPage[]>([]);
  const [recent, setRecent] = useState<Posting[]>([]);
  const [totalPostings, setTotalPostings] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.listPages(),
      api.listPostings({ limit: 8, sort: "first_seen_at", order: "desc" }),
      api.getSettings(),
    ])
      .then(([p, posts, s]) => {
        setPages(p);
        setRecent(posts.items);
        setTotalPostings(posts.total);
        setSettings(s);
      })
      .catch((e) => toast.show(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const checkNow = async () => {
    setPolling(true);
    try {
      const summary = await api.poll();
      const results = summary.results as Array<{ newPostings?: number }>;
      const newTotal = results.reduce((n, r) => n + (r.newPostings ?? 0), 0);
      toast.show(`Checked ${summary.pages} source${summary.pages === 1 ? "" : "s"} · ${newTotal} new posting${newTotal === 1 ? "" : "s"}`);
      await load();
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

  const llmConfigured = Boolean(settings?.llm_provider && settings?.llm_model && settings?.has_llm_api_key);
  const telegramConfigured = Boolean(settings?.has_telegram_bot_token && settings?.telegram_chat_id);
  const showSetupBanner = !loading && settings && (!llmConfigured || !telegramConfigured);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="page-subtitle">Last checked {timeAgo(lastChecked)}</p>
        </div>
        <button disabled={polling} onClick={checkNow}>
          {polling ? "Checking…" : "Check now"}
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
        <Link to="/sources" className="stat-card">
          <span className="stat-value">
            {activeCount}
            <span className="stat-of">/{pages.length}</span>
          </span>
          <span className="stat-label">Active sources</span>
          {errorCount > 0 && <span className="stat-flag error">{errorCount} with errors</span>}
        </Link>
        <Link to="/postings" className="stat-card">
          <span className="stat-value">{totalPostings}</span>
          <span className="stat-label">Postings extracted</span>
        </Link>
        <Link to="/sources" className="stat-card">
          <span className="stat-value">{errorCount === 0 ? "✓" : errorCount}</span>
          <span className="stat-label">{errorCount === 0 ? "No source errors" : "Sources need attention"}</span>
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
                {p.notified_at ? (
                  <StatusPill tone="ok">sent</StatusPill>
                ) : p.pending_notify ? (
                  <StatusPill tone="pending">pending</StatusPill>
                ) : (
                  <StatusPill tone="muted">baseline</StatusPill>
                )}
              </div>
            </li>
          ))}
          {!loading && recent.length === 0 && <li className="empty">Nothing extracted yet.</li>}
        </ul>
      </section>
    </div>
  );
}
