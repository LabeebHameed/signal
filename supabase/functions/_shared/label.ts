/**
 * Derive a short site label from a URL's hostname.
 * e.g. "https://dribbble.com/jobs" -> "Dribbble"
 *      "https://jobs.lever.co/plaid" -> "Lever"
 *      "https://job-boards.greenhouse.io/anthropic" -> "Greenhouse"
 */
export function deriveLabel(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return url;
  }
  hostname = hostname.replace(/^www\./i, "");
  const parts = hostname.split(".").filter(Boolean);
  // Second-to-last label is the registrable domain name for the common case
  // (single-label TLDs like .com/.io/.co); falls back to the whole hostname
  // for bare hosts (e.g. "localhost").
  const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? hostname;
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : hostname;
}
