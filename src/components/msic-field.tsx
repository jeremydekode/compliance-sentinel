import { useEffect, useMemo, useRef, useState } from "react";
import { searchMsic, msicLabel, suggestMsic, type MsicEntry } from "@/lib/msic";
import { cn } from "@/lib/utils";
import { Check, Search } from "lucide-react";

/**
 * MSIC code input with search-as-you-type over the official 5-digit code list.
 *
 * Single-line: when closed it displays "47912 · Retail sale of any kind…" in
 * one input, so the row height matches every other field. Typing digits
 * filters by code prefix; typing words filters by label. When the field is
 * empty and a business description is available, ranked suggestions for that
 * description are offered before the filer types at all — the task is
 * "confirm one of these", not "go find the code on SSM's site".
 */
export function MsicField({
  value,
  onChange,
  description,
  flaggedMissing,
  autoFilled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The extracted nature-of-business text this code should correspond to. */
  description?: string;
  flaggedMissing?: boolean;
  /** True when the value was machine-matched from the description. */
  autoFilled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const knownLabel = value ? msicLabel(value) : null;
  const display = value ? (knownLabel ? `${value} · ${knownLabel}` : value) : "";
  const invalid = !!value && !knownLabel;

  const options: MsicEntry[] = useMemo(() => {
    if (query.trim()) return searchMsic(query, 8);
    if (description?.trim()) return suggestMsic(description, 5);
    return [];
  }, [query, description]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setHighlight(0), [query, open]);

  function pick(e: MsicEntry) {
    onChange(e.code);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative w-72">
      <div className="relative">
        <input
          type="text"
          value={open ? query : display}
          placeholder={
            open ? "Type a code or description…" : flaggedMissing ? "Not in report — search the list" : ""
          }
          title={invalid ? `"${value}" is not a recognised MSIC 2008 code` : display}
          onFocus={() => { setOpen(true); setQuery(value); }}
          onChange={(e) => {
            setQuery(e.target.value);
            // Direct 5-digit entry is a valid way to set the value too.
            if (/^\d{5}$/.test(e.target.value.trim())) onChange(e.target.value.trim());
          }}
          onKeyDown={(e) => {
            if (!open || !options.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(options[highlight]); }
            else if (e.key === "Escape") setOpen(false);
          }}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className={cn(
            "w-full text-[13px] px-2.5 py-1.5 pr-8 rounded-md border bg-white text-gray-900 truncate transition-colors duration-150",
            "focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500",
            "placeholder:text-gray-400",
            invalid ? "border-red-400"
              : autoFilled ? "border-amber-400 bg-amber-50/40"
              : flaggedMissing && !value ? "border-amber-400 bg-amber-50/40"
              : "border-gray-300",
          )}
        />
        <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-gray-400 pointer-events-none" />
      </div>

      {open && options.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-[26rem] max-w-[80vw] right-0 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden"
        >
          {!query.trim() && description?.trim() && (
            <li className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 border-b border-gray-100">
              Matches for “{description.slice(0, 60)}{description.length > 60 ? "…" : ""}”
            </li>
          )}
          {options.map((o, i) => (
            <li key={o.code} role="option" aria-selected={i === highlight}>
              <button
                onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "w-full text-left px-3 py-2 flex items-start gap-2.5 text-[13px] transition-colors duration-100",
                  i === highlight ? "bg-teal-50" : "bg-transparent",
                )}
              >
                <span className="font-mono font-semibold tabular-nums shrink-0 text-gray-900">{o.code}</span>
                <span className="text-gray-500 leading-snug">{o.label}</span>
                {o.code === value && <Check className="size-3.5 ml-auto shrink-0 text-teal-600" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
