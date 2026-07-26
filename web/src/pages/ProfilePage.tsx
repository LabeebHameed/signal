import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, FilterProfile, Settings } from "../api";
import { useToast } from "../components/Toast";

type LocationMode = "" | "remote" | "country" | "both";

function serializeLocations(mode: LocationMode, country: string): string {
  const trimmed = country.trim();
  if (mode === "remote") return "Remote";
  if (mode === "country") return trimmed;
  if (mode === "both") return trimmed ? `Remote or ${trimmed}` : "Remote";
  return "";
}

/** Parses a saved locations string back into the mode/country control.
 * Anything that isn't exactly "Remote" or "Remote or <x>" is treated as a
 * plain country value (covers hand-edited or legacy free text — nothing is
 * ever dropped, it just lands in the country field, editable). */
function parseLocations(value: string): { mode: LocationMode; country: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { mode: "", country: "" };
  if (/^remote$/i.test(trimmed)) return { mode: "remote", country: "" };
  const both = trimmed.match(/^remote or (.+)$/i);
  if (both) return { mode: "both", country: both[1] };
  return { mode: "country", country: trimmed };
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
  const [loc, setLoc] = useState<{ mode: LocationMode; country: string }>({ mode: "", country: "" });
  useEffect(() => {
    if (data && !settings) {
      setSettings(data);
      setLoc(parseLocations(data.filter_profile.locations ?? ""));
    }
  }, [data, settings]);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const setProfile = (field: keyof FilterProfile, value: string) => {
    setSettings((s) => (s ? { ...s, filter_profile: { ...s.filter_profile, [field]: value } } : s));
  };

  const updateLocation = (next: Partial<{ mode: LocationMode; country: string }>) => {
    setLoc((prev) => {
      const merged = { ...prev, ...next };
      setProfile("locations", serializeLocations(merged.mode, merged.country));
      return merged;
    });
  };

  const generate = async () => {
    if (!settings || settings.profile_input.trim() === "") return;
    setGenerating(true);
    try {
      const { profile } = await api.expandProfile(settings.profile_input);
      setSettings({ ...settings, filter_profile: { ...settings.filter_profile, ...profile } });
      toast.show("Profile generated — review below, then save");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setGenerating(false);
    }
  };

  const clearProfile = () => {
    if (!settings) return;
    if (
      !confirm(
        "Clear the profile? Statement, target role, and preferences will all be wiped — Save to make it permanent.",
      )
    ) {
      return;
    }
    setSettings({ ...settings, profile_input: "", filter_profile: {} });
    setLoc({ mode: "", country: "" });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.saveSettings({
        profile_input: settings.profile_input,
        filter_profile: settings.filter_profile,
      });
      setSettings(updated);
      setLoc(parseLocations(updated.filter_profile.locations ?? ""));
      queryClient.setQueryData(["settings"], updated);
      toast.show("Profile saved");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
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

  const hasGenerated = Boolean(
    settings.filter_profile.roles || settings.filter_profile.role_synonyms || settings.filter_profile.title_keywords,
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Profile</h1>
          <p className="page-subtitle">What Signal judges every new posting's title against.</p>
        </div>
      </header>

      <form onSubmit={save}>
        <section className="card">
          <h2>What are you looking for?</h2>
          <textarea
            value={settings.profile_input}
            onChange={(e) => setSettings({ ...settings, profile_input: e.target.value })}
            rows={3}
            placeholder="e.g. I'm good at design and I want to be a design engineer"
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
            <button type="button" className="secondary" onClick={clearProfile}>
              Clear profile
            </button>
          </div>

          <div className="grid-2">
            <label>
              Location
              <select value={loc.mode} onChange={(e) => updateLocation({ mode: e.target.value as LocationMode })}>
                <option value="">No preference</option>
                <option value="remote">Remote</option>
                <option value="country">A specific country</option>
                <option value="both">Remote or a specific country</option>
              </select>
            </label>
            {(loc.mode === "country" || loc.mode === "both") && (
              <label>
                Country
                <input
                  value={loc.country}
                  onChange={(e) => updateLocation({ country: e.target.value })}
                  placeholder="e.g. India"
                />
              </label>
            )}
          </div>

          <label>
            Compensation <span className="hint">only checked when a posting shows pay</span>
            <input
              value={settings.filter_profile.compensation ?? ""}
              onChange={(e) => setProfile("compensation", e.target.value)}
              placeholder="e.g. ≥ $120k"
            />
          </label>

          {hasGenerated && (
            <div className="grid-2">
              <label>
                Target role
                <input value={settings.filter_profile.roles ?? ""} onChange={(e) => setProfile("roles", e.target.value)} />
              </label>
              <label>
                Equivalent titles
                <input
                  value={settings.filter_profile.role_synonyms ?? ""}
                  onChange={(e) => setProfile("role_synonyms", e.target.value)}
                />
              </label>
              <label>
                Title keywords{" "}
                <span className="hint">
                  hard filter — a posting whose title contains none of these is rejected before the AI judge ever
                  sees it
                </span>
                <input
                  value={settings.filter_profile.title_keywords ?? ""}
                  onChange={(e) => setProfile("title_keywords", e.target.value)}
                />
              </label>
            </div>
          )}
        </section>

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </form>
    </div>
  );
}
