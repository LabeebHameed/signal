import { useCallback, useEffect, useState } from "react";
import { api, Posting, PostingSort } from "../api";
import { StatusPill } from "../components/StatusPill";
import { timeAgo } from "../lib/format";

const PAGE_SIZE = 50;

export default function Postings() {
  const [items, setItems] = useState<Posting[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<PostingSort>("first_seen_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      setError("");
      try {
        const page = await api.listPostings({ limit: PAGE_SIZE, offset, sort, order });
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setTotal(page.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [sort, order],
  );

  useEffect(() => {
    load(0, false);
  }, [load]);

  const sortBy = (field: PostingSort) => {
    if (sort === field) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(field);
      setOrder(field === "title" || field === "company" ? "asc" : "desc");
    }
  };

  const arrow = (field: PostingSort) => (sort === field ? (order === "desc" ? " ↓" : " ↑") : "");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Postings</h1>
          <p className="page-subtitle">
            {total} extracted{items.length < total ? ` · showing ${items.length}` : ""}
          </p>
        </div>
      </header>

      <section className="card">
        {error && <p className="error">{error}</p>}
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => sortBy("title")}>
                Title{arrow("title")}
              </th>
              <th className="sortable" onClick={() => sortBy("company")}>
                Company{arrow("company")}
              </th>
              <th>Location</th>
              <th>Source</th>
              <th className="sortable" onClick={() => sortBy("posted_at")}>
                Posted{arrow("posted_at")}
              </th>
              <th className="sortable" onClick={() => sortBy("first_seen_at")}>
                Seen{arrow("first_seen_at")}
              </th>
              <th>Notified</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {p.title}
                    </a>
                  ) : (
                    p.title
                  )}
                </td>
                <td>{p.company ?? "—"}</td>
                <td>{p.location ?? "—"}</td>
                <td className="muted">{p.watched_pages?.label || p.watched_pages?.url || "—"}</td>
                <td className="muted">{p.posted_text || p.posted_at || "—"}</td>
                <td className="muted">{timeAgo(p.first_seen_at)}</td>
                <td>
                  {p.notified_at ? (
                    <StatusPill tone="ok">sent</StatusPill>
                  ) : p.pending_notify ? (
                    <StatusPill tone="pending">pending</StatusPill>
                  ) : (
                    <StatusPill tone="muted">baseline</StatusPill>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="empty">
                  Nothing extracted yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {items.length < total && (
          <p className="load-more">
            <button className="secondary" disabled={loading} onClick={() => load(items.length, true)}>
              {loading ? "Loading…" : `Load more (${total - items.length} remaining)`}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
