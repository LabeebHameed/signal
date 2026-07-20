import { useQuery } from "@tanstack/react-query";
import { api, UserStatus } from "../api";
import { StatusSelect } from "../components/PostingActions";
import { timeAgo } from "../lib/format";

const COLUMNS: Array<{ status: UserStatus; label: string }> = [
  { status: "interested", label: "Interested" },
  { status: "applied", label: "Applied" },
  { status: "interviewing", label: "Interviewing" },
  { status: "offer", label: "Offer" },
  { status: "rejected", label: "Rejected" },
];

function PipelineColumn({ status, label }: { status: UserStatus; label: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["postings", "user_status_at", "desc", "", status],
    queryFn: () => api.listPostings({ limit: 100, sort: "user_status_at", order: "desc", userStatus: status }),
  });
  const items = data?.items ?? [];
  return (
    <div className="pipeline-column">
      <h2>
        {label} <span className="pipeline-count">{data?.total ?? (isLoading ? "…" : 0)}</span>
      </h2>
      <div className="pipeline-cards">
        {items.map((p) => (
          <article key={p.id} className="card pipeline-card">
            <h3>
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.title}
                </a>
              ) : (
                p.title
              )}
            </h3>
            <p className="muted pipeline-meta">
              {[p.companies?.display_name || p.company, p.location].filter(Boolean).join(" · ") || "—"}
            </p>
            <div className="pipeline-foot">
              <span className="muted">{timeAgo(p.user_status_at)}</span>
              <StatusSelect posting={p} />
            </div>
          </article>
        ))}
        {!isLoading && items.length === 0 && <p className="empty small">Nothing here yet.</p>}
      </div>
    </div>
  );
}

/**
 * Postings the seeker is actively tracking, grouped by where they are in the
 * process — moving a status here (or from the Inbox) is the same write that
 * feeds the judge's calibration examples, so the pipeline and the filter
 * quality improve together.
 */
export default function PipelinePage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Pipeline</h1>
          <p className="page-subtitle">Postings you're tracking, from interested through offer or rejection.</p>
        </div>
      </header>
      <div className="pipeline-board">
        {COLUMNS.map((c) => (
          <PipelineColumn key={c.status} status={c.status} label={c.label} />
        ))}
      </div>
    </div>
  );
}
