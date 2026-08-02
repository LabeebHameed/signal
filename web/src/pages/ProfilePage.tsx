import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { PencilIcon, SparklesIcon } from "lucide-react";

import {
  api,
  COMP_CURRENCIES,
  CompCurrency,
  CompPeriod,
  FilterProfile,
  Settings,
} from "@/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { Page, PageHeader } from "@/components/PageShell";
import TagField from "@/components/TagField";
import { useToast } from "@/components/Toast";
import { SelectCombobox, type SelectOption } from "@/components/ui-ext/select-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatCompRange, groupDigits, parseAmount } from "@/lib/format";
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
} from "@/lib/profileTags";
import { cn } from "@/lib/utils";

const CURRENCY_LABELS: Record<CompCurrency, string> = {
  USD: "USD $",
  EUR: "EUR €",
  GBP: "GBP £",
  INR: "INR ₹",
};

const CURRENCY_OPTIONS: SelectOption[] = COMP_CURRENCIES.map((code) => ({
  value: code,
  label: CURRENCY_LABELS[code],
}));

const PERIOD_OPTIONS: SelectOption[] = [
  { value: "year", label: "Per year" },
  { value: "month", label: "Per month" },
];

/** One read-only block in view mode: a small caps label above its content. */
function ProfileSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
      {children}
    </div>
  );
}

function ProfileTag({ tone, ai, children }: { tone?: "include" | "exclude"; ai?: boolean; children: React.ReactNode }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "bg-muted text-foreground",
        tone === "include" && "bg-primary/15 text-primary",
        tone === "exclude" && "bg-destructive/15 text-destructive",
        ai && "ring-1 ring-current/30 ring-inset",
      )}
    >
      {children}
    </Badge>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

function ProfileSkeleton() {
  return (
    <Page>
      <PageHeader title="Profile Criteria" />
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="grid gap-7">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="grid gap-2">
              <Skeleton className="h-3 w-32" />
              <div className="flex gap-1.5">
                <Skeleton className="h-6 w-20 rounded-4xl" />
                <Skeleton className="h-6 w-24 rounded-4xl" />
                <Skeleton className="h-6 w-16 rounded-4xl" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
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
  const confirm = useConfirm();

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

  const clearProfile = async () => {
    if (!settings) return;
    const ok = await confirm({
      title: "Clear the profile?",
      description: "Statement, target role, and preferences will all be wiped.",
      confirmLabel: "Clear profile",
      destructive: true,
    });
    if (!ok) return;

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
      <Page>
        <PageHeader title="Profile Criteria" />
        <p className="text-sm text-destructive">
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </p>
      </Page>
    );
  }

  if (!settings) return <ProfileSkeleton />;

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
    <Page>
      <PageHeader
        title="Profile Criteria"
        description="Your active job preferences used by AI to judge incoming postings."
      />

      {!isEditing ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{roleTitle}</CardTitle>
            <CardDescription>Target role</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                <PencilIcon />
                Edit Profile
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent className="grid gap-7">
            {settings.profile_input && (
              <ProfileSection label="Your statement">
                <p className="text-sm text-muted-foreground italic">"{settings.profile_input}"</p>
              </ProfileSection>
            )}

            {hasAiTags(profile) && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ProfileTag ai>AI-suggested</ProfileTag>
                <ProfileTag>Yours</ProfileTag>
              </div>
            )}

            <ProfileSection label="Title keywords (hard pre-filter)">
              {keywordTags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {keywordTags.map((tag) => (
                    <ProfileTag key={tag} ai={isAiValue(keywordAi, tag)}>
                      {tag}
                    </ProfileTag>
                  ))}
                </div>
              ) : (
                <EmptyText>None specified</EmptyText>
              )}
            </ProfileSection>

            <ProfileSection label="Equivalent titles (synonyms)">
              {synonymTags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {synonymTags.map((tag) => (
                    <ProfileTag key={tag} ai={isAiValue(synonymAi, tag)}>
                      {tag}
                    </ProfileTag>
                  ))}
                </div>
              ) : (
                <EmptyText>None specified</EmptyText>
              )}
            </ProfileSection>

            <ProfileSection label="Negative keywords (excluded)">
              {negativeKeywordTags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {negativeKeywordTags.map((tag) => (
                    <ProfileTag key={tag} tone="exclude">
                      {tag}
                    </ProfileTag>
                  ))}
                </div>
              ) : (
                <EmptyText>None specified</EmptyText>
              )}
            </ProfileSection>

            <ProfileSection label="Locations">
              {noLocationFilter ? (
                <EmptyText>No location filter — postings from anywhere pass.</EmptyText>
              ) : (
                <div className="grid gap-2">
                  {loc.include.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">Only</span>
                      {loc.include.map((tag) => (
                        <ProfileTag key={tag} tone="include">
                          {tag}
                        </ProfileTag>
                      ))}
                    </div>
                  )}
                  {loc.exclude.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">Never</span>
                      {loc.exclude.map((tag) => (
                        <ProfileTag key={tag} tone="exclude">
                          {tag}
                        </ProfileTag>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </ProfileSection>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1 rounded-xl bg-muted/40 p-4">
                <span className="text-xs text-muted-foreground">Target compensation</span>
                <span className="font-heading text-lg font-medium">{compPreview || "No target set"}</span>
              </div>
              <div className="grid gap-1 rounded-xl bg-muted/40 p-4">
                <span className="text-xs text-muted-foreground">Postings without stated pay</span>
                <span className="font-heading text-lg font-medium">Always pass through</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>AI Profile Generator</CardTitle>
              <CardDescription>
                Describe your target job in plain text. AI will expand it into specific roles, keywords, and title
                synonyms.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field>
                <FieldLabel htmlFor="profile-input">What are you looking for?</FieldLabel>
                <Textarea
                  id="profile-input"
                  value={settings.profile_input}
                  onChange={(e) => setSettings({ ...settings, profile_input: e.target.value })}
                  rows={3}
                  placeholder="e.g. I'm good at design and I want to be a senior product designer or design engineer"
                />
                <FieldDescription>
                  Kept as written — it's the statement the generated criteria are derived from.
                </FieldDescription>
              </Field>
            </CardContent>
            <CardFooter className="justify-between border-t">
              <Button type="button" variant="ghost" onClick={clearProfile}>
                Clear Profile
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={generating || settings.profile_input.trim() === ""}
                onClick={generate}
              >
                {generating ? <Spinner /> : <SparklesIcon />}
                {generating ? "Generating…" : "Generate Profile"}
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Basic Job Criteria</CardTitle>
              <CardDescription>
                Fine-tune your job criteria preferences to get better recommendations.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="profile-roles">Target role</FieldLabel>
                  <Input
                    id="profile-roles"
                    value={profile.roles ?? ""}
                    onChange={(e) => patchProfile({ roles: e.target.value })}
                    placeholder="e.g. Product Designer"
                  />
                  <FieldDescription>The role in your own words — the judge reads this first.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="profile-synonyms">Equivalent titles (synonyms)</FieldLabel>
                  <TagField
                    id="profile-synonyms"
                    describedBy="profile-synonyms-hint"
                    values={synonymTags}
                    aiValues={synonymAi}
                    onChange={(next) => patchProfile({ role_synonyms: joinTags(next) })}
                    placeholder="Type a title and press Enter"
                  />
                  <FieldDescription id="profile-synonyms-hint">
                    Press Enter to turn a title into a tag. Backspace on an empty field turns the last tag back
                    into text so you can edit it.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="profile-keywords">Title keywords (hard pre-filter)</FieldLabel>
                  <TagField
                    id="profile-keywords"
                    describedBy="profile-keywords-hint"
                    values={keywordTags}
                    aiValues={keywordAi}
                    onChange={(next) => patchProfile({ title_keywords: joinTags(next) })}
                    placeholder="e.g. design, designer, ui, ux"
                  />
                  <FieldDescription id="profile-keywords-hint">
                    Postings missing all of these keywords are rejected before the AI judge runs.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="profile-negative">Negative keywords (hard exclude)</FieldLabel>
                  <TagField
                    id="profile-negative"
                    describedBy="profile-negative-hint"
                    tone="negative"
                    values={negativeKeywordTags}
                    onChange={(next) => setSettings({ ...settings, negative_keywords: joinTags(next) })}
                    placeholder="e.g. Senior, Contract, Unpaid"
                  />
                  <FieldDescription id="profile-negative-hint">
                    Postings whose title contains any of these words are rejected before the AI judge ever runs — no
                    LLM call, no exceptions. Case-insensitive.
                  </FieldDescription>
                </Field>

                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="profile-loc-include">Locations — include</FieldLabel>
                    <TagField
                      id="profile-loc-include"
                      tone="include"
                      describedBy="profile-loc-include-hint"
                      values={loc.include}
                      onChange={(next) => updateLocations({ include: next })}
                      placeholder="e.g. Remote, Germany"
                    />
                    <FieldDescription id="profile-loc-include-hint">
                      Only these places — plus postings that don't say where.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-loc-exclude">Locations — exclude</FieldLabel>
                    <TagField
                      id="profile-loc-exclude"
                      tone="exclude"
                      describedBy="profile-loc-exclude-hint"
                      values={loc.exclude}
                      onChange={(next) => updateLocations({ exclude: next })}
                      placeholder="e.g. United States"
                    />
                    <FieldDescription id="profile-loc-exclude-hint">
                      Never these places, even if Include also matches.
                    </FieldDescription>
                  </Field>
                </FieldGroup>

                {noLocationFilter && (
                  <FieldDescription>
                    No location filter set — postings from anywhere pass through.
                  </FieldDescription>
                )}

                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="profile-comp-min">Compensation from</FieldLabel>
                    <Input
                      id="profile-comp-min"
                      inputMode="numeric"
                      value={groupDigits(comp.min)}
                      onChange={(e) => updateComp({ min: parseAmount(e.target.value) })}
                      placeholder="120,000"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-comp-max">Compensation to</FieldLabel>
                    <Input
                      id="profile-comp-max"
                      inputMode="numeric"
                      value={groupDigits(comp.max)}
                      onChange={(e) => updateComp({ max: parseAmount(e.target.value) })}
                      placeholder="160,000"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-comp-currency">Currency</FieldLabel>
                    <SelectCombobox
                      id="profile-comp-currency"
                      options={CURRENCY_OPTIONS}
                      value={comp.currency}
                      onValueChange={(currency) => updateComp({ currency: currency as CompCurrency })}
                      placeholder="Currency"
                      searchPlaceholder="Search currencies…"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-comp-period">Per</FieldLabel>
                    <SelectCombobox
                      id="profile-comp-period"
                      options={PERIOD_OPTIONS}
                      value={comp.period}
                      onValueChange={(period) => updateComp({ period: period as CompPeriod })}
                      placeholder="Period"
                      searchPlaceholder="Search…"
                    />
                  </Field>
                </FieldGroup>

                <Field>
                  <p className={cn("text-sm", compRangeInverted ? "text-destructive" : "text-muted-foreground")}>
                    {compRangeInverted ? (
                      <>“To” is lower than “From” — swap them so the range reads the right way round.</>
                    ) : compPreview ? (
                      <>
                        Screened as <strong className="text-foreground">{compPreview}</strong>
                      </>
                    ) : (
                      "No pay target set — compensation won't affect screening."
                    )}
                  </p>
                  <FieldDescription>
                    A posting that states pay below your floor is rejected outright. Most postings don't disclose
                    pay at all — those always pass through to the AI judge.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>

            <CardFooter className="justify-between border-t">
              <Button type="button" variant="outline" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || compRangeInverted}>
                {saving && <Spinner />}
                {saving ? "Saving…" : "Update Profile"}
              </Button>
            </CardFooter>
          </Card>
        </form>
      )}
    </Page>
  );
}
