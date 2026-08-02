import { BanIcon, CopyIcon, LinkIcon, ScaleIcon } from "lucide-react";

import { CompanyPanel } from "./CompanyPanel";
import type { Posting } from "../api";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";

const LINK_SOURCE_LABELS: Record<Posting["link_source"], string> = {
  unknown: "predates link provenance",
  platform: "real URL from the source platform (ATS/RSS)",
  card: "read off the page card showing this posting's title",
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
    <div className="flex flex-col gap-3 py-1">
      {posting.duplicate_of && (
        <Marker>
          <MarkerIcon>
            <CopyIcon />
          </MarkerIcon>
          <MarkerContent>
            Duplicate — a matching posting from another source was already notified.
          </MarkerContent>
        </Marker>
      )}

      {v?.title_mismatch && (
        <Marker>
          <MarkerIcon>
            <BanIcon className="text-destructive" />
          </MarkerIcon>
          <MarkerContent className="text-destructive">
            Off-target title: {v.title_mismatch}
          </MarkerContent>
        </Marker>
      )}

      {v?.summary && (
        <Marker>
          <MarkerIcon>
            <ScaleIcon />
          </MarkerIcon>
          <MarkerContent className="text-foreground">{v.summary}</MarkerContent>
        </Marker>
      )}

      {v && <CompanyPanel posting={posting} />}

      <Marker variant="separator">
        <MarkerContent>Link audit</MarkerContent>
      </Marker>

      {/* Link audit trail — the raw stored URL and how it was obtained,
          regardless of what the View Posting button ends up showing
          (see resolvePostingLink in lib/parsePosting.ts). */}
      <Marker>
        <MarkerIcon>
          <LinkIcon />
        </MarkerIcon>
        <MarkerContent>
          {posting.url ? (
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{posting.url}</code>
          ) : (
            "none"
          )}{" "}
          ({LINK_SOURCE_LABELS[posting.link_source]})
          {posting.link_note && <> — {posting.link_note}</>}
        </MarkerContent>
      </Marker>
    </div>
  );
}
