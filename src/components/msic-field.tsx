import { useEffect, useMemo, useRef, useState } from "react";
import { searchMsic, msicLabel, allMsic, MSIC_COUNT, type MsicEntry } from "@/lib/msic";
import { cn } from "@/lib/utils";
import { Check, Search, X, Sparkles } from "lucide-react";

/** Rows rendered when browsing unfiltered. The full list is 1,175 entries —
 *  rendering all of them into a dropdown janks the scroll, and nobody browses
 *  to the tail anyway; typing is the real path there. */
const BROWSE_RENDER_CAP = 60;

/**
 * MSIC code picker: suggestions, search, browse, clear.
 *
 * Opening with no search term shows AI-suggested codes for THIS company —
 * grounded in the report's own principal-activities wording, validated against
 * the official list, and shown with that wording so the filer can judge them
 * (see lib/mbrs-msic-suggest). They are candidates only: picking is always a
 * human act, and the field stays flagged until one is chosen. The full list
 * follows underneath, and typing searches all 1,175 codes.
 */
export function MsicField({
  value,
  onChange,
  flaggedMissing,
  suggestions = [],
  suggestNote,
  evidence,
}: {
  value: string;
  onChange: (v: string) => void;
  flaggedMissing?: boolean;
  /** AI candidates for this company, already validated against the code list. */
  suggestions?: Array<{ code: string; label: string; reason?: string }>;
  /** Why there are none, when there are none. */
  suggestNote?: string | null;
  /** The report wording the suggestions were drawn from. */
  evidence?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const knownLabel = value ? msicLabel(value) : null;
  const display = value ? (knownLabel ? `${value} · ${knownLabel}` : value) : "";
  const invalid = !!value && !knownLabel;

  const searching = query.trim().length > 0;

  const suggestEntries: MsicEntry[] = useMemo(() => {
    if (searching) return [];
    return suggestions
      .filter((sg) => sg.code && sg.label)
      .map((sg) => ({ code: sg.code, label: sg.label }));
  }, [suggestions, searching]);
  const reasonFor = useMemo(
    () => new Map(suggestions.map((sg) => [sg.code, sg.reason ?? ""])),
    [suggestions],
  );

  const browseEntries: MsicEntry[] = useMemo(() => {
    if (searching) return searchMsic(query, 40);
    const skip = new Set(suggestEntries.map((e) => e.code));
    return allMsic().filter((e) => !skip.has(e.code));
  }, [query, searching, suggestEntries]);

  const rendered = searching ? browseEntries : browseEntries.slice(0, BROWSE_RENDER_CAP);
  /** Flat option list — keyboard nav runs across both groups. */
  const options = useMemo(() => [...suggestEntries, ...rendered], [suggestEntries, rendered]);
  const hiddenCount = searching ? 0 : browseEntries.length - rendered.length;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setHighlight(0), [query, open]);

  // Keep the highlighted row in view during arrow-key nav.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function pick(e: MsicEntry) {
    onChange(e.code);
    setQuery("");
    setOpen(false);
  }

  function clear() {
    onChange("");
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
            open
              ? value ? `${display} — type to change` : "Search code or activity…"
              : flaggedMissing ? "Not in report — search the list" : ""
          }
          title={invalid ? `"${value}" is not a recognised MSIC 2008 code` : display}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); return; }
            if (!open || !options.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(options[highlight]); }
          }}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className={cn(
            "w-full text-[13px] px-2.5 py-1.5 rounded-md border bg-white text-gray-900 truncate transition-colors duration-150",
            "focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500",
            "placeholder:text-gray-400",
            value ? "pr-14" : "pr-8",
            invalid ? "border-red-400"
              : flaggedMissing && !value ? "border-amber-400 bg-amber-50/40"
              : "border-gray-300",
          )}
        />

        {value && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); clear(); }}
            title="Clear this code"
            aria-label="Clear MSIC code"
            className="absolute right-7 top-1/2 -translate-y-1/2 grid place-items-center size-5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <X className="size-3.5" />
          </button>
        )}
        <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-gray-400 pointer-events-none" />
      </div>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[28rem] max-w-[80vw] rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
          <ul ref={listRef} role="listbox" className="max-h-72 overflow-y-auto">
            {!searching && suggestEntries.length > 0 && (
              <li className="px-3 pt-2 pb-1.5 bg-amber-50/60 border-b border-amber-100">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
                  <Sparkles className="size-3" />
                  Suggested for this company
                </div>
                {evidence && (
                  <p className="mt-1 text-[11px] text-amber-900/80 leading-snug">
                    From the report: “{evidence.slice(0, 180)}{evidence.length > 180 ? "…" : ""}”
                  </p>
                )}
                <p className="mt-1 text-[11px] text-amber-900/70 leading-snug">
                  Suggestions only — confirm against the company's SSM registration before filing.
                </p>
              </li>
            )}
            {!searching && suggestEntries.length === 0 && suggestNote && (
              <li className="px-3 py-2 text-[11px] text-gray-500 leading-snug bg-gray-50 border-b border-gray-100">
                {suggestNote}
              </li>
            )}
            {options.map((o, i) => {
              const startsBrowse = !searching && suggestEntries.length > 0 && i === suggestEntries.length;
              const reason = !searching && i < suggestEntries.length ? reasonFor.get(o.code) : "";
              return (
                <li key={`${o.code}-${i}`} role="option" aria-selected={i === highlight}>
                  {startsBrowse && (
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50 border-t border-gray-100">
                      All MSIC codes
                    </div>
                  )}
                  <button
                    data-idx={i}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "w-full text-left px-3 py-1.5 flex items-start gap-2.5 text-[13px] transition-colors duration-100",
                      i === highlight ? "bg-teal-50" : "bg-transparent",
                    )}
                  >
                    <span className="font-mono font-semibold tabular-nums shrink-0 text-gray-900">{o.code}</span>
                    <span className="leading-snug">
                      <span className="text-gray-600">{o.label}</span>
                      {reason && (
                        <span className="block text-[11px] text-amber-800/80 mt-0.5">{reason}</span>
                      )}
                    </span>
                    {o.code === value && <Check className="size-3.5 ml-auto shrink-0 text-teal-600" />}
                  </button>
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="px-3 py-3 text-[13px] text-gray-500">
                No MSIC code matches “{query.trim()}”.
              </li>
            )}
          </ul>

          <div className="px-3 py-1.5 border-t border-gray-100 bg-gray-50 text-[11px] text-gray-500">
            {searching
              ? `${browseEntries.length} match${browseEntries.length === 1 ? "" : "es"} of ${MSIC_COUNT} codes`
              : hiddenCount > 0
                ? `Showing ${rendered.length} of ${MSIC_COUNT} codes — type to search the rest`
                : `${MSIC_COUNT} codes`}
          </div>
        </div>
      )}
    </div>
  );
}
