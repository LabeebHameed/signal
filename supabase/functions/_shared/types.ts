export interface ExtractedPosting {
  title: string;
  url?: string;
  company?: string;
  location?: string;
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

export interface Settings {
  id: number;
  job_description: string;
  telegram_chat_id: string;
}
