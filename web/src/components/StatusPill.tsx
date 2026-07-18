import { ReactNode } from "react";

type Tone = "ok" | "error" | "muted" | "pending" | "checking";

export function StatusPill({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}
