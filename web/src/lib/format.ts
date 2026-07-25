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
