import { useState } from "react";
import { Link } from "react-router-dom";
import type { Posting } from "../api";
import { PostingStatusPill, VerdictPill } from "./PostingStatus";
import { PostingVerdictDetail } from "./PostingVerdictDetail";

/**
 * Compact, sidebar-width list of postings for the Workflow page's per-stage
 * inspector. Click a row to expand the exact stored reason in place (reuses
 * PostingVerdictDetail — same "why" panel as the Postings page).
 */
export function PostingRoster({
  items,
  total,
  isLoading,
  emptyLabel,
  viewAllHref,
}: {
  items: Posting[];
  total: number;
  isLoading?: boolean;
  emptyLabel: string;
  viewAllHref?: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="empty">{emptyLabel}</p>;

  return (
    <>
      <ul className="wf-roster">
        {items.map((p) => (
          <li key={p.id} className="wf-roster-row" onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}>
            <div className="wf-roster-row-main">
              <span className="wf-roster-row-title">{p.title}</span>
              <PostingStatusPill posting={p} />
            </div>
            <div className="wf-roster-row-sub">
              <span>{p.companies?.display_name || p.company || "—"}</span>
              <VerdictPill posting={p} />
            </div>
            {expandedId === p.id && (
              <div onClick={(e) => e.stopPropagation()}>
                <PostingVerdictDetail posting={p} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="hint">
          {viewAllHref ? (
            <Link to={viewAllHref}>View all {total} in Postings →</Link>
          ) : (
            <Link to="/postings">Showing {items.length} of {total} — view all in Postings →</Link>
          )}
        </p>
      )}
    </>
  );
}
