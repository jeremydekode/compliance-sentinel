import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Loader2, AlertTriangle, CheckCircle2, ShieldCheck, RefreshCw,
  Download, Flag, Check, ScanSearch, FileWarning, Eye, X,
} from "lucide-react";
import {
  runRspoPrismaParse, runRspoExtraction, saveRspoVerdicts,
} from "@/lib/compliance.functions";
import {
  RSPO_CHECKLIST, RSPO_AREAS, CERT_TYPE_LABELS,
  type RspoArea, type RspoItemResult, type RspoItemStatus, type RspoSource, type RspoChecklistItem,
} from "@/lib/rspo-checklist";
import { exportRspoChecklist } from "@/lib/rspo-export";
import { AiCostTooltip } from "@/components/ai-cost-tooltip";
import { PdfViewer } from "@/components/pdf-viewer";
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

  const parseFn = useServerFn(runRspoPrismaParse);
  const extractFn = useServerFn(runRspoExtraction);
  const saveFn = useServerFn(saveRspoVerdicts);

  const [running, setRunning] = useState(false);
  const [activeArea, setActiveArea] = useState<RspoArea>("License Details");
  const [pickedApp, setPickedApp] = useState<string | null>(null);
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set());
  const [showNa, setShowNa] = useState(false);
  /** Briefly rings a row after a jump-to, so the eye finds it in a full table. */
  const [highlightedItem, setHighlightedItem] = useState<string | null>(null);
  /** Evidence overlay: `mounted` flips true on the first eye-click and never
   *  back — the audit report can be 100+ pages, so once pdf.js has rendered
   *  it we keep the panes alive and just re-point them at a new item on the
   *  next click, rather than re-rendering the whole document every time. */
  const [evidenceMounted, setEvidenceMounted] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceItemId, setEvidenceItemId] = useState<string | null>(null);
  const openEvidence = useCallback((itemId: string) => {
    setEvidenceItemId(itemId);
    setEvidenceMounted(true);
    setEvidenceOpen(true);
  }, []);
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

  /** Switches tabs (areas are mutually exclusive panels now, not an accordion)
   *  and, when jumping to a specific item, scrolls it into view and rings it —
   *  a plain scrollIntoView is easy to lose in an 85-row table otherwise. */
  const jumpTo = useCallback((area: RspoArea, itemId?: string) => {
    setActiveArea(area);
    if (!itemId) return;
    setHighlightedItem(itemId);
    requestAnimationFrame(() => {
      document.getElementById(`rspo-item-${itemId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setTimeout(() => setHighlightedItem((cur) => (cur === itemId ? null : cur)), 2200);
  }, []);

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
          <div className="w-full px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
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

        <div className="w-full px-6 py-6 flex gap-6 items-start">
          {/* Area tabs — literal single-panel tabs, not an accordion. Clicking
              swaps the whole table below rather than scrolling past 4 other
              85-item-wide sections, which was the actual navigation problem. */}
          <nav aria-label="Checklist areas" className="hidden lg:block w-52 shrink-0 sticky top-[136px]">
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              {RSPO_AREAS.map((area) => {
                const rs = byArea.get(area) ?? [];
                const out = outstanding(rs);
                const active = activeArea === area;
                return (
                  <button
                    key={area}
                    onClick={() => setActiveArea(area)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "w-full text-left px-3 py-2.5 text-[13px] transition-colors duration-100 flex items-center justify-between gap-2 border-b last:border-b-0 border-gray-100",
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
                );
              })}
            </div>
            <div className="mt-3 px-1 text-[11px] text-gray-400 leading-relaxed">
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

            {/* Mobile tab select — the side rail is lg:hidden */}
            <select
              value={activeArea}
              onChange={(e) => setActiveArea(e.target.value as RspoArea)}
              className="lg:hidden w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white"
            >
              {RSPO_AREAS.map((area) => {
                const out = outstanding(byArea.get(area) ?? []);
                return <option key={area} value={area}>{area}{out ? ` (${out})` : ""}</option>;
              })}
            </select>

            {/* Active area table */}
            <AreaTable
              area={activeArea}
              results={byArea.get(activeArea) ?? []}
              showNa={showNa}
              onToggleShowNa={() => setShowNa((v) => !v)}
              verdictOf={effectiveVerdict}
              changedItems={changedItems}
              expandedEntities={expandedEntities}
              highlightedItem={highlightedItem}
              onToggleEntities={(id) =>
                setExpandedEntities((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })
              }
              onVerdict={setVerdict}
              onOpenEvidence={openEvidence}
            />

            <p className="text-[12px] text-gray-400 pb-10 max-w-[70ch]">
              Every check carries the verbatim values it compared and, where read from a document,
              the page it came from. Automated verdicts are proposals — an item is only complete
              once a reviewer accepts or flags it.
            </p>
          </div>
        </div>
      </div>

      {evidenceMounted && (
        <RspoEvidenceOverlay
          visible={evidenceOpen}
          onClose={() => setEvidenceOpen(false)}
          item={evidenceItemId ? ITEM_BY_ID.get(evidenceItemId) : undefined}
          result={evidenceItemId ? results.find((r) => r.itemId === evidenceItemId) : undefined}
          certificateUrl={sj.rspo_files?.certificateUrl ?? null}
          auditReportUrl={sj.rspo_files?.auditReportUrl ?? null}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          prismaApp={sj.rspo_prisma_apps?.[sj.rspo_application_number] as any}
        />
      )}
    </AppShell>
  );
}

const SOURCE_COLUMNS: RspoSource[] = ["prisma", "certificate", "audit_report"];

function AreaTable({
  area, results, showNa, onToggleShowNa, verdictOf, changedItems, expandedEntities,
  highlightedItem, onToggleEntities, onVerdict, onOpenEvidence,
}: {
  area: RspoArea;
  results: RspoItemResult[];
  showNa: boolean;
  onToggleShowNa: () => void;
  verdictOf: (itemId: string) => Verdict | undefined;
  changedItems: Record<string, { from: RspoItemStatus; to: RspoItemStatus }>;
  expandedEntities: Set<string>;
  highlightedItem: string | null;
  onToggleEntities: (itemId: string) => void;
  onVerdict: (itemId: string, patch: Partial<Verdict>) => void;
  onOpenEvidence: (itemId: string) => void;
}) {
  const na = results.filter((r) => r.status === "not_applicable");
  const visible = results.filter((r) => r.status !== "not_applicable");

  return (
    // No overflow-hidden here — it silently breaks position:sticky on the
    // header below (confirmed: an ancestor with overflow other than visible
    // changes what a sticky descendant sticks relative to, and with this
    // section's height unconstrained the header ends up sticking nowhere,
    // rendering wherever it happened to lay out — exactly the "header stuck
    // mid-list" bug). Rounding moves to the header bar's own top corners
    // instead of relying on the section clipping its children to match.
    <section className="rounded-lg border border-gray-200">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 rounded-t-lg flex items-center gap-3">
        <span className="text-sm font-bold flex-1">{area}</span>
        <span className="text-[11px] text-gray-400">{visible.length} item{visible.length === 1 ? "" : "s"}</span>
      </div>

      {/* This div is BOTH scroll axes at once, on purpose — max-h + overflow-auto
          makes it a bounded, self-scrolling pane (like a spreadsheet), which is
          what actually lets a sticky header AND horizontal scroll coexist.
          Tried page-relative sticky first (offset to match the rail); it turns
          out CSS silently upgrades `overflow-x: auto` to also clip overflow-y
          (spec behavior, not a bug), which breaks a `position: sticky`
          descendant's reference frame no matter what — confirmed empirically,
          not assumed. Once THIS is the intended scroll container instead of
          fighting it, sticky top-0 relative to it works with no caveats, and
          the page around it (rail, summary strip) still scrolls normally since
          this pane is independent of that. */}
      <div className="overflow-auto max-h-[calc(100vh-15rem)]">
        {/* Percentage widths, not fixed rem — with table-fixed these divide up
            whatever width is available, so the table genuinely grows with the
            window instead of sitting at a frozen size. min-w keeps it readable
            on a narrow window: below that the pane scrolls sideways rather
            than crushing the comparison columns to nothing. */}
        <table className="w-full min-w-[64rem] text-left border-collapse table-fixed">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[16%]" />
            <col className="w-[16%]" />
            <col className="w-[9%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead>
            {/* Sticky on each <th>, not the <thead> — position:sticky on the
                group element itself is unreliable in Safari; per-cell is the
                spec-correct, cross-browser way to pin a table header. top-0 is
                relative to the pane above, not the page.
                Column order puts Status immediately before Review, so the
                verdict ("what is it?") sits right next to the action ("what do
                I do about it?") — they're read together.
                Two colors, matching the two things a reviewer is doing: Item /
                Status / Review (what this check IS, what to do about it) stay
                neutral gray-50; the three source columns (what's being
                COMPARED) get a cooler slate tint, carried down into every body
                cell in those columns too — so the comparison zone reads as one
                visually distinct band, not identical to the rest of the row.
                Vertical borders turn it into a real grid, which is what makes
                three adjacent values scannable as a comparison. */}
            <tr className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 font-bold border-b border-r border-gray-200">Item</th>
              {SOURCE_COLUMNS.map((s) => (
                <th key={s} className="sticky top-0 z-10 bg-slate-100 px-3 py-2 font-bold border-b border-r border-gray-200">{SOURCE_LABELS[s]}</th>
              ))}
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 font-bold border-b border-r border-gray-200">Status</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 font-bold border-b border-gray-200">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((r) => (
              <TableRow
                key={r.itemId}
                result={r}
                verdict={verdictOf(r.itemId)}
                changed={changedItems[r.itemId]}
                expanded={expandedEntities.has(r.itemId)}
                highlighted={highlightedItem === r.itemId}
                onToggleEntities={() => onToggleEntities(r.itemId)}
                onVerdict={(patch) => onVerdict(r.itemId, patch)}
                onOpenEvidence={() => onOpenEvidence(r.itemId)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {na.length > 0 && (
        <div className="border-t border-gray-100">
          <button
            onClick={onToggleShowNa}
            className="w-full text-left px-4 py-2 text-[12px] text-gray-400 hover:bg-gray-50 transition-colors"
          >
            {showNa ? "Hide" : "Show"} {na.length} item{na.length === 1 ? "" : "s"} not applicable for this
            certification type
          </button>
          {showNa && (
            <div className="divide-y divide-gray-100 border-t border-gray-100">
              {na.map((r) => {
                const item = ITEM_BY_ID.get(r.itemId);
                if (!item) return null;
                return (
                  <div key={r.itemId} className="px-4 py-1.5 flex items-center gap-2 text-[12px] text-gray-400">
                    <span className="size-1.5 rounded-full bg-gray-300 shrink-0" />
                    <span className="truncate">{item.label || item.group}</span>
                    <span className="text-gray-300 ml-auto shrink-0">{r.reason}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Same slate tint as the header for these three columns — carrying it down
// into every row is what actually makes the "this is the comparison zone"
// grouping read while scanning down the table, not just at the header. A
// <td>'s own background paints OVER its <tr>'s background, so the row-level
// amber (jumped-to) / rose (unresolved mismatch) highlighting would otherwise
// vanish under this tint for exactly these three columns — `tone` folds that
// row state into which tint these cells get instead, so both signals coexist.
type CellTone = "normal" | "mismatch" | "highlighted";
const COMPARE_CELL_BG: Record<CellTone, string> = {
  normal: "bg-slate-50/70",
  mismatch: "bg-rose-50/70",
  highlighted: "bg-amber-100/70",
};

function ValueCell({
  v, applies, tone = "normal",
}: {
  v?: { value: string | null; page?: number | null; quote?: string };
  applies: boolean;
  tone?: CellTone;
}) {
  // border-r on every source cell: three adjacent values only read as a
  // comparison when there's a ruled line between them.
  const base = cn("px-3 py-2.5 align-top border-r border-gray-200", COMPARE_CELL_BG[tone]);
  if (!applies) {
    return <td className={cn(base, "text-[12px] text-gray-300 text-center")}>–</td>;
  }
  if (!v || v.value == null) {
    return <td className={cn(base, "text-[12px] text-gray-400 italic")}>not found</td>;
  }
  return (
    <td className={cn(base, "text-[12px] text-gray-800")}>
      <div className="line-clamp-2 break-words" title={v.quote ? `"${v.quote}"` : v.value}>
        {v.value}
      </div>
      {v.page != null && <div className="text-[10px] font-mono text-gray-400 mt-0.5">p.{v.page}</div>}
    </td>
  );
}

function TableRow({
  result, verdict, changed, expanded, highlighted, onToggleEntities, onVerdict, onOpenEvidence,
}: {
  result: RspoItemResult;
  verdict?: Verdict;
  changed?: { from: RspoItemStatus; to: RspoItemStatus };
  expanded: boolean;
  highlighted: boolean;
  onToggleEntities: () => void;
  onVerdict: (patch: Partial<Verdict>) => void;
  onOpenEvidence: () => void;
}) {
  const item = ITEM_BY_ID.get(result.itemId);
  if (!item) return null;
  const meta = STATUS_META[result.status];
  const needsAttention = result.status === "mismatch" || result.status === "missing" || result.status === "needs_review";
  const stale = verdict?.stale;
  const flaggedEntities = (result.entityRows ?? []).filter((e) => e.status === "mismatch").length;

  const tone: CellTone = highlighted ? "highlighted"
    : result.status === "mismatch" && !verdict?.verdict ? "mismatch"
    : "normal";

  return (
    <>
      <tr
        id={`rspo-item-${result.itemId}`}
        className={cn(
          "scroll-mt-40 transition-colors duration-300",
          highlighted ? "bg-amber-100/70"
            : result.status === "mismatch" && !verdict?.verdict ? "bg-rose-50/50"
            : "bg-transparent",
        )}
      >
        <td className="px-3 py-2.5 align-top border-r border-gray-200">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-mono text-gray-400">{result.itemId}</span>
            <span className="text-[13px] font-medium text-gray-900">{item.label || item.group}</span>
            {result.method === "ai" && (
              <span
                className="text-[9px] font-bold text-gray-400 border border-gray-200 rounded px-1"
                title={`AI-judged consistency${result.aiConfidence != null ? ` · confidence ${Math.round(result.aiConfidence * 100)}%` : ""}`}
              >
                AI
              </span>
            )}
            {changed && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800"
                title={`Previous run: ${STATUS_META[changed.from].label}`}
              >
                was {STATUS_META[changed.from].label}
              </span>
            )}
          </div>
          {item.label && item.group && item.label !== item.group && (
            <div className="text-[11px] text-gray-400 mt-0.5 truncate">{item.group}</div>
          )}
          {needsAttention && (
            <p className="text-[11px] text-gray-500 mt-1">{result.reason}</p>
          )}
          {item.notes && (
            <p className="mt-1 text-[10.5px] text-gray-400 whitespace-pre-line">{item.notes}</p>
          )}
          {result.entityRows && result.entityRows.length > 0 && (
            <button
              onClick={onToggleEntities}
              className="text-[11px] font-medium text-lime-700 hover:underline underline-offset-2 mt-1 block"
            >
              {expanded ? "Hide" : "Show"} {result.entityRows.length} site{result.entityRows.length === 1 ? "" : "s"}
              {flaggedEntities > 0 && ` · ${flaggedEntities} flagged`}
            </button>
          )}
        </td>

        {SOURCE_COLUMNS.map((s) => (
          <ValueCell key={s} v={result.values[s]} applies={item.sources.includes(s)} tone={tone} />
        ))}

        {/* Status sits next to Review on purpose: the verdict and the action
            taken on it are read as a pair. */}
        <td className="px-3 py-2.5 align-top border-r border-gray-200">
          <span className={cn("inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded", meta.chip)}>
            <span className={cn("size-1.5 rounded-full shrink-0", meta.dot)} />
            {meta.label}
          </span>
        </td>

        <td className="px-3 py-2.5 align-top">
          <div className={cn("space-y-1", needsAttention && stale && "ring-2 ring-amber-300 rounded-md p-1 -m-1")}>
            <div className="flex items-center gap-1">
              <button
                onClick={onOpenEvidence}
                title="View the source documents for this check"
                className="grid place-items-center size-6 rounded-md border border-gray-200 text-gray-400 hover:border-lime-400 hover:text-lime-700 transition-colors duration-100"
              >
                <Eye className="size-3.5" />
              </button>
              {needsAttention && (
                <>
                  <button
                    onClick={() => onVerdict({ verdict: verdict?.verdict === "accepted" ? null : "accepted" })}
                    title="Accept"
                    className={cn(
                      "grid place-items-center size-6 rounded-md border transition-colors duration-100",
                      verdict?.verdict === "accepted"
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                        : "border-gray-200 text-gray-400 hover:border-emerald-400 hover:text-emerald-700",
                    )}
                  >
                    <Check className="size-3.5" />
                  </button>
                  <button
                    onClick={() => onVerdict({ verdict: verdict?.verdict === "flagged" ? null : "flagged" })}
                    title="Flag"
                    className={cn(
                      "grid place-items-center size-6 rounded-md border transition-colors duration-100",
                      verdict?.verdict === "flagged"
                        ? "border-rose-500 bg-rose-50 text-rose-700"
                        : "border-gray-200 text-gray-400 hover:border-rose-400 hover:text-rose-700",
                    )}
                  >
                    <Flag className="size-3.5" />
                  </button>
                  {verdict?.by && (
                    <span className="text-[9px] text-gray-400 truncate" title={verdict.at}>
                      {verdict.by.split("@")[0]}
                    </span>
                  )}
                </>
              )}
            </div>
            {needsAttention && stale && (
              <p className="text-[10px] text-amber-700 font-medium leading-snug">
                Result changed — confirm your verdict still stands.
              </p>
            )}
            {needsAttention && (
              <input
                type="text"
                value={verdict?.remarks ?? ""}
                onChange={(e) => onVerdict({ remarks: e.target.value })}
                placeholder="Remarks…"
                className="w-full text-[11px] px-2 py-1 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-lime-500/30 focus:border-lime-500 placeholder:text-gray-400"
              />
            )}
          </div>
        </td>
      </tr>

      {expanded && result.entityRows && result.entityRows.length > 0 && (
        <tr>
          <td colSpan={6} className="bg-gray-50/60 px-3 py-2">
            <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100 max-h-80 overflow-y-auto">
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
          </td>
        </tr>
      )}
    </>
  );
}

// ── Evidence overlay: 3-way source comparison ───────────────────────────────
//
// PRISMA has no page concept — it's a system export, not a paginated document
// — so its pane shows the parsed record rather than pretending to page through
// a spreadsheet. The two PDF panes reuse PdfViewer's existing quote-anchored
// highlight pass when a value carries a verbatim quote (the precise case: it
// scrolls straight to the sentence), and fall back to page-only scrolling
// (added to PdfViewer for this) when only a page number is available.

interface PrismaApplicationLike {
  applicationNumber: string;
  legalEntity: { name: string | null; address: string | null };
  membership: { number: string | null };
  certificate: { number: string | null; startDate: string | null; endDate: string | null };
}

function RspoEvidenceOverlay({
  visible, onClose, item, result, certificateUrl, auditReportUrl, prismaApp,
}: {
  visible: boolean;
  onClose: () => void;
  item?: RspoChecklistItem;
  result?: RspoItemResult;
  certificateUrl: string | null;
  auditReportUrl: string | null;
  prismaApp?: PrismaApplicationLike;
}) {
  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  const prismaV = result?.values.prisma;
  const certV = result?.values.certificate;
  const auditV = result?.values.audit_report;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm p-4",
        visible ? "flex" : "hidden",
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="m-auto w-full max-w-[1600px] h-[92vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-mono text-gray-400">{item?.id}</div>
            <div className="text-sm font-bold text-gray-900 truncate">{item?.label || item?.group || "Evidence"}</div>
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center size-8 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-200">
          <div className="flex flex-col min-h-0">
            <PaneHeader label="PRISMA" applies={!!item?.sources.includes("prisma")} />
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <PrismaPane app={prismaApp} value={prismaV} />
            </div>
          </div>

          <div className="flex flex-col min-h-0">
            <PaneHeader label="Certificate" applies={!!item?.sources.includes("certificate")} page={certV?.page} />
            <div className="flex-1 min-h-0">
              {certificateUrl ? (
                <PdfViewer
                  fileUrl={certificateUrl}
                  className="h-full"
                  focusPage={certV?.page ?? null}
                  highlights={certV?.quote ? [{ id: "evidence", text: certV.quote, kind: "info" }] : []}
                  activeId={certV?.quote ? "evidence" : null}
                />
              ) : (
                <EmptyPane text="No certificate uploaded" />
              )}
            </div>
          </div>

          <div className="flex flex-col min-h-0">
            <PaneHeader label="Audit report" applies={!!item?.sources.includes("audit_report")} page={auditV?.page} />
            <div className="flex-1 min-h-0">
              {auditReportUrl ? (
                <PdfViewer
                  fileUrl={auditReportUrl}
                  className="h-full"
                  focusPage={auditV?.page ?? null}
                  highlights={auditV?.quote ? [{ id: "evidence", text: auditV.quote, kind: "info" }] : []}
                  activeId={auditV?.quote ? "evidence" : null}
                />
              ) : (
                <EmptyPane text="No audit report uploaded" />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneHeader({ label, applies, page }: { label: string; applies: boolean; page?: number | null }) {
  return (
    <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 flex items-center gap-2 shrink-0">
      <span className="text-[11px] font-bold uppercase tracking-wide text-gray-600">{label}</span>
      {!applies && <span className="text-[10px] text-gray-400">not used in this check</span>}
      {page != null && <span className="ml-auto text-[10px] font-mono text-gray-400">p.{page}</span>}
    </div>
  );
}

function EmptyPane({ text }: { text: string }) {
  return <div className="h-full grid place-items-center text-[12px] text-gray-400">{text}</div>;
}

function PrismaPane({
  app, value,
}: {
  app?: PrismaApplicationLike;
  value?: { value: string | null; quote?: string };
}) {
  if (!app) return <EmptyPane text="No PRISMA data" />;
  return (
    <div className="space-y-4">
      {value?.value && (
        <div className="rounded-lg border border-lime-200 bg-lime-50 px-3 py-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-lime-700">Value used in this check</div>
          <div className="text-[13px] text-gray-900 mt-1 whitespace-pre-line break-words">{value.value}</div>
        </div>
      )}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Application record</div>
        <dl className="text-[12.5px] space-y-1.5">
          <PrismaRow label="Legal entity" v={app.legalEntity?.name} />
          <PrismaRow label="Address" v={app.legalEntity?.address} />
          <PrismaRow label="Membership no." v={app.membership?.number} />
          <PrismaRow label="Certificate no." v={app.certificate?.number} />
          <PrismaRow
            label="Certificate validity"
            v={[app.certificate?.startDate, app.certificate?.endDate].filter(Boolean).join(" → ") || null}
          />
          <PrismaRow label="Application no." v={app.applicationNumber} />
        </dl>
      </div>
      <p className="text-[11px] text-gray-400 leading-relaxed">
        PRISMA is a system export, not a paginated document — shown here as the parsed record
        rather than a page location.
      </p>
    </div>
  );
}

function PrismaRow({ label, v }: { label: string; v?: string | null }) {
  if (!v) return null;
  return (
    <div className="flex gap-2">
      <dt className="text-gray-400 shrink-0 w-32">{label}</dt>
      <dd className="text-gray-800 break-words">{v}</dd>
    </div>
  );
}
