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

function parseLocations(value: string): { mode: LocationMode; country: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { mode: "", country: "" };
  if (/^remote$/i.test(trimmed)) return { mode: "remote", country: "" };
  const both = trimmed.match(/^remote or (.+)$/i);
  if (both) return { mode: "both", country: both[1] };
  return { mode: "country", country: trimmed };
}

function splitToTags(str?: string): string[] {
  if (!str) return [];
  return str
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const { data, error: loadError } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loc, setLoc] = useState<{ mode: LocationMode; country: string }>({ mode: "", country: "" });
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (data && !settings) {
      setSettings(data);
      setLoc(parseLocations(data.filter_profile.locations ?? ""));
      // Default to editing if no profile content exists yet
      const hasContent = Boolean(
        data.filter_profile.roles ||
          data.filter_profile.role_synonyms ||
          data.filter_profile.title_keywords ||
          data.filter_profile.locations ||
          data.filter_profile.compensation,
      );
      if (!hasContent) {
        setIsEditing(true);
      }
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
      toast.show("Profile generated — review and click Update Profile");
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
        "Clear the profile? Statement, target role, and preferences will all be wiped.",
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
      toast.show("Profile saved successfully");
      setIsEditing(false);
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

  const roleTitle = settings.filter_profile.roles || "Target Role Unspecified";
  const keywordTags = splitToTags(settings.filter_profile.title_keywords);
  const synonymTags = splitToTags(settings.filter_profile.role_synonyms);

  return (
    <div className="page profile-redesign-page">
      <header className="page-header">
        <div>
          <h1>Profile Criteria</h1>
          <p className="page-subtitle">Your active job preferences used by AI to judge incoming postings.</p>
        </div>
      </header>

      {!isEditing ? (
        /* VIEW MODE: Spacious, full-width Profile Card (Image 2 style) */
        <div className="profile-spacious-card">
          <div className="profile-spacious-header">
            <div className="profile-spacious-title-group">
              <h2 className="profile-user-title">{roleTitle}</h2>
              <span className="profile-badge">Target Role</span>
            </div>
            <button
              type="button"
              className="profile-btn-edit"
              onClick={() => setIsEditing(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit Profile
            </button>
          </div>

          {/* Plain Text Goal / Input Statement */}
          {settings.profile_input && (
            <div className="profile-section-group">
              <h3 className="profile-section-label">Your Statement</h3>
              <p className="profile-statement-text">"{settings.profile_input}"</p>
            </div>
          )}

          {/* Title Keywords (Hard Filter) */}
          <div className="profile-section-group">
            <h3 className="profile-section-label">Title Keywords (Hard Pre-Filter)</h3>
            {keywordTags.length > 0 ? (
              <div className="profile-tag-list">
                {keywordTags.map((tag, idx) => (
                  <span key={idx} className="profile-tag-pill">
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="profile-empty-text">None specified</span>
            )}
          </div>

          {/* Equivalent Role Synonyms */}
          <div className="profile-section-group">
            <h3 className="profile-section-label">Equivalent Titles (Synonyms)</h3>
            {synonymTags.length > 0 ? (
              <div className="profile-tag-list">
                {synonymTags.map((tag, idx) => (
                  <span key={idx} className="profile-tag-pill secondary-pill">
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="profile-empty-text">None specified</span>
            )}
          </div>

          {/* Metrics Grid */}
          <div className="profile-metrics-grid">
            <div className="profile-metric-box">
              <span className="profile-metric-label">Location Preference</span>
              <span className="profile-metric-value">
                {settings.filter_profile.locations || "No preference"}
              </span>
            </div>
            <div className="profile-metric-box">
              <span className="profile-metric-label">Target Compensation</span>
              <span className="profile-metric-value">
                {settings.filter_profile.compensation || "Pay undisclosed"}
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* EDIT MODE: Criteria Form + AI Generator (Image 1 style) */
        <form onSubmit={save} className="profile-form-container">
          {/* AI Generator Card */}
          <section className="profile-card">
            <div className="profile-card-header">
              <h2>AI Profile Generator</h2>
              <p className="profile-card-subtitle">
                Describe your target job in plain text. AI will automatically expand it into specific roles, keywords, and title synonyms.
              </p>
            </div>
            <textarea
              className="profile-prompt-input"
              value={settings.profile_input}
              onChange={(e) => setSettings({ ...settings, profile_input: e.target.value })}
              rows={3}
              placeholder="e.g. I'm good at design and I want to be a senior product designer or design engineer"
            />
            <div className="profile-card-actions">
              <button
                type="button"
                className="profile-btn-secondary"
                disabled={generating || settings.profile_input.trim() === ""}
                onClick={generate}
              >
                {generating ? (
                  "Generating…"
                ) : (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: 'text-bottom' }}>
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                      <path d="M5 3v4" />
                      <path d="M19 17v4" />
                      <path d="M3 5h4" />
                      <path d="M17 19h4" />
                    </svg>
                    Generate Profile
                  </>
                )}
              </button>
              <button type="button" className="profile-btn-danger" onClick={clearProfile}>
                Clear Profile
              </button>
            </div>
          </section>

          {/* Preferences Form */}
          <section className="profile-card">
            <div className="profile-card-header">
              <h2>Basic Job Criteria</h2>
              <p className="profile-card-subtitle">
                Fine-tune your job criteria preferences to get better recommendations.
              </p>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Target Role *</label>
              <input
                type="text"
                className="profile-text-input"
                value={settings.filter_profile.roles ?? ""}
                onChange={(e) => setProfile("roles", e.target.value)}
                placeholder="e.g. Product Designer"
              />
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Work Model & Location</label>
              <div className="profile-radio-group">
                <label className={`profile-radio-pill ${loc.mode === "" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="locMode"
                    value=""
                    checked={loc.mode === ""}
                    onChange={() => updateLocation({ mode: "" })}
                  />
                  No preference
                </label>
                <label className={`profile-radio-pill ${loc.mode === "remote" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="locMode"
                    value="remote"
                    checked={loc.mode === "remote"}
                    onChange={() => updateLocation({ mode: "remote" })}
                  />
                  Remote Only
                </label>
                <label className={`profile-radio-pill ${loc.mode === "country" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="locMode"
                    value="country"
                    checked={loc.mode === "country"}
                    onChange={() => updateLocation({ mode: "country" })}
                  />
                  Specific Country
                </label>
                <label className={`profile-radio-pill ${loc.mode === "both" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="locMode"
                    value="both"
                    checked={loc.mode === "both"}
                    onChange={() => updateLocation({ mode: "both" })}
                  />
                  Remote or Country
                </label>
              </div>
            </div>

            {(loc.mode === "country" || loc.mode === "both") && (
              <div className="profile-field-group">
                <label className="profile-field-label">Country / City</label>
                <input
                  type="text"
                  className="profile-text-input"
                  value={loc.country}
                  onChange={(e) => updateLocation({ country: e.target.value })}
                  placeholder="e.g. United States, India, UK"
                />
              </div>
            )}

            <div className="profile-field-group">
              <label className="profile-field-label">Target Compensation</label>
              <input
                type="text"
                className="profile-text-input"
                value={settings.filter_profile.compensation ?? ""}
                onChange={(e) => setProfile("compensation", e.target.value)}
                placeholder="e.g. ≥ $120k / yr"
              />
              <span className="profile-field-hint">Checked whenever a posting discloses pay.</span>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Equivalent Titles (Synonyms)</label>
              <input
                type="text"
                className="profile-text-input"
                value={settings.filter_profile.role_synonyms ?? ""}
                onChange={(e) => setProfile("role_synonyms", e.target.value)}
                placeholder="e.g. UI/UX Designer, Lead Designer, Design Engineer"
              />
              <span className="profile-field-hint">Comma-separated equivalent titles that match your profile.</span>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Title Keywords (Hard Pre-Filter)</label>
              <input
                type="text"
                className="profile-text-input"
                value={settings.filter_profile.title_keywords ?? ""}
                onChange={(e) => setProfile("title_keywords", e.target.value)}
                placeholder="e.g. design, designer, ui, ux"
              />
              <span className="profile-field-hint">
                Postings missing all of these keywords are rejected before the AI judge runs.
              </span>
            </div>

            <div className="profile-form-footer">
              <button
                type="button"
                className="profile-btn-secondary"
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </button>
              <button type="submit" className="profile-btn-primary" disabled={saving}>
                {saving ? "Saving…" : "Update Profile"}
              </button>
            </div>
          </section>
        </form>
      )}
    </div>
  );
}
