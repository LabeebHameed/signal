// Runtime config resolution: an env var with the matching name always wins;
// otherwise the value comes from the settings table (managed in the web UI).

import type { FilterMode, RuntimeConfig, Settings } from "./types.ts";

function env(name: string, fallback: string): string {
  const value = Deno.env.get(name);
  return value && value.trim() !== "" ? value : fallback;
}

export function resolveConfig(settings: Settings): RuntimeConfig {
  return {
    adminToken: env("ADMIN_TOKEN", settings.admin_token),
    llmProvider: env("LLM_PROVIDER", settings.llm_provider),
    llmModel: env("LLM_MODEL", settings.llm_model),
    llmApiKey: env("LLM_API_KEY", settings.llm_api_key),
    llmBaseUrl: env("LLM_BASE_URL", settings.llm_base_url),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN", settings.telegram_bot_token),
    telegramChatId: settings.telegram_chat_id,
    tavilyApiKey: env("TAVILY_API_KEY", settings.tavily_api_key),
    filterProfile: settings.filter_profile ?? {},
    filterMode: (settings.filter_mode ?? "balanced") as FilterMode,
    companyFilterEnabled: settings.company_filter_enabled ?? false,
    blockedCompanies: settings.blocked_companies ?? "",
    minScore: settings.min_score ?? 0,
  };
}
