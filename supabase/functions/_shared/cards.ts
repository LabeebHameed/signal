// Capture a posting's link where it is unambiguous: on the page, at scrape
// time, from the DOM node that contains the posting's own title.
//
// A job listing renders each posting as a card — a repeated container holding
// the title, the company, and the link. That association is structural and
// deterministic, so reading it needs no model judgement and no second HTTP
// request. This replaces proving links after the fact, which could not work:
// verification had to re-fetch each posting from sites that wall datacenter
// IPs (dailyremote.com) or sit behind a real Cloudflare challenge
// (himalayas.app), so almost every link stayed permanently "unconfirmed".
//
// Why this beats handing the model a flat list of the page's anchors: a
// single nodesk.co card contains FIVE links — the job, the company, the
// location, and tag links, one of which is literally titled "Product
// Designer". Flattened into 456 numbered anchors, choosing correctly is
// guesswork. Scoped to its card, the job link is the only one that is unique
// per card, which is exactly what pickPrimarySlot below keys on.
//
// Deliberately indexes EVERY card-like group rather than trying to identify
// "the" job list. Picking the right group is unreliable on nav-heavy pages
// (ycombinator.com, web3.career), and it is also unnecessary: lookups are by
// posting title, and no posting is ever titled "Engineering", so a navigation
// group's entries are inert. Validated against live HTML from seven sources —
// nodesk (49/49), weworkremotely (38/38), cryptocurrencyjobs (47/47),
// dribbble (48/48), dailyremote (29/29), plus ycombinator and web3.career,
// which only resolve under this index-everything approach.

// Imports only dom.ts and dedupe.ts on purpose: links.ts consumes this
// module, so depending on it here would close a runtime import cycle.
// Screening card hrefs through isUsableHref is therefore links.ts's job,
// applied to the index this module returns.
import { type DomElement, ancestors, parseHtml, walk } from "./dom.ts";
import { canonicalUrl, normText } from "./dedupe.ts";

/** One card's primary link: the posting title it displays, that card's own
 * link, and the card's full text (used to split duplicate titles by company). */
export interface CardLink {
  title: string;
  /** Absolute, canonical, original-case URL. */
  href: string;
  /** The whole card's collapsed text — company, location, pay, tags. */
  cardText: string;
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const MIN_GROUP = 3;
/** A slot must appear in most cards to be that group's primary link. */
const MIN_SLOT_COVERAGE = 0.7;
/** ...and its href must differ card to card. This is the whole discriminator:
 * the job link is distinct per card, while company/category/tag links repeat. */
const MIN_SLOT_UNIQUENESS = 0.9;
const MIN_TITLE_CHARS = 3;
const MAX_TITLE_CHARS = 160;
/** Guards against pathological pages; a real listing is far below this. */
const MAX_CARDS_SCANNED = 4000;

function signature(el: DomElement): string {
  return `${el.tag}.${el.classes}`;
}

function anchorsOf(card: DomElement): DomElement[] {
  const out: DomElement[] = [];
  for (const el of walk(card)) {
    if (el.tag === "a" && el.href) out.push(el);
  }
  return out;
}

/** An anchor's position within its card: the signature path from the card
 * root down to the anchor. The same slot in sibling cards yields the same
 * key, which is what lets a slot be compared across the whole group. */
function slotKey(card: DomElement, anchor: DomElement): string {
  const path: string[] = [];
  let node: DomElement | null = anchor;
  while (node !== null && node !== card) {
    path.push(signature(node));
    node = node.parent;
  }
  return path.reverse().join(">");
}

function pathDepth(href: string): number {
  const withoutQuery = href.split("?")[0];
  return withoutQuery.split("/").filter((s) => s !== "").length;
}

/** Sibling elements sharing a signature, at least MIN_GROUP of them, each
 * containing at least one link — the shape every card listing has. */
function candidateGroups(root: DomElement): DomElement[][] {
  const groups: DomElement[][] = [];
  for (const el of walk(root)) {
    if (el.children.length < MIN_GROUP) continue;
    const bySignature = new Map<string, DomElement[]>();
    for (const child of el.children) {
      const sig = signature(child);
      const arr = bySignature.get(sig);
      if (arr) arr.push(child);
      else bySignature.set(sig, [child]);
    }
    for (const siblings of bySignature.values()) {
      if (siblings.length < MIN_GROUP) continue;
      const withLinks = siblings.filter((c) => anchorsOf(c).length > 0);
      if (withLinks.length >= MIN_GROUP) groups.push(withLinks);
    }
  }
  return groups;
}

/**
 * The group's primary (job) link slot: the anchor position whose href is
 * distinct in nearly every card. Company, category and tag anchors fail the
 * uniqueness test because they repeat across cards; an "Apply"/"View job"
 * button is unique but loses the tie-break to the deeper, title-bearing link.
 */
function pickPrimarySlot(cards: DomElement[]): Array<{ card: DomElement; anchor: DomElement }> | null {
  const slots = new Map<string, Array<{ card: DomElement; anchor: DomElement }>>();
  for (const card of cards) {
    for (const anchor of anchorsOf(card)) {
      const key = slotKey(card, anchor);
      const arr = slots.get(key);
      if (arr) arr.push({ card, anchor });
      else slots.set(key, [{ card, anchor }]);
    }
  }

  let best: { items: Array<{ card: DomElement; anchor: DomElement }>; rank: number[] } | null = null;
  for (const items of slots.values()) {
    const coverage = new Set(items.map((i) => i.card)).size / cards.length;
    if (coverage < MIN_SLOT_COVERAGE) continue;
    const distinct = new Set(items.map((i) => (i.anchor.href ?? "").split("?")[0])).size;
    const uniqueness = distinct / items.length;
    if (uniqueness < MIN_SLOT_UNIQUENESS) continue;

    const avgDepth = items.reduce((n, i) => n + pathDepth(i.anchor.href ?? ""), 0) / items.length;
    const headingShare = items.filter((i) =>
      [...walk(i.anchor)].some((d) => d.tag in HEADING_LEVEL) ||
      [...ancestors(i.anchor)].some((a) => a.tag in HEADING_LEVEL)
    ).length / items.length;
    const avgTextLen = Math.min(items.reduce((n, i) => n + i.anchor.text.length, 0) / items.length, 90);

    const rank = [coverage, avgDepth, headingShare, avgTextLen];
    if (best === null || compareRank(rank, best.rank) > 0) best = { items, rank };
  }
  return best?.items ?? null;
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The card's displayed title: its highest-ranked heading when it has one
 * (nodesk/cryptocurrencyjobs put the job in <h2> and the company in <h3>, so
 * rank matters), otherwise the anchor's own text — ycombinator's cards use no
 * heading elements at all.
 */
function titleForCard(card: DomElement, anchor: DomElement): string | null {
  let bestLevel = Infinity;
  let bestText: string | null = null;
  for (const el of walk(card)) {
    const level = HEADING_LEVEL[el.tag];
    if (level === undefined || level >= bestLevel) continue;
    const text = el.text;
    if (text.length < MIN_TITLE_CHARS || text.length > MAX_TITLE_CHARS) continue;
    bestLevel = level;
    bestText = text;
  }
  if (bestText !== null) return bestText;
  const anchorText = anchor.text;
  if (anchorText.length >= MIN_TITLE_CHARS && anchorText.length <= MAX_TITLE_CHARS) return anchorText;
  return null;
}

/**
 * Every card-like group's primary links, unioned into one index. Absolutized
 * and screened through the same isUsableHref rules the citation path uses, so
 * an ad wrapper or taxonomy page can't enter the index as a posting link.
 */
export function extractCardLinks(html: string, pageUrl: string): CardLink[] {
  const root = parseHtml(html);
  if (!root) return [];

  const out: CardLink[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const cards of candidateGroups(root)) {
    if (scanned > MAX_CARDS_SCANNED) break;
    scanned += cards.length;
    const items = pickPrimarySlot(cards);
    if (!items) continue;
    for (const { card, anchor } of items) {
      const href = anchor.href;
      if (!href) continue;
      const title = titleForCard(card, anchor);
      if (!title) continue;
      const canonical = canonicalUrl(href, pageUrl);
      if (!canonical) continue;
      const dedupe = `${normText(title)} ${canonical}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ title, href: canonical, cardText: card.text });
    }
  }
  return out;
}

/** A title the page renders with extra chrome around it ("New!", a location
 * suffix) still names the same job — accepted only when one side wholly
 * contains the other, never on partial word overlap. */
function sameTitle(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  // Guard against a two-word title matching inside every card on the page.
  if (shorter.length < 12) return false;
  return longer.includes(shorter);
}

/**
 * The card link for one extracted posting, or null when the page does not
 * unambiguously answer.
 *
 * Duplicate titles are real and common — "Staff Product Designer" at both
 * Polymarket and Shakepay, "Creative Director" at both 6sense and Boulevard.
 * The card's own text carries the company, so a duplicate is split by looking
 * for the company inside it. Still ambiguous after that returns null rather
 * than picking one: a wrong link is worse than no link.
 */
export function resolveByCard(
  title: string,
  company: string | null,
  cards: CardLink[],
): { href: string; score: number } | null {
  if (cards.length === 0) return null;
  const wanted = normText(title);
  if (wanted === "") return null;

  let matches = cards.filter((c) => normText(c.title) === wanted);
  if (matches.length === 0) {
    // No exact title; accept a containment match (punctuation or chrome drift
    // between the model's reading and the page's markup).
    matches = cards.filter((c) => sameTitle(title, c.title));
  }
  if (matches.length === 0) return null;

  if (matches.length > 1 && company) {
    const wantedCompany = normText(company);
    if (wantedCompany !== "") {
      const byCompany = matches.filter((c) => normText(c.cardText).includes(wantedCompany));
      if (byCompany.length === 1) return { href: byCompany[0].href, score: 1 };
      if (byCompany.length > 1) matches = byCompany;
    }
  }

  // One card, or several that all point at the same place.
  const distinct = new Set(matches.map((c) => c.href));
  if (distinct.size === 1) return { href: matches[0].href, score: 1 };
  return null;
}
