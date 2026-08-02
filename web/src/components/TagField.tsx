// A list of values edited as discrete tags rather than one comma-soup string.
//
// The interaction the Profile page needs: a committed tag is a single element,
// and backspacing it lifts it back into the input as plain editable text
// instead of deleting it outright. So the field has exactly three states — a
// draft being typed, a set of committed tags, and (for keyboard users) one
// selected tag. Everything below is those three and the moves between them.
//
// Tags carry a tone (what the tag DOES — a keyword, an exclusion, an allowed
// place) and, separately, provenance (who wrote it — the seeker or the LLM
// expansion). Those are orthogonal, so provenance is a modifier on top of the
// tone rather than a fifth tone.

import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { isAiValue, normalizeTag, tagKey } from "../lib/profileTags";
import { cn } from "@/lib/utils";

export type TagTone = "neutral" | "negative" | "include" | "exclude";

/** What the tag DOES, mapped onto brand tokens. Provenance (AI vs. the
 * seeker's own typing) is layered on top as a modifier, not a fifth tone. */
const TONE_CLASSES: Record<TagTone, string> = {
  neutral: "bg-muted text-foreground",
  negative: "bg-destructive/15 text-destructive",
  include: "bg-primary/15 text-primary",
  exclude: "bg-destructive/15 text-destructive",
};

interface TagFieldProps {
  values: string[];
  onChange: (next: string[]) => void;
  tone?: TagTone;
  placeholder?: string;
  /** Values the LLM authored — rendered distinctly from the seeker's own. */
  aiValues?: string[];
  /** Ties the field to its <label> and hint for screen readers. */
  id?: string;
  describedBy?: string;
}

export default function TagField({
  values,
  onChange,
  tone = "neutral",
  placeholder,
  aiValues = [],
  id,
  describedBy,
}: TagFieldProps) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [duplicate, setDuplicate] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);

  // The duplicate flash is feedback, not state — clear it once it has played.
  useEffect(() => {
    if (duplicate === null) return;
    const timer = window.setTimeout(() => setDuplicate(null), 600);
    return () => window.clearTimeout(timer);
  }, [duplicate]);

  // Move real DOM focus to follow the selected chip, so arrow-key navigation
  // is announced by a screen reader rather than being a purely visual change.
  useEffect(() => {
    if (selected !== null) chipRefs.current[selected]?.focus();
  }, [selected]);

  const focusInput = () => inputRef.current?.focus();

  /** Commit the draft. A value already in the list flashes the existing tag
   * instead of adding a second copy — silently swallowing the keystroke would
   * read as the field being broken. */
  const commit = (raw: string): boolean => {
    const value = normalizeTag(raw);
    if (value === "") {
      setDraft("");
      return false;
    }
    const existing = values.findIndex((v) => tagKey(v) === tagKey(value));
    if (existing !== -1) {
      setDuplicate(existing);
      setDraft("");
      return false;
    }
    onChange([...values, value]);
    setDraft("");
    return true;
  };

  /** Pull a tag out of the list and back into the input for editing — the
   * "backspace splits it into the actual word again" behaviour. Any draft
   * already being typed is committed first so it isn't lost. */
  const lift = (index: number) => {
    const value = values[index];
    const remaining = values.filter((_, i) => i !== index);
    const pending = normalizeTag(draft);
    const kept = pending !== "" && !remaining.some((v) => tagKey(v) === tagKey(pending))
      ? [...remaining, pending]
      : remaining;
    onChange(kept);
    setDraft(value);
    setSelected(null);
    focusInput();
  };

  const remove = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
    setSelected(null);
    focusInput();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Comma is a commit key, which is what guarantees no tag ever contains
    // one — the delimiter the profile is stored with stays unambiguous.
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === "Backspace" && draft === "" && values.length > 0) {
      e.preventDefault();
      lift(values.length - 1);
      return;
    }
    if (e.key === "ArrowLeft" && draft === "" && values.length > 0) {
      e.preventDefault();
      setSelected(values.length - 1);
      return;
    }
    if (e.key === "Escape") {
      setDraft("");
      setSelected(null);
    }
  };

  const onTagKeyDown = (e: KeyboardEvent<HTMLSpanElement>, index: number) => {
    if (e.key === "Backspace" || e.key === "Enter") {
      e.preventDefault();
      lift(index);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      remove(index);
      return;
    }
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      setSelected(index - 1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < values.length - 1) setSelected(index + 1);
      else {
        setSelected(null);
        focusInput();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setSelected(null);
      focusInput();
    }
  };

  return (
    <div
      className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-4xl border border-input bg-input/30 px-2.5 py-1.5 text-sm transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
      onMouseDown={(e) => {
        // Clicking the padding focuses the input; clicking a tag or its
        // remove button must keep its own handler.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          focusInput();
        }
      }}
    >
      {values.map((value, index) => {
        const ai = isAiValue(aiValues, value);
        return (
          <span
            key={`${tagKey(value)}-${index}`}
            className={cn(
              "flex h-[calc(--spacing(5.5))] cursor-pointer items-center gap-1 rounded-4xl px-2 text-xs font-medium whitespace-nowrap outline-none",
              TONE_CLASSES[tone],
              ai && "ring-1 ring-current/30 ring-inset",
              selected === index && "ring-2 ring-ring",
              duplicate === index && "animate-pulse ring-2 ring-amber-500",
            )}
            tabIndex={-1}
            role="button"
            aria-label={`${ai ? "AI-suggested" : "You added"}: ${value}. Press Backspace to edit, Delete to remove.`}
            onKeyDown={(e) => onTagKeyDown(e, index)}
            // Suppress the input's blur so lift() sees the live draft rather
            // than racing the blur handler's own commit.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => lift(index)}
            ref={(node) => {
              chipRefs.current[index] = node;
            }}
          >
            {ai && (
              <svg
                className="shrink-0 opacity-70"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z" />
              </svg>
            )}
            <span>{value}</span>
            <button
              type="button"
              className="-mr-1 flex size-4 shrink-0 items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100"
              aria-label={`Remove ${value}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                remove(index);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        id={id}
        aria-describedby={describedBy}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onInputKeyDown}
        // Committing on blur is deliberate: a half-typed value that vanishes
        // when you click Save is data loss the seeker never sees happen.
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
