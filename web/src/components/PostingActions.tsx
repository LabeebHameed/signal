import { useQueryClient } from "@tanstack/react-query";
import { api, Posting, Settings, UserStatus } from "../api";
import { useToast } from "./Toast";

const QUICK_ACTIONS: Array<{ status: UserStatus; label: string }> = [
  { status: "interested", label: "Interested" },
  { status: "not_interested", label: "Not interested" },
  { status: "applied", label: "Applied" },
];

type PostingsListData = { items: Posting[]; total: number };
type PostingsInfiniteData = { pages: PostingsListData[] };

function patchCachedPostings(data: PostingsListData | PostingsInfiniteData | undefined, id: string, patch: Partial<Posting>) {
  if (!data) return data;
  const applyTo = (items: Posting[]) => items.map((p) => (p.id === id ? { ...p, ...patch } : p));
  if ("pages" in data) return { ...data, pages: data.pages.map((pg) => ({ ...pg, items: applyTo(pg.items) })) };
  return { ...data, items: applyTo(data.items) };
}

/**
 * Records what the seeker did with a posting — feeds straight back into the
 * judge's calibration context on every future screening call (see judge.ts /
 * loadCalibration in poll-pages). Optimistic across every cached postings
 * query (Inbox, Postings, Dashboard's recent list all key off
 * "postings"), reverted with a toast if the write actually fails.
 */
function useSetPostingStatus() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return (posting: Posting, status: UserStatus) => {
    // Clicking an already-active quick action undoes it back to "none".
    const next: UserStatus = posting.user_status === status ? "none" : status;
    const patch = { user_status: next, user_status_at: new Date().toISOString() };
    queryClient.setQueriesData<PostingsListData | PostingsInfiniteData | undefined>(
      { queryKey: ["postings"] },
      (data) => patchCachedPostings(data, posting.id, patch),
    );
    api.updatePostingStatus(posting.id, next)
      .then(() => {
        // Refetch so changes are immediately visible across pages.
        queryClient.invalidateQueries({ queryKey: ["postings"] });
      })
      .catch((e) => {
        queryClient.invalidateQueries({ queryKey: ["postings"] });
        toast.show(e instanceof Error ? e.message : String(e), "error");
      });
  };
}

/** Interested / Not interested / Applied — the three calls that matter for
 * calibrating the judge. */
export function PostingActions({ posting }: { posting: Posting }) {
  const setStatus = useSetPostingStatus();
  return (
    <div className="posting-actions">
      {QUICK_ACTIONS.map(({ status, label }) => (
        <button
          key={status}
          type="button"
          className={`action-btn${posting.user_status === status ? " active" : ""}`}
          onClick={() => setStatus(posting, status)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Adds this posting's company to settings.blocked_companies — future
 * postings from it are filtered deterministically, before the LLM judge
 * ever sees them (see _shared/company.ts isCompanyBlocked). */
export function BlockCompanyButton({ posting }: { posting: Posting }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const company = posting.companies?.display_name || posting.company;
  if (!company) return null;

  const block = async () => {
    if (!confirm(`Block ${company}? Future postings from this company will be filtered out automatically.`)) return;
    try {
      const settings = queryClient.getQueryData<Settings>(["settings"]);
      const current = settings?.blocked_companies ?? "";
      const list = current.split("\n").map((s) => s.trim()).filter(Boolean);
      if (list.some((c) => c.toLowerCase() === company.toLowerCase())) {
        toast.show(`${company} is already blocked`);
        return;
      }
      list.push(company);
      const updated = await api.saveSettings({ blocked_companies: list.join("\n") });
      queryClient.setQueryData(["settings"], updated);
      toast.show(`Blocked ${company} — future postings from them are filtered automatically`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <button type="button" className="action-btn danger-text" onClick={block}>
      Block company
    </button>
  );
}
