import type { Posting } from "../api";
import { timeAgo } from "./format";

export interface ParsedJobDetails {
  cleanTitle: string;
  tags: string[];
  companyName: string;
  sourceSiteName: string;
  websiteDomain: string | null;
  postingUrl: string | null;
  locationText: string;
  compensationText: string;
  timeText: string;
}

const AGGREGATOR_DOMAINS = new Set([
  "contra.com",
  "dribbble.com",
  "linkedin.com",
  "weworkremotely.com",
  "cryptocurrencyjobs.co",
  "wellfound.com",
  "angel.co",
  "indeed.com",
  "ycombinator.com",
  "remoteok.com",
  "dailyremote.com",
  "himalayas.app",
  "nodesk.co",
  "flexjobs.com",
  "workingnomads.com",
  "startup.jobs",
]);

/**
 * Cleans company names, preventing raw URLs (e.g. "https://startup.jobs/company/odin-company")
 * from being rendered as company names.
 */
export function cleanCompanyName(rawCompany: string | null | undefined, rawTitle: string): string {
  if (!rawCompany || typeof rawCompany !== "string") {
    // Try parsing "Role at Company" from title
    const atMatch = rawTitle.match(/\b(?:at|@)\s+([A-Z0-9\.\-\s]{2,30})$/i);
    if (atMatch && atMatch[1]) {
      return atMatch[1].trim();
    }
    return "Company";
  }

  let company = rawCompany.trim();

  // Handle case where company was stored as a raw URL
  if (company.startsWith("http://") || company.startsWith("https://") || company.includes("/")) {
    try {
      const urlObj = new URL(company.startsWith("http") ? company : `https://${company}`);
      const segments = urlObj.pathname.split("/").filter(Boolean);
      // e.g. /company/odin-company -> "odin-company"
      const lastSeg = segments[segments.length - 1] || urlObj.hostname.replace(/^www\./, "");
      const cleanSlug = lastSeg
        .replace(/^(company|org|employer|jobs|careers)[-_\.]?/i, "")
        .replace(/[-_]+/g, " ")
        .trim();

      if (cleanSlug) {
        return cleanSlug
          .split(" ")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    } catch {
      // Ignore URL parse error
    }
  }

  return company;
}

/**
 * Format raw date strings (e.g. "Sat, 25 Jul 2026 20:32:33 GMT") cleanly into time-ago
 */
export function cleanPostedTime(postedText: string | null | undefined, firstSeenAt: string): string {
  if (!postedText) {
    return timeAgo(firstSeenAt);
  }

  const trimmed = postedText.trim();

  // Short relative times like "3d", "5h ago", "2 weeks ago"
  if (/^\d+[smhdw]\b/i.test(trimmed) || /\bago\b/i.test(trimmed)) {
    return trimmed;
  }

  // Attempt ISO / GMT date parsing
  const parsedDate = Date.parse(trimmed);
  if (!isNaN(parsedDate)) {
    return timeAgo(new Date(parsedDate).toISOString());
  }

  return timeAgo(firstSeenAt);
}

/**
 * Resolves job posting URL strictly for the specific posting.
 * Does NOT fall back to generic company homepages or career index URLs if posting.url is absent.
 */
export function resolvePostingUrl(posting: Posting): string | null {
  const rawUrl = posting.url?.trim();
  const pageUrl = posting.watched_pages?.url?.trim();

  if (!rawUrl) return null;

  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }

  // Relative link resolution against page URL
  if (pageUrl && (pageUrl.startsWith("http://") || pageUrl.startsWith("https://"))) {
    try {
      return new URL(rawUrl, pageUrl).href;
    } catch {
      // Ignore URL parse failure
    }
  }

  return rawUrl.startsWith("/") || rawUrl.startsWith("http") ? rawUrl : null;
}

/**
 * Extract target domain for company favicon, avoiding aggregator domain misattribution.
 */
export function getCompanyFaviconDomain(posting: Posting): string | null {
  const companyWebsite = posting.companies?.dossier?.website?.trim();
  if (companyWebsite) {
    try {
      const host = new URL(companyWebsite.startsWith("http") ? companyWebsite : `https://${companyWebsite}`).hostname.replace(/^www\./, "");
      if (host) return host;
    } catch {
      // Ignore
    }
  }

  if (posting.url) {
    try {
      const host = new URL(posting.url.startsWith("http") ? posting.url : `https://${posting.url}`).hostname.replace(/^www\./, "").toLowerCase();
      if (host && !AGGREGATOR_DOMAINS.has(host) && !Array.from(AGGREGATOR_DOMAINS).some((domain) => host.endsWith("." + domain))) {
        return host;
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Validates whether a compensation string is actual pay information.
 * Rejects category tags (e.g. "DeFi, Non-Tech, Product", "Engineering", etc.)
 */
export function cleanCompensation(rawComp: string | null | undefined): string {
  if (!rawComp || typeof rawComp !== "string") return "Pay undisclosed";

  const trimmed = rawComp.trim();
  if (!trimmed) return "Pay undisclosed";

  const categoryKeywords = /\b(non-tech|tech|product|design|engineering|defi|crypto|marketing|sales|finance|operations|full-time|part-time|contract|remote)\b/i;

  const hasCurrency = /[$€£¥₹]/.test(trimmed);
  const hasPayTerms = /\b(\d+k|\d+k\/yr|\d+\/hr|hour|hourly|year|yearly|salary|month|monthly|usd|eur|gbp|\d{2,3},\d{3})\b/i.test(trimmed);
  const hasNumberRange = /\b\d{2,3}\s*[-–—]\s*\d{2,3}\b/.test(trimmed);

  if ((hasCurrency || hasPayTerms || hasNumberRange) && !categoryKeywords.test(trimmed)) {
    return trimmed;
  }

  if (hasCurrency || hasPayTerms) {
    const priceMatch = trimmed.match(/([$€£¥₹]\s*\d+[\d,.]*\s*(?:[kK]|(?:\/[a-zA-Z]+))?(?:\s*[-–—]\s*[$€£¥₹]?\s*\d+[\d,.]*\s*(?:[kK]|(?:\/[a-zA-Z]+))?)?)/);
    if (priceMatch && priceMatch[1]) {
      return priceMatch[1].trim();
    }
  }

  return "Pay undisclosed";
}

/**
 * Cleans location string by stripping remote noise, splitting multi-city lists,
 * and returning a short, clean location string (e.g. "United States" or "San Francisco, CA").
 */
export function cleanLocation(rawLoc: string | null | undefined, tags: string[]): string {
  if (!rawLoc || typeof rawLoc !== "string") return "Location unlisted";

  let loc = rawLoc.trim();
  if (!loc) return "Location unlisted";

  if (/\b(remote|remote-friendly|work from anywhere|worldwide|anywhere)\b/i.test(loc)) {
    if (!tags.includes("Remote")) {
      tags.push("Remote");
    }
  }

  loc = loc
    .replace(/\b(remote-friendly|remote|work from anywhere|worldwide|anywhere)\b[\s,;\-\|]*/gi, "")
    .replace(/[\s,;\-\|]*\b(remote-friendly|remote)\b/gi, "")
    .trim();

  if (!loc) {
    return "Worldwide";
  }

  const segments = loc
    .split(/[\;\|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length > 0) {
    const primary = segments[0];

    let cleanPrimary = primary
      .replace(/^[\s,;\-\|]+/, "")
      .replace(/[\s,;\-\|]+$/, "")
      .trim();

    if (cleanPrimary.toLowerCase().includes("united states") || cleanPrimary.toLowerCase() === "us" || cleanPrimary.toLowerCase() === "usa") {
      cleanPrimary = "United States";
    }

    if (cleanPrimary.length > 30) {
      const parts = cleanPrimary.split(",");
      cleanPrimary = parts[0].trim();
    }

    return cleanPrimary;
  }

  return "Location unlisted";
}

/**
 * Extracts clean source site name (e.g. "LinkedIn", "WeWorkRemotely", "Dribbble", "Contra", "Y Combinator", "Startup Jobs", "Direct")
 */
export function getSourceSiteName(posting: Posting, companyName: string): string {
  const label = posting.watched_pages?.label?.trim() || "";
  const pageUrl = posting.watched_pages?.url || posting.url || "";

  const lowerLabel = label.toLowerCase();
  const lowerUrl = pageUrl.toLowerCase();

  // Known third-party job boards / aggregators
  if (lowerLabel.includes("linkedin") || lowerUrl.includes("linkedin")) return "LinkedIn";
  if (lowerLabel.includes("dribbble") || lowerUrl.includes("dribbble")) return "Dribbble";
  if (lowerLabel.includes("greenhouse") || lowerUrl.includes("greenhouse")) return "Greenhouse";
  if (lowerLabel.includes("lever") || lowerUrl.includes("lever")) return "Lever";
  if (lowerLabel.includes("ashby") || lowerUrl.includes("ashby")) return "Ashby";
  if (lowerLabel.includes("y combinator") || lowerUrl.includes("ycombinator")) return "Y Combinator";
  if (lowerLabel.includes("wellfound") || lowerUrl.includes("wellfound") || lowerUrl.includes("angel")) return "Wellfound";
  if (lowerLabel.includes("indeed") || lowerUrl.includes("indeed")) return "Indeed";
  if (lowerLabel.includes("weworkremotely") || lowerUrl.includes("weworkremotely")) return "WeWorkRemotely";
  if (lowerLabel.includes("cryptocurrency") || lowerUrl.includes("cryptocurrencyjobs")) return "Cryptocurrency Jobs";
  if (lowerLabel.includes("contra") || lowerUrl.includes("contra.com")) return "Contra";
  if (lowerLabel.includes("startup.jobs") || lowerUrl.includes("startup.jobs")) return "Startup Jobs";
  if (lowerLabel.includes("himalayas") || lowerUrl.includes("himalayas.app")) return "Himalayas";
  if (lowerLabel.includes("nodesk") || lowerUrl.includes("nodesk.co")) return "NoDesk";
  if (lowerLabel.includes("dailyremote") || lowerUrl.includes("dailyremote.com")) return "DailyRemote";

  const cleanComp = companyName.toLowerCase().replace(/[\s,.\-]+/g, "");
  const cleanLabel = label.toLowerCase().replace(/[\s,.\-]+/g, "");
  if (cleanComp && cleanLabel && (cleanLabel.includes(cleanComp) || cleanComp.includes(cleanLabel))) {
    return "Direct";
  }

  if (label && !label.toLowerCase().includes("http") && !label.toLowerCase().includes("feed") && !label.toLowerCase().includes("postings")) {
    return label;
  }

  try {
    const parsed = new URL(pageUrl.startsWith("http") ? pageUrl : `https://${pageUrl}`);
    const host = parsed.hostname.replace(/^www\./, "");
    const mainDomain = host.split(".")[0];
    if (mainDomain && cleanComp.includes(mainDomain.toLowerCase())) {
      return "Direct";
    }
    if (mainDomain) {
      return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
    }
  } catch {
    // Ignore invalid URL
  }

  return "Direct";
}

/**
 * Clean job title and extract tags (employment type, work model, senior level)
 */
export function parseJobDetails(posting: Posting): ParsedJobDetails {
  const rawTitle = posting.title || "Untitled Role";
  const tags: string[] = [];

  const tagPatterns: Array<{ regex: RegExp; tag: string }> = [
    { regex: /\b(full[- ]?time)\b/i, tag: "Full-time" },
    { regex: /\b(part[- ]?time)\b/i, tag: "Part-time" },
    { regex: /\b(contract|contractor)\b/i, tag: "Contract" },
    { regex: /\b(internship|intern)\b/i, tag: "Internship" },
    { regex: /\b(remote)\b/i, tag: "Remote" },
    { regex: /\b(hybrid)\b/i, tag: "Hybrid" },
    { regex: /\b(in[- ]?office|on[- ]?site)\b/i, tag: "In office" },
    { regex: /\b(flexible[- ]?schedule|flexible)\b/i, tag: "Flexible schedule" },
    { regex: /\b(senior level|sr\.? level|senior)\b/i, tag: "Senior level" },
    { regex: /\b(junior level|jr\.? level|junior)\b/i, tag: "Junior level" },
    { regex: /\b(lead|principal)\b/i, tag: "Lead" },
  ];

  let cleanedTitle = rawTitle;

  tagPatterns.forEach(({ regex, tag }) => {
    if (regex.test(cleanedTitle)) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
    cleanedTitle = cleanedTitle.replace(new RegExp(`[\\(\\[\\|\\-–—]?\\s*${regex.source}\\s*[\\)\\]]?`, "gi"), "");
  });

  cleanedTitle = cleanedTitle
    .replace(/^[\s\-\–\—\:\,\(\[\-]+/, "")
    .replace(/[\s\-\–\—\:\,\(\[\-]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleanedTitle) {
    cleanedTitle = rawTitle;
  }

  const companyName = cleanCompanyName(posting.companies?.display_name || posting.company, rawTitle);
  const locationText = cleanLocation(posting.location, tags);
  const compensationText = cleanCompensation(posting.compensation);

  // Guarantee at least 1-2 clean tags so the card layout never has awkward empty gaps
  if (tags.length === 0) {
    if (cleanedTitle.toLowerCase().includes("designer") || cleanedTitle.toLowerCase().includes("engineer") || cleanedTitle.toLowerCase().includes("developer")) {
      tags.push("Full-time");
    } else {
      tags.push("Matched");
    }
  }

  const finalTags = Array.from(new Set(tags)).slice(0, 3);
  const websiteDomain = getCompanyFaviconDomain(posting);
  const postingUrl = resolvePostingUrl(posting);
  const sourceSiteName = getSourceSiteName(posting, companyName);
  const timeText = cleanPostedTime(posting.posted_text, posting.first_seen_at);

  return {
    cleanTitle: cleanedTitle,
    tags: finalTags,
    companyName,
    sourceSiteName,
    websiteDomain,
    postingUrl,
    locationText,
    compensationText,
    timeText,
  };
}
