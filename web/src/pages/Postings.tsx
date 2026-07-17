import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, PostingSort } from "../api";
import { StatusPill } from "../components/StatusPill";
import { timeAgo } from "../lib/format";

const PAGE_SIZE = 50;

export default function Postings() {
  const [sort, setSort] = useState<PostingSort>("first_seen_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, error } = useInfiniteQuery({
    queryKey: ["postings", sort, order],
    queryFn: ({ pageParam }) => api.listPostings({ limit: PAGE_SIZE, offset: pageParam, sort, order }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;

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
        {error && <p className="error">{error instanceof Error ? error.message : String(error)}</p>}
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
            {items.length === 0 && !isLoading && (
              <tr>
                <td colSpan={7} className="empty">
                  Nothing extracted yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {hasNextPage && (
          <p className="load-more">
            <button className="secondary" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
              {isFetchingNextPage ? "Loading…" : `Load more (${total - items.length} remaining)`}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
