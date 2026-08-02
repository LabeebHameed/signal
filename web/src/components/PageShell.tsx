import { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Every route renders inside this. Pages take the full width of the inset —
 * no centered reading column — so the layout tracks the browser window at
 * every size. Padding steps up with the viewport and lands on the same
 * `--card-spacing` (--spacing(6) = 24px) the brand preset's Card uses, so
 * page padding, the gaps between cards, and the padding inside a card all
 * line up on one grid.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-4 p-4 md:gap-6 md:p-6", className)}>
      {children}
    </div>
  );
}

/** Alias kept for the Workflow page, which reads as its own kind of layout. */
export const WidePage = Page;

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-2">
        <h1 className="font-heading text-2xl font-medium tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </header>
  );
}
