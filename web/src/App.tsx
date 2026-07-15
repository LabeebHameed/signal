import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, Posting, Settings, WatchedPage } from "./api";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function TokenGate({ onReady }: { onReady: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="token-gate">
      <h1>Signal</h1>
      <p>Enter the admin token to continue.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setToken(value.trim());
          onReady();
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="admin token"
          autoFocus
        />
        <button type="submit">Save</button>
      </form>
    </div>
  );
}

function PagesSection({ pages, refresh }: { pages: WatchedPage[]; refresh: () => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.addPage(url.trim(), label.trim());
      setUrl("");
      setLabel("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <h2>Watched pages</h2>
      <form className="row" onSubmit={add}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://company.com/careers"
          required
        />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" />
        <button type="submit">Watch</button>
      </form>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Active</th>
            <th>Last checked</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id} className={p.active ? "" : "inactive"}>
              <td>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.label || p.url}
                </a>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={async () => {
                    await api.updatePage(p.id, { active: !p.active });
                    refresh();
                  }}
                />
              </td>
              <td>{timeAgo(p.last_checked_at)}</td>
              <td className={p.last_error ? "error" : ""}>
                {p.last_error ?? (p.first_crawl_done ? "ok" : "pending first crawl")}
              </td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (confirm(`Stop watching ${p.label || p.url}?`)) {
                      await api.deletePage(p.id);
                      refresh();
                    }
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {pages.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">No pages yet — add a careers page above.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function SettingsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  // Secret inputs are write-only: the server never echoes stored values back.
  const [secrets, setSecrets] = useState({ llm_api_key: "", telegram_bot_token: "", jina_api_key: "" });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message));
  }, []);

  if (error && !settings) return <section><h2>Settings</h2><p className="error">{error}</p></section>;
  if (!settings) return <section><h2>Settings</h2><p>Loading…</p></section>;

  const secretPlaceholder = (isSet: boolean) => (isSet ? "•••••• (set — leave blank to keep)" : "not set");

  return (
    <section>
      <h2>Settings</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const updated = await api.saveSettings({
              job_description: settings.job_description,
              telegram_chat_id: settings.telegram_chat_id,
              llm_provider: settings.llm_provider,
              llm_model: settings.llm_model,
              llm_base_url: settings.llm_base_url,
              ...(secrets.llm_api_key.trim() ? { llm_api_key: secrets.llm_api_key.trim() } : {}),
              ...(secrets.telegram_bot_token.trim() ? { telegram_bot_token: secrets.telegram_bot_token.trim() } : {}),
              ...(secrets.jina_api_key.trim() ? { jina_api_key: secrets.jina_api_key.trim() } : {}),
            });
            setSettings(updated);
            setSecrets({ llm_api_key: "", telegram_bot_token: "", jina_api_key: "" });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <label>
          What kind of job are you looking for? <span className="hint">(used by filters in a later version)</span>
          <textarea
            value={settings.job_description}
            onChange={(e) => setSettings({ ...settings, job_description: e.target.value })}
            rows={3}
            placeholder="e.g. Senior frontend engineer, React, remote or Bangalore"
          />
        </label>

        <h3>LLM (extracts postings from pages)</h3>
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
          LLM API key
          <input
            type="password"
            value={secrets.llm_api_key}
            onChange={(e) => setSecrets({ ...secrets, llm_api_key: e.target.value })}
            placeholder={secretPlaceholder(settings.has_llm_api_key)}
          />
        </label>

        <h3>Telegram (receives the notifications)</h3>
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
            Chat ID <span className="hint">(message @userinfobot to get yours)</span>
            <input
              value={settings.telegram_chat_id}
              onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
              placeholder="123456789"
            />
          </label>
        </div>

        <label>
          Jina Reader API key <span className="hint">(optional — only for JS-heavy pages hitting rate limits; free at jina.ai)</span>
          <input
            type="password"
            value={secrets.jina_api_key}
            onChange={(e) => setSecrets({ ...secrets, jina_api_key: e.target.value })}
            placeholder={secretPlaceholder(settings.has_jina_api_key)}
          />
        </label>

        <button type="submit">Save settings</button>
        {saved && <span className="saved">Saved ✓</span>}
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

function PostingsSection({ postings }: { postings: Posting[] }) {
  return (
    <section>
      <h2>Recent postings</h2>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Company</th>
            <th>Location</th>
            <th>Source</th>
            <th>Seen</th>
            <th>Notified</th>
          </tr>
        </thead>
        <tbody>
          {postings.map((p) => (
            <tr key={p.id}>
              <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title}</td>
              <td>{p.company ?? "—"}</td>
              <td>{p.location ?? "—"}</td>
              <td>{p.watched_pages?.label || p.watched_pages?.url || "—"}</td>
              <td>{timeAgo(p.first_seen_at)}</td>
              <td>{p.notified_at ? "✓" : "baseline"}</td>
            </tr>
          ))}
          {postings.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">Nothing extracted yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export default function App() {
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  const [pages, setPages] = useState<WatchedPage[]>([]);
  const [postings, setPostings] = useState<Posting[]>([]);
  const [polling, setPolling] = useState(false);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(() => {
    api.listPages().then(setPages).catch((e) => setLoadError(e.message));
    api.listPostings().then(setPostings).catch(() => {});
  }, []);

  useEffect(() => {
    if (hasToken) refresh();
  }, [hasToken, refresh]);

  if (!hasToken) return <TokenGate onReady={() => setHasToken(true)} />;

  return (
    <main>
      <header>
        <h1>Signal</h1>
        <div>
          <button
            disabled={polling}
            onClick={async () => {
              setPolling(true);
              try {
                await api.poll();
                refresh();
              } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
              } finally {
                setPolling(false);
              }
            }}
          >
            {polling ? "Checking…" : "Check now"}
          </button>
          <button
            className="secondary"
            onClick={() => {
              setToken("");
              setHasToken(false);
            }}
          >
            Log out
          </button>
        </div>
      </header>
      {loadError && (
        <p className="error">
          {loadError} {loadError.includes("unauthorized") && "— check your admin token."}
        </p>
      )}
      <PagesSection pages={pages} refresh={refresh} />
      <SettingsSection />
      <PostingsSection postings={postings} />
    </main>
  );
}
