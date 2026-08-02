import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2Icon } from "lucide-react";

import { api, Settings } from "@/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { Page, PageHeader } from "@/components/PageShell";
import { useToast } from "@/components/Toast";
import { SelectCombobox, type SelectOption } from "@/components/ui-ext/select-combobox";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import { Switch } from "@/components/ui/switch";

const PROVIDER_OPTIONS: SelectOption[] = [
  { value: "anthropic", label: "Anthropic" },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible",
    hint: "OpenAI, Gemini, Groq, OpenRouter, Ollama…",
  },
];

function SettingsSkeleton() {
  return (
    <Page>
      <PageHeader title="Settings" />
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {Array.from({ length: 2 }).map((__, j) => (
                <div key={j} className="grid gap-3">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full rounded-4xl" />
                  <Skeleton className="h-3 w-56" />
                </div>
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      ))}
    </Page>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  // refetchInterval/focus refetch are off here: this form holds in-progress
  // edits, and a background refetch would silently overwrite them. The query
  // still makes navigating back to this page instant via the shared cache.
  const { data, error: loadError } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !settings) setSettings(data);
  }, [data, settings]);

  // Secret inputs are write-only: the server never echoes stored values back.
  const [secrets, setSecrets] = useState({ llm_api_key: "", telegram_bot_token: "", tavily_api_key: "" });
  const [saving, setSaving] = useState(false);
  const [tgTest, setTgTest] = useState<{ status: "idle" | "sending" | "ok" | "fail"; message?: string }>({
    status: "idle",
  });
  const [clearing, setClearing] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const clearPostings = async () => {
    const ok = await confirm({
      title: "Clear all postings?",
      description:
        "This deletes every scraped posting and its screening/company history, and resets every source so the " +
        "next check re-fetches and re-extracts from scratch. This can't be undone.",
      confirmLabel: "Clear all postings",
      destructive: true,
    });
    if (!ok) return;

    setClearing(true);
    try {
      const res = await api.clearPostings();
      queryClient.invalidateQueries({ queryKey: ["postings"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.show(`Cleared ${res.deleted} posting${res.deleted === 1 ? "" : "s"}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClearing(false);
    }
  };

  const testTelegram = async () => {
    setTgTest({ status: "sending" });
    try {
      await api.testTelegram();
      setTgTest({ status: "ok" });
    } catch (e) {
      setTgTest({ status: "fail", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.saveSettings({
        telegram_chat_id: settings.telegram_chat_id,
        llm_provider: settings.llm_provider,
        llm_model: settings.llm_model,
        llm_base_url: settings.llm_base_url,
        company_filter_enabled: settings.company_filter_enabled,
        ...(secrets.llm_api_key.trim() ? { llm_api_key: secrets.llm_api_key.trim() } : {}),
        ...(secrets.telegram_bot_token.trim() ? { telegram_bot_token: secrets.telegram_bot_token.trim() } : {}),
        ...(secrets.tavily_api_key.trim() ? { tavily_api_key: secrets.tavily_api_key.trim() } : {}),
      });
      setSettings(updated);
      queryClient.setQueryData(["settings"], updated);
      setSecrets({ llm_api_key: "", telegram_bot_token: "", tavily_api_key: "" });
      toast.show("Settings saved");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const secretPlaceholder = (isSet: boolean) => (isSet ? "•••••• set — leave blank to keep" : "not set");

  if (loadError && !settings) {
    return (
      <Page>
        <PageHeader title="Settings" />
        <p className="text-sm text-destructive">
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </p>
      </Page>
    );
  }
  if (!settings) return <SettingsSkeleton />;

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="LLM provider and Telegram delivery configuration. Your job filter lives on the Profile page."
      />

      <form onSubmit={save} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>LLM extraction</CardTitle>
            <CardDescription>The model that reads a careers page and pulls out postings.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-provider">Provider</FieldLabel>
                <SelectCombobox
                  id="settings-provider"
                  options={PROVIDER_OPTIONS}
                  value={settings.llm_provider}
                  onValueChange={(llm_provider) => setSettings({ ...settings, llm_provider })}
                  placeholder="Choose a provider"
                  searchPlaceholder="Search providers…"
                />
                <FieldDescription>
                  Anthropic uses the Messages API; anything OpenAI-shaped goes through the compatible route.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="settings-model">Model</FieldLabel>
                <Input
                  id="settings-model"
                  value={settings.llm_model}
                  onChange={(e) => setSettings({ ...settings, llm_model: e.target.value })}
                  placeholder="claude-sonnet-5"
                />
                <FieldDescription>The exact model id as your provider spells it.</FieldDescription>
              </Field>

              {settings.llm_provider === "openai-compatible" && (
                <Field>
                  <FieldLabel htmlFor="settings-base-url">Base URL</FieldLabel>
                  <Input
                    id="settings-base-url"
                    value={settings.llm_base_url}
                    onChange={(e) => setSettings({ ...settings, llm_base_url: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                  <FieldDescription>
                    Leave blank for OpenAI; set it for Gemini, Groq, OpenRouter, Ollama and friends.
                  </FieldDescription>
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="settings-llm-key">API key</FieldLabel>
                <Input
                  id="settings-llm-key"
                  type="password"
                  value={secrets.llm_api_key}
                  onChange={(e) => setSecrets({ ...secrets, llm_api_key: e.target.value })}
                  placeholder={secretPlaceholder(settings.has_llm_api_key)}
                />
                <FieldDescription>
                  Stored encrypted and never sent back to this page — leave blank to keep the current key.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Telegram</CardTitle>
            <CardDescription>Where matched postings get delivered.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-bot-token">Bot token</FieldLabel>
                <Input
                  id="settings-bot-token"
                  type="password"
                  value={secrets.telegram_bot_token}
                  onChange={(e) => setSecrets({ ...secrets, telegram_bot_token: e.target.value })}
                  placeholder={secretPlaceholder(settings.has_telegram_bot_token)}
                />
                <FieldDescription>Issued by @BotFather when you create the bot.</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="settings-chat-id">Chat ID(s)</FieldLabel>
                <Input
                  id="settings-chat-id"
                  value={settings.telegram_chat_id}
                  onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                  placeholder="123456789, 987654321"
                />
                <FieldDescription>
                  Your numeric ID from @userinfobot — not the bot's own ID. Comma-separate to notify several
                  accounts.
                </FieldDescription>
              </Field>

              <Field orientation="horizontal">
                <Button
                  type="button"
                  variant="outline"
                  disabled={tgTest.status === "sending"}
                  onClick={testTelegram}
                >
                  {tgTest.status === "sending" && <Spinner />}
                  {tgTest.status === "sending" ? "Sending…" : "Send test message"}
                </Button>
                {tgTest.status === "ok" && (
                  <span className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle2Icon className="size-4" />
                    Sent — check your Telegram
                  </span>
                )}
                {tgTest.status === "fail" && (
                  <span className="text-sm text-destructive">{tgTest.message}</span>
                )}
              </Field>

              <FieldDescription>
                Save settings first if you just changed them. "chat not found" means the chat ID is wrong, or you
                haven't pressed Start in your bot's chat yet.
              </FieldDescription>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Company research</CardTitle>
            <CardDescription>
              Look up the company behind a matched posting — legitimacy, size, funding — before notifying. Never
              blocks a match, only adds a caution when something looks off.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="settings-company-filter">
                  Research companies behind matched postings
                </FieldLabel>
                <Switch
                  id="settings-company-filter"
                  checked={settings.company_filter_enabled}
                  onCheckedChange={(company_filter_enabled) =>
                    setSettings({ ...settings, company_filter_enabled })
                  }
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="settings-tavily-key">Tavily API key</FieldLabel>
                <Input
                  id="settings-tavily-key"
                  type="password"
                  value={secrets.tavily_api_key}
                  onChange={(e) => setSecrets({ ...secrets, tavily_api_key: e.target.value })}
                  placeholder={secretPlaceholder(settings.has_tavily_api_key)}
                />
                <FieldDescription>
                  Free at tavily.com.
                  {settings.company_filter_enabled && !settings.has_tavily_api_key && (
                    <span className="text-destructive"> Required for company research to actually run.</span>
                  )}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving && <Spinner />}
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Deletes every scraped posting and its screening/company history, and resets every source so the next
            check re-fetches from scratch. Settings, sources, and company research are kept.
          </CardDescription>
        </CardHeader>
        <CardFooter className="border-t">
          <Button type="button" variant="destructive" disabled={clearing} onClick={clearPostings}>
            {clearing && <Spinner />}
            {clearing ? "Clearing…" : "Clear all postings"}
          </Button>
        </CardFooter>
      </Card>
    </Page>
  );
}
