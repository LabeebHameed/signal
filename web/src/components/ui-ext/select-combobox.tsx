import * as React from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional second line rendered under the label inside the popup. */
  hint?: string;
}

interface SelectComboboxProps {
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Placeholder for the filter input inside the popup. */
  searchPlaceholder?: string;
  emptyLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * The single dropdown control used everywhere in the app: a Base UI combobox
 * whose trigger reads like a form input (same height/radius/border as
 * `<Input>`), with a filterable list in the popup. Replaces every native
 * `<select>` so a dropdown looks identical whether it holds 2 options or 200.
 */
export function SelectCombobox({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyLabel = "No results found.",
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SelectComboboxProps) {
  const selected = options.find((o) => o.value === value) ?? null;
  // The filter input is controlled so it starts empty on every open. Left
  // uncontrolled, Base UI seeds it with the selected item's label, which
  // renders the current value twice — once in the trigger, once in the popup.
  const [query, setQuery] = React.useState("");

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(option) => onValueChange((option as SelectOption | null)?.value ?? "")}
      itemToStringLabel={(option) => (option as SelectOption).label}
      isItemEqualToValue={(a, b) => (a as SelectOption).value === (b as SelectOption).value}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (open) setQuery("");
      }}
      disabled={disabled}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-4xl border border-input bg-input/30 px-3 py-1 text-left text-sm transition-colors outline-none",
          "data-popup-open:border-ring focus-visible:border-ring",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <ComboboxValue placeholder={placeholder}>
          {(option: SelectOption | null) =>
            option ? (
              <span className="truncate">{option.label}</span>
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )
          }
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput placeholder={searchPlaceholder} showTrigger={false} />
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(option: SelectOption) => (
            <ComboboxItem key={option.value} value={option}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.hint && (
                  <span className="truncate text-xs text-muted-foreground">{option.hint}</span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
