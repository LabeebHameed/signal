import { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "ok" | "error" | "muted" | "pending" | "checking";

/** One tone vocabulary for every status pill in the app, expressed in brand
 * tokens: "ok" is the brand's emerald, everything else steps down from it. */
const TONE_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-400",
  error: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
  pending: "bg-amber-500/15 text-amber-500",
  checking: "bg-sky-500/15 text-sky-400 animate-pulse",
};

export function StatusPill({
  tone,
  title,
  className,
  children,
}: {
  tone: Tone;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="secondary" title={title} className={cn(TONE_CLASSES[tone], className)}>
      {children}
    </Badge>
  );
}
