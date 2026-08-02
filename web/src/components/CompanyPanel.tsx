import { CompanyLegitimacy, Posting } from "../api";
import { StatusPill } from "./StatusPill";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const LEGITIMACY_LABELS: Record<CompanyLegitimacy | "unknown", { label: string; tone: "ok" | "pending" | "error" | "muted" }> = {
  verified: { label: "✓ verified", tone: "ok" },
  likely_real: { label: "✓ likely real", tone: "ok" },
  uncertain: { label: "? unverified", tone: "pending" },
  suspicious: { label: "⚠ suspicious", tone: "error" },
  unknown: { label: "unknown", tone: "muted" },
};

/** Small legitimacy badge shown next to a company name. */
export function CompanyBadge({ posting }: { posting: Posting }) {
  if (posting.company_status === "pending") return <StatusPill tone="checking">checking…</StatusPill>;
  const legitimacy = posting.companies?.legitimacy;
  if (!legitimacy || legitimacy === "unknown") return null;
  const { label, tone } = LEGITIMACY_LABELS[legitimacy];
  return (
    <StatusPill tone={tone} title={posting.company_verdict?.reason || undefined}>
      {label}
    </StatusPill>
  );
}

/**
 * The researched company background attached to a posting: what the company
 * does, size/stage/funding, red flags, the verdict's caution when there is
 * one, and the sources the research drew on.
 */
export function CompanyPanel({ posting }: { posting: Posting }) {
  if (posting.company_status === "pending") {
    return (
      <p className="text-sm text-muted-foreground">
        Researching this company — background appears on the next check…
      </p>
    );
  }
  const dossier = posting.companies?.dossier;
  if (!dossier) return null;

  const facts = [
    dossier.industry,
    dossier.size_estimate,
    dossier.stage,
    dossier.funding,
    dossier.founded ? `founded ${dossier.founded}` : null,
  ].filter(Boolean);

  return (
    <div className="mt-3 grid gap-2 rounded-xl bg-muted/40 p-4 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <strong className="font-medium">{posting.companies?.display_name || dossier.name}</strong>
        <CompanyBadge posting={posting} />
        {dossier.website && (
          <a
            href={dossier.website}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-primary underline-offset-4 hover:underline"
          >
            {dossier.website.replace(/^https?:\/\//, "")}
          </a>
        )}
      </p>
      {posting.company_verdict?.decision === "warn" && posting.company_verdict.reason && (
        <p className="text-amber-500">⚠️ {posting.company_verdict.reason}</p>
      )}
      {dossier.summary && <p className="text-muted-foreground">{dossier.summary}</p>}
      {facts.length > 0 && <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>}
      {dossier.flags.length > 0 && (
        <ul className="list-disc pl-4 text-amber-500">
          {dossier.flags.map((flag, i) => (
            <li key={i}>{flag}</li>
          ))}
        </ul>
      )}
      {dossier.sources.length > 0 && (
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          Sources:{" "}
          {dossier.sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-primary underline-offset-4 hover:underline"
            >
              {s.title || hostnameOf(s.url)}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}
