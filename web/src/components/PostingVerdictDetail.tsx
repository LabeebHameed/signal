import { CompanyPanel } from "./CompanyPanel";
import { PostingActions } from "./PostingActions";
import type { Posting } from "../api";

/** The judge's full reasoning for one posting — the literal stored verdict
 * (dealbreaker / title_mismatch / per-dimension fit), never a fresh
 * explanation. Shared by the Postings table's expanded row and the
 * Workflow page's per-stage roster so "why it passed/failed" always
 * renders identically everywhere it's shown. */
export function PostingVerdictDetail({ posting }: { posting: Posting }) {
  const v = posting.filter_verdict;
  return (
    <div className="verdict-detail">
      {posting.duplicate_of && (
        <p className="hint">Duplicate — a matching posting from another source was already notified.</p>
      )}
      {v && (
        <>
          {v.dealbreaker && <p className="verdict-dealbreaker">⛔ Dealbreaker: {v.dealbreaker}</p>}
          {v.title_mismatch && <p className="verdict-title-mismatch">🚫 Off-target title: {v.title_mismatch}</p>}
          {v.summary && <p>{v.summary}</p>}
          {v.dimensions.length > 0 && (
            <ul className="verdict-dims">
              {v.dimensions.map((d, i) => (
                <li key={`${d.name}-${i}`}>
                  <span className={`dim-fit dim-${d.fit}`}>
                    {d.name}: {d.fit}
                  </span>
                  {d.note && <span className="muted"> — {d.note}</span>}
                </li>
              ))}
            </ul>
          )}
          <CompanyPanel posting={posting} />
        </>
      )}
      <PostingActions posting={posting} />
    </div>
  );
}
