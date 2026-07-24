import { Posting } from "../api";
import { StatusPill } from "./StatusPill";

/**
 * A posting's delivery state, filter-aware:
 * sent → duplicate (matched but suppressed — another source already sent
 * this job) → queued (waiting on Telegram) → screening (waiting on the
 * judge) → company check (waiting on company research) → filtered (judged,
 * kept but silent) → baseline (pre-dates notifications: filtering was off,
 * or this page's first crawl).
 *
 * Order matters: a cross-source duplicate can happen on any poll, not just
 * the first one, and must be checked before the catch-all "baseline" case —
 * it has notified_at=null and pending_notify=false just like a true
 * baseline row, but filter_status is "matched", not "skipped".
 */
export function PostingStatusPill({ posting }: { posting: Posting }) {
  if (posting.notified_at) return <StatusPill tone="ok">sent</StatusPill>;
  if (posting.duplicate_of) return <StatusPill tone="muted">duplicate</StatusPill>;
  if (posting.pending_notify) return <StatusPill tone="pending">queued</StatusPill>;
  if (posting.filter_status === "pending") return <StatusPill tone="checking">screening</StatusPill>;
  if (posting.company_status === "pending") return <StatusPill tone="checking">company check</StatusPill>;
  if (posting.filter_status === "filtered") return <StatusPill tone="muted">filtered</StatusPill>;
  if (posting.filter_status === "skipped") return <StatusPill tone="muted">baseline</StatusPill>;
  return <StatusPill tone="muted">matched</StatusPill>;
}

/** The judge's verdict on a posting: match/maybe/no fit with its score. */
export function VerdictPill({ posting }: { posting: Posting }) {
  const v = posting.filter_verdict;
  if (v) {
    const tone = v.verdict === "match" ? "ok" : v.verdict === "borderline" ? "pending" : "muted";
    const label = v.verdict === "match" ? "match" : v.verdict === "borderline" ? "maybe" : "no fit";
    return (
      <StatusPill tone={tone} title={v.summary}>
        {label} · {v.score}
      </StatusPill>
    );
  }
  if (posting.filter_status === "pending") return <StatusPill tone="checking">…</StatusPill>;
  return <span className="muted">—</span>;
}
