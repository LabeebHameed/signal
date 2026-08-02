import { Link } from "react-router-dom";
import {
  BriefcaseIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SendIcon,
} from "lucide-react";

import type { Posting } from "@/api";
import { PostingStatusPill } from "@/components/PostingStatus";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { resolvePostingLink } from "@/lib/parsePosting";

/**
 * How many rows the card shows before you go to the Postings page for the
 * rest. Drives both the query's limit and the skeleton's row count, so the
 * loading state is exactly the height of the list that replaces it.
 */
export const RECENT_POSTINGS_LIMIT = 7;

/** The row's category icon, chosen from where the posting sits in the
 * pipeline — the same role the merchant-category icon plays in the shadcn
 * transactions table. */
function rowIcon(posting: Posting) {
  if (posting.notified_at) return <SendIcon />;
  if (posting.duplicate_of) return <CopyIcon />;
  if (posting.filter_status === "matched") return <CircleCheckIcon />;
  if (posting.filter_status === "filtered") return <CircleSlashIcon />;
  if (posting.filter_status === "pending") return <SearchIcon />;
  return <BriefcaseIcon />;
}

function RowActions({ posting }: { posting: Posting }) {
  const link = resolvePostingLink(posting);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="size-8 text-muted-foreground" />}
        aria-label={`Actions for ${posting.title}`}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          disabled={!link.href}
          render={
            link.href ? <a href={link.href} target="_blank" rel="noreferrer" /> : <div />
          }
        >
          <ExternalLinkIcon />
          {link.isDirect ? "Open posting" : "Open source page"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!posting.url}
          onClick={() => posting.url && navigator.clipboard.writeText(posting.url)}
        >
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/postings" />}>
          <BriefcaseIcon />
          View in Postings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: RECENT_POSTINGS_LIMIT }).map((_, i) => (
        <TableRow key={i} className="hover:bg-transparent">
          <TableCell className="w-11 px-0 py-4">
            <Skeleton className="size-11 rounded-xl" />
          </TableCell>
          <TableCell className="w-full max-w-0 py-4 pr-3 pl-4">
            <div className="grid gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-28" />
            </div>
          </TableCell>
          <TableCell className="px-3 py-4">
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell className="px-3 py-4 text-right">
            <Skeleton className="ml-auto h-5 w-16" />
          </TableCell>
          <TableCell className="w-8 px-0 py-4">
            <Skeleton className="size-8 rounded-lg" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/**
 * The dashboard's activity feed, laid out as the shadcn "Recent
 * Transactions" table: a category icon tile, a two-line primary cell, a
 * muted timestamp, the row's payoff value right-aligned, and a row-actions
 * menu — one separator between rows, none after the last.
 */
export function RecentPostings({
  postings,
  isLoading,
}: {
  postings: Posting[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Recent Postings</CardTitle>
        <CardDescription>The latest jobs Signal extracted.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" render={<Link to="/postings" />}>
            View All
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableBody>
            {isLoading && postings.length === 0 && <SkeletonRows />}

            {postings.map((posting) => {
              const link = resolvePostingLink(posting);
              const source = posting.watched_pages?.label || posting.watched_pages?.url;
              return (
                <TableRow key={posting.id}>
                  <TableCell className="w-11 px-0 py-4">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
                      {rowIcon(posting)}
                    </div>
                  </TableCell>
                  <TableCell className="w-full max-w-0 py-4 pr-3 pl-4">
                    <div className="grid gap-0.5">
                      {link.isDirect && link.href ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-medium text-foreground hover:underline"
                        >
                          {posting.title}
                        </a>
                      ) : (
                        <span className="truncate font-medium text-foreground">{posting.title}</span>
                      )}
                      <span className="truncate text-sm text-muted-foreground">
                        {[posting.companies?.display_name || posting.company, source]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden px-3 py-4 text-muted-foreground sm:table-cell">
                    {timeAgo(posting.first_seen_at)}
                  </TableCell>
                  <TableCell className="px-3 py-4 text-right">
                    <PostingStatusPill posting={posting} />
                  </TableCell>
                  <TableCell className="w-8 px-0 py-4 text-right">
                    <RowActions posting={posting} />
                  </TableCell>
                </TableRow>
              );
            })}

            {!isLoading && postings.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-0 py-4">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <BriefcaseIcon />
                      </EmptyMedia>
                      <EmptyTitle>Nothing extracted yet</EmptyTitle>
                      <EmptyDescription>
                        Add a careers page on the Sources tab, then run a check.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
