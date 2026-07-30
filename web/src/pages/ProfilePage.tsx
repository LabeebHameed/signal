import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import {
  api,
  COMP_CURRENCIES,
  CompCurrency,
  CompPeriod,
  FilterProfile,
  Settings,
} from "../api";
import { useToast } from "../components/Toast";
import TagField from "../components/TagField";
import { formatCompRange, groupDigits, parseAmount } from "../lib/format";
import {
  aiValuesFor,
  CompPrefs,
  detectDroppedFields,
  hasAiTags,
  isAiValue,
  joinTags,
  LocationPrefs,
  markGenerated,
  pruneProvenance,
  readCompensation,
  readLocations,
  serializeLocations,
  splitToTags,
} from "../lib/profileTags";

const CURRENCY_LABELS: Record<CompCurrency, string> = {
  USD: "USD $",
  EUR: "EUR €",
  GBP: "GBP £",
  INR: "INR ₹",
};

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const { data, error: loadError } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loc, setLoc] = useState<LocationPrefs>({ include: [], exclude: [] });
  const [comp, setComp] = useState<CompPrefs>({ currency: "USD", period: "year" });
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (data && !settings) {
      const locPrefs = readLocations(data.filter_profile);
      const compPrefs = readCompensation(data.filter_profile);
      setLoc(locPrefs);
      setComp(compPrefs);
      // Materialize the structured fields from whatever the profile actually
      // holds, at load rather than on first edit. A profile stored as prose
      // only — written by an API predating these fields, or from before they
      // existed — parses into the right tags for display, but nothing would
      // carry them back on save: only updateLocations/updateComp write them
      // into filter_profile. Without this, opening such a profile and pressing
      // Update Profile stores the prose again and no structure, so the tags
      // you can see never become the tags the gates read.
      setSettings({
        ...data,
        filter_profile: {
          ...data.filter_profile,
          locations_include: locPrefs.include,
          locations_exclude: locPrefs.exclude,
          locations: serializeLocations(locPrefs),
          compensation_min: compPrefs.min,
          compensation_max: compPrefs.max,
          compensation_currency: compPrefs.currency,
          compensation_period: compPrefs.period,
          compensation: formatCompRange(compPrefs.min, compPrefs.max, compPrefs.currency, compPrefs.period),
        },
      });
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

  const patchProfile = (patch: Partial<FilterProfile>) => {
    setSettings((s) => (s ? { ...s, filter_profile: { ...s.filter_profile, ...patch } } : s));
  };

  const updateLocations = (next: Partial<LocationPrefs>) => {
    setLoc((prev) => {
      const merged = { ...prev, ...next };
      patchProfile({
        locations_include: merged.include,
        locations_exclude: merged.exclude,
        locations: serializeLocations(merged),
      });
      return merged;
    });
  };

  const updateComp = (next: Partial<CompPrefs>) => {
    setComp((prev) => {
      const merged = { ...prev, ...next };
      patchProfile({
        compensation_min: merged.min,
        compensation_max: merged.max,
        compensation_currency: merged.currency,
        compensation_period: merged.period,
        compensation: formatCompRange(merged.min, merged.max, merged.currency, merged.period),
      });
      return merged;
    });
  };

  const generate = async () => {
    if (!settings || settings.profile_input.trim() === "") return;
    setGenerating(true);
    try {
      const { profile } = await api.expandProfile(settings.profile_input);
      setSettings((s) =>
        s
          ? {
            ...s,
            filter_profile: {
              ...s.filter_profile,
              ...profile,
              ai_generated: markGenerated(s.filter_profile, profile),
            },
          }
          : s
      );
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
    setLoc({ include: [], exclude: [] });
    setComp({ currency: "USD", period: "year" });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      // Provenance is pruned at the last moment so a tag the seeker deleted,
      // or edited and retyped, doesn't come back wearing the AI's colour.
      const filter_profile: FilterProfile = {
        ...settings.filter_profile,
        ai_generated: pruneProvenance(settings.filter_profile),
      };
      const updated = await api.saveSettings({
        profile_input: settings.profile_input,
        filter_profile,
        negative_keywords: settings.negative_keywords,
      });
      setSettings(updated);
      setLoc(readLocations(updated.filter_profile));
      setComp(readCompensation(updated.filter_profile));
      queryClient.setQueryData(["settings"], updated);

      // The PUT returns the saved row, so anything missing from it was
      // dropped server-side — almost always an API function deployed before
      // these fields existed. Say so instead of reporting success over the
      // top of data that silently vanished.
      const dropped = detectDroppedFields(
        { profile: filter_profile, negativeKeywords: settings.negative_keywords },
        { profile: updated.filter_profile, negativeKeywords: updated.negative_keywords ?? "" },
      );
      if (dropped.length > 0) {
        toast.show(
          `Saved, but the API didn't store your ${dropped.join(", ")} — it's running an older version. ` +
            "Redeploy the Supabase functions (and apply pending migrations) to fix this.",
          "error",
        );
      } else {
        toast.show("Profile saved successfully");
      }
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

  const profile = settings.filter_profile;
  const roleTitle = profile.roles || "Target Role Unspecified";
  const keywordTags = splitToTags(profile.title_keywords);
  const synonymTags = splitToTags(profile.role_synonyms);
  const negativeKeywordTags = splitToTags(settings.negative_keywords);
  const synonymAi = aiValuesFor(profile, "role_synonyms");
  const keywordAi = aiValuesFor(profile, "title_keywords");
  const compPreview = formatCompRange(comp.min, comp.max, comp.currency, comp.period);
  // A backwards range would screen against a floor above the ceiling the
  // seeker meant. Flagged rather than auto-swapped: silently rewriting what
  // someone typed into a pay field is worse than telling them.
  const compRangeInverted = comp.min !== undefined && comp.max !== undefined && comp.min > comp.max;
  const noLocationFilter = loc.include.length === 0 && loc.exclude.length === 0;

  return (
    <div className="page profile-redesign-page">
      <header className="page-header">
        <div>
          <h1>Profile Criteria</h1>
          <p className="page-subtitle">Your active job preferences used by AI to judge incoming postings.</p>
        </div>
      </header>

      {!isEditing ? (
        /* VIEW MODE: Spacious, full-width Profile Card */
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

          {hasAiTags(profile) && (
            <p className="profile-tag-legend">
              <span className="profile-tag-pill tag-chip-ai legend-swatch">AI-suggested</span>
              <span className="profile-tag-pill legend-swatch">Yours</span>
            </p>
          )}

          {/* Title Keywords (Hard Filter) */}
          <div className="profile-section-group">
            <h3 className="profile-section-label">Title Keywords (Hard Pre-Filter)</h3>
            {keywordTags.length > 0 ? (
              <div className="profile-tag-list">
                {keywordTags.map((tag) => (
                  <span
                    key={tag}
                    className={`profile-tag-pill ${isAiValue(keywordAi, tag) ? "tag-chip-ai" : ""}`}
                  >
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
                {synonymTags.map((tag) => (
                  <span
                    key={tag}
                    className={`profile-tag-pill ${isAiValue(synonymAi, tag) ? "tag-chip-ai" : ""}`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="profile-empty-text">None specified</span>
            )}
          </div>

          {/* Negative Keywords (Hard Exclude) */}
          <div className="profile-section-group">
            <h3 className="profile-section-label">Negative Keywords (Excluded)</h3>
            {negativeKeywordTags.length > 0 ? (
              <div className="profile-tag-list">
                {negativeKeywordTags.map((tag) => (
                  <span key={tag} className="profile-tag-pill tag-chip-exclude">
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="profile-empty-text">None specified</span>
            )}
          </div>

          {/* Locations */}
          <div className="profile-section-group">
            <h3 className="profile-section-label">Locations</h3>
            {noLocationFilter ? (
              <span className="profile-empty-text">No location filter — postings from anywhere pass.</span>
            ) : (
              <div className="profile-location-view">
                {loc.include.length > 0 && (
                  <div className="profile-location-row">
                    <span className="profile-location-rule">Only</span>
                    <div className="profile-tag-list">
                      {loc.include.map((tag) => (
                        <span key={tag} className="profile-tag-pill tag-chip-include">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {loc.exclude.length > 0 && (
                  <div className="profile-location-row">
                    <span className="profile-location-rule">Never</span>
                    <div className="profile-tag-list">
                      {loc.exclude.map((tag) => (
                        <span key={tag} className="profile-tag-pill tag-chip-exclude">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Metrics Grid */}
          <div className="profile-metrics-grid">
            <div className="profile-metric-box">
              <span className="profile-metric-label">Target Compensation</span>
              <span className="profile-metric-value profile-metric-figure">
                {compPreview || "No target set"}
              </span>
            </div>
            <div className="profile-metric-box">
              <span className="profile-metric-label">Postings without stated pay</span>
              <span className="profile-metric-value">Always pass through</span>
            </div>
          </div>
        </div>
      ) : (
        /* EDIT MODE: Criteria Form + AI Generator */
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
              <label className="profile-field-label" htmlFor="profile-roles">Target Role *</label>
              <input
                id="profile-roles"
                type="text"
                className="profile-text-input"
                value={profile.roles ?? ""}
                onChange={(e) => patchProfile({ roles: e.target.value })}
                placeholder="e.g. Product Designer"
              />
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label" htmlFor="profile-synonyms">Equivalent Titles (Synonyms)</label>
              <TagField
                id="profile-synonyms"
                describedBy="profile-synonyms-hint"
                values={synonymTags}
                aiValues={synonymAi}
                onChange={(next) => patchProfile({ role_synonyms: joinTags(next) })}
                placeholder="Type a title and press Enter"
              />
              <span className="profile-field-hint" id="profile-synonyms-hint">
                Press Enter to turn a title into a tag. Backspace on an empty field turns the last tag back into text
                so you can edit it.
              </span>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label" htmlFor="profile-keywords">Title Keywords (Hard Pre-Filter)</label>
              <TagField
                id="profile-keywords"
                describedBy="profile-keywords-hint"
                values={keywordTags}
                aiValues={keywordAi}
                onChange={(next) => patchProfile({ title_keywords: joinTags(next) })}
                placeholder="e.g. design, designer, ui, ux"
              />
              <span className="profile-field-hint" id="profile-keywords-hint">
                Postings missing all of these keywords are rejected before the AI judge runs.
              </span>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label" htmlFor="profile-negative">Negative Keywords (Hard Exclude)</label>
              <TagField
                id="profile-negative"
                describedBy="profile-negative-hint"
                tone="negative"
                values={negativeKeywordTags}
                onChange={(next) => setSettings({ ...settings, negative_keywords: joinTags(next) })}
                placeholder="e.g. Senior, Contract, Unpaid"
              />
              <span className="profile-field-hint" id="profile-negative-hint">
                Postings whose title contains any of these words are rejected before the AI judge ever runs — no
                LLM call, no exceptions. Case-insensitive.
              </span>
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Locations</label>
              <div className="profile-location-grid">
                <div className="profile-location-col">
                  <span className="profile-subfield-label profile-subfield-include" id="profile-loc-include-label">
                    Include
                  </span>
                  <TagField
                    tone="include"
                    describedBy="profile-loc-include-label"
                    values={loc.include}
                    onChange={(next) => updateLocations({ include: next })}
                    placeholder="e.g. Remote, Germany"
                  />
                  <span className="profile-field-hint">
                    Only these places — plus postings that don't say where.
                  </span>
                </div>
                <div className="profile-location-col">
                  <span className="profile-subfield-label profile-subfield-exclude" id="profile-loc-exclude-label">
                    Exclude
                  </span>
                  <TagField
                    tone="exclude"
                    describedBy="profile-loc-exclude-label"
                    values={loc.exclude}
                    onChange={(next) => updateLocations({ exclude: next })}
                    placeholder="e.g. United States"
                  />
                  <span className="profile-field-hint">
                    Never these places, even if Include also matches.
                  </span>
                </div>
              </div>
              {noLocationFilter && (
                <span className="profile-field-hint">
                  No location filter set — postings from anywhere pass through.
                </span>
              )}
            </div>

            <div className="profile-field-group">
              <label className="profile-field-label">Target Compensation</label>
              <div className="profile-comp-row">
                <div className="profile-comp-amount">
                  <span className="profile-subfield-label" id="profile-comp-min-label">From</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-labelledby="profile-comp-min-label"
                    className="profile-text-input profile-amount-input"
                    value={groupDigits(comp.min)}
                    onChange={(e) => updateComp({ min: parseAmount(e.target.value) })}
                    placeholder="120,000"
                  />
                </div>
                <div className="profile-comp-amount">
                  <span className="profile-subfield-label" id="profile-comp-max-label">To</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-labelledby="profile-comp-max-label"
                    className="profile-text-input profile-amount-input"
                    value={groupDigits(comp.max)}
                    onChange={(e) => updateComp({ max: parseAmount(e.target.value) })}
                    placeholder="160,000"
                  />
                </div>
                <div className="profile-comp-amount">
                  <span className="profile-subfield-label" id="profile-comp-currency-label">Currency</span>
                  <select
                    aria-labelledby="profile-comp-currency-label"
                    className="profile-text-input profile-currency-select"
                    value={comp.currency}
                    onChange={(e) => updateComp({ currency: e.target.value as CompCurrency })}
                  >
                    {COMP_CURRENCIES.map((code) => (
                      <option key={code} value={code}>{CURRENCY_LABELS[code]}</option>
                    ))}
                  </select>
                </div>
                <div className="profile-comp-amount">
                  <span className="profile-subfield-label">Per</span>
                  <div className="profile-radio-group profile-period-group">
                    {(["year", "month"] as CompPeriod[]).map((period) => (
                      <label
                        key={period}
                        className={`profile-radio-pill ${comp.period === period ? "active" : ""}`}
                      >
                        <input
                          type="radio"
                          name="compPeriod"
                          value={period}
                          checked={comp.period === period}
                          onChange={() => updateComp({ period })}
                        />
                        {period === "year" ? "Year" : "Month"}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <p className={`profile-comp-preview ${compRangeInverted ? "is-invalid" : ""}`}>
                {compRangeInverted ? (
                  <>“To” is lower than “From” — swap them so the range reads the right way round.</>
                ) : compPreview ? (
                  <>
                    Screened as <strong>{compPreview}</strong>
                  </>
                ) : (
                  "No pay target set — compensation won't affect screening."
                )}
              </p>
              <span className="profile-field-hint">
                A posting that states pay below your floor is rejected outright. Most postings don't disclose pay at
                all — those always pass through to the AI judge.
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
              <button type="submit" className="profile-btn-primary" disabled={saving || compRangeInverted}>
                {saving ? "Saving…" : "Update Profile"}
              </button>
            </div>
          </section>
        </form>
      )}
    </div>
  );
}
