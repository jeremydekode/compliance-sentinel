import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Loader2, AlertTriangle, CheckCircle2, Download,
  ScanLine, Save, RefreshCw, ChevronDown, Undo2,
} from "lucide-react";
import {
  runMbrsExtraction, saveMbrsExtraction, generateMbrsXml,
} from "@/lib/compliance.functions";
import {
  ENTITY_FIELDS, SOFP_FIELDS, PL_FIELDS, CF_FIELDS, GROUP_LABELS, DERIVED_KEYS,
  REQUIRED_ENTITY_KEYS,
  type FieldSpec, type MbrsExtraction, type ValidationIssue,
} from "@/lib/mbrs";
import { findExactMsic } from "@/lib/msic";
import { MsicField } from "@/components/msic-field";
import { computeCost, formatUsd } from "@/lib/pricing";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/mbrs/$reportId")({
  component: MbrsFilingPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-10 text-sm text-destructive">{error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-10">Filing not found.</div></AppShell>,
});

type Group = FieldSpec["group"];

const SECTIONS: Array<{ group: Group; fields: FieldSpec[] }> = [
  { group: "entity", fields: ENTITY_FIELDS },
  { group: "sofp", fields: SOFP_FIELDS },
  { group: "pl", fields: PL_FIELDS },
  { group: "cf", fields: CF_FIELDS },
];

const NAV_LABELS: Record<Group, string> = {
  entity: "Company details",
  sofp: "Financial position",
  pl: "Profit or loss",
  cf: "Cash flows",
};

/** msicCodeN → its paired description field. */
const MSIC_PAIRS: Array<[code: string, description: string]> = [
  ["msicCode1", "businessDescription1"],
  ["msicCode2", "businessDescription2"],
  ["msicCode3", "businessDescription3"],
];
const MSIC_KEYS = new Set(MSIC_PAIRS.map(([c]) => c));
const REQUIRED = new Set<string>(REQUIRED_ENTITY_KEYS);

function fmtMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-MY", { maximumFractionDigits: 2 }).format(n);
}

/** Accounting parentheses read as negative, matching how the statement prints. */
function parseMoney(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t);
  const cleaned = (neg ? t.slice(1, -1) : t).replace(/[,\s]/g, "").replace(/^RM/i, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function isBlank(f: FieldSpec, x: MbrsExtraction): boolean {
  if (f.group === "entity") return !String(x.entity?.[f.key] ?? "").trim();
  return typeof x.current?.[f.key] !== "number" && typeof x.previous?.[f.key] !== "number";
}

function MbrsFilingPage() {
  const { reportId } = Route.useParams();
  const qc = useQueryClient();
  const startedRef = useRef(false);
  const sectionRefs = useRef<Partial<Record<Group, HTMLElement | null>>>({});

  const runExtract = useServerFn(runMbrsExtraction);
  const saveFn = useServerFn(saveMbrsExtraction);
  const genFn = useServerFn(generateMbrsXml);

  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<MbrsExtraction | null>(null);
  const [collapsed, setCollapsed] = useState<Set<Group>>(new Set());
  const [activeGroup, setActiveGroup] = useState<Group>("entity");
  /** MSIC codes machine-matched this session — flagged until saved. */
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());

  const report = useQuery({
    queryKey: ["mbrs_report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analysis_reports").select("*").eq("id", reportId).single();
      if (error) throw error;
      return data;
    },
  });

  const sj = ((report.data as any)?.summary_json ?? {}) as any;
  const extraction: MbrsExtraction | undefined = sj.mbrs_extraction;
  const issues: ValidationIssue[] = sj.mbrs_issues ?? [];
  const status: string = sj.mbrs_status ?? (sj.pending_analysis ? "queued" : "unknown");

  // Seed the editable draft — and enter MSIC codes the filer would otherwise
  // have to look up. Only an EXACT label match may auto-enter (a wrong MSIC
  // code on a statutory filing is worse than a blank), it's flagged "confirm",
  // and the fill lands in the unsaved draft so the save step is the
  // confirmation gate — nothing reaches the filing unseen.
  useEffect(() => {
    if (!extraction || draft) return;
    const seeded: MbrsExtraction = { ...extraction, entity: { ...extraction.entity } };
    const filled = new Set<string>();
    for (const [codeKey, descKey] of MSIC_PAIRS) {
      if (String(seeded.entity[codeKey] ?? "").trim()) continue;
      const desc = String(seeded.entity[descKey] ?? "").trim();
      if (!desc) continue;
      const hit = findExactMsic(desc);
      if (hit) {
        seeded.entity[codeKey] = hit.code;
        filled.add(codeKey);
      }
    }
    setDraft(seeded);
    if (filled.size) {
      setAutoFilled(filled);
      toast.info(
        `Matched ${filled.size} MSIC code${filled.size === 1 ? "" : "s"} from the business description`,
        { description: "Confirm and save — codes come from the official MSIC 2008 list, never guessed." },
      );
    }
  }, [extraction]);

  async function runAnalysis() {
    if (running) return;
    setRunning(true);
    try {
      await runExtract({ data: { reportId } });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["mbrs_report", reportId] });
    } catch (e: any) {
      // A long extraction can outlive the HTTP request while still completing
      // server-side; re-read before calling it a failure, or the retry bills
      // the whole OCR pass twice.
      await qc.invalidateQueries({ queryKey: ["mbrs_report", reportId] });
      const { data } = await supabase
        .from("analysis_reports").select("summary_json").eq("id", reportId).single();
      if (!(data as any)?.summary_json?.mbrs_extraction) {
        toast.error("Extraction failed", { description: e?.message });
      }
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    if (report.isLoading || !report.data) return;
    if (sj.pending_analysis) {
      startedRef.current = true;
      runAnalysis();
    }
  }, [report.isLoading, report.data]);

  const view = draft ?? extraction;
  const naSet = useMemo(() => new Set(view?.na ?? []), [view]);

  const dirty = useMemo(
    () => !!draft && !!extraction && JSON.stringify(draft) !== JSON.stringify(extraction),
    [draft, extraction],
  );

  /** Per-section outstanding work, driving the rail badges and the checklist. */
  const stats = useMemo(() => {
    const out: Record<Group, { errors: number; toFill: FieldSpec[]; toConfirm: FieldSpec[] }> = {
      entity: { errors: 0, toFill: [], toConfirm: [] },
      sofp: { errors: 0, toFill: [], toConfirm: [] },
      pl: { errors: 0, toFill: [], toConfirm: [] },
      cf: { errors: 0, toFill: [], toConfirm: [] },
    };
    if (!view) return out;
    for (const i of issues) {
      if (i.severity === "error") out[i.group].errors += 1;
    }
    for (const { group, fields } of SECTIONS) {
      for (const f of fields) {
        if (DERIVED_KEYS.has(f.key) || naSet.has(f.key)) continue;
        if (autoFilled.has(f.key) && !isBlank(f, view)) {
          out[group].toConfirm.push(f);
          continue;
        }
        if (view.missing?.includes(f.key) && isBlank(f, view)) out[group].toFill.push(f);
      }
    }
    return out;
  }, [view, issues, autoFilled, naSet]);

  const totalToFill = SECTIONS.reduce((n, s) => n + stats[s.group].toFill.length, 0);
  const totalToConfirm = SECTIONS.reduce((n, s) => n + stats[s.group].toConfirm.length, 0);
  const errors = issues.filter((i) => i.severity === "error");

  const jumpTo = useCallback((group: Group, fieldKey?: string) => {
    setCollapsed((prev) => {
      if (!prev.has(group)) return prev;
      const next = new Set(prev);
      next.delete(group);
      return next;
    });
    requestAnimationFrame(() => {
      const target = fieldKey
        ? document.getElementById(`mbrs-field-${fieldKey}`)
        : sectionRefs.current[group];
      target?.scrollIntoView({ behavior: "smooth", block: fieldKey ? "center" : "start" });
      if (fieldKey) {
        const input = document.getElementById(`mbrs-field-${fieldKey}`)?.querySelector("input");
        (input as HTMLInputElement | null)?.focus();
      }
    });
  }, []);

  // Scroll-spy: highlight whichever section owns the upper third of the viewport.
  useEffect(() => {
    if (!view) return;
    const els = SECTIONS.map((s) => sectionRefs.current[s.group]).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const g = visible?.target.getAttribute("data-group") as Group | undefined;
        if (g) setActiveGroup(g);
      },
      { rootMargin: "-80px 0px -66% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [view, collapsed]);

  function toggleNa(key: string) {
    if (!view) return;
    const na = new Set(view.na ?? []);
    if (na.has(key)) {
      na.delete(key);
    } else {
      na.add(key);
      setAutoFilled((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    setDraft({
      ...view,
      na: Array.from(na),
      // Marking N/A clears any value so the filing stays blank there.
      entity: na.has(key) ? { ...view.entity, [key]: "" } : view.entity,
    });
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await saveFn({
        data: {
          reportId,
          entity: draft.entity,
          current: draft.current,
          previous: draft.previous,
          na: draft.na ?? [],
        },
      });
      setDraft(null);
      setAutoFilled(new Set()); // saving IS the confirmation
      await qc.invalidateQueries({ queryKey: ["mbrs_report", reportId] });
      toast.success("Saved and re-validated");
    } catch (e: any) {
      toast.error("Could not save", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  async function download() {
    if (generating) return;
    setGenerating(true);
    try {
      const { xml, filename, factCount } = await genFn({ data: { reportId } });
      const blob = new Blob([xml], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      await qc.invalidateQueries({ queryKey: ["mbrs_report", reportId] });
      toast.success(`Generated ${filename}`, { description: `${factCount} XBRL facts` });
    } catch (e: any) {
      toast.error("Cannot generate the filing", { description: e?.message });
    } finally {
      setGenerating(false);
    }
  }

  const busyExtracting = running || status === "running" || status === "queued";

  if (report.isLoading) {
    return <AppShell><div className="p-10 text-sm text-gray-500 bg-white min-h-screen">Loading…</div></AppShell>;
  }

  if (busyExtracting || (!view && status !== "failed")) {
    return (
      <AppShell>
        <div className="bg-white min-h-screen grid place-items-center p-10">
          <div className="text-center max-w-md">
            <ScanLine className="size-8 mx-auto text-teal-600 animate-pulse motion-reduce:animate-none" />
            <h2 className="mt-4 text-lg font-bold text-gray-900">Reading the audited report</h2>
            <p className="mt-2 text-sm text-gray-500">
              Extracting the statements, notes and disclosures. Scanned reports go through OCR —
              around a minute.
            </p>
            <Loader2 className="size-4 mx-auto mt-5 animate-spin motion-reduce:animate-none text-gray-400" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (!view) {
    return (
      <AppShell>
        <div className="bg-white min-h-screen grid place-items-center p-10">
          <div className="text-center max-w-md">
            <AlertTriangle className="size-8 mx-auto text-red-600" />
            <h2 className="mt-4 text-lg font-bold text-gray-900">Extraction failed</h2>
            <p className="mt-2 text-sm text-gray-500">{sj.mbrs_error}</p>
            <Button onClick={runAnalysis} className="mt-5 gap-2 bg-teal-600 hover:bg-teal-700 text-white" disabled={running}>
              <RefreshCw className="size-3.5" /> Try again
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  const outstanding = totalToFill + totalToConfirm + errors.length;

  return (
    <AppShell>
      <div className="bg-white min-h-screen">
        {/* Sticky action bar — pinned BELOW the app shell's own h-14 sticky
            header; both at top-0 would fight and un-stick the section rail. */}
        <header className="sticky top-14 z-10 border-b border-gray-200 bg-white">
          <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-gray-900 truncate">
                {view.entity.entityName || (report.data as any)?.title}
              </h1>
              <p className="text-xs text-gray-500">
                MBRS · FS-MPERS
                {view.entity.registrationNumber ? ` · Reg. ${view.entity.registrationNumber}` : ""}
                {" · FY "}{view.entity.currentPeriodStart || "?"} – {view.entity.currentPeriodEnd || "?"}
                {sj.usage ? ` · ${formatUsd(computeCost(sj.usage, sj.mbrs_model).usd)}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={runAnalysis} variant="ghost" size="sm" className="gap-1.5 text-gray-600" disabled={running}>
                <RefreshCw className="size-3.5" /> Re-extract
              </Button>
              <Button
                onClick={save}
                disabled={!dirty || saving}
                variant="outline"
                className="gap-1.5 border-gray-300"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Save className="size-3.5" />}
                {dirty ? "Save" : "Saved"}
              </Button>
              <Button
                onClick={download}
                disabled={generating || errors.length > 0 || dirty}
                className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white"
                title={
                  dirty ? "Save your changes first"
                  : errors.length ? "Fix the validation errors first"
                  : "Download the SSM XBRL file"
                }
              >
                {generating ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Download className="size-3.5" />}
                Download XBRL
              </Button>
            </div>
          </div>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6 flex gap-8 items-start">
          {/* Section rail */}
          <nav
            aria-label="Filing sections"
            className="hidden lg:block w-52 shrink-0 sticky top-[136px]"
          >
            <ul className="space-y-0.5">
              {SECTIONS.map(({ group }) => {
                const s = stats[group];
                const active = activeGroup === group;
                const count = s.errors + s.toFill.length + s.toConfirm.length;
                return (
                  <li key={group}>
                    <button
                      onClick={() => jumpTo(group)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-md text-[13px] flex items-center justify-between gap-2 transition-colors duration-150",
                        active
                          ? "bg-teal-50 text-teal-800 font-semibold"
                          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
                      )}
                    >
                      <span className="truncate">{NAV_LABELS[group]}</span>
                      {count > 0 ? (
                        <span
                          className={cn(
                            "min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold grid place-items-center",
                            s.errors > 0 ? "bg-red-600 text-white" : "bg-gray-200 text-gray-700",
                          )}
                        >
                          {count}
                        </span>
                      ) : (
                        <CheckCircle2 className="size-3.5 text-teal-600 shrink-0" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex-1 min-w-0 max-w-[41rem] space-y-4">
            {/* Status strip. Only true validation errors get listed here —
                fill/confirm work is already visible in the rail and the form. */}
            <section
              className={cn(
                "rounded-lg border px-4 py-3",
                errors.length ? "border-red-200" : "border-gray-200",
              )}
            >
              <div className="flex items-center gap-2">
                {outstanding === 0 ? (
                  <>
                    <CheckCircle2 className="size-4 text-teal-600 shrink-0" />
                    <span className="text-sm font-semibold text-gray-900">Ready to generate</span>
                  </>
                ) : (
                  <span className="text-sm font-semibold text-gray-900">
                    {[
                      errors.length && `${errors.length} error${errors.length === 1 ? "" : "s"}`,
                      totalToFill && `${totalToFill} to fill in`,
                      totalToConfirm && `${totalToConfirm} to confirm`,
                    ].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
              {errors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {errors.map((i, n) => (
                    <li key={n}>
                      <button
                        onClick={() => jumpTo(i.group, i.fields[0])}
                        className="text-left text-[13px] text-red-700 hover:underline underline-offset-2"
                      >
                        {i.period && <span className="capitalize">{i.period} — </span>}
                        {i.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* The review form */}
            {SECTIONS.map(({ group, fields }) => {
              const s = stats[group];
              const isOpen = !collapsed.has(group);
              const count = s.errors + s.toFill.length + s.toConfirm.length;
              return (
                <section
                  key={group}
                  data-group={group}
                  ref={(el) => { sectionRefs.current[group] = el; }}
                  className="rounded-lg border border-gray-200 overflow-hidden scroll-mt-36"
                >
                  <h2>
                    <button
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(group)) next.delete(group); else next.add(group);
                          return next;
                        })
                      }
                      aria-expanded={isOpen}
                      className="w-full px-4 py-2.5 bg-white hover:bg-gray-50 transition-colors duration-150 flex items-center gap-3 text-left"
                    >
                      <ChevronDown
                        className={cn(
                          "size-4 text-gray-400 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                          !isOpen && "-rotate-90",
                        )}
                      />
                      <span className="text-sm font-semibold text-gray-900 flex-1">{GROUP_LABELS[group]}</span>

                      {count > 0 ? (
                        <span
                          className={cn(
                            "text-[11px] font-semibold px-2 py-0.5 rounded-full",
                            s.errors > 0 ? "bg-red-600 text-white" : "bg-gray-100 text-gray-600",
                          )}
                        >
                          {s.errors > 0 ? `${s.errors} error${s.errors === 1 ? "" : "s"}` : `${count} outstanding`}
                        </span>
                      ) : (
                        <CheckCircle2 className="size-4 text-teal-600 shrink-0" />
                      )}

                    </button>
                  </h2>

                  {/* 0fr→1fr keeps the collapse smooth without measuring heights. */}
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                      isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                    )}
                  >
                    <div className="overflow-hidden">
                      <div className="divide-y divide-gray-100 border-t border-gray-200">
                        {/* Two-column table: right-aligned label hugging the
                            control column, so there's no dead space to travel
                            across. Same grid on every row = perfect alignment. */}
                        {group !== "entity" && (
                          <div className="hidden sm:grid grid-cols-[16rem_1fr] gap-x-5 px-4 py-1.5">
                            <span />
                            <span className="flex gap-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                              <span className="w-32 text-right">Current</span>
                              <span className="w-32 text-right">Previous</span>
                            </span>
                          </div>
                        )}
                        {fields.map((f) => {
                          const na = naSet.has(f.key);
                          const flaggedMissing = !na && view.missing?.includes(f.key) && isBlank(f, view);
                          const derived = DERIVED_KEYS.has(f.key);
                          const isAutoFilled = autoFilled.has(f.key) && !isBlank(f, view);
                          const flagged = issues.some(
                            (i) => i.severity === "error" && i.fields.includes(f.key),
                          );
                          const sub = f.label.startsWith("—");
                          const canNa = f.group === "entity" && !REQUIRED.has(f.key);
                          return (
                            <div
                              key={f.key}
                              id={`mbrs-field-${f.key}`}
                              className={cn(
                                "grid sm:grid-cols-[16rem_1fr] items-center gap-x-5 gap-y-1 px-4 py-2 scroll-mt-40",
                                flagged && "bg-red-50",
                              )}
                            >
                              <div className="flex items-center sm:justify-end gap-2 min-w-0">
                                {isAutoFilled && (
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">
                                    confirm
                                  </span>
                                )}
                                {derived && (
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 shrink-0">
                                    auto
                                  </span>
                                )}
                                <span
                                  title={f.label.length > 30 ? f.label : undefined}
                                  className={cn(
                                    "text-[13px] sm:text-right truncate",
                                    sub ? "text-gray-500" : "text-gray-800",
                                  )}
                                >
                                  {sub ? f.label.replace(/^—\s*/, "↳ ") : f.label}
                                </span>
                              </div>

                              {group === "entity" ? (
                                <div className="flex items-center gap-1.5">
                                  {na ? (
                                    <div className="w-72 px-2.5 py-1.5 text-[13px] text-gray-400 italic border border-transparent">
                                      Not applicable
                                    </div>
                                  ) : MSIC_KEYS.has(f.key) ? (
                                    <MsicField
                                      value={view.entity[f.key] ?? ""}
                                      onChange={(v) => {
                                        setAutoFilled((prev) => {
                                          if (!prev.has(f.key)) return prev;
                                          const next = new Set(prev);
                                          next.delete(f.key);
                                          return next;
                                        });
                                        setDraft({ ...view, entity: { ...view.entity, [f.key]: v } });
                                      }}
                                      description={view.entity[MSIC_PAIRS.find(([c]) => c === f.key)?.[1] ?? ""] ?? ""}
                                      flaggedMissing={flaggedMissing}
                                      autoFilled={isAutoFilled}
                                    />
                                  ) : (
                                    <input
                                      type="text"
                                      value={view.entity[f.key] ?? ""}
                                      onChange={(e) =>
                                        setDraft({ ...view, entity: { ...view.entity, [f.key]: e.target.value } })
                                      }
                                      placeholder={flaggedMissing ? "Not in report" : ""}
                                      className={cn(
                                        "w-72 text-[13px] px-2.5 py-1.5 rounded-md border bg-white text-gray-900 transition-colors duration-150",
                                        "focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500",
                                        "placeholder:text-gray-400",
                                        flagged ? "border-red-400"
                                          : flaggedMissing ? "border-amber-400 bg-amber-50/40"
                                          : "border-gray-300",
                                      )}
                                    />
                                  )}
                                  <span className="w-9 shrink-0">
                                    {na ? (
                                      <button
                                        onClick={() => toggleNa(f.key)}
                                        title="Undo N/A"
                                        className="w-9 py-1.5 grid place-items-center rounded-md border border-gray-200 text-gray-400 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors duration-100"
                                      >
                                        <Undo2 className="size-3.5" />
                                      </button>
                                    ) : canNa && isBlank(f, view) ? (
                                      <NaButton onClick={() => toggleNa(f.key)} />
                                    ) : null}
                                  </span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-3">
                                  {(["current", "previous"] as const).map((period) => (
                                    <input
                                      key={period}
                                      type="text"
                                      inputMode="decimal"
                                      disabled={derived}
                                      aria-label={`${f.label} — ${period} period`}
                                      value={fmtMoney(view[period]?.[f.key])}
                                      onChange={(e) =>
                                        setDraft({
                                          ...view,
                                          [period]: { ...view[period], [f.key]: parseMoney(e.target.value) },
                                        })
                                      }
                                      className={cn(
                                        "w-32 text-[13px] text-right tabular-nums px-2.5 py-1.5 rounded-md border bg-white text-gray-900 transition-colors duration-150",
                                        "focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500",
                                        derived && "text-gray-500 bg-gray-50 cursor-not-allowed",
                                        flagged ? "border-red-400" : "border-gray-300",
                                      )}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function NaButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Mark as not applicable"
      className="w-9 py-1.5 grid place-items-center text-[11px] font-medium rounded-md border border-gray-200 text-gray-400 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors duration-100"
    >
      N/A
    </button>
  );
}
