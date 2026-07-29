import type { CompanyDossier, PostingVerdict } from "./types.ts";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Defense-in-depth against Telegram's 4096-char message cap: extraction
 * already caps these fields (see llm.ts), but this guards against any other
 * source of an oversized value ever reaching a send — one bad field must
 * never be able to block a whole page's notify queue again. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Every bot token is shaped "<bot_id>:<secret>" and a bot's own numeric ID
 * looks exactly like a valid chat ID. Pasting the bot ID into the chat-ID
 * field (mistaking it for a personal ID) is a common, easy-to-repeat error —
 * Telegram itself rejects the send ("chat not found" or "the bot can't send
 * messages to the bot"), but only after a network round trip. Catch it
 * up front instead.
 */
export function botIdFromToken(token: string): string {
  return token.split(":")[0] ?? "";
}

/** Chat IDs are comma-separated to support notifying multiple accounts
 * (e.g. testing on a second phone) — blank entries are dropped. */
export function parseChatIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export function chatIdIsBotItself(botToken: string, chatId: string): boolean {
  const botId = botIdFromToken(botToken);
  return botId !== "" && parseChatIds(chatId).some((id) => id === botId);
}

export async function sendTelegramMessage(botToken: string, chatId: string, html: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

/** Send the same message to every configured chat ID. Stops at the first
 * failure — the caller's retry-on-next-run handling covers the rest, same
 * as the single-recipient contract this replaces. */
export async function sendTelegramMessageToAll(botToken: string, chatIds: string[], html: string): Promise<void> {
  if (chatIds.length === 0) throw new Error("no Telegram chat ID configured");
  for (const chatId of chatIds) {
    await sendTelegramMessage(botToken, chatId, html);
  }
}

/** Company background researched by the company layer, when it ran. */
export interface CompanyInfo {
  display_name: string;
  dossier: CompanyDossier | null;
}

/**
 * Deliberately minimal: title, why it matched (score + the judge's own
 * summary — every notification says why, per the product vision), company
 * (+ type when researched), location, pay, and a link. The full
 * per-dimension breakdown and company dossier live on the Inbox page —
 * Telegram is just the ping to go look.
 *
 * The link line only ever points straight at the posting once its link has
 * been positively VERIFIED (link_verification, migration 0019) — anything
 * short of that (never checked, a wall on the site, or proven wrong) links
 * to the watched source-listing page instead, labelled honestly, so a
 * Telegram tap never lands somewhere other than what it claims to be.
 */
export function formatPostingMessage(posting: {
  title: string;
  url?: string | null;
  company?: string | null;
  location?: string | null;
  compensation?: string | null;
  filter_verdict?: Pick<PostingVerdict, "summary"> | null;
}, pageLabel: string, companyInfo?: CompanyInfo | null): string {
  const lines: string[] = [];
  lines.push(`\u{1F514}  ${escapeHtml(truncate(posting.title, 300))}`);
  lines.push("");

  const companyName = companyInfo?.display_name || posting.company;
  if (companyName) {
    lines.push(`\u{1F3E2}  ${escapeHtml(truncate(companyName, 150))}`);
  }
  if (posting.compensation) {
    lines.push(`\u{1F4B0}  ${escapeHtml(truncate(posting.compensation, 150))}`);
  }
  if (posting.location) {
    lines.push(`\u{1F4CD}  ${escapeHtml(truncate(posting.location, 150))}`);
  }

  lines.push("");
  const truncatedPageLabel = truncate(pageLabel, 100);
  const href = posting.url;
  if (href) {
    lines.push(`${escapeHtml(truncatedPageLabel)} - <a href="${escapeAttr(href)}">See Job Post</a>`);
  } else if (pageLabel) {
    lines.push(escapeHtml(truncatedPageLabel));
  }
  lines.push("_________________________________");

  return lines.join("\n");
}
