// ============================================================================
// SIMPLIFY V2 — document-centric review page (all three modes).
// Layout mirrors legal.review.$documentId.tsx: the rendered document on the
// left (real page chrome via docx-preview, inline highlights), a 380px review
// rail on the right. Recommend & Edit adds a stage-gated restructure panel and
// an original-vs-restructured side-by-side comparison.
// ============================================================================

import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DocViewer, type DocHighlight } from "@/components/doc-viewer";
import { FindingsRail, RestructurePanel } from "@/components/simplify-findings";
import { AuditHealthDashboard, SimplifyChangesDashboard, RedraftDashboard } from "@/components/simplify-health";
import type { FindingSeverity } from "@/lib/recommend";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  runSimplifyV2Report,
  setSimplificationDecision,
  bulkSetSimplificationDecision,
  applySimplifyV2Report,
  bulkSetV2FindingDecision,
} from "@/lib/compliance.functions";
import type { Finding } from "@/lib/recommend";
import { SIMPLIFY_TYPE_LABEL } from "@/lib/simplify";
import type { VerifiedAction, ActionDecision } from "@/lib/simplify";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, Loader2, RotateCcw, Check, X, Sparkles, SearchCheck, FileEdit,
  FileDown, AlertTriangle, Link2Off, Quote, Info,
} from "lucide-react";

export const Route = createFileRoute("/simplify2/$reportId")({
  component: SimplifyV2Route,
  head: () => ({ meta: [{ title: "Simplify v2 · AI Document Workflow" }] }),
});

/**
 * Remounts the page whenever the report id changes.
 *
 * TanStack Router REUSES the component across param-only navigations (e.g. Rudy
 * routing you straight from one report to another). Without this key the page
 * carries the previous report's refs and state: `startedRef` stays true so a
 * freshly-created report's analysis never kicks off, the AnalyzingView guard
 * (`pending_analysis && !startedRef.current`) is skipped, and the dashboard
 * renders "no verified findings — the audit came back clean" for a document
 * that was never analysed. The Rudy auto-chain's `autoRef` leaks the same way.
 * Keying by id resets all of it in one place.
 */
function SimplifyV2Route() {
  const { reportId } = Route.useParams();
  return <SimplifyV2ReportPage key={reportId} />;
}

const MODE_META: Record<string, { label: string; icon: React.ElementType; chip: string }> = {
  simplify: { label: "Simplify", icon: Sparkles, chip: "bg-violet-100 text-violet-700 ring-violet-200" },
  recommend: { label: "Recommendation", icon: SearchCheck, chip: "bg-sky-100 text-sky-700 ring-sky-200" },
  recommend_edit: { label: "Recommend & Edit", icon: FileEdit, chip: "bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-200" },
  create: { label: "New Document", icon: FileEdit, chip: "bg-emerald-100 text-emerald-700 ring-emerald-200" },
};

function SimplifyV2ReportPage() {
  const { reportId } = Route.useParams();
  const qc = useQueryClient();
  const runFn = useServerFn(runSimplifyV2Report);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchorStatus, setAnchorStatus] = useState<Record<string, boolean>>({});
  // Each mode LANDS on its dashboard (the management-level view); "document"
  // is the drill-down; "compare" is the R&E side-by-side.
  const [view, setView] = useState<"dashboard" | "document" | "compare">("dashboard");
  const [severityFilter, setSeverityFilter] = useState<FindingSeverity | "all">("all");
  const startedRef = useRef(false);

  const report = useQuery({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analysis_reports").select("*").eq("id", reportId).single();
      if (error) throw error;
      return data;
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sj = ((report.data as any)?.summary_json ?? {}) as any;
  const workflowMode: string = sj.workflow_mode ?? "simplify";
  const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
  const actions: VerifiedAction[] = Array.isArray(sj.actions) ? sj.actions : [];

  async function runAnalysis() {
    setFailed(false);
    setAnalyzing(true);
    startedRef.current = true;
    try {
      const r = await runFn({ data: { reportId } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      if (r.status !== "ok") setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    if (report.isLoading || !report.data) return;
    if (sj.pending_analysis) runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.isLoading, report.data]);

  // ── Rudy's redraft chain — PAUSES for review ──
  // When the report was created with redraft_auto, the moment the audit lands we
  // pre-accept every VERIFIED finding, then STOP at the findings dashboard so the
  // reviewer can read the insights, adjust decisions, and click Generate when
  // ready — the redraft is never produced (or downloaded) behind their back.
  // Runs once per page load; only announces when it actually changed something.
  const bulkAcceptFn = useServerFn(bulkSetV2FindingDecision);
  const [autoStep, setAutoStep] = useState<null | "accepting">(null);
  const [reviewReady, setReviewReady] = useState(false);
  const autoRef = useRef(false);
  useEffect(() => {
    if (autoRef.current) return;
    if (sj.redraft_auto !== true || sj.workflow_mode !== "recommend_edit") return;
    if (sj.pending_analysis || sj.simplification_status !== "ok" || sj.restructure) return;
    if (!Array.isArray(sj.findings)) return;
    autoRef.current = true;
    (async () => {
      try {
        setAutoStep("accepting");
        // Verified-only: findings still in "review" (verifier returned no
        // verdict) must NOT be auto-selected without a human.
        const verifiedIds = findings
          .filter((f) => f.verification?.status === "verified")
          .map((f) => f.id);
        if (verifiedIds.length === 0) {
          toast.info("The audit found nothing verified to fix — review the findings, then generate if needed.");
          return;
        }
        const r = await bulkAcceptFn({ data: { reportId, decision: "accepted", findingIds: verifiedIds } });
        await qc.invalidateQueries({ queryKey: ["report", reportId] });
        setReviewReady(true);
        if (r.changed > 0) {
          toast.success(`Rudy pre-selected ${r.changed} verified fix${r.changed === 1 ? "" : "es"}`, {
            description: "Review the findings below, then click Generate redraft when you're ready.",
          });
        }
      } catch (e) {
        toast.error("Could not pre-select findings", { description: (e as Error)?.message });
      } finally {
        setAutoStep(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sj.redraft_auto, sj.workflow_mode, sj.pending_analysis, sj.simplification_status, sj.restructure]);

  // Inline highlights for the doc viewer.
  const highlights: DocHighlight[] = useMemo(() => {
    if (workflowMode === "simplify") {
      // Ids MUST use the ORIGINAL action index — the rail and dashboards key
      // decisions by it; filtering first would shift ids once anything is
      // quarantined and highlight the wrong text.
      return actions
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.verification?.status !== "rejected")
        .map(({ a, i }) => ({ id: `a-${i}`, text: a.before, kind: "edit" as const }));
    }
    return findings
      .filter((f) => f.verification?.status !== "rejected")
      .map((f) => ({
        id: f.id,
        text: f.evidence[0]?.quote ?? "",
        kind: (f.severity === "critical" || f.severity === "high" || f.severity === "medium" || f.severity === "info"
          ? f.severity : "medium") as DocHighlight["kind"],
      }))
      .filter((h) => h.text);
  }, [workflowMode, actions, findings]);

  if (report.isLoading) {
    return (
      <AppShell>
        <div className="p-8 space-y-4 animate-pulse">
          <div className="h-4 bg-muted rounded w-32" />
          <div className="h-8 bg-muted rounded w-2/5" />
          <div className="h-96 bg-muted rounded-xl" />
        </div>
      </AppShell>
    );
  }
  if (!report.data) throw notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const title = ((report.data as any).title as string) ?? "Document";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceUrl = ((report.data as any).source_file_url as string) ?? null;
  const runFailed = failed || sj.simplification_status === "failed";
  const meta = MODE_META[workflowMode] ?? MODE_META.simplify;
  const ModeIcon = meta.icon;

  if (analyzing || (sj.pending_analysis && !startedRef.current)) {
    return (
      <AppShell>
        <AnalyzingView mode={workflowMode} title={title} />
      </AppShell>
    );
  }
  if (runFailed) {
    return (
      <AppShell>
        <div className="p-8 max-w-xl mx-auto text-center space-y-4 mt-16">
          <AlertTriangle className="size-8 mx-auto text-amber-500" />
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{sj.simplification_error ?? "The analysis failed."}</p>
          <Button onClick={runAnalysis}><RotateCcw className="size-4 mr-2" /> Re-run analysis</Button>
        </div>
      </AppShell>
    );
  }

  const restructure = sj.restructure ?? null;

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-0px)]">
        {/* compact header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b bg-card/60 shrink-0">
          <Link
            to="/reports"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ArrowLeft className="size-3" /> All documents
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-bold truncate">{title}</h1>
          <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 shrink-0", meta.chip)}>
            <ModeIcon className="size-3" /> {meta.label}
          </span>
          {sj.cost?.usd != null && (
            <span title="Metered AI cost of the last run" className="text-[10px] text-muted-foreground inline-flex items-center gap-1 shrink-0">
              <Info className="size-3" /> ${Number(sj.cost.usd).toFixed(2)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {autoStep === "accepting" && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-200 px-2 py-1 text-[11px] font-semibold">
                <Loader2 className="size-3 animate-spin" />
                Pre-selecting verified fixes…
              </span>
            )}
            {reviewReady && !restructure && !autoStep && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 text-amber-800 ring-1 ring-amber-200 px-2 py-1 text-[11px] font-semibold">
                Review findings, then Generate redraft
              </span>
            )}
            {/* view toggle: dashboard ↔ document (compare lives on the R&E dashboard) */}
            <div className="flex rounded-lg border overflow-hidden text-[11px] font-medium">
              {(["dashboard", "document"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    "px-2.5 py-1 transition-colors capitalize",
                    view === v ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/50",
                    v === "document" && "border-l",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={runAnalysis} disabled={analyzing || autoStep !== null}>
              <RotateCcw className="size-3 mr-1" /> Re-run
            </Button>
          </div>
        </div>

        {/* body */}
        {workflowMode === "create" ? (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-h-0 min-w-0 border-r overflow-hidden">
              <DocViewer fileUrl={sj.created?.downloadUrl ?? null} className="h-full" />
            </div>
            <div className="min-h-0 overflow-y-auto bg-card/30 p-4 space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
                <div className="text-sm font-bold">Draft generated</div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Drafted in the house structure inside "{sj.doc_brief?.donorTitle ?? "the template"}"'s
                  packaging — logo, headers and styles included. Placeholders like
                  [OWNER TO CONFIRM] mark values a human must fill in.
                </p>
                {sj.created?.downloadUrl && (
                  <a href={sj.created.downloadUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" className="w-full h-8 text-xs mt-3">Download DOCX</Button>
                  </a>
                )}
              </div>
              {Array.isArray(sj.created?.outline) && (
                <div className="rounded-xl border bg-card p-4">
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Outline</div>
                  <ul className="space-y-1">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {sj.created.outline.map((o: any, i: number) => (
                      <li key={i} className={cn("text-xs", o.level === 1 ? "font-semibold" : "pl-3 text-muted-foreground")}>
                        {o.heading}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {sj.doc_brief?.brief && (
                <div className="rounded-xl border bg-card p-4">
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Brief</div>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{sj.doc_brief.brief}</p>
                </div>
              )}
            </div>
          </div>
        ) : view === "dashboard" ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {workflowMode === "simplify" ? (
              <SimplifyChangesDashboard
                reportId={reportId}
                actions={actions}
                structure={sj.structure ?? null}
                sourceUrl={sourceUrl}
                onView={(id) => { setActiveId(id); setView("document"); }}
                onDrill={() => setView("document")}
              />
            ) : workflowMode === "recommend_edit" && restructure ? (
              <RedraftDashboard
                restructure={restructure}
                findings={findings}
                structure={sj.structure ?? null}
                sourceUrl={sourceUrl}
                onCompare={() => setView("compare")}
                onDrill={() => setView("document")}
              />
            ) : (
              <AuditHealthDashboard
                reportId={reportId}
                findings={findings}
                structure={sj.structure ?? null}
                sourceUrl={sourceUrl}
                onView={(id) => { setSeverityFilter("all"); setActiveId(id); setView("document"); }}
                onDrill={(sev) => { setSeverityFilter(sev); setView("document"); }}
              />
            )}
          </div>
        ) : view === "compare" && restructure?.downloadUrl ? (
          <div className="flex-1 min-h-0 grid grid-cols-2">
            <div className="min-h-0 min-w-0 border-r flex flex-col overflow-hidden">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground border-b bg-muted/40 shrink-0">
                Original
              </div>
              <DocViewer fileUrl={sourceUrl} className="flex-1" />
            </div>
            <div className="min-h-0 min-w-0 flex flex-col overflow-hidden">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-emerald-700 border-b bg-emerald-50/60 shrink-0">
                Restructured
              </div>
              <DocViewer fileUrl={restructure.downloadUrl} className="flex-1" />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* document viewer */}
            <div className="min-h-0 min-w-0 border-r overflow-hidden">
              <DocViewer
                fileUrl={sourceUrl}
                highlights={highlights}
                activeId={activeId}
                onSelect={setActiveId}
                onAnchorStatus={setAnchorStatus}
                className="h-full"
              />
            </div>

            {/* review rail */}
            <div className="min-h-0 min-w-0 flex flex-col bg-card/30">
              {workflowMode === "simplify" ? (
                <SimplifyRail
                  reportId={reportId}
                  actions={actions}
                  activeId={activeId}
                  anchorStatus={anchorStatus}
                  onSelect={setActiveId}
                  apply={sj.apply ?? null}
                />
              ) : (
                <>
                  <div className="flex-1 min-h-0">
                    <FindingsRail
                      reportId={reportId}
                      findings={findings}
                      activeId={activeId}
                      anchorStatus={anchorStatus}
                      onSelect={setActiveId}
                      severityFilter={severityFilter}
                      onSeverityFilterChange={setSeverityFilter}
                    />
                  </div>
                  {workflowMode === "recommend_edit" && (
                    <RestructurePanel
                      reportId={reportId}
                      findings={findings}
                      restructure={restructure}
                      comparing={view === "compare"}
                      onCompareToggle={(on) => setView(on ? "compare" : "document")}
                      onGenerated={() => qc.invalidateQueries({ queryKey: ["report", reportId] })}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ── analyzing view ───────────────────────────────────────────────────────────

const ANALYZE_COPY: Record<string, string[]> = {
  simplify: [
    "Reading every paragraph and table cell…",
    "Hunting verbosity patterns and duplicated content…",
    "Anchoring every proposed edit back to the source…",
  ],
  recommend: [
    "Extracting every obligation, step and threshold…",
    "Cross-checking claims between sections for contradictions…",
    "Verifying every finding against its quoted evidence…",
  ],
  recommend_edit: [
    "Extracting every obligation, step and threshold…",
    "Cross-checking claims between sections for contradictions…",
    "Verifying every finding against its quoted evidence…",
  ],
};

function AnalyzingView({ mode, title }: { mode: string; title: string }) {
  const [step, setStep] = useState(0);
  const lines = ANALYZE_COPY[mode] ?? ANALYZE_COPY.simplify;
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % lines.length), 6000);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div className="p-8 max-w-xl mx-auto text-center space-y-4 mt-24">
      <Loader2 className="size-8 mx-auto animate-spin text-fuchsia-600" />
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{lines[step]}</p>
      <p className="text-xs text-muted-foreground/70">
        This reads the whole document and can take a few minutes. You can leave this page — the
        result is saved to the report.
      </p>
    </div>
  );
}

// ── simplify-mode rail ───────────────────────────────────────────────────────

const TYPE_LABEL = SIMPLIFY_TYPE_LABEL;

function SimplifyRail({
  reportId, actions, activeId, anchorStatus, onSelect, apply,
}: {
  reportId: string;
  actions: VerifiedAction[];
  activeId: string | null;
  anchorStatus: Record<string, boolean>;
  onSelect: (id: string | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: any | null;
}) {
  const qc = useQueryClient();
  const saveDecision = useServerFn(setSimplificationDecision);
  const bulkDecision = useServerFn(bulkSetSimplificationDecision);
  const applyFn = useServerFn(applySimplifyV2Report);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<"clean" | "annotated" | null>(null);
  const [local, setLocal] = useState<Record<number, ActionDecision>>({});

  const indexed = actions.map((action, index) => ({ action, index }));
  const live = indexed.filter((x) => x.action.verification?.status !== "rejected");
  const decisionOf = (i: number, a: VerifiedAction): ActionDecision => local[i] ?? a.decision ?? "pending";
  const acceptedCount = live.filter((x) => decisionOf(x.index, x.action) === "accepted").length;
  const pendingCount = live.filter((x) => decisionOf(x.index, x.action) === "pending").length;

  // Pending first, then accepted, then rejected — reviewers see open work on top.
  const sorted = [...live].sort((a, b) => {
    const rank = (d: ActionDecision) => (d === "pending" ? 0 : d === "accepted" ? 1 : 2);
    return rank(decisionOf(a.index, a.action)) - rank(decisionOf(b.index, b.action));
  });

  async function decide(index: number, action: VerifiedAction, decision: ActionDecision) {
    const prev = decisionOf(index, action);
    if (prev === decision) return;
    setLocal((d) => ({ ...d, [index]: decision }));
    try {
      await saveDecision({ data: { reportId, index, decision } });
    } catch (e) {
      setLocal((d) => ({ ...d, [index]: prev }));
      toast.error("Couldn't save that decision", { description: (e as Error)?.message });
    }
  }

  async function acceptAll() {
    setBusy(true);
    try {
      const r = await bulkDecision({ data: { reportId, decision: "accepted" } });
      setLocal({});
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      toast.success(`Accepted ${r.changed} edit${r.changed === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error("Couldn't accept all", { description: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  }

  async function exportDoc(mode: "clean" | "annotated") {
    setExporting(mode);
    try {
      await applyFn({ data: { reportId, exportMode: mode } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      toast.success(mode === "clean" ? "Clean copy generated" : "Tracked-changes copy generated");
    } catch (e) {
      toast.error("Export failed", { description: (e as Error)?.message });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b space-y-2">
        <div className="text-sm font-semibold">
          {live.length} edit{live.length === 1 ? "" : "s"}
          <span className="text-muted-foreground font-normal"> · {acceptedCount} accepted · {pendingCount} open</span>
        </div>
        {pendingCount > 0 && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} onClick={acceptAll}>
            <Check className="size-3 mr-1" /> Accept all open
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {sorted.map(({ action, index }) => {
          const id = `a-${index}`;
          const decision = decisionOf(index, action);
          return (
            <div
              key={index}
              onClick={() => onSelect(activeId === id ? null : id)}
              className={cn(
                "rounded-xl border bg-card p-3 space-y-2 cursor-pointer transition-colors",
                activeId === id ? "border-primary ring-1 ring-primary/30" : "hover:border-primary/40",
                decision === "accepted" && "border-emerald-300 bg-emerald-50/40",
                decision === "rejected" && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200">
                  {TYPE_LABEL[action.type] ?? action.type}
                </span>
                {action.section && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-[140px]" title={action.section}>
                    <Quote className="size-3 inline mr-0.5" />{action.section}
                  </span>
                )}
                {anchorStatus[id] === false && (
                  <span title="Couldn't locate in the rendered document" className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">
                    <Link2Off className="size-3" />
                  </span>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">{action.confidence}%</span>
              </div>
              <div className="text-xs leading-relaxed line-through text-muted-foreground/80">{action.before}</div>
              {action.after && <div className="text-xs leading-relaxed text-emerald-800">{action.after}</div>}
              {action.rationale && <div className="text-[11px] text-muted-foreground italic">{action.rationale}</div>}
              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {decision === "pending" ? (
                  <>
                    <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => decide(index, action, "accepted")}>
                      <Check className="size-3 mr-1" /> Accept
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => decide(index, action, "rejected")}>
                      <X className="size-3 mr-1" /> Reject
                    </Button>
                  </>
                ) : (
                  <>
                    <span className={cn("text-[11px] font-medium", decision === "accepted" ? "text-emerald-700" : "text-muted-foreground")}>
                      {decision === "accepted" ? "Accepted" : "Rejected"}
                    </span>
                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] text-muted-foreground" onClick={() => decide(index, action, "pending")}>
                      <RotateCcw className="size-3 mr-0.5" /> Undo
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {live.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">No edits proposed.</p>
        )}
      </div>

      {/* export */}
      <div className="border-t bg-card/60 p-3 space-y-2">
        <div className="text-xs font-semibold">Export amended document</div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Applies the {acceptedCount} accepted edit{acceptedCount === 1 ? "" : "s"} to the original
          file — logo, headers and formatting preserved.
        </p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] flex-1"
            disabled={acceptedCount === 0 || exporting !== null} onClick={() => exportDoc("annotated")}>
            {exporting === "annotated" ? <Loader2 className="size-3 mr-1 animate-spin" /> : <FileDown className="size-3 mr-1" />}
            Tracked changes
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] flex-1"
            disabled={acceptedCount === 0 || exporting !== null} onClick={() => exportDoc("clean")}>
            {exporting === "clean" ? <Loader2 className="size-3 mr-1 animate-spin" /> : <FileDown className="size-3 mr-1" />}
            Clean copy
          </Button>
        </div>
        {(apply?.annotatedUrl || apply?.cleanUrl) && (
          <div className="flex flex-col gap-1 pt-1">
            {apply.annotatedUrl && (
              <a href={apply.annotatedUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline">
                Download tracked-changes copy
              </a>
            )}
            {apply.cleanUrl && (
              <a href={apply.cleanUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline">
                Download clean copy
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
