export interface ExtractedPosting {
  title: string;
  url?: string;
  company?: string;
  location?: string;
  /** ISO date (YYYY-MM-DD) the job was posted, when the page shows one. */
  posted_at?: string;
  /** The posted-date text verbatim as shown on the page, e.g. "2 days ago". */
  posted_text?: string;
}

export interface WatchedPage {
  id: string;
  url: string;
  label: string;
  active: boolean;
  fetch_source: "direct" | "jina";
  last_content_hash: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  failure_count: number;
  first_crawl_done: boolean;
}

// Full settings row, including secret columns. Only ever read via the
// service-role client; the api function returns a masked view of it.
export interface Settings {
  id: number;
  job_description: string;
  telegram_chat_id: string;
  admin_token: string;
  llm_provider: string;
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
  telegram_bot_token: string;
  jina_api_key: string;
}

export interface RuntimeConfig {
  adminToken: string;
  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  jinaApiKey: string;
}
