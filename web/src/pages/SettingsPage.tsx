import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, Settings } from "../api";
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
  const [secrets, setSecrets] = useState({ llm_api_key: "", telegram_bot_token: "", tavily_api_key: "" });
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
        telegram_chat_id: settings.telegram_chat_id,
        llm_provider: settings.llm_provider,
        llm_model: settings.llm_model,
        llm_base_url: settings.llm_base_url,
        ...(secrets.llm_api_key.trim() ? { llm_api_key: secrets.llm_api_key.trim() } : {}),
        ...(secrets.telegram_bot_token.trim() ? { telegram_bot_token: secrets.telegram_bot_token.trim() } : {}),
        ...(secrets.tavily_api_key.trim() ? { tavily_api_key: secrets.tavily_api_key.trim() } : {}),
      });
      setSettings(updated);
      queryClient.setQueryData(["settings"], updated);
      setSecrets({ llm_api_key: "", telegram_bot_token: "", tavily_api_key: "" });
      toast.show("Settings saved");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const secretPlaceholder = (isSet: boolean) => (isSet ? "•••••• set — leave blank to keep" : "not set");

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
          <p className="page-subtitle">
            LLM provider and Telegram delivery configuration. Your job filter lives on the Profile page.
          </p>
        </div>
      </header>

      <form onSubmit={save}>
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
              Chat ID(s){" "}
              <span className="hint">
                numeric ID from @userinfobot — not your bot's own ID. Comma-separated to notify multiple accounts
                (e.g. for testing).
              </span>
              <input
                value={settings.telegram_chat_id}
                onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                placeholder="123456789, 987654321"
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
            Tavily <span className="hint">(optional)</span>
          </h2>
          <label>
            API key{" "}
            <span className="hint">
              powers the company background checks (see Profile) — free at tavily.com
            </span>
            <input
              type="password"
              value={secrets.tavily_api_key}
              onChange={(e) => setSecrets({ ...secrets, tavily_api_key: e.target.value })}
              placeholder={secretPlaceholder(settings.has_tavily_api_key)}
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
