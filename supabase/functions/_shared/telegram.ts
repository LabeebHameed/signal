import type { CompanyDossier } from "./types.ts";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
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
 * Deliberately minimal: title, company (+ type when researched), location,
 * pay, and a link. The judge's full reasoning and the company dossier live
 * on the Matches page — Telegram is just the ping to go look.
 */
export function formatPostingMessage(posting: {
  title: string;
  url?: string | null;
  company?: string | null;
  location?: string | null;
  compensation?: string | null;
}, pageLabel: string, companyInfo?: CompanyInfo | null): string {
  const lines: string[] = [];
  lines.push(`\u{1F514} ${escapeHtml(posting.title)}`);
  lines.push("");

  const companyName = companyInfo?.display_name || posting.company;
  if (companyName) {
    const type = companyInfo?.dossier?.company_type;
    lines.push(`\u{1F3E2} ${escapeHtml(companyName)}${type ? ` — ${escapeHtml(type)}` : ""}`);
  }
  if (posting.location) lines.push(`\u{1F4CD} ${escapeHtml(posting.location)}`);
  if (posting.compensation) lines.push(`\u{1F4B0} ${escapeHtml(posting.compensation)}`);

  lines.push("");
  if (posting.url) {
    lines.push(`${escapeHtml(pageLabel)} - <a href="${escapeAttr(posting.url)}">See Job Post</a>`);
  } else if (pageLabel) {
    lines.push(escapeHtml(pageLabel));
  }

  return lines.join("\n");
}
