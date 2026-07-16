// Provider-agnostic LLM extraction. The provider is chosen entirely by config
// (settings table via the UI, or env vars — see _shared/config.ts):
//
//   llmProvider  "anthropic" | "openai-compatible"
//   llmModel     any model id for that provider
//   llmApiKey    the provider's API key
//   llmBaseUrl   (openai-compatible only) defaults to https://api.openai.com/v1
//                e.g. Gemini compat, Groq, Mistral, OpenRouter, local Ollama
//
// No vendor SDKs — two thin fetch adapters speaking each provider's raw HTTP API.

import type { ExtractedPosting, RuntimeConfig } from "./types.ts";

const POSTINGS_SCHEMA = {
  type: "object",
  properties: {
    postings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          company: { type: "string" },
          location: { type: "string" },
          posted_at: { type: "string" },
          posted_text: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  required: ["postings"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract job postings from the text content of a careers / job-listing web page.

Return every individual job posting visible in the content. For each posting include:
- title (required): the job title exactly as shown
- url: the posting's link if one appears near it (may be relative)
- company: the hiring company if identifiable
- location: the location(s) shown for the posting, verbatim
- posted_text: if the page shows when the job was posted (e.g. "2 days ago", "Posted Mar 3", "3h"), that text verbatim
- posted_at: the same posted date as an ISO date (YYYY-MM-DD), computed from today's date when the page shows a relative time. Omit if the page shows no posted date — never guess.

Do NOT filter, judge, or deduplicate beyond obvious exact repeats. Do NOT invent postings or fields that are not in the content. Navigation links, department headers, and generic buttons are not postings.

Respond with JSON only, matching: {"postings": [{"title": "...", "url": "...", "company": "...", "location": "...", "posted_at": "...", "posted_text": "..."}]}
If the content contains no job postings, respond with {"postings": []}.`;

interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

function getConfig(cfg: RuntimeConfig): LlmConfig {
  const provider = cfg.llmProvider.trim();
  const model = cfg.llmModel.trim();
  const apiKey = cfg.llmApiKey.trim();
  const baseUrl = (cfg.llmBaseUrl.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!provider || !model || !apiKey) {
    throw new Error("LLM not configured: set provider, model and API key in Settings");
  }
  return { provider, model, apiKey, baseUrl };
}

function userPrompt(pageUrl: string, content: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today's date: ${today}\nPage URL: ${pageUrl}\n\nPage content:\n${content}`;
}

/** Strip markdown fences some models wrap around JSON, then parse. */
function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function validatePostings(parsed: unknown): ExtractedPosting[] {
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { postings?: unknown }).postings)) {
    throw new Error("LLM response is not of shape {postings: [...]}");
  }
  const out: ExtractedPosting[] = [];
  for (const item of (parsed as { postings: unknown[] }).postings) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (typeof p.title !== "string" || p.title.trim() === "") continue;
    const postedAt = typeof p.posted_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.posted_at.trim())
      ? p.posted_at.trim()
      : undefined;
    out.push({
      title: p.title.trim(),
      url: typeof p.url === "string" && p.url.trim() !== "" ? p.url.trim() : undefined,
      company: typeof p.company === "string" && p.company.trim() !== "" ? p.company.trim() : undefined,
      location: typeof p.location === "string" && p.location.trim() !== "" ? p.location.trim() : undefined,
      posted_at: postedAt,
      posted_text: typeof p.posted_text === "string" && p.posted_text.trim() !== "" ? p.posted_text.trim() : undefined,
    });
  }
  return out;
}

async function callAnthropic(cfg: LlmConfig, pageUrl: string, content: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: POSTINGS_SCHEMA } },
      messages: [{ role: "user", content: userPrompt(pageUrl, content) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic API error: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("anthropic API refused the request");
  const text = (data.content as Array<{ type: string; text?: string }> | undefined)
    ?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("anthropic API returned no text content");
  return text;
}

async function callOpenAiCompatible(cfg: LlmConfig, pageUrl: string, content: string): Promise<string> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(pageUrl, content) },
  ];
  // Not every OpenAI-compatible provider supports json_schema response_format;
  // degrade json_schema → json_object → none on 4xx.
  const formats: Array<Record<string, unknown> | undefined> = [
    { type: "json_schema", json_schema: { name: "postings", strict: true, schema: POSTINGS_SCHEMA } },
    { type: "json_object" },
    undefined,
  ];
  let lastError = "";
  for (const response_format of formats) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, ...(response_format ? { response_format } : {}) }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error("openai-compatible API returned no message content");
      return text;
    }
    lastError = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
    // Only fall through to a simpler format on client errors (unsupported param);
    // auth/rate/server errors won't be fixed by changing the format.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) break;
  }
  throw new Error(`openai-compatible API error: ${lastError}`);
}

/** Extract job postings from page content using the configured LLM provider. */
export async function extractPostings(
  pageContent: string,
  pageUrl: string,
  runtime: RuntimeConfig,
): Promise<ExtractedPosting[]> {
  const cfg = getConfig(runtime);
  let text: string;
  if (cfg.provider === "anthropic") {
    text = await callAnthropic(cfg, pageUrl, pageContent);
  } else if (cfg.provider === "openai-compatible") {
    text = await callOpenAiCompatible(cfg, pageUrl, pageContent);
  } else {
    throw new Error(`unknown LLM_PROVIDER "${cfg.provider}" (expected "anthropic" or "openai-compatible")`);
  }
  return validatePostings(parseJson(text));
}
