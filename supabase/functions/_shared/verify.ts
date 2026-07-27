// Live, per-posting link verification: the last line of defense against a
// wrong link ever reaching the user. Everything upstream (fetcher.ts's
// citation markers, llm.ts's link_id schema, links.ts's deterministic
// reconciliation) makes a hallucinated URL structurally hard to produce —
// this module is what actually proves the resolved URL is correct, by
// fetching it and confirming the posting's own title is really there.
//
// classifyVerification is deliberately pure (fixture-testable, no network) —
// verifyPostingLink is the thin network shell around it. The classifier
// draws a hard line between two different kinds of "not verified":
//   - indeterminate: the JOB SITE stonewalled us (a wall, a timeout, a 5xx)
//     — evidence about the site, not about whether the link is right.
//   - mismatch / dead: positive evidence the link itself is wrong (the page
//     exists but isn't this posting, or doesn't exist at all).
// Only the second kind ever triggers the source-listing fallback in the UI
// (see web/src/lib/parsePosting.ts) — an anti-bot wall must never demote a
// real, correctly-cited link to "here's the whole listing page instead".

import type { LinkVerification } from "./types.ts";
import { normText } from "./dedupe.ts";
import { titleAnchorScore } from "./links.ts";
import { blockSignature, BROWSER_HEADERS, fetchWithTimeout, htmlToTextWithLinks } from "./fetcher.ts";

// How much of the posting-page body classifyVerification actually reasons
// over — generous enough to reach real content past a page's head/nav, but
// bounded so a single check can't balloon memory or CPU.
const VERIFY_BODY_CHARS = 300_000;
// A normalized title/anchor agreement at or above this, against ANY of the
// page's title candidates (<title>/og:title/<h1>) or the flattened body
// text, counts as "the posting is really here".
const VERIFY_TITLE_THRESHOLD = 0.6;
// Below this many characters of body text with no title candidate at all,
// the page is almost certainly a client-rendered shell — mirrors fetcher.ts's
// looksLikeShell threshold, same reasoning: ambiguous, so it's treated as
// "couldn't tell", never as proof the link is wrong.
const SHELL_BODY_CHARS = 500;

export interface VerificationOutcome {
  verification: LinkVerification;
  /** Post-redirect URL, only when it actually differs from what was
   * requested — canonicalizes shortener/tracker links for free. */
  finalUrl: string | null;
  /** One user-facing sentence: why this verdict. */
  note: string;
}

function decodeEntitiesLocal(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** <title>, og:title, and the first <h1> — regex only, no parser dependency,
 * consistent with the rest of this codebase's HTML handling. */
export function pageTitleCandidates(html: string): string[] {
  const out: string[] = [];
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) out.push(decodeEntitiesLocal(titleMatch[1]).replace(/\s+/g, " ").trim());

  const ogForward = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
  const ogBackward = html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
  const og = ogForward?.[1] ?? ogBackward?.[1];
  if (og) out.push(decodeEntitiesLocal(og).replace(/\s+/g, " ").trim());

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) out.push(decodeEntitiesLocal(h1Match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());

  return out.filter((c) => c !== "");
}

/** A redirect that landed on the site's homepage, login, or search page is
 * the classic "soft-404": the posting is gone but the site answered 2xx
 * anyway. Checked against the FINAL (post-redirect) URL only. */
function isSoftFailureRedirect(finalUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return false;
  }
  if (u.pathname === "/" || u.pathname === "") return u.search === "";
  return /^\/(login|log-in|signin|sign-in|search)\/?$/i.test(u.pathname);
}

/**
 * The whole classification ladder, pure and network-free so it's directly
 * testable from fixture HTML. `status: null` means a network error or
 * timeout happened before any response arrived.
 */
export function classifyVerification(input: {
  status: number | null;
  body: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
}): VerificationOutcome {
  const finalUrl = input.finalUrl && input.finalUrl !== input.requestedUrl ? input.finalUrl : null;

  if (input.status === null) {
    return { verification: "indeterminate", finalUrl, note: "network error or timeout — not evidence the link is wrong" };
  }
  if (input.status === 404 || input.status === 410) {
    return { verification: "dead", finalUrl, note: `posting page returned HTTP ${input.status}` };
  }
  if (input.status === 401 || input.status === 403 || input.status === 429 || input.status >= 500) {
    return {
      verification: "indeterminate",
      finalUrl,
      note: `site returned HTTP ${input.status} — likely a wall, not evidence the link is wrong`,
    };
  }
  if (input.status < 200 || input.status >= 300) {
    return { verification: "indeterminate", finalUrl, note: `unexpected HTTP ${input.status}` };
  }

  // 2xx from here on — the request succeeded, so every remaining check is
  // about whether the page it returned is really this posting.
  const block = blockSignature(input.body);
  if (block) {
    return {
      verification: "indeterminate",
      finalUrl,
      note: `page matched an anti-bot challenge signature ("${block}") — not evidence the link is wrong`,
    };
  }

  if (isSoftFailureRedirect(input.finalUrl)) {
    return { verification: "mismatch", finalUrl, note: "redirected to the site's homepage/login/search — the posting is gone" };
  }

  const candidates = pageTitleCandidates(input.body);
  const bodyText = htmlToTextWithLinks(input.body, input.requestedUrl).text.slice(0, 20_000);

  if (candidates.length === 0 && bodyText.length < SHELL_BODY_CHARS) {
    return {
      verification: "indeterminate",
      finalUrl,
      note: "page body is a near-empty shell — likely needs JavaScript to render",
    };
  }

  const titleScore = candidates.reduce((max, c) => Math.max(max, titleAnchorScore(input.title, c)), 0);
  const normTitle = normText(input.title);
  const substringMatch = normTitle !== "" &&
    (candidates.some((c) => normText(c).includes(normTitle)) || normText(bodyText).includes(normTitle));

  if (titleScore >= VERIFY_TITLE_THRESHOLD || substringMatch) {
    return { verification: "verified", finalUrl, note: "posting title confirmed on the page" };
  }

  return { verification: "mismatch", finalUrl, note: "fetched fine, but the posting title was not found on the page" };
}

/**
 * One bounded, direct GET — not fetcher.ts's four-strategy proxy chain,
 * which would quadruple per-posting cost for no benefit here (a posting
 * link either resolves directly or it's genuinely wrong/blocked). Always
 * resolves; never throws — a network failure becomes an 'indeterminate'
 * outcome like any other wall.
 */
export async function verifyPostingLink(url: string, title: string, timeoutMs: number): Promise<VerificationOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, BROWSER_HEADERS, timeoutMs);
  } catch (e) {
    return {
      verification: "indeterminate",
      finalUrl: null,
      note: `network error or timeout: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = (await res.text()).slice(0, VERIFY_BODY_CHARS);
  return classifyVerification({
    status: res.status,
    body,
    requestedUrl: url,
    finalUrl: res.url || url,
    title,
  });
}
