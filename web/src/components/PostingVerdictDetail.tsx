import { CompanyPanel } from "./CompanyPanel";
import type { Posting } from "../api";

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
    </div>
  );
}
