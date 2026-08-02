import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";

import { api, WatchedPage } from "@/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { Page, PageHeader } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { isBlockedSourceError, isLinkQualityWarning, timeAgo, truncate } from "@/lib/format";
import { cn } from "@/lib/utils";

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
const COLUMN_COUNT = 5;

function isPageChecking(p: WatchedPage, pendingCheck: PendingCheck | null): boolean {
  if (!pendingCheck || !pendingCheck.ids.has(p.id)) return false;
  if (!p.last_checked_at) return true;
  return new Date(p.last_checked_at).getTime() < pendingCheck.startedAt;
}

function SourceStatus({ page, checking }: { page: WatchedPage; checking: boolean }) {
  if (checking) return <StatusPill tone="checking">checking now</StatusPill>;
  if (isBlockedSourceError(page.last_error)) {
    return (
      <StatusPill tone="pending" title={page.last_error ?? undefined}>
        blocked by site
      </StatusPill>
    );
  }
  if (isLinkQualityWarning(page.last_error)) {
    return (
      <StatusPill tone="pending" title={page.last_error ?? undefined}>
        links unreliable
      </StatusPill>
    );
  }
  if (page.last_error) {
    return (
      <StatusPill tone="error" title={page.last_error}>
        {truncate(page.last_error, 44)}
      </StatusPill>
    );
  }
  if (page.first_crawl_done) return <StatusPill tone="ok">ok</StatusPill>;
  return <StatusPill tone="pending">pending first crawl</StatusPill>;
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
  const confirm = useConfirm();

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

  const removePage = async (page: WatchedPage) => {
    const ok = await confirm({
      title: "Stop watching this source?",
      description: `${page.label || page.url} will no longer be checked for new postings. Postings already extracted from it are kept.`,
      confirmLabel: "Stop watching",
      destructive: true,
    });
    if (!ok) return;

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
    <Page>
      <PageHeader
        title="Sources"
        description="Career pages Signal checks for new postings."
        action={
          <Button disabled={Boolean(pendingCheck)} onClick={checkNow}>
            {pendingCheck ? <Spinner /> : <RefreshCwIcon />}
            {pendingCheck ? "Checking…" : "Check now"}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Add sources</CardTitle>
          <CardDescription>Paste one or more career page URLs, one per line.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={addPages} className="flex flex-col gap-6">
            <Field>
              <FieldLabel htmlFor="sources-bulk">Career page URLs</FieldLabel>
              <Textarea
                id="sources-bulk"
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"https://dribbble.com/jobs\nhttps://jobs.lever.co/plaid"}
                rows={3}
              />
              <FieldDescription>
                Already-watched URLs are skipped; new ones are labeled from their site (e.g. dribbble.com →
                Dribbble).
              </FieldDescription>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={adding}>
                {adding && <Spinner />}
                {adding ? "Adding…" : "Watch pages"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-0">
          {error && (
            <p className="pb-4 text-sm text-destructive">
              {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Page</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i} className="hover:bg-transparent">
                    {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
                      <TableCell key={j} className="py-3.5">
                        <Skeleton className={cn("h-4", j === 0 ? "w-48" : "w-16")} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {pages.map((p) => {
                const checking = isPageChecking(p, pendingCheck);
                return (
                  <TableRow key={p.id} className={cn(!p.active && "opacity-50")}>
                    <TableCell className="w-full max-w-0 py-3.5">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate font-medium hover:underline"
                      >
                        {p.label || p.url}
                      </a>
                    </TableCell>
                    <TableCell className="py-3.5">
                      <Switch
                        checked={p.active}
                        onCheckedChange={() => toggleActive(p)}
                        aria-label={`${p.active ? "Pause" : "Resume"} ${p.label || p.url}`}
                      />
                    </TableCell>
                    <TableCell
                      className={cn("py-3.5", checking ? "text-sky-400" : "text-muted-foreground")}
                    >
                      {checking ? "Checking…" : timeAgo(p.last_checked_at)}
                    </TableCell>
                    <TableCell className="py-3.5">
                      <SourceStatus page={p} checking={checking} />
                    </TableCell>
                    <TableCell className="py-3.5 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${p.label || p.url}`}
                        onClick={() => removePage(p)}
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}

              {!isLoading && pages.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT}>
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No sources yet</EmptyTitle>
                        <EmptyDescription>Add a careers page above to start watching it.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Page>
  );
}
