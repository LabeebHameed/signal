import { CompanyPanel } from "./CompanyPanel";
import type { Posting } from "../api";

const LINK_SOURCE_LABELS: Record<Posting["link_source"], string> = {
  unknown: "predates link verification",
  platform: "real URL from the source platform (ATS/RSS)",
  cited: "cited by the extraction model from a real link on the page",
  matched: "recovered by matching the title against the page's links",
  none: "no defensible link found",
};

/** The judge's full reasoning for one posting — the literal stored verdict
 * (off-target title, summary), never a fresh explanation. Shared by the
 * Postings table's expanded row, the Inbox cards, and the Workflow page's
 * per-stage roster so "why it passed/failed" always renders identically
 * everywhere it's shown. */
export function PostingVerdictDetail({ posting }: { posting: Posting }) {
  const v = posting.filter_verdict;
  return (
    <div className="verdict-detail">
      {posting.duplicate_of && (
        <p className="hint">Duplicate — a matching posting from another source was already notified.</p>
      )}
      {v && (
        <>
          {v.title_mismatch && <p className="verdict-title-mismatch">🚫 Off-target title: {v.title_mismatch}</p>}
          {v.summary && <p>{v.summary}</p>}
          <CompanyPanel posting={posting} />
        </>
      )}
      {/* Link audit trail — the raw stored URL and how it was obtained/
          verified, regardless of what the View Posting button ends up
          showing (see resolvePostingLink in lib/parsePosting.ts). */}
      <p className="hint">
        Link: {posting.url ? <code>{posting.url}</code> : "none"} ({LINK_SOURCE_LABELS[posting.link_source]}) —{" "}
        {posting.link_verification}
        {posting.link_note && <> — {posting.link_note}</>}
      </p>
    </div>
  );
}
