// Provider-agnostic LLM access. The provider is chosen entirely by config
// (settings table via the UI, or env vars — see _shared/config.ts):
//
//   llmProvider  "anthropic" | "openai-compatible"
//   llmModel     any model id for that provider
//   llmApiKey    the provider's API key
//   llmBaseUrl   (openai-compatible only) defaults to https://api.openai.com/v1
//                e.g. Gemini compat, Groq, Mistral, OpenRouter, local Ollama
//
// No vendor SDKs — two thin fetch adapters speaking each provider's raw HTTP
// API. Both callers (posting extraction below, posting screening in judge.ts)
// go through the same llmJson() entry point.

import type { ExtractedPosting, RuntimeConfig } from "./types.ts";

const MAX_OUTPUT_TOKENS = 16000;

const POSTINGS_SCHEMA = {
  type: "object",
  properties: {
    postings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          // A citation into this crawl's numbered link markers — never a URL
          // the model writes itself. See SYSTEM_PROMPT below and
          // resolvePostingLinks in _shared/links.ts, which is the only place
          // an id ever gets turned into an actual href.
          link_id: { type: ["integer", "null"] },
          company: { type: "string" },
          location: { type: "string" },
          posted_at: { type: "string" },
          posted_text: { type: "string" },
          compensation: { type: "string" },
        },
        required: ["title", "link_id"],
        additionalProperties: false,
      },
    },
  },
  required: ["postings"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract job postings from the text content of a careers / job-listing web page.

Every hyperlink in the content is wrapped in a pair of numbered markers, like this: [[7]]Senior Product Designer[[/7]]. The number is that link's id.

Return every individual job posting visible in the content. For each posting include:
- title (required): the job title exactly as shown
- link_id: the id of the marker wrapping THIS posting's own title or its apply/view link — copy the number exactly as shown between the [[ ]] brackets. Set it to null if no marker wraps this posting. Never invent a number that doesn't appear in the content, and never write a URL — any link you write yourself instead of citing a marker's id is discarded, because it cannot be trusted to actually point at this posting.
- company: the hiring company if identifiable
- location: the location(s) shown for the posting, verbatim. Include work arrangement (Remote, Hybrid, On-site) here when shown — these describe where the work happens, not pay.
- posted_text: if the page shows when the job was posted (e.g. "2 days ago", "Posted Mar 3", "3h"), that text verbatim
- posted_at: the same posted date as an ISO date (YYYY-MM-DD), computed from today's date when the page shows a relative time. Omit if the page shows no posted date — never guess.
- compensation: ONLY the pay figure/range as shown for the posting, verbatim (e.g. "$150K - $200K", "$45/hr") — never tags, categories, skills, or any other page metadata, even if it appears near the posting. Employment type ("Full Time", "Part Time", "Contract", "Freelance") and work arrangement ("Remote", "Hybrid", "On-site") are NEVER compensation — do not put them here even if no other field fits. Omit if the page shows no pay for this posting — never estimate or guess.

Do NOT filter, judge, or deduplicate beyond obvious exact repeats. Do NOT invent postings or fields that are not in the content. Navigation links, department headers, and generic buttons are not postings.

Sponsored/ad units are not postings either — skip them even when they're styled like a listing. Tells: a link path containing "/ads/", "/sponsored/", "/promo/", or "click"-tracking segments (e.g. "/listing_ads/13/click"); ad-copy phrasing instead of a real job title ("Remote Tech Jobs Paying $130k to $250k", "Post a job", "Hire remotely"); no identifiable single employer. A genuine posting names one specific role at one specific (or "confidential"/"stealth") employer. The same tells apply to which marker you cite as link_id — an ad unit's own link is never a posting's link_id.

Respond with JSON only, matching: {"postings": [{"title": "...", "link_id": 7, "company": "...", "location": "...", "posted_at": "...", "posted_text": "...", "compensation": "..."}]}
If the content contains no job postings, respond with {"postings": []}.`;

interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** One structured-output request: system + user prompt and the JSON schema
 * the response must match (schemaName is for providers that name schemas). */
export interface LlmJsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LLM providers return 429 (rate limit) or 5xx/529 (Anthropic's "overloaded")
 * under load — transient, not a config problem. Retry with exponential
 * backoff instead of failing that page's whole crawl for one busy moment.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) return res;
    await res.body?.cancel();
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    console.warn(`${label}: HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(delay);
  }
  throw new Error("unreachable");
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

// A real compensation/location string is always short — a model occasionally
// misassigns a whole tag cloud or sidebar into one of these fields instead of
// omitting it. Past this length it's not pay/location data, it's noise:
// dropped rather than trusted (this is what let one 7000+ char "compensation"
// value reach Telegram and blow past its 4096-char message limit, silently
// blocking every other queued notification behind it on that page).
const MAX_COMPENSATION_CHARS = 100;
const MAX_LOCATION_CHARS = 200;
const MAX_TITLE_CHARS = 300;

/** Real compensation always contains at least one digit or currency symbol,
 * and isn't malformed (e.g. ",000 - ,000" from a number split by HTML-tag
 * stripping — see htmlToTextWithLinks's rejoin regex in fetcher.ts, which prevents
 * most of these but not ones the LLM introduces itself). Employment types
 * ("Full Time"), work arrangements ("Remote"), and other non-pay metadata
 * the model sometimes misassigns here are rejected. */
function looksLikeCompensation(value: string): boolean {
  const v = value.trim();
  if (!/[\d$€£¥₹₩]/.test(v)) return false;
  if (/^[^\w$€£¥₹₩]/.test(v)) return false; // starts with punctuation, e.g. ",000"
  if (/(^|[^\d])\s*,\s*\d{3}\b/.test(v)) return false; // orphan comma-thousands
  return true;
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
    const location = typeof p.location === "string" ? p.location.trim() : "";
    const compensation = typeof p.compensation === "string" ? p.compensation.trim() : "";
    // link_id must be a non-negative integer citation — anything else (a
    // float, a negative number, an out-of-range id) is as good as no
    // citation at all. Range-checking against the actual link table happens
    // downstream in resolvePostingLinks (_shared/links.ts), which is the
    // only place that has the table; an id that turns out not to exist
    // there is treated exactly like "no citation", never as a URL to trust.
    const linkId = typeof p.link_id === "number" && Number.isInteger(p.link_id) && p.link_id >= 0
      ? p.link_id
      : undefined;
    out.push({
      title: p.title.trim().slice(0, MAX_TITLE_CHARS),
      link_id: linkId,
      // Not part of the schema — some providers ignore json_schema entirely
      // under the "none"-format fallback in callOpenAiCompatible and a model
      // may still emit a url out of habit. Kept only as raw, UNTRUSTED input:
      // resolvePostingLinks honors it solely when it matches a real anchor
      // href from this same crawl, exactly like link_id.
      url: typeof p.url === "string" && p.url.trim() !== "" ? p.url.trim() : undefined,
      company: typeof p.company === "string" && p.company.trim() !== "" ? p.company.trim() : undefined,
      location: location !== "" && location.length <= MAX_LOCATION_CHARS ? location : undefined,
      posted_at: postedAt,
      posted_text: typeof p.posted_text === "string" && p.posted_text.trim() !== "" ? p.posted_text.trim() : undefined,
      compensation: compensation !== "" && compensation.length <= MAX_COMPENSATION_CHARS &&
          looksLikeCompensation(compensation)
        ? compensation
        : undefined,
    });
  }
  return out;
}

async function callAnthropic(cfg: LlmConfig, req: LlmJsonRequest): Promise<string> {
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Classification/extraction, not creative generation — pin out
      // provider-default sampling variance (Anthropic defaults to 1.0).
      temperature: 0,
      system: req.system,
      output_config: { format: { type: "json_schema", schema: req.schema } },
      messages: [{ role: "user", content: req.user }],
    }),
  }, "anthropic");
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

/** One attempt in callOpenAiCompatible's degrade ladder. Exported for testing
 * the ordering without a network call. */
export interface OpenAiAttempt {
  response_format?: Record<string, unknown>;
  temperature?: number;
}

/** Not every OpenAI-compatible provider supports json_schema response_format,
 * and some (e.g. OpenAI's o1/o3 reasoning family) reject a custom temperature
 * outright with a 400 — degrade json_schema → json_object → no format on
 * 4xx, dropping temperature as the last resort. Classification/extraction has
 * no need for sampling variance (this is the same reasoning as callAnthropic's
 * fixed temperature: 0, and applies to extractPostings too, not just
 * judgePostings — both callers share llmJson), so every attempt but the last
 * asks for it; only a provider that rejects it outright falls through. */
export function buildOpenAiAttempts(req: LlmJsonRequest): OpenAiAttempt[] {
  return [
    {
      response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      temperature: 0,
    },
    { response_format: { type: "json_object" }, temperature: 0 },
    { temperature: 0 },
    {},
  ];
}

async function callOpenAiCompatible(cfg: LlmConfig, req: LlmJsonRequest): Promise<string> {
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  let lastError = "";
  for (const attempt of buildOpenAiAttempts(req)) {
    const res = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        ...(attempt.response_format ? { response_format: attempt.response_format } : {}),
        ...(attempt.temperature !== undefined ? { temperature: attempt.temperature } : {}),
      }),
    }, "openai-compatible");
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

/** Run one structured-output request against the configured provider and
 * return the parsed JSON (shape validation is the caller's job). */
export async function llmJson(runtime: RuntimeConfig, req: LlmJsonRequest): Promise<unknown> {
  const cfg = getConfig(runtime);
  let text: string;
  if (cfg.provider === "anthropic") {
    text = await callAnthropic(cfg, req);
  } else if (cfg.provider === "openai-compatible") {
    text = await callOpenAiCompatible(cfg, req);
  } else {
    throw new Error(`unknown LLM_PROVIDER "${cfg.provider}" (expected "anthropic" or "openai-compatible")`);
  }
  return parseJson(text);
}

/** Extract job postings from page content using the configured LLM provider. */
export async function extractPostings(
  pageContent: string,
  pageUrl: string,
  runtime: RuntimeConfig,
): Promise<ExtractedPosting[]> {
  const parsed = await llmJson(runtime, {
    system: SYSTEM_PROMPT,
    user: userPrompt(pageUrl, pageContent),
    schema: POSTINGS_SCHEMA,
    schemaName: "postings",
  });
  return validatePostings(parsed);
}
