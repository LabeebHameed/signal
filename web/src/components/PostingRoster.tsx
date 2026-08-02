import { useState } from "react";
import { Link } from "react-router-dom";
import type { Posting } from "../api";
import { PostingStatusPill, VerdictPill } from "./PostingStatus";
import { PostingVerdictDetail } from "./PostingVerdictDetail";
import { Skeleton } from "@/components/ui/skeleton";

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

  if (isLoading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="grid gap-2 rounded-xl p-2.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;

  return (
    <>
      <ul className="grid gap-1">
        {items.map((p) => (
          <li
            key={p.id}
            className="cursor-pointer rounded-xl p-2.5 transition-colors hover:bg-muted/50"
            onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-sm font-medium">{p.title}</span>
              <PostingStatusPill posting={p} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{p.companies?.display_name || p.company || "—"}</span>
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
        <p className="mt-3 text-xs text-muted-foreground">
          {viewAllHref ? (
            <Link to={viewAllHref} className="text-primary underline-offset-4 hover:underline">
              View all {total} in Postings →
            </Link>
          ) : (
            <Link to="/postings" className="text-primary underline-offset-4 hover:underline">
              Showing {items.length} of {total} — view all in Postings →
            </Link>
          )}
        </p>
      )}
    </>
  );
}
