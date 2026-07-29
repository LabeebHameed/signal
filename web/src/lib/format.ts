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
 * Whether a source's last_error is the link-reliability advisory rather than
 * a genuine fault — the crawl itself worked, but the extractor couldn't find
 * per-posting links in this page's markup. Renders as the "links unreliable"
 * pill on the Sources page. Matches the message poll-pages writes
 * (LOW_LINK_QUALITY_PREFIX) — keep the two in sync.
 */
const LINK_WARNING_PREFIXES = [
  "Most postings on this crawl have no direct link",
];

export function isLinkQualityWarning(lastError: string | null): boolean {
  return LINK_WARNING_PREFIXES.some((prefix) => lastError?.startsWith(prefix) ?? false);
}
