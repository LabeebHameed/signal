import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { api } from "@/api";
import { Page, PageHeader } from "@/components/PageShell";
import { RecentPostings } from "@/components/RecentPostings";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

function StatCard({
  value,
  label,
  to,
  flag,
  isLoading,
}: {
  value: ReactNode;
  label: string;
  to?: string;
  flag?: string;
  isLoading?: boolean;
}) {
  const body = (
    <Card size="sm" className={cn("h-full", to && "transition-colors hover:bg-muted/40")}>
      <CardContent className="grid gap-1">
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <span className="font-heading text-2xl font-medium tracking-tight">{value}</span>
        )}
        <span className="text-sm text-muted-foreground">{label}</span>
        {flag && <span className="text-xs text-destructive">{flag}</span>}
      </CardContent>
    </Card>
  );

  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [polling, setPolling] = useState(false);
  const toast = useToast();

  const { data: pages = [], isLoading: pagesLoading } = useQuery({
    queryKey: ["pages"],
    queryFn: api.listPages,
  });
  const { data: recentPage, isLoading: postingsLoading } = useQuery({
    queryKey: ["postings", "recent"],
    queryFn: () => api.listPostings({ limit: 8, sort: "first_seen_at", order: "desc" }),
  });
  // The most recent matches, used both for the "matches today" count and
  // (via .total) how many have ever matched — one query covers both.
  const { data: matchedRecent } = useQuery({
    queryKey: ["postings", "first_seen_at", "desc", "matched", "", "dashboard"],
    queryFn: () => api.listPostings({ limit: 50, sort: "first_seen_at", order: "desc", status: "matched" }),
  });
  // limit: 1 — only the total count is needed, not the rows themselves.
  const { data: pendingQueue } = useQuery({
    queryKey: ["postings", "pending", "count"],
    queryFn: () => api.listPostings({ limit: 1, status: "pending" }),
  });
  const { data: lastNotified } = useQuery({
    queryKey: ["postings", "notified_at", "desc", "", "", "dashboard"],
    queryFn: () => api.listPostings({ limit: 1, sort: "notified_at", order: "desc" }),
  });
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const loading = pagesLoading || postingsLoading || settingsLoading;
  const recent = recentPage?.items ?? [];
  const totalPostings = recentPage?.total ?? 0;

  const checkNow = async () => {
    setPolling(true);
    try {
      const activeCount = pages.filter((p) => p.active).length;
      await api.poll();
      toast.show(
        `Started checking ${activeCount} source${activeCount === 1 ? "" : "s"} — new postings will appear here automatically.`,
      );
      // A background run takes anywhere from a few seconds to a couple
      // minutes depending on page count; a few staggered refetches surface
      // progress sooner than waiting on the normal 20s background interval.
      [5000, 15000, 30000, 60000].forEach((ms) =>
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["pages"] });
          queryClient.invalidateQueries({ queryKey: ["postings"] });
        }, ms)
      );
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setPolling(false);
    }
  };

  const activeCount = pages.filter((p) => p.active).length;
  const errorCount = pages.filter((p) => p.active && p.last_error).length;
  const lastChecked = pages.reduce<string | null>((latest, p) => {
    if (!p.last_checked_at) return latest;
    return !latest || p.last_checked_at > latest ? p.last_checked_at : latest;
  }, null);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const matchesToday = (matchedRecent?.items ?? []).filter((p) => new Date(p.first_seen_at) >= startOfToday).length;
  const pendingTotal = pendingQueue?.total ?? 0;
  const lastNotifiedAt = lastNotified?.items?.[0]?.notified_at ?? null;

  const llmConfigured = Boolean(settings?.llm_provider && settings?.llm_model && settings?.has_llm_api_key);
  const telegramConfigured = Boolean(settings?.has_telegram_bot_token && settings?.telegram_chat_id);
  const showSetupBanner = !loading && settings && (!llmConfigured || !telegramConfigured);

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description={`Last checked ${timeAgo(lastChecked)}`}
        action={
          <Button disabled={polling} onClick={checkNow}>
            {polling ? <Spinner /> : <RefreshCwIcon />}
            {polling ? "Starting…" : "Check now"}
          </Button>
        }
      />

      {showSetupBanner && (
        <Card size="sm" className="ring-amber-500/30">
          <CardContent className="flex items-start gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              {!llmConfigured && "LLM isn't configured yet, so postings can't be extracted. "}
              {!telegramConfigured && "Telegram isn't configured yet, so you won't get notifications. "}
              <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                Finish setup in Settings →
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard value={matchesToday} label="Matches today" to="/inbox" isLoading={loading} />
        <StatCard value={pendingTotal} label="Awaiting screening" to="/postings" isLoading={loading} />
        <StatCard
          value={
            <>
              {activeCount}
              <span className="text-muted-foreground">/{pages.length}</span>
            </>
          }
          label="Active sources"
          to="/sources"
          flag={errorCount > 0 ? `${errorCount} with errors` : undefined}
          isLoading={loading}
        />
        <StatCard value={timeAgo(lastNotifiedAt)} label="Last Telegram send" isLoading={loading} />
        <StatCard value={totalPostings} label="Postings extracted" to="/postings" isLoading={loading} />
      </section>

      <RecentPostings postings={recent} isLoading={loading} />
    </Page>
  );
}
