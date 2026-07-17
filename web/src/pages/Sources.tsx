import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, WatchedPage } from "../api";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { timeAgo, truncate } from "../lib/format";

export default function Sources() {
  const [pages, setPages] = useState<WatchedPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api
      .listPages()
      .then(setPages)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Optimistic: flip the switch instantly; only revert if the request actually fails.
  const toggleActive = (page: WatchedPage) => {
    const next = !page.active;
    setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, active: next } : p)));
    api.updatePage(page.id, { active: next }).catch((e) => {
      setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, active: page.active } : p)));
      toast.show(e instanceof Error ? e.message : String(e), "error");
    });
  };

  const removePage = (page: WatchedPage) => {
    if (!confirm(`Stop watching ${page.label || page.url}?`)) return;
    const previous = pages;
    setPages((prev) => prev.filter((p) => p.id !== page.id));
    api.deletePage(page.id).catch((e) => {
      setPages(previous);
      toast.show(e instanceof Error ? e.message : String(e), "error");
    });
  };

  const addPages = async (e: FormEvent) => {
    e.preventDefault();
    const urls = bulkText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    setAdding(true);
    try {
      const res = await api.addPages(urls);
      setBulkText("");
      load();
      const parts = [`Added ${res.addedCount}`];
      if (res.skippedCount > 0) parts.push(`${res.skippedCount} already watched`);
      if (res.invalid.length > 0) parts.push(`${res.invalid.length} invalid`);
      toast.show(parts.join(" · "), res.invalid.length > 0 ? "error" : "success");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Sources</h1>
          <p className="page-subtitle">Career pages Signal checks for new postings.</p>
        </div>
      </header>

      <section className="card">
        <form className="add-form" onSubmit={addPages}>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"Paste one or more career page URLs, one per line:\nhttps://dribbble.com/jobs\nhttps://jobs.lever.co/plaid"}
            rows={3}
          />
          <button type="submit" disabled={adding}>
            {adding ? "Adding…" : "Watch pages"}
          </button>
        </form>
        <p className="hint">
          Already-watched URLs are skipped; new ones are labeled from their site (e.g. dribbble.com → Dribbble).
        </p>
      </section>

      <section className="card">
        {loadError && <p className="error">{loadError}</p>}
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
                  <Toggle checked={p.active} onChange={() => toggleActive(p)} />
                </td>
                <td className="muted">{timeAgo(p.last_checked_at)}</td>
                <td>
                  {p.last_error ? (
                    <StatusPill tone="error" title={p.last_error}>
                      {truncate(p.last_error, 44)}
                    </StatusPill>
                  ) : p.first_crawl_done ? (
                    <StatusPill tone="ok">ok</StatusPill>
                  ) : (
                    <StatusPill tone="pending">pending first crawl</StatusPill>
                  )}
                </td>
                <td>
                  <button className="danger" onClick={() => removePage(p)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!loading && pages.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No pages yet — add a careers page above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
