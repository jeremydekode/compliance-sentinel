import { useEffect, useMemo, useRef, useState } from "react";
import { searchMsic, msicLabel, allMsic, MSIC_COUNT, type MsicEntry } from "@/lib/msic";
import { cn } from "@/lib/utils";
import { Check, Search, X } from "lucide-react";

const RECENT_KEY = "mbrs.msic.recent";
const RECENT_MAX = 5;
/** Rows rendered when browsing unfiltered. The full list is 1,175 entries —
 *  rendering all of them into a dropdown janks the scroll, and nobody browses
 *  to the tail anyway; typing is the real path there. */
const BROWSE_RENDER_CAP = 60;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(code: string) {
  try {
    const next = [code, ...readRecent().filter((c) => c !== code)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recents are a convenience, never load-bearing */
  }
}

/**
 * MSIC code picker: search, browse, clear.
 *
 * Deliberately does NOT suggest a code from the audited report. MSIC belongs to
 * the SSM registration record, and inferring it from the accounts put a
 * wrong-industry code on a real filing — see REGISTRY_ONLY_ENTITY_KEYS in
 * lib/mbrs. With no search term the dropdown opens on the filer's OWN recently
 * used codes (their previous picks, not a machine guess), then the full list to
 * browse. Typing filters across every code.
 */
export function MsicField({
  value,
  onChange,
  flaggedMissing,
}: {
  value: string;
  onChange: (v: string) => void;
  flaggedMissing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const knownLabel = value ? msicLabel(value) : null;
  const display = value ? (knownLabel ? `${value} · ${knownLabel}` : value) : "";
  const invalid = !!value && !knownLabel;

  useEffect(() => setRecent(readRecent()), []);

  const searching = query.trim().length > 0;

  const recentEntries: MsicEntry[] = useMemo(() => {
    if (searching) return [];
    return recent
      .filter((c) => c !== value)
      .map((c) => ({ code: c, label: msicLabel(c) ?? "" }))
      .filter((e) => e.label);
  }, [recent, value, searching]);

  const browseEntries: MsicEntry[] = useMemo(() => {
    if (searching) return searchMsic(query, 40);
    const skip = new Set(recentEntries.map((e) => e.code));
    return allMsic().filter((e) => !skip.has(e.code));
  }, [query, searching, recentEntries]);

  const rendered = searching ? browseEntries : browseEntries.slice(0, BROWSE_RENDER_CAP);
  /** Flat option list — keyboard nav runs across both groups. */
  const options = useMemo(() => [...recentEntries, ...rendered], [recentEntries, rendered]);
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
    pushRecent(e.code);
    setRecent(readRecent());
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
            {recentEntries.length > 0 && (
              <li className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">
                Recently used
              </li>
            )}
            {options.map((o, i) => {
              const startsBrowse = !searching && recentEntries.length > 0 && i === recentEntries.length;
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
                    <span className="text-gray-600 leading-snug">{o.label}</span>
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
