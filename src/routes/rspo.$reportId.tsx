import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Loader2, AlertTriangle, CheckCircle2, ShieldCheck, RefreshCw, ChevronDown,
  Download, Flag, Check, ScanSearch, FileWarning,
} from "lucide-react";
import {
  runRspoPrismaParse, runRspoExtraction, saveRspoVerdicts,
} from "@/lib/compliance.functions";
import {
  RSPO_CHECKLIST, RSPO_AREAS, CERT_TYPE_LABELS,
  type RspoArea, type RspoItemResult, type RspoItemStatus, type RspoSource,
} from "@/lib/rspo-checklist";
import { exportRspoChecklist } from "@/lib/rspo-export";
import { AiCostTooltip } from "@/components/ai-cost-tooltip";
import { computeCost } from "@/lib/pricing";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/rspo/$reportId")({
  component: RspoReviewPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-10 text-sm text-destructive">{error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-10">Review not found.</div></AppShell>,
});

const ITEM_BY_ID = new Map(RSPO_CHECKLIST.map((i) => [i.id, i]));

const SOURCE_LABELS: Record<RspoSource, string> = {
  prisma: "PRISMA",
  certificate: "Certificate",
  audit_report: "Audit report",
};

const STATUS_META: Record<RspoItemStatus, { label: string; chip: string; dot: string }> = {
  pass:           { label: "Pass",         chip: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
  mismatch:       { label: "Mismatch",     chip: "bg-rose-100 text-rose-800",       dot: "bg-rose-500" },
  missing:        { label: "Missing",      chip: "bg-amber-100 text-amber-800",     dot: "bg-amber-500" },
  needs_review:   { label: "Check",        chip: "bg-sky-100 text-sky-800",         dot: "bg-sky-500" },
  not_applicable: { label: "N/A",          chip: "bg-gray-100 text-gray-500",       dot: "bg-gray-300" },
};

interface Verdict {
  verdict: "accepted" | "flagged" | null;
  remarks: string;
  by?: string | null;
  at?: string;
  stale?: boolean;
}

function RspoReviewPage() {
  const { reportId } = Route.useParams();
  const qc = useQueryClient();
  const startedRef = useRef(false);
  const sectionRefs = useRef<Partial<Record<RspoArea, HTMLElement | null>>>({});

  const parseFn = useServerFn(runRspoPrismaParse);
  const extractFn = useServerFn(runRspoExtraction);
  const saveFn = useServerFn(saveRspoVerdicts);

  const [running, setRunning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<RspoArea>>(new Set());
  const [activeArea, setActiveArea] = useState<RspoArea>("License Details");
  const [pickedApp, setPickedApp] = useState<string | null>(null);
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set());
  /** Local verdict edits not yet flushed to the server. */
  const [dirty, setDirty] = useState<Record<string, Verdict>>({});
  const [savingVerdicts, setSavingVerdicts] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const report = useQuery({
    queryKey: ["rspo_report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analysis_reports").select("*").eq("id", reportId).single();
      if (error) throw error;
      return data;
    },
    refetchInterval: (q) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sj = ((q.state.data as any)?.summary_json ?? {}) as any;
      const busyStates = ["queued", "parsing_prisma", "extracting"];
      return sj.pending_analysis || busyStates.includes(sj.rspo_status) ? 4000 : false;
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sj = ((report.data as any)?.summary_json ?? {}) as any;
  const status: string = sj.rspo_status ?? (sj.pending_analysis ? "queued" : "unknown");
  const results: RspoItemResult[] = sj.rspo_results ?? [];
  const verdicts: Record<string, Verdict> = sj.rspo_verdicts ?? {};
  const changedItems: Record<string, { from: RspoItemStatus; to: RspoItemStatus }> = sj.rspo_changed_items ?? {};

  async function runExtraction(applicationNumber: string) {
    if (running) return;
    setRunning(true);
    try {
      await extractFn({ data: { reportId, applicationNumber } });
      await qc.invalidateQueries({ queryKey: ["rspo_report", reportId] });
    } catch (e: unknown) {
      // A 100+ page extraction can outlive the HTTP request while still
      // completing server-side — re-read before declaring failure, or a retry
      // double-bills the whole run.
      await qc.invalidateQueries({ queryKey: ["rspo_report", reportId] });
      const { data } = await supabase
        .from("analysis_reports").select("summary_json").eq("id", reportId).single();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fresh = ((data as any)?.summary_json ?? {}) as any;
      if (fresh.rspo_status !== "ready" && fresh.rspo_status !== "extracting") {
        toast.error("Check run failed", { description: e instanceof Error ? e.message : undefined });
      }
    } finally {
      setRunning(false);
    }
  }

  async function kickOff() {
    if (running) return;
    setRunning(true);
    try {
      const r = await parseFn({ data: { reportId } });
      await qc.invalidateQueries({ queryKey: ["rspo_report", reportId] });
      if (r.autoSelected) {
        setRunning(false);
        await runExtraction(r.autoSelected);
        return;
      }
    } catch (e: unknown) {
      await qc.invalidateQueries({ queryKey: ["rspo_report", reportId] });
      toast.error("Could not parse the PRISMA export", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    if (report.isLoading || !report.data) return;
    if (sj.pending_analysis || sj.rspo_status === "queued") {
      startedRef.current = true;
      kickOff();
    }
  }, [report.isLoading, report.data]);

  // ── Verdict editing (debounced batch save) ───────────────────────────────

  const effectiveVerdict = useCallback(
    (itemId: string): Verdict | undefined => dirty[itemId] ?? verdicts[itemId],
    [dirty, verdicts],
  );

  const flushVerdicts = useCallback(async () => {
    const pending = dirtyRef.current;
    if (!Object.keys(pending).length) return;
    setSavingVerdicts(true);
    try {
      await saveFn({
        data: {
          reportId,
          verdicts: Object.fromEntries(
            Object.entries(pending).map(([id, v]) => [id, { verdict: v.verdict, remarks: v.remarks }]),
          ),
        },
      });
      setDirty((cur) => {
        const next = { ...cur };
        for (const k of Object.keys(pending)) {
          if (next[k] === pending[k]) delete next[k];
        }
        return next;
      });
      await qc.invalidateQueries({ queryKey: ["rspo_report", reportId] });
    } catch (e: unknown) {
      toast.error("Could not save review verdicts", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingVerdicts(false);
    }
  }, [reportId, saveFn, qc]);

  useEffect(() => {
    if (!Object.keys(dirty).length) return;
    const t = setTimeout(flushVerdicts, 1500);
    return () => clearTimeout(t);
  }, [dirty, flushVerdicts]);

  function setVerdict(itemId: string, patch: Partial<Verdict>) {
    setDirty((cur) => {
      const base = cur[itemId] ?? verdicts[itemId] ?? { verdict: null, remarks: "" };
      return { ...cur, [itemId]: { ...base, ...patch, stale: false } };
    });
  }

  // ── Derived stats ────────────────────────────────────────────────────────

  const byArea = useMemo(() => {
    const map = new Map<RspoArea, RspoItemResult[]>();
    for (const a of RSPO_AREAS) map.set(a, []);
    for (const r of results) {
      const item = ITEM_BY_ID.get(r.itemId);
      if (item) map.get(item.area)!.push(r);
    }
    return map;
  }, [results]);

  /** Items needing attention = flagged status without a reviewer verdict yet. */
  const outstanding = useCallback(
    (rs: RspoItemResult[]) =>
      rs.filter((r) =>
        (r.status === "mismatch" || r.status === "missing" || r.status === "needs_review") &&
        !effectiveVerdict(r.itemId)?.verdict,
      ).length,
    [effectiveVerdict],
  );

  const totals = useMemo(() => {
    const t = { pass: 0, mismatch: 0, missing: 0, needs_review: 0, not_applicable: 0 };
    for (const r of results) t[r.status] += 1;
    return t;
  }, [results]);

  const needingVerdict = results.filter(
    (r) => r.status === "mismatch" || r.status === "missing" || r.status === "needs_review",
  );
  const verdictedCount = needingVerdict.filter((r) => effectiveVerdict(r.itemId)?.verdict).length;

  const jumpTo = useCallback((area: RspoArea, itemId?: string) => {
    setCollapsed((prev) => {
      if (!prev.has(area)) return prev;
      const next = new Set(prev);
      next.delete(area);
      return next;
    });
    requestAnimationFrame(() => {
      const target = itemId
        ? document.getElementById(`rspo-item-${itemId}`)
        : sectionRefs.current[area];
      target?.scrollIntoView({ behavior: "smooth", block: itemId ? "center" : "start" });
    });
  }, []);

  // Scroll-spy for the rail.
  useEffect(() => {
    if (status !== "ready") return;
    const els = RSPO_AREAS.map((a) => sectionRefs.current[a]).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const a = visible?.target.getAttribute("data-area") as RspoArea | undefined;
        if (a) setActiveArea(a);
      },
      { rootMargin: "-140px 0px -60% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [status, collapsed]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (report.isLoading) {
    return <AppShell><div className="p-10 text-sm text-muted-foreground">Loading…</div></AppShell>;
  }

  const busy = running || ["queued", "parsing_prisma", "extracting"].includes(status);

  if (busy) {
    const stage =
      status === "parsing_prisma" ? "Parsing the PRISMA export…"
      : status === "extracting" ? "Reading the certificate and audit report, then running all checks…"
      : "Starting the review…";
    return (
      <AppShell>
        <div className="min-h-[60vh] grid place-items-center p-10">
          <div className="text-center max-w-md">
            <ScanSearch className="size-8 mx-auto text-lime-600 animate-pulse motion-reduce:animate-none" />
            <h2 className="mt-4 font-display text-lg font-bold">Running the licence review</h2>
            <p className="mt-2 text-sm text-muted-foreground">{stage}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Long audit reports take a minute or two — the page updates by itself.
            </p>
            <Loader2 className="size-4 mx-auto mt-5 animate-spin motion-reduce:animate-none text-muted-foreground" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (status === "failed") {
    return (
      <AppShell>
        <div className="min-h-[60vh] grid place-items-center p-10">
          <div className="text-center max-w-md">
            <AlertTriangle className="size-8 mx-auto text-destructive" />
            <h2 className="mt-4 font-display text-lg font-bold">Review failed</h2>
            <p className="mt-2 text-sm text-muted-foreground">{sj.rspo_error}</p>
            <Button onClick={kickOff} className="mt-5 gap-2" disabled={running}>
              <RefreshCw className="size-3.5" /> Try again
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  if (status === "awaiting_application") {
    const appNos: string[] = sj.rspo_application_numbers ?? [];
    return (
      <AppShell>
        <div className="min-h-[60vh] grid place-items-center p-10">
          <div className="w-full max-w-lg rounded-xl border bg-card p-6">
            <h2 className="font-display text-lg font-bold">Which application is this review for?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The PRISMA export holds {appNos.length} applications. Pick the one that matches the
              uploaded certificate and audit report.
            </p>
            <div className="mt-4 space-y-2">
              {appNos.map((no) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const app = (sj.rspo_prisma_apps ?? {})[no] as any;
                const picked = pickedApp === no;
                return (
                  <button
                    key={no}
                    onClick={() => setPickedApp(no)}
                    className={cn(
                      "w-full text-left rounded-lg border px-4 py-3 transition-colors",
                      picked
                        ? "border-lime-500 bg-lime-50 dark:bg-lime-950/20"
                        : "border-border hover:border-lime-400 hover:bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "size-3.5 rounded-full border-2 grid place-items-center shrink-0",
                        picked ? "border-lime-600" : "border-muted-foreground/40",
                      )}>
                        {picked && <span className="size-1.5 rounded-full bg-lime-600" />}
                      </span>
                      <span className="font-semibold text-sm">{no}</span>
                    </div>
                    <div className="mt-1 pl-5.5 text-xs text-muted-foreground">
                      {[app?.legalEntity?.name, app?.certificate?.number, `${app?.sites?.length ?? 0} site(s)`]
                        .filter(Boolean).join(" · ")}
                    </div>
                  </button>
                );
              })}
            </div>
            <Button
              onClick={() => pickedApp && runExtraction(pickedApp)}
              disabled={!pickedApp || running}
              className="mt-4 w-full gap-2 bg-lime-600 hover:bg-lime-700 text-white"
            >
              {running
                ? <><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Running…</>
                : <><ShieldCheck className="size-3.5" /> Run the checks</>}
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!results.length) {
    return (
      <AppShell>
        <div className="min-h-[60vh] grid place-items-center p-10">
          <div className="text-center max-w-md">
            <FileWarning className="size-8 mx-auto text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">No results yet.</p>
            <Button onClick={kickOff} className="mt-5 gap-2" disabled={running}>
              <RefreshCw className="size-3.5" /> Start the review
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  const certTypeLabel = CERT_TYPE_LABELS[sj.rspo_cert_type as keyof typeof CERT_TYPE_LABELS] ?? "";
  const changedCount = Object.keys(changedItems).length;
  const prismaWarnings: string[] = sj.rspo_prisma_warnings ?? [];

  return (
    <AppShell>
      <div className="bg-white min-h-screen text-gray-900">
        {/* Sticky action bar — below the app shell's h-14 sticky header. */}
        <header className="sticky top-14 z-10 border-b border-gray-200 bg-white">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-lime-700">
                <ShieldCheck className="size-3.5" /> RSPO · SCC Licence Review
              </div>
              <h1 className="font-display text-xl font-bold truncate">
                {sj.rspo_prisma_apps?.[sj.rspo_application_number]?.legalEntity?.name ??
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (report.data as any)?.title}
              </h1>
              <p className="text-xs text-gray-500">
                {sj.rspo_application_number} · {certTypeLabel}
                {sj.rspo_extracted_at ? ` · checked ${new Date(sj.rspo_extracted_at).toLocaleString()}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <AiCostTooltip
                costLog={sj.costLog}
                fallbackUsd={sj.usage ? computeCost(sj.usage, sj.rspo_model).usd : 0}
                ocrUsed={!!(sj.rspo_ocr_used?.certificate || sj.rspo_ocr_used?.audit_report)}
              />
              {savingVerdicts && (
                <span className="text-[11px] text-gray-400 flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> saving
                </span>
              )}
              <Button
                onClick={() => sj.rspo_application_number && runExtraction(sj.rspo_application_number)}
                variant="ghost" size="sm" className="gap-2" disabled={running}
              >
                <RefreshCw className="size-3.5" /> Re-run checks
              </Button>
              <Button
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={() => exportRspoChecklist(report.data as any)}
                className="gap-2 bg-lime-600 hover:bg-lime-700 text-white"
              >
                <Download className="size-3.5" /> Export checklist
              </Button>
            </div>
          </div>
        </header>

        <div className="max-w-6xl mx-auto px-6 py-6 flex gap-8 items-start">
          {/* Area rail */}
          <nav aria-label="Checklist areas" className="hidden lg:block w-52 shrink-0 sticky top-[136px]">
            <ul className="space-y-0.5">
              {RSPO_AREAS.map((area) => {
                const rs = byArea.get(area) ?? [];
                const out = outstanding(rs);
                const active = activeArea === area;
                return (
                  <li key={area}>
                    <button
                      onClick={() => jumpTo(area)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-lg text-[13px] transition-colors duration-150 flex items-center justify-between gap-2",
                        active ? "bg-lime-50 text-lime-900 font-semibold" : "text-gray-600 hover:bg-gray-50",
                      )}
                    >
                      <span className="truncate">{area}</span>
                      {out > 0 ? (
                        <span className="min-w-4 h-4 px-1 rounded text-[10px] font-bold grid place-items-center bg-amber-500 text-white shrink-0">
                          {out}
                        </span>
                      ) : (
                        <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 pt-3 border-t border-gray-100 text-[11px] text-gray-400 leading-relaxed">
              {verdictedCount} of {needingVerdict.length} flagged items reviewed
            </div>
          </nav>

          <div className="flex-1 min-w-0 space-y-4">
            {/* Summary strip */}
            <section className="rounded-lg border border-gray-200 px-4 py-3">
              <div className="flex items-center gap-4 flex-wrap text-sm">
                <span className="font-semibold">
                  {totals.mismatch === 0 && totals.missing === 0
                    ? "No discrepancies found"
                    : `${totals.mismatch} mismatch${totals.mismatch === 1 ? "" : "es"} · ${totals.missing} missing`}
                </span>
                <span className="text-gray-500 text-[13px]">
                  {totals.pass} pass · {totals.needs_review} to check · {totals.not_applicable} n/a
                </span>
                {changedCount > 0 && (
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-800">
                    {changedCount} changed since previous run
                  </span>
                )}
              </div>
              {prismaWarnings.length > 0 && (
                <p className="mt-2 text-[12px] text-amber-700">
                  PRISMA export: {prismaWarnings[0]}
                  {prismaWarnings.length > 1 ? ` (+${prismaWarnings.length - 1} more)` : ""}
                </p>
              )}
            </section>

            {/* Areas */}
            {RSPO_AREAS.map((area) => {
              const rs = byArea.get(area) ?? [];
              if (!rs.length) return null;
              const isOpen = !collapsed.has(area);
              const out = outstanding(rs);
              const na = rs.filter((r) => r.status === "not_applicable");
              const visible = rs.filter((r) => r.status !== "not_applicable");
              return (
                <section
                  key={area}
                  data-area={area}
                  ref={(el) => { sectionRefs.current[area] = el; }}
                  className="rounded-lg border border-gray-200 overflow-hidden scroll-mt-36"
                >
                  <h2>
                    <button
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(area)) next.delete(area); else next.add(area);
                          return next;
                        })
                      }
                      aria-expanded={isOpen}
                      className="w-full px-4 py-2.5 bg-white hover:bg-gray-50 transition-colors duration-150 flex items-center gap-3 text-left"
                    >
                      <ChevronDown className={cn(
                        "size-4 text-gray-400 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                        !isOpen && "-rotate-90",
                      )} />
                      <span className="text-sm font-bold flex-1">{area}</span>
                      {out > 0 ? (
                        <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                          {out} outstanding
                        </span>
                      ) : (
                        <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                      )}
                    </button>
                  </h2>

                  <div className={cn(
                    "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                    isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}>
                    <div className="overflow-hidden">
                      <div className="divide-y divide-gray-100 border-t border-gray-200">
                        {visible.map((r) => (
                          <ItemRow
                            key={r.itemId}
                            result={r}
                            verdict={effectiveVerdict(r.itemId)}
                            changed={changedItems[r.itemId]}
                            expanded={expandedEntities.has(r.itemId)}
                            onToggleEntities={() =>
                              setExpandedEntities((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.itemId)) next.delete(r.itemId); else next.add(r.itemId);
                                return next;
                              })
                            }
                            onVerdict={(patch) => setVerdict(r.itemId, patch)}
                          />
                        ))}
                        {na.length > 0 && (
                          <div className="px-4 py-2 text-[12px] text-gray-400">
                            {na.length} item{na.length === 1 ? "" : "s"} not applicable for this
                            certification type{na.length <= 4
                              ? `: ${na.map((r) => ITEM_BY_ID.get(r.itemId)?.label || ITEM_BY_ID.get(r.itemId)?.group).filter(Boolean).slice(0, 4).join("; ")}`
                              : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              );
            })}

            <p className="text-[12px] text-gray-400 pb-10 max-w-[70ch]">
              Every check carries the verbatim values it compared and, where read from a document,
              the page it came from. Automated verdicts are proposals — an item is only complete
              once a reviewer accepts or flags it.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function ItemRow({
  result, verdict, changed, expanded, onToggleEntities, onVerdict,
}: {
  result: RspoItemResult;
  verdict?: Verdict;
  changed?: { from: RspoItemStatus; to: RspoItemStatus };
  expanded: boolean;
  onToggleEntities: () => void;
  onVerdict: (patch: Partial<Verdict>) => void;
}) {
  const item = ITEM_BY_ID.get(result.itemId);
  if (!item) return null;
  const meta = STATUS_META[result.status];
  const needsAttention = result.status === "mismatch" || result.status === "missing" || result.status === "needs_review";
  const stale = verdict?.stale;
  const flaggedEntities = (result.entityRows ?? []).filter((e) => e.status === "mismatch").length;

  return (
    <div
      id={`rspo-item-${result.itemId}`}
      className={cn(
        "px-4 py-3 scroll-mt-40",
        result.status === "mismatch" && !verdict?.verdict && "bg-rose-50/50",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-1.5 size-2 rounded-full shrink-0", meta.dot)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-mono text-gray-400">{result.itemId}</span>
            <span className="text-[13px] font-medium text-gray-900">
              {item.label || item.group}
            </span>
            <span className={cn("text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded", meta.chip)}>
              {meta.label}
            </span>
            {result.method === "ai" && (
              <span className="text-[10px] text-gray-400" title={`AI-judged consistency${result.aiConfidence != null ? ` · confidence ${Math.round(result.aiConfidence * 100)}%` : ""}`}>
                AI-judged
              </span>
            )}
            {changed && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800"
                title={`Previous run: ${STATUS_META[changed.from].label}`}>
                was {STATUS_META[changed.from].label}
              </span>
            )}
          </div>

          {item.label && item.group && item.label !== item.group && (
            <div className="text-[11px] text-gray-400 mt-0.5">{item.group}</div>
          )}

          {/* Source values, side by side */}
          {Object.keys(result.values).length > 0 && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.entries(result.values) as Array<[RspoSource, { value: string | null; page?: number | null; quote?: string }]>).map(
                ([source, v]) => (
                  <div key={source} className="rounded-md border border-gray-200 bg-gray-50/60 px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                        {SOURCE_LABELS[source]}
                      </span>
                      {v.page != null && (
                        <span className="text-[10px] font-mono text-gray-400">p.{v.page}</span>
                      )}
                    </div>
                    <div
                      className={cn("text-[12px] mt-0.5 break-words", v.value ? "text-gray-800" : "text-gray-400 italic")}
                      title={v.quote ? `"${v.quote}"` : undefined}
                    >
                      {v.value ?? "not found"}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}

          <p className="mt-1.5 text-[12px] text-gray-500">{result.reason}</p>
          {item.notes && (
            <p className="mt-1 text-[11px] text-gray-400 whitespace-pre-line">{item.notes}</p>
          )}

          {/* Per-site rows */}
          {result.entityRows && result.entityRows.length > 0 && (
            <div className="mt-2">
              <button
                onClick={onToggleEntities}
                className="text-[12px] font-medium text-lime-700 hover:underline underline-offset-2"
              >
                {expanded ? "Hide" : "Show"} {result.entityRows.length} site{result.entityRows.length === 1 ? "" : "s"}
                {flaggedEntities > 0 && ` · ${flaggedEntities} flagged`}
              </button>
              {expanded && (
                <div className="mt-2 rounded-md border border-gray-200 divide-y divide-gray-100 max-h-80 overflow-y-auto">
                  {result.entityRows.map((e, i) => (
                    <div key={i} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={cn("size-1.5 rounded-full shrink-0", STATUS_META[e.status].dot)} />
                        <span className="text-[12px] font-medium text-gray-900">{e.entity}</span>
                        <span className="text-[11px] text-gray-400">{e.reason}</span>
                      </div>
                      <div className="mt-1 pl-3.5 space-y-0.5">
                        {(Object.entries(e.values) as Array<[RspoSource, { value: string | null; page?: number | null }]>).map(([s, v]) => (
                          <div key={s} className="text-[11px] text-gray-500">
                            <span className="font-semibold text-gray-400">{SOURCE_LABELS[s]}:</span>{" "}
                            {v.value ?? "—"}{v.page != null ? ` (p.${v.page})` : ""}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Reviewer verdict */}
          {needsAttention && (
            <div className={cn(
              "mt-2.5 flex items-center gap-2 flex-wrap rounded-lg",
              stale && "ring-2 ring-amber-300 ring-offset-2 p-1",
            )}>
              {stale && (
                <span className="text-[11px] text-amber-700 font-medium w-full">
                  The result changed since this was reviewed — confirm your verdict still stands.
                </span>
              )}
              <button
                onClick={() => onVerdict({ verdict: verdict?.verdict === "accepted" ? null : "accepted" })}
                className={cn(
                  "flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md border transition-colors duration-100",
                  verdict?.verdict === "accepted"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                    : "border-gray-200 text-gray-500 hover:border-emerald-400 hover:text-emerald-700",
                )}
              >
                <Check className="size-3.5" /> Accept
              </button>
              <button
                onClick={() => onVerdict({ verdict: verdict?.verdict === "flagged" ? null : "flagged" })}
                className={cn(
                  "flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md border transition-colors duration-100",
                  verdict?.verdict === "flagged"
                    ? "border-rose-500 bg-rose-50 text-rose-800"
                    : "border-gray-200 text-gray-500 hover:border-rose-400 hover:text-rose-700",
                )}
              >
                <Flag className="size-3.5" /> Flag
              </button>
              <input
                type="text"
                value={verdict?.remarks ?? ""}
                onChange={(e) => onVerdict({ remarks: e.target.value })}
                placeholder="Remarks…"
                className="flex-1 min-w-40 text-[12px] px-2.5 py-1.5 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-lime-500/30 focus:border-lime-500 placeholder:text-gray-400"
              />
              {verdict?.by && (
                <span className="text-[10px] text-gray-400" title={verdict.at}>
                  {verdict.by.split("@")[0]}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
