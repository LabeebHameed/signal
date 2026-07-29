import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, FilterStatus, PostingSort } from "../api";
import { CompanyBadge } from "../components/CompanyPanel";
import { PostingVerdictDetail } from "../components/PostingVerdictDetail";
import { PostingStatusPill, VerdictPill } from "../components/PostingStatus";
import { StatusPill } from "../components/StatusPill";
import { timeAgo } from "../lib/format";
import { resolvePostingLink } from "../lib/parsePosting";

const PAGE_SIZE = 50;

const STATUS_OPTIONS: Array<{ value: FilterStatus | ""; label: string }> = [
  { value: "", label: "All postings" },
  { value: "matched", label: "Matched" },
  { value: "filtered", label: "Filtered out" },
  { value: "pending", label: "Awaiting screening" },
  { value: "skipped", label: "Not screened" },
];

const VALID_STATUSES: ReadonlyArray<FilterStatus> = ["pending", "matched", "filtered", "skipped"];

export default function Postings() {
  const [searchParams] = useSearchParams();
  const [sort, setSort] = useState<PostingSort>("first_seen_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  // Seeds from ?status= (e.g. a "View all in Postings" link from the
  // Workflow page) once on mount — status itself still lives in local
  // state afterward, same as the rest of this page's filters.
  const [status, setStatus] = useState<FilterStatus | "">(() => {
    const fromUrl = searchParams.get("status");
    return VALID_STATUSES.includes(fromUrl as FilterStatus) ? (fromUrl as FilterStatus) : "";
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, error } = useInfiniteQuery({
    queryKey: ["postings", sort, order, status],
    queryFn: ({ pageParam }) => api.listPostings({ limit: PAGE_SIZE, offset: pageParam, sort, order, status }),
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
            {total} {status === "" ? "extracted" : STATUS_OPTIONS.find((o) => o.value === status)?.label.toLowerCase()}
            {items.length < total ? ` · showing ${items.length}` : ""} · click a row for the judge's reasoning
          </p>
        </div>
        <div className="postings-filters">
          <select value={status} onChange={(e) => setStatus(e.target.value as FilterStatus | "")}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
              <th className="sortable" onClick={() => sortBy("first_seen_at")}>
                Seen{arrow("first_seen_at")}
              </th>
              <th>Match</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const link = resolvePostingLink(p);
              return (
              <Fragment key={p.id}>
                <tr className="expandable" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                  <td>
                    {link.isDirect && link.href ? (
                      <a href={link.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {p.title}
                      </a>
                    ) : (
                      p.title
                    )}
                    {p.duplicate_of && (
                      <StatusPill tone="muted" title="A matching posting from another source was already notified">
                        dup
                      </StatusPill>
                    )}
                  </td>
                  <td>
                    {p.companies?.display_name || p.company || "—"} <CompanyBadge posting={p} />
                  </td>
                  <td>{p.location ?? "—"}</td>
                  <td className="muted">{timeAgo(p.first_seen_at)}</td>
                  <td>
                    <VerdictPill posting={p} />
                  </td>
                  <td>
                    <PostingStatusPill posting={p} />
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr className="verdict-row">
                    <td colSpan={6}>
                      <PostingVerdictDetail posting={p} />
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
            {items.length === 0 && !isLoading && (
              <tr>
                <td colSpan={6} className="empty">
                  {status === "" ? "Nothing extracted yet." : "No postings match these filters."}
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
