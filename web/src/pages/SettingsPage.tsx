import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, FilterMode, FilterProfile, Settings } from "../api";
import { useToast } from "../components/Toast";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  // refetchInterval/focus refetch are off here: this form holds in-progress
  // edits, and a background refetch would silently overwrite them. The query
  // still makes navigating back to this page instant via the shared cache.
  const { data, error: loadError } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !settings) setSettings(data);
  }, [data, settings]);

  // Secret inputs are write-only: the server never echoes stored values back.
  const [secrets, setSecrets] = useState({ llm_api_key: "", telegram_bot_token: "", jina_api_key: "" });
  const [saving, setSaving] = useState(false);
  const [tgTest, setTgTest] = useState<{ status: "idle" | "sending" | "ok" | "fail"; message?: string }>({
    status: "idle",
  });
  const toast = useToast();

  const testTelegram = async () => {
    setTgTest({ status: "sending" });
    try {
      await api.testTelegram();
      setTgTest({ status: "ok" });
    } catch (e) {
      setTgTest({ status: "fail", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.saveSettings({
        filter_profile: settings.filter_profile,
        filter_mode: settings.filter_mode,
        telegram_chat_id: settings.telegram_chat_id,
        llm_provider: settings.llm_provider,
        llm_model: settings.llm_model,
        llm_base_url: settings.llm_base_url,
        ...(secrets.llm_api_key.trim() ? { llm_api_key: secrets.llm_api_key.trim() } : {}),
        ...(secrets.telegram_bot_token.trim() ? { telegram_bot_token: secrets.telegram_bot_token.trim() } : {}),
        ...(secrets.jina_api_key.trim() ? { jina_api_key: secrets.jina_api_key.trim() } : {}),
      });
      setSettings(updated);
      queryClient.setQueryData(["settings"], updated);
      setSecrets({ llm_api_key: "", telegram_bot_token: "", jina_api_key: "" });
      toast.show("Settings saved");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const secretPlaceholder = (isSet: boolean) => (isSet ? "•••••• set — leave blank to keep" : "not set");

  const setProfile = (field: keyof FilterProfile, value: string) => {
    if (!settings) return;
    setSettings({ ...settings, filter_profile: { ...settings.filter_profile, [field]: value } });
  };

  if (loadError && !settings) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Settings</h1>
        </header>
        <p className="error">{loadError instanceof Error ? loadError.message : String(loadError)}</p>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Settings</h1>
        </header>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">Job filter, LLM provider and Telegram delivery configuration.</p>
        </div>
      </header>

      <form onSubmit={save}>
        <section className="card">
          <h2>Job filter</h2>
          <p className="hint filter-intro">
            Every new posting is judged against this profile by the LLM — the way a person would weigh it, not by
            keyword matching. Postings that don't qualify are kept on the Postings page with the full reasoning, but
            never sent to Telegram. All fields are optional free text; the judge only weighs what you fill in, and
            leaving everything blank turns filtering off.
          </p>
          <label>
            Filtering
            <select
              value={settings.filter_mode}
              onChange={(e) => setSettings({ ...settings, filter_mode: e.target.value as FilterMode })}
            >
              <option value="off">Off — notify about every new posting</option>
              <option value="balanced">Balanced — notify for matches and borderline calls</option>
              <option value="strict">Strict — notify only for clear matches</option>
            </select>
          </label>
          <div className="grid-2">
            <label>
              Target roles
              <input
                value={settings.filter_profile.roles ?? ""}
                onChange={(e) => setProfile("roles", e.target.value)}
                placeholder="e.g. Senior frontend engineer; design engineer; founding engineer"
              />
            </label>
            <label>
              Seniority
              <input
                value={settings.filter_profile.seniority ?? ""}
                onChange={(e) => setProfile("seniority", e.target.value)}
                placeholder="e.g. senior or staff — no internships or junior roles"
              />
            </label>
            <label>
              Locations &amp; remote
              <input
                value={settings.filter_profile.locations ?? ""}
                onChange={(e) => setProfile("locations", e.target.value)}
                placeholder="e.g. remote (must allow India) or hybrid in Bangalore"
              />
            </label>
            <label>
              Skills &amp; stack
              <input
                value={settings.filter_profile.skills ?? ""}
                onChange={(e) => setProfile("skills", e.target.value)}
                placeholder="e.g. React, TypeScript; design systems a plus"
              />
            </label>
            <label>
              Company preferences
              <input
                value={settings.filter_profile.company_prefs ?? ""}
                onChange={(e) => setProfile("company_prefs", e.target.value)}
                placeholder="e.g. product startups or mid-size companies; no agencies"
              />
            </label>
            <label>
              Compensation
              <input
                value={settings.filter_profile.compensation ?? ""}
                onChange={(e) => setProfile("compensation", e.target.value)}
                placeholder="e.g. ≥ $120k — only counts when the posting shows pay"
              />
            </label>
          </div>
          <label>
            Must-haves <span className="hint">hard requirements — a posting that clearly violates one can't match</span>
            <textarea
              value={settings.filter_profile.must_haves ?? ""}
              onChange={(e) => setProfile("must_haves", e.target.value)}
              rows={2}
              placeholder="e.g. remote-friendly for India; individual-contributor role"
            />
          </label>
          <label>
            Nice-to-haves <span className="hint">soft preferences that boost a posting without being required</span>
            <textarea
              value={settings.filter_profile.nice_to_haves ?? ""}
              onChange={(e) => setProfile("nice_to_haves", e.target.value)}
              rows={2}
              placeholder="e.g. developer-tools product; small team; open source"
            />
          </label>
          <label>
            Dealbreakers <span className="hint">auto-reject — if one clearly applies, the posting is filtered no matter what</span>
            <textarea
              value={settings.filter_profile.dealbreakers ?? ""}
              onChange={(e) => setProfile("dealbreakers", e.target.value)}
              rows={2}
              placeholder="e.g. crypto/web3; outsourcing agencies; on-site US only"
            />
          </label>
          <label>
            About you <span className="hint">background and anything else the judge should know</span>
            <textarea
              value={settings.filter_profile.context ?? ""}
              onChange={(e) => setProfile("context", e.target.value)}
              rows={3}
              placeholder="e.g. 8 years building React apps, led a design-system team, prefer product-focused work…"
            />
          </label>
        </section>

        <section className="card">
          <h2>LLM extraction</h2>
          <div className="grid-2">
            <label>
              Provider
              <select
                value={settings.llm_provider}
                onChange={(e) => setSettings({ ...settings, llm_provider: e.target.value })}
              >
                <option value="">— choose —</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">OpenAI-compatible (OpenAI, Gemini, Groq, OpenRouter, Ollama…)</option>
              </select>
            </label>
            <label>
              Model
              <input
                value={settings.llm_model}
                onChange={(e) => setSettings({ ...settings, llm_model: e.target.value })}
                placeholder="model id"
              />
            </label>
          </div>
          {settings.llm_provider === "openai-compatible" && (
            <label>
              Base URL <span className="hint">(leave blank for OpenAI; set for Gemini/Groq/OpenRouter/Ollama…)</span>
              <input
                value={settings.llm_base_url}
                onChange={(e) => setSettings({ ...settings, llm_base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              value={secrets.llm_api_key}
              onChange={(e) => setSecrets({ ...secrets, llm_api_key: e.target.value })}
              placeholder={secretPlaceholder(settings.has_llm_api_key)}
            />
          </label>
        </section>

        <section className="card">
          <h2>Telegram</h2>
          <div className="grid-2">
            <label>
              Bot token <span className="hint">(from @BotFather)</span>
              <input
                type="password"
                value={secrets.telegram_bot_token}
                onChange={(e) => setSecrets({ ...secrets, telegram_bot_token: e.target.value })}
                placeholder={secretPlaceholder(settings.has_telegram_bot_token)}
              />
            </label>
            <label>
              Chat ID <span className="hint">(numeric ID from @userinfobot — not your bot's own ID)</span>
              <input
                value={settings.telegram_chat_id}
                onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                placeholder="123456789"
              />
            </label>
          </div>
          <div className="tg-test-row">
            <button type="button" className="secondary" disabled={tgTest.status === "sending"} onClick={testTelegram}>
              {tgTest.status === "sending" ? "Sending…" : "Send test message"}
            </button>
            {tgTest.status === "ok" && <span className="ok-text">Sent ✓ — check your Telegram</span>}
            {tgTest.status === "fail" && <span className="error">{tgTest.message}</span>}
          </div>
          <p className="hint">
            Save settings first if you just changed them. "chat not found" means the chat ID is wrong (it must be
            your personal ID from @userinfobot, not the bot's own ID) or you haven't pressed Start in your bot's
            chat yet.
          </p>
        </section>

        <section className="card">
          <h2>
            Jina Reader <span className="hint">(optional)</span>
          </h2>
          <label>
            API key <span className="hint">only needed for JS-heavy pages hitting anonymous rate limits — free at jina.ai</span>
            <input
              type="password"
              value={secrets.jina_api_key}
              onChange={(e) => setSecrets({ ...secrets, jina_api_key: e.target.value })}
              placeholder={secretPlaceholder(settings.has_jina_api_key)}
            />
          </label>
        </section>

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </div>
  );
}
