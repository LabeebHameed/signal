import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { api, FilterStatus, PostingSort } from "@/api";
import { CompanyBadge } from "@/components/CompanyPanel";
import { Page, PageHeader } from "@/components/PageShell";
import { PostingStatusPill, VerdictPill } from "@/components/PostingStatus";
import { PostingVerdictDetail } from "@/components/PostingVerdictDetail";
import { StatusPill } from "@/components/StatusPill";
import { SelectCombobox, type SelectOption } from "@/components/ui-ext/select-combobox";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { resolvePostingLink } from "@/lib/parsePosting";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All postings" },
  { value: "matched", label: "Matched" },
  { value: "filtered", label: "Filtered out" },
  { value: "pending", label: "Awaiting screening" },
  { value: "skipped", label: "Not screened" },
];

const VALID_STATUSES: ReadonlyArray<FilterStatus> = ["pending", "matched", "filtered", "skipped"];

const COLUMN_COUNT = 6;

/**
 * The page numbers to render: always the first and last page, the current
 * page with a neighbour either side, and an ellipsis wherever that skips a
 * run. Returns e.g. [1, "…", 4, 5, 6, "…", 20].
 */
function pageItems(current: number, count: number): Array<number | "ellipsis"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);

  const items: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(count - 1, current + 1);

  if (start > 2) items.push("ellipsis");
  for (let p = start; p <= end; p++) items.push(p);
  if (end < count - 1) items.push("ellipsis");
  items.push(count);

  return items;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <TableRow key={i} className="hover:bg-transparent">
          {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
            <TableCell key={j} className="py-3.5">
              <Skeleton className={cn("h-4", j === 0 ? "w-56" : "w-20")} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export default function Postings() {
  const [searchParams] = useSearchParams();
  const [sort, setSort] = useState<PostingSort>("first_seen_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  // Seeds from ?status= (e.g. a "View all in Postings" link from the
  // Workflow page) once on mount — status itself still lives in local
  // state afterward, same as the rest of this page's filters.
  const [status, setStatus] = useState<FilterStatus | "">(() => {
    const fromUrl = searchParams.get("status");
    return VALID_STATUSES.includes(fromUrl as FilterStatus) ? (fromUrl as FilterStatus) : "";
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // Any filter/sort change re-slices the whole result set, so the current
  // page number no longer refers to the same rows — start over at page 1.
  useEffect(() => {
    setPage(1);
    setExpanded(null);
  }, [sort, order, status]);

  const { data, isLoading, isPlaceholderData, error } = useQuery({
    queryKey: ["postings", sort, order, status, page],
    queryFn: () =>
      api.listPostings({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, sort, order, status }),
    placeholderData: (previous) => previous,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const sortBy = (field: PostingSort) => {
    if (sort === field) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(field);
      setOrder(field === "title" || field === "company" ? "asc" : "desc");
    }
  };

  const SortHead = ({ field, children }: { field: PostingSort; children: React.ReactNode }) => (
    <TableHead
      className="cursor-pointer select-none hover:text-foreground/80"
      onClick={() => sortBy(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sort === field &&
          (order === "desc" ? (
            <ArrowDownIcon className="size-3.5" />
          ) : (
            <ArrowUpIcon className="size-3.5" />
          ))}
      </span>
    </TableHead>
  );

  const statusLabel = STATUS_OPTIONS.find((o) => o.value === status)?.label.toLowerCase();

  return (
    <Page className="max-w-6xl">
      <PageHeader
        title="Postings"
        description={
          <>
            {total} {status === "" ? "extracted" : statusLabel} · click a row for the judge's reasoning
          </>
        }
        action={
          <div className="w-56">
            <SelectCombobox
              options={STATUS_OPTIONS}
              value={status}
              onValueChange={(next) => setStatus(next as FilterStatus | "")}
              placeholder="All postings"
              searchPlaceholder="Filter status…"
              aria-label="Filter by status"
            />
          </div>
        }
      />

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
                <SortHead field="title">Title</SortHead>
                <SortHead field="company">Company</SortHead>
                <TableHead>Location</TableHead>
                <SortHead field="first_seen_at">Seen</SortHead>
                <TableHead>Match</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={cn(isPlaceholderData && "opacity-60 transition-opacity")}>
              {isLoading && <SkeletonRows />}

              {items.map((p) => {
                const link = resolvePostingLink(p);
                return (
                  <Fragment key={p.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                    >
                      <TableCell className="w-full max-w-0 py-3.5">
                        <span className="flex items-center gap-2">
                          {link.isDirect && link.href ? (
                            <a
                              href={link.href}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="truncate font-medium hover:underline"
                            >
                              {p.title}
                            </a>
                          ) : (
                            <span className="truncate font-medium">{p.title}</span>
                          )}
                          {p.duplicate_of && (
                            <StatusPill
                              tone="muted"
                              title="A matching posting from another source was already notified"
                            >
                              dup
                            </StatusPill>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="py-3.5">
                        <span className="flex items-center gap-2">
                          {p.companies?.display_name || p.company || "—"}
                          <CompanyBadge posting={p} />
                        </span>
                      </TableCell>
                      <TableCell className="py-3.5 text-muted-foreground">
                        {p.location ?? "—"}
                      </TableCell>
                      <TableCell className="py-3.5 text-muted-foreground">
                        {timeAgo(p.first_seen_at)}
                      </TableCell>
                      <TableCell className="py-3.5">
                        <VerdictPill posting={p} />
                      </TableCell>
                      <TableCell className="py-3.5">
                        <PostingStatusPill posting={p} />
                      </TableCell>
                    </TableRow>
                    {expanded === p.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30 p-4 whitespace-normal">
                          <PostingVerdictDetail posting={p} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}

              {items.length === 0 && !isLoading && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT}>
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>
                          {status === "" ? "Nothing extracted yet" : "No postings match these filters"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {status === ""
                            ? "Add a careers page on the Sources tab, then run a check."
                            : "Try a different status filter."}
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

      {pageCount > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={page === 1}
                className={cn(page === 1 && "pointer-events-none opacity-50")}
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.max(1, p - 1));
                }}
              />
            </PaginationItem>

            {pageItems(page, pageCount).map((item, i) =>
              item === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={item}>
                  <PaginationLink
                    href="#"
                    isActive={item === page}
                    onClick={(e) => {
                      e.preventDefault();
                      setPage(item);
                    }}
                  >
                    {item}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}

            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={page === pageCount}
                className={cn(page === pageCount && "pointer-events-none opacity-50")}
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.min(pageCount, p + 1));
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </Page>
  );
}
