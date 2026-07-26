import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, WatchedPage } from "../api";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { isBlockedSourceError, isLinkQualityWarning, timeAgo, truncate } from "../lib/format";

// A snapshot of which pages a "Check now" run covers and when it started —
// used to show a live "checking…" state per row instead of the previous
// (now stale) last-checked value until each page's real result lands.
interface PendingCheck {
  startedAt: number;
  ids: Set<string>;
}

const FAST_POLL_MS = 2500;
const NORMAL_POLL_MS = 20_000;
const CHECK_TIMEOUT_MS = 3 * 60_000;

function isPageChecking(p: WatchedPage, pendingCheck: PendingCheck | null): boolean {
  if (!pendingCheck || !pendingCheck.ids.has(p.id)) return false;
  if (!p.last_checked_at) return true;
  return new Date(p.last_checked_at).getTime() < pendingCheck.startedAt;
}

export default function Sources() {
  const queryClient = useQueryClient();
  const [pendingCheck, setPendingCheck] = useState<PendingCheck | null>(null);
  const { data: pages = [], isLoading, error } = useQuery({
    queryKey: ["pages"],
    queryFn: api.listPages,
    // While a check is in flight, poll fast so each row's status flips from
    // "checking…" to its real result as soon as it actually lands.
    refetchInterval: pendingCheck ? FAST_POLL_MS : NORMAL_POLL_MS,
  });
  const [bulkText, setBulkText] = useState("");
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  // Once every page in the run has a fresher last_checked_at than when the
  // run started, the run is done — drop back to normal polling.
  useEffect(() => {
    if (!pendingCheck) return;
    const stillChecking = pages.some((p) => isPageChecking(p, pendingCheck));
    if (!stillChecking) setPendingCheck(null);
  }, [pages, pendingCheck]);

  // Safety net: never poll fast forever if a run hangs or a page never reports back.
  useEffect(() => {
    if (!pendingCheck) return;
    const timer = setTimeout(() => setPendingCheck(null), CHECK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingCheck]);

  const checkNow = async () => {
    const ids = new Set(pages.filter((p) => p.active).map((p) => p.id));
    if (ids.size === 0) {
      toast.show("No active sources to check", "error");
      return;
    }
    setPendingCheck({ startedAt: Date.now(), ids });
    try {
      await api.poll();
      toast.show(`Checking ${ids.size} source${ids.size === 1 ? "" : "s"} — this table updates live.`);
    } catch (e) {
      setPendingCheck(null);
      toast.show(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // Optimistic: flip the switch instantly; only revert if the request actually fails.
  const toggleActive = (page: WatchedPage) => {
    const next = !page.active;
    queryClient.setQueryData<WatchedPage[]>(["pages"], (prev) =>
      prev?.map((p) => (p.id === page.id ? { ...p, active: next } : p)));
    api.updatePage(page.id, { active: next }).catch((e) => {
      queryClient.setQueryData<WatchedPage[]>(["pages"], (prev) =>
        prev?.map((p) => (p.id === page.id ? { ...p, active: page.active } : p)));
      toast.show(e instanceof Error ? e.message : String(e), "error");
    });
  };

  const removePage = (page: WatchedPage) => {
    if (!confirm(`Stop watching ${page.label || page.url}?`)) return;
    const previous = pages;
    queryClient.setQueryData<WatchedPage[]>(["pages"], (prev) => prev?.filter((p) => p.id !== page.id));
    api.deletePage(page.id).catch((e) => {
      queryClient.setQueryData<WatchedPage[]>(["pages"], previous);
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
      queryClient.invalidateQueries({ queryKey: ["pages"] });
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
        <button disabled={Boolean(pendingCheck)} onClick={checkNow}>
          {pendingCheck ? "Checking…" : "Check now"}
        </button>
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
        {error && <p className="error">{error instanceof Error ? error.message : String(error)}</p>}
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
            {pages.map((p) => {
              const checking = isPageChecking(p, pendingCheck);
              return (
                <tr key={p.id} className={p.active ? "" : "inactive"}>
                  <td>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {p.label || p.url}
                    </a>
                  </td>
                  <td>
                    <Toggle checked={p.active} onChange={() => toggleActive(p)} />
                  </td>
                  <td className={checking ? "checking-text" : "muted"}>
                    {checking ? "Checking…" : timeAgo(p.last_checked_at)}
                  </td>
                  <td>
                    {checking ? (
                      <StatusPill tone="checking">checking now</StatusPill>
                    ) : isBlockedSourceError(p.last_error) ? (
                      <StatusPill tone="pending" title={p.last_error ?? undefined}>
                        blocked by site
                      </StatusPill>
                    ) : isLinkQualityWarning(p.last_error) ? (
                      <StatusPill tone="pending" title={p.last_error ?? undefined}>
                        links unreliable
                      </StatusPill>
                    ) : p.last_error ? (
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
              );
            })}
            {!isLoading && pages.length === 0 && (
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
