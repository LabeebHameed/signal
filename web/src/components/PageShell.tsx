import { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Every route renders inside this. The `p-6` / `gap-6` rhythm is the same
 * `--card-spacing` (--spacing(6) = 24px) the brand preset's Card uses, so
 * page padding, the gaps between cards, and the padding inside a card all
 * line up on one 24px grid.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-6 p-6", className)}>
      {children}
    </div>
  );
}

/** Wider column for the Workflow page's graph + inspector split. */
export function WidePage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex w-full flex-col gap-6 p-6", className)}>{children}</div>
  );
}

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
