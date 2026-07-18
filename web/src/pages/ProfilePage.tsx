import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, FilterMode, FilterProfile, Settings } from "../api";
import { useToast } from "../components/Toast";

/** Field order + labels for the derived-profile editor (mirrors the judge's view). */
const PROFILE_FIELDS: Array<{
  key: keyof FilterProfile;
  label: string;
  hint?: string;
  rows?: number;
  placeholder: string;
}> = [
  { key: "roles", label: "Target roles", placeholder: "e.g. Design engineer" },
  {
    key: "role_synonyms",
    label: "Equivalent titles",
    hint: "other names companies use for the same work — the judge treats any of these as the target role",
    placeholder: "e.g. UX Engineer, Design Technologist, UI Engineer",
  },
  { key: "seniority", label: "Seniority", placeholder: "e.g. senior or staff — no internships" },
  { key: "locations", label: "Locations & remote", placeholder: "e.g. remote (must allow India)" },
  { key: "skills", label: "Skills & stack", placeholder: "e.g. React, TypeScript; design systems" },
  { key: "company_prefs", label: "Company preferences", placeholder: "e.g. product companies; no tiny 2–3 person firms" },
  { key: "compensation", label: "Compensation", placeholder: "e.g. ≥ $120k — only counts when the posting shows pay" },
  {
    key: "must_haves",
    label: "Must-haves",
    hint: "hard requirements — a posting that clearly violates one can't match",
    rows: 2,
    placeholder: "e.g. remote-friendly for India; individual-contributor role",
  },
  {
    key: "nice_to_haves",
    label: "Nice-to-haves",
    hint: "soft preferences that boost a posting without being required",
    rows: 2,
    placeholder: "e.g. developer-tools product; small team; open source",
  },
  {
    key: "dealbreakers",
    label: "Dealbreakers",
    hint: "auto-reject — if one clearly applies, the posting is filtered no matter what",
    rows: 2,
    placeholder: "e.g. crypto/web3; outsourcing agencies; on-site US only",
  },
  {
    key: "context",
    label: "About you",
    hint: "background and anything else the judge should know",
    rows: 3,
    placeholder: "e.g. 8 years building React apps, led a design-system team…",
  },
];

function profileHasContent(profile: FilterProfile): boolean {
  return PROFILE_FIELDS.some(({ key }) => (profile[key] ?? "").trim() !== "");
}

export default function ProfilePage() {
  const queryClient = useQueryClient();
  // Same no-background-refetch setup as Settings: this form holds in-progress
  // edits, and a silent refetch would overwrite them.
  const { data, error: loadError } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showDerived, setShowDerived] = useState(false);
  useEffect(() => {
    if (data && !settings) {
      setSettings(data);
      // Legacy profiles (fields filled by hand, no statement) start open so
      // nothing the user wrote before looks like it disappeared.
      if (profileHasContent(data.filter_profile) && data.profile_input.trim() === "") setShowDerived(true);
    }
  }, [data, settings]);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const generate = async () => {
    if (!settings || settings.profile_input.trim() === "") return;
    setGenerating(true);
    try {
      const { profile } = await api.expandProfile(settings.profile_input);
      setSettings({ ...settings, filter_profile: profile });
      setShowDerived(true);
      toast.show("Profile generated — review below, then save");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setGenerating(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.saveSettings({
        profile_input: settings.profile_input,
        filter_profile: settings.filter_profile,
        filter_mode: settings.filter_mode,
        company_filter_enabled: settings.company_filter_enabled,
      });
      setSettings(updated);
      queryClient.setQueryData(["settings"], updated);
      toast.show("Profile saved");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const setProfile = (field: keyof FilterProfile, value: string) => {
    if (!settings) return;
    setSettings({ ...settings, filter_profile: { ...settings.filter_profile, [field]: value } });
  };

  if (loadError && !settings) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Profile</h1>
        </header>
        <p className="error">{loadError instanceof Error ? loadError.message : String(loadError)}</p>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Profile</h1>
        </header>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Profile</h1>
          <p className="page-subtitle">Tell Signal what you're looking for — one sentence is enough.</p>
        </div>
      </header>

      <form onSubmit={save}>
        <section className="card">
          <h2>What are you looking for?</h2>
          <p className="hint filter-intro">
            Say it the way you'd tell a friend — role, and anything that matters to you. Signal expands it into a
            full search profile, including the other titles companies use for the same job, so postings never have
            to match your exact wording. Anything you don't mention stays open. Every new posting is then judged
            against this profile the way a person would weigh it, not by keyword matching.
          </p>
          <textarea
            value={settings.profile_input}
            onChange={(e) => setSettings({ ...settings, profile_input: e.target.value })}
            rows={3}
            placeholder="e.g. I'm good at design and I want to be a design engineer — remote, no agencies"
          />
          <div className="generate-row">
            <button
              type="button"
              className="secondary"
              disabled={generating || settings.profile_input.trim() === ""}
              onClick={generate}
            >
              {generating ? "Generating…" : "Generate profile"}
            </button>
            <label className="inline-label">
              Filtering
              <select
                value={settings.filter_mode}
                onChange={(e) => setSettings({ ...settings, filter_mode: e.target.value as FilterMode })}
              >
                <option value="off">Off — notify about every new posting</option>
                <option value="balanced">Balanced — matches and borderline calls</option>
                <option value="strict">Strict — clear matches only</option>
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <h2 className="collapsible-head" onClick={() => setShowDerived(!showDerived)}>
            <span className={`chevron${showDerived ? " open" : ""}`}>▸</span> Derived profile — review &amp; fine-tune
          </h2>
          {showDerived && (
            <>
              <p className="hint">
                This is what the judge actually reads. Generated from your description — correct anything, or fill
                fields directly. Empty fields mean "no preference".
              </p>
              <div className="grid-2">
                {PROFILE_FIELDS.filter((f) => !f.rows).map(({ key, label, hint, placeholder }) => (
                  <label key={key}>
                    {label} {hint && <span className="hint">{hint}</span>}
                    <input
                      value={settings.filter_profile[key] ?? ""}
                      onChange={(e) => setProfile(key, e.target.value)}
                      placeholder={placeholder}
                    />
                  </label>
                ))}
              </div>
              {PROFILE_FIELDS.filter((f) => f.rows).map(({ key, label, hint, rows, placeholder }) => (
                <label key={key}>
                  {label} {hint && <span className="hint">{hint}</span>}
                  <textarea
                    value={settings.filter_profile[key] ?? ""}
                    onChange={(e) => setProfile(key, e.target.value)}
                    rows={rows}
                    placeholder={placeholder}
                  />
                </label>
              ))}
            </>
          )}
        </section>

        <section className="card">
          <h2>Company background checks</h2>
          <p className="hint filter-intro">
            When on, Signal researches the company behind every matched posting before notifying you — is it a real
            operating company, what does it do, its size, stage, and recent funding. Nothing gets hidden: a company
            that can't be verified or clashes with your preferences is delivered with a clear caution and the full
            background on the Matches page. Uses your Jina API key for web search (spends Jina quota).
          </p>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.company_filter_enabled}
              onChange={(e) => setSettings({ ...settings, company_filter_enabled: e.target.checked })}
            />
            Research companies behind matched postings
          </label>
          {settings.company_filter_enabled && !settings.has_jina_api_key && (
            <p className="error">
              Company checks stay inactive until a Jina API key is set in Settings (free at jina.ai).
            </p>
          )}
        </section>

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </form>
    </div>
  );
}
