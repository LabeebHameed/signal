import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { InboxIcon, InfoIcon } from "lucide-react";

import { api, profileHasContent } from "@/api";
import { JobCard } from "@/components/JobCard";
import { Page, PageHeader } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

const PAGE_SIZE = 20;

function JobCardSkeleton() {
  return (
    <Card size="sm" className="h-full">
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="grid gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-3/4" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-4xl" />
          <Skeleton className="h-5 w-20 rounded-4xl" />
        </div>
        <Skeleton className="h-px w-full rounded-none" />
        <div className="flex items-end justify-between gap-3">
          <div className="grid gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-28 rounded-4xl" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The payoff surface: only the postings that came out of the filter, as
 * cards, each carrying the judge's reasoning and the researched company
 * background. Nothing here is ever hidden by the company layer — a shady
 * company is simply shown as that.
 */
export default function InboxPage() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, error } = useInfiniteQuery({
    queryKey: ["postings", "first_seen_at", "desc", "matched"],
    queryFn: ({ pageParam }) =>
      api.listPostings({ limit: PAGE_SIZE, offset: pageParam, sort: "first_seen_at", order: "desc", status: "matched" }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 30_000,
  });

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const noProfile = Boolean(settings) && !profileHasContent(settings!.filter_profile);

  return (
    <Page className="max-w-6xl">
      <PageHeader
        title="Inbox"
        description={`${total} posting${total === 1 ? "" : "s"} that fit your profile.`}
      />

      {noProfile && (
        <Card size="sm">
          <CardContent className="flex items-start gap-3">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No profile yet, so every new posting is notified as-is. Describe what you're looking for on the{" "}
              <Link to="/profile" className="text-primary underline-offset-4 hover:underline">
                Profile page
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <JobCardSkeleton key={i} />
          ))}
        </div>
      ) : items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => (
            <JobCard key={p.id} posting={p} />
          ))}
        </div>
      ) : (
        !noProfile && (
          <Card>
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon />
                  </EmptyMedia>
                  <EmptyTitle>No matches yet</EmptyTitle>
                  <EmptyDescription>
                    They appear here as soon as a new posting fits the profile you described on the{" "}
                    <Link to="/profile" className="text-primary underline-offset-4 hover:underline">
                      Profile page
                    </Link>
                    .
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        )
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
            {isFetchingNextPage && <Spinner />}
            {isFetchingNextPage ? "Loading…" : `Load more (${total - items.length} remaining)`}
          </Button>
        </div>
      )}
    </Page>
  );
}
