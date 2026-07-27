export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Whether a source's last_error is the "this site refuses automated access"
 * state rather than a genuine fault. It's a settled condition with nothing
 * to retry, so the UI marks it distinctly instead of as a red error.
 * Matches the message poll-pages writes (BLOCKED_SOURCE_MESSAGE) — keep the
 * two in sync.
 */
export function isBlockedSourceError(lastError: string | null): boolean {
  return lastError?.startsWith("Site blocks automated access") ?? false;
}

/**
 * Whether a source's last_error is one of the two link-reliability
 * advisories rather than a genuine fault — the crawl itself worked, but
 * either the extractor can't find per-posting links on this page's markup
 * (LOW_LINK_QUALITY_PREFIX, missing links) or the links it does find keep
 * failing live verification (LOW_LINK_TRUST_PREFIX, wrong links). Both
 * render as the same "links unreliable" pill on the Sources page — the
 * distinction only matters for the tooltip text, not the pill itself.
 * Matches the messages poll-pages writes — keep the two in sync.
 */
const LINK_WARNING_PREFIXES = [
  "Most postings on this crawl have no direct link",
  "Many verified links on this source turned out wrong",
];

export function isLinkQualityWarning(lastError: string | null): boolean {
  return LINK_WARNING_PREFIXES.some((prefix) => lastError?.startsWith(prefix) ?? false);
}
