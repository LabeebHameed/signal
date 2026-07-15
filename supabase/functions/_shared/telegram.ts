function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export function formatPostingMessage(posting: {
  title: string;
  url?: string | null;
  company?: string | null;
  location?: string | null;
}, pageLabel: string): string {
  const lines: string[] = [];
  lines.push(`\u{1F514} <b>New job posting</b>`);
  lines.push(escapeHtml(posting.title));
  if (posting.company) lines.push(`\u{1F3E2} ${escapeHtml(posting.company)}`);
  if (posting.location) lines.push(`\u{1F4CD} ${escapeHtml(posting.location)}`);
  if (posting.url) lines.push(escapeHtml(posting.url));
  lines.push(`<i>from: ${escapeHtml(pageLabel)}</i>`);
  return lines.join("\n");
}
