import { CompCurrency, CompPeriod } from "../api";

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

const CURRENCY_SYMBOLS: Record<CompCurrency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
};

/** Drop a trailing ".0" so 120000 reads "120K", not "120.0K". */
function trimUnit(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * A salary as a person would say it out loud: 120000 → "$120K", 1_250_000 →
 * "$1.3M". Rupees use the lakh/crore scale instead (1_200_000 → "₹12L",
 * 25_000_000 → "₹2.5Cr") because that is how Indian pay is actually quoted —
 * "₹1.2M" is a phrase nobody uses.
 */
export function formatCompact(amount: number, currency: CompCurrency): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const n = Math.abs(amount);
  if (currency === "INR") {
    if (n >= 10_000_000) return `${symbol}${trimUnit(amount / 10_000_000)}Cr`;
    if (n >= 100_000) return `${symbol}${trimUnit(amount / 100_000)}L`;
    if (n >= 1_000) return `${symbol}${trimUnit(amount / 1_000)}K`;
    return `${symbol}${amount}`;
  }
  if (n >= 1_000_000) return `${symbol}${trimUnit(amount / 1_000_000)}M`;
  if (n >= 1_000) return `${symbol}${trimUnit(amount / 1_000)}K`;
  return `${symbol}${amount}`;
}

/**
 * The one human-readable rendering of a target pay range — e.g.
 * "$120K – $160K / yr", "From $120K / yr", "Up to €5K / mo". Used for the
 * live preview under the range inputs, the read-only profile card, AND the
 * string handed to the AI judge, so what the seeker sees is exactly what the
 * system screens with. Returns "" when no bound is set.
 */
export function formatCompRange(
  min: number | undefined,
  max: number | undefined,
  currency: CompCurrency,
  period: CompPeriod,
): string {
  const unit = period === "month" ? "/ mo" : "/ yr";
  const hasMin = typeof min === "number" && min > 0;
  const hasMax = typeof max === "number" && max > 0;
  if (hasMin && hasMax) return `${formatCompact(min, currency)} – ${formatCompact(max, currency)} ${unit}`;
  if (hasMin) return `From ${formatCompact(min, currency)} ${unit}`;
  if (hasMax) return `Up to ${formatCompact(max, currency)} ${unit}`;
  return "";
}

/** Keep digits only — what the user typed minus the grouping commas they may
 * have typed themselves. Returns undefined for an empty field so the profile
 * stores an absent bound rather than a meaningless 0. */
export function parseAmount(raw: string): number | undefined {
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return undefined;
  return Number(digits);
}

/** Group an in-progress amount for display: 120000 → "120,000". */
export function groupDigits(amount: number | undefined): string {
  if (amount === undefined) return "";
  return amount.toLocaleString("en-US");
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
