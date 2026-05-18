import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApprovalWorkflow } from "@/components/approval-workflow";
import { AmendmentPanel } from "@/components/amendment-panel";
import { LegalReviewView } from "@/components/legal-review-view";
import { useRole } from "@/lib/role";
import { MD } from "@/components/md";
import { exportExcel, exportHtmlPresentation } from "@/lib/exports";
import { impactClasses, formatDate, statusMeta, changeTypeMeta } from "@/lib/format";
import { updateImpact, rerunReport } from "@/lib/compliance.functions";
import { cn } from "@/lib/utils";
import { diffOld, diffNew } from "@/lib/text-diff";
import {
  ArrowLeft, FileSpreadsheet, Presentation, Loader2,
  ArrowRightLeft, CheckCircle2, XCircle, UserCheck,
  Scale, FileText, AlertCircle, Sparkles, ExternalLink,
  ArrowDownToLine, MoveDown, AlertTriangle, LayoutGrid,
  CircleDot, Circle, RefreshCw, PanelLeftClose, PanelLeftOpen, FileEdit,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/reports/$reportId")({
  component: ReportPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-10 text-sm text-destructive">{error.message}</div></AppShell>
  ),
  notFoundComponent: () => (
    <AppShell><div className="p-10">Report not found.</div></AppShell>
  ),
});

function ReportPage() {
  const { reportId } = Route.useParams();
  const [role] = useRole();
  // selectedId: null = Summary view, "<uuid>" = a specific change
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "gaps">("analysis");
  const [exporting, setExporting] = useState<null | "xlsx" | "html">(null);
  const [rerunning, setRerunning] = useState(false);
  const [registerCollapsed, setRegisterCollapsed] = useState(false);
  const rerun = useServerFn(rerunReport);
  const qc = useQueryClient();

  const report = useQuery({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase.from("analysis_reports").select("*").eq("id", reportId).single();
      if (error) throw error;
      return data;
    },
  });
  const changes = useQuery({
    queryKey: ["changes", reportId],
    queryFn: async () => {
      const { data } = await supabase.from("regulatory_changes").select("*").eq("report_id", reportId).order("position");
      return data ?? [];
    },
  });
  const impacts = useQuery({
    queryKey: ["impacts", reportId],
    queryFn: async () => {
      const { data } = await supabase.from("sop_impacts").select("*").eq("report_id", reportId).order("position");
      return data ?? [];
    },
  });
  const sopsQuery = useQuery({
    queryKey: ["sop_documents_all", (report.data as any)?.workspace_id ?? "rmit"],
    enabled: !!report.data,
    queryFn: async () => {
      const ws = (report.data as any)?.workspace_id ?? "rmit";
      const { data } = await (supabase as any).from("sop_documents")
        .select("id,title,doc_type,version,file_url")
        .eq("workspace_id", ws);
      return data ?? [];
    },
  });
  const sopById = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of sopsQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [sopsQuery.data]);

  // ALL hooks must be called above any conditional early-return.
  // Compute UC1 derived state before the loading guard.
  const allChanges = changes.data ?? [];
  const allImpacts = impacts.data ?? [];
  const summary = ((report.data?.summary_json) ?? {}) as any;
  const isFormUpdate: boolean = !!summary?.uc1_form_update;

  const docGroups = useMemo(() => {
    if (!isFormUpdate) return [];
    const map = new Map<string, { sopId: string | null; sopTitle: string; impacts: any[] }>();
    for (const imp of allImpacts) {
      const key = imp.sop_id ?? `__nokey_${imp.sop_title}`;
      if (!map.has(key)) map.set(key, { sopId: imp.sop_id, sopTitle: imp.sop_title, impacts: [] });
      map.get(key)!.impacts.push(imp);
    }
    return Array.from(map.values()).sort((a, b) => b.impacts.length - a.impacts.length);
  }, [allImpacts, isFormUpdate]);

  // Conditional early returns are safe BELOW this line — no hooks after this.
  if (report.isLoading) return (
    <AppShell>
      <div className="p-8 space-y-4 animate-pulse">
        <div className="h-4 bg-muted rounded w-32" />
        <div className="h-8 bg-muted rounded w-2/5" />
        <div className="h-24 bg-muted rounded-xl" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-40 bg-muted rounded-xl" />)}
        </div>
      </div>
    </AppShell>
  );
  if (!report.data) throw notFound();

  const oldPolicyName: string = summary.old_policy_name ?? "Previous version";
  const newPolicyName: string = report.data.policy_name ?? "Updated policy";
  const s = statusMeta(report.data.status);

  const formFieldChanges: { label: string; oldValue: string; newValue: string }[] = summary?.field_changes ?? [];

  // null selectedId = Summary view; otherwise show the specific change/doc
  const showSummary = selectedId === null;
  const selectedChange = showSummary || isFormUpdate ? null : (allChanges.find(c => c.id === selectedId) ?? null);
  const selectedDocGroup = isFormUpdate && !showSummary ? docGroups.find((d) => (d.sopId ?? `__nokey_${d.sopTitle}`) === selectedId) : null;

  const impactsForChange = (chapter_ref: string) => {
    const target = (chapter_ref ?? "").trim().toLowerCase();
    if (!target) return [];
    return allImpacts.filter((i) => {
      const ic = (i.chapter ?? "").trim().toLowerCase();
      if (!ic) return false;
      // Exact match, or one is a prefix/substring of the other.
      // Handles e.g. UC1 where impact.chapter="FGROP 037/2016" and
      // change.chapter_ref="FGROP 037/2016 · Name", and UC3 where
      // impact.chapter="10.31" and change.chapter_ref="10.31(a)".
      return ic === target || target.includes(ic) || ic.includes(target);
    });
  };

  // Approval rollup per change — used for status pill on each register tile
  function changeStatusRollup(chapter_ref: string) {
    const list = impactsForChange(chapter_ref);
    const total = list.length;
    if (total === 0) return { total: 0, decided: 0, approved: 0, allApproved: false, allDecided: false };
    const approved = list.filter(i => i.status === "approved").length;
    const rejected = list.filter(i => i.status === "rejected").length;
    const routed   = list.filter(i => i.status === "routed").length;
    const decided  = approved + rejected + routed;
    return {
      total,
      decided,
      approved,
      allApproved: approved === total,
      allDecided: decided === total,
    };
  }

  const counts = {
    high: allChanges.filter(c => c.impact === "high").length,
    medium: allChanges.filter(c => c.impact === "medium").length,
    low: allChanges.filter(c => c.impact === "low").length,
  };

  async function runExport(kind: "xlsx" | "html", fn: () => Promise<void> | void) {
    if (exporting) return;
    setExporting(kind);
    try { await fn(); }
    catch (e: any) { toast.error("Export failed", { description: e?.message }); }
    finally { setExporting(null); }
  }

  async function handleRerun() {
    if (rerunning) return;
    if (!confirm("Re-run the AI analysis on this report?\n\nThis will replace all current changes and SOP impacts with a fresh analysis using the latest prompts and KB documents. Approval decisions on existing impacts will be lost.")) return;
    setRerunning(true);
    try {
      const result = await rerun({ data: { reportId } });
      toast.success(`Re-analysis complete: ${result.changesCount} changes, ${result.impactCount} SOP impacts`);
      qc.invalidateQueries({ queryKey: ["report", reportId] });
      qc.invalidateQueries({ queryKey: ["changes", reportId] });
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error("Re-analysis failed", { description: e?.message });
    } finally {
      setRerunning(false);
    }
  }

  // ── Head of Legal view ────────────────────────────────────────
  if (role === "legal") {
    return (
      <AppShell>
        <div style={{ height: "calc(100vh - 3.5rem)" }}>
          <LegalReviewView
            report={report.data}
            changes={allChanges}
            impacts={allImpacts}
            sopById={sopById}
          />
        </div>
      </AppShell>
    );
  }

  // ── Compliance Officer view (default) ─────────────────────────
  return (
    <AppShell>
      <div className="flex flex-col overflow-hidden" style={{ height: "calc(100vh - 3.5rem)" }}>

        {/* ── Top strip ─────────────────────────────────────────────── */}
        <div className="shrink-0 px-4 sm:px-6 py-2.5 border-b bg-card flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link to="/reports" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-0.5 transition-colors">
              <ArrowLeft className="size-3" /> All Analyses
            </Link>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display font-bold text-base leading-tight truncate">{report.data.title}</h1>
              <Badge variant="outline" className={cn("text-[10px]", s.classes)}>{s.label}</Badge>
              <span className="text-xs text-muted-foreground hidden sm:inline">{formatDate(report.data.created_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isFormUpdate && (
              <>
                <Button variant="outline" size="sm" disabled={rerunning} className="h-7 text-xs gap-1.5"
                  onClick={handleRerun}
                  title="Re-run AI analysis on this report (replaces current changes)">
                  {rerunning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  <span className="hidden sm:inline">{rerunning ? "Re-analysing…" : "Re-run"}</span>
                </Button>
                <div className="h-4 w-px bg-border mx-0.5" />
              </>
            )}
            <Button variant="outline" size="sm" disabled={!!exporting} className="h-7 text-xs gap-1.5"
              onClick={() => runExport("html", () => exportHtmlPresentation(report.data, allChanges, allImpacts))}>
              {exporting === "html" ? <Loader2 className="size-3 animate-spin" /> : <Presentation className="size-3" />}
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} className="h-7 text-xs gap-1.5"
              onClick={() => runExport("xlsx", () => exportExcel(report.data, allChanges, allImpacts))}>
              {exporting === "xlsx" ? <Loader2 className="size-3 animate-spin" /> : <FileSpreadsheet className="size-3" />}
              <span className="hidden sm:inline">Excel</span>
            </Button>
          </div>
        </div>

        {/* ── Approval workflow ──────────────────────────────────────── */}
        <div className="shrink-0">
          <ApprovalWorkflow report={report.data} />
        </div>

        {/* ── Step 9 · Apply amendments to source docs ──────────────── */}
        {(report.data.status === "signed_off" || report.data.status === "pending_manual" || report.data.status === "published") && (
          <div className="shrink-0">
            <AmendmentPanel reportId={reportId} />
          </div>
        )}

        {/* ── Section tabs ───────────────────────────────────────────── */}
        <div className="shrink-0 px-4 sm:px-6 border-b bg-card flex items-center gap-0">
          {(["analysis", "gaps"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap",
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "analysis"
                ? (isFormUpdate ? `Documents (${docGroups.length})` : `Change Analysis (${allChanges.length})`)
                : (isFormUpdate ? `All Edits (${allImpacts.length})` : `SOP Gap Register (${allImpacts.length})`)}
            </button>
          ))}
        </div>

        {/* ── Main area ─────────────────────────────────────────────── */}
        {activeTab === "analysis" ? (
          <div className="flex-1 flex min-h-0 overflow-hidden">

            {/* ── Left: Change Register (collapsible) ───────────────── */}
            {registerCollapsed ? (
              <div className="w-10 shrink-0 border-r flex flex-col items-center bg-slate-50/60 dark:bg-slate-900/30">
                <button
                  onClick={() => setRegisterCollapsed(false)}
                  title="Expand change register"
                  className="w-full py-3 text-muted-foreground hover:text-foreground hover:bg-white dark:hover:bg-slate-800/60 transition-colors border-b"
                >
                  <PanelLeftOpen className="size-4 mx-auto" />
                </button>
                <div className="py-3 px-2 text-center border-b w-full bg-card">
                  <div className="text-rose-600 text-sm font-display font-black leading-none">{counts.high}</div>
                  <div className="text-amber-600 text-sm font-display font-black leading-none mt-1.5">{counts.medium}</div>
                  <div className="text-emerald-600 text-sm font-display font-black leading-none mt-1.5">{counts.low}</div>
                </div>
                <div className="flex-1 flex items-center justify-center px-1">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-muted-foreground -rotate-90 whitespace-nowrap">
                    {allChanges.length} changes
                  </div>
                </div>
              </div>
            ) : (
            <div className="w-64 lg:w-72 shrink-0 border-r flex flex-col overflow-hidden bg-slate-50/60 dark:bg-slate-900/30">
              {/* Stats bar with collapse toggle */}
              <div className="px-3 py-2.5 border-b bg-card flex items-center gap-2">
                <div className="grid grid-cols-3 gap-1 text-center flex-1">
                  <StatPill label="High" count={counts.high} color="text-rose-600" />
                  <StatPill label="Med" count={counts.medium} color="text-amber-600" />
                  <StatPill label="Low" count={counts.low} color="text-emerald-600" />
                </div>
                <button
                  onClick={() => setRegisterCollapsed(true)}
                  title="Collapse change register"
                  className="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <PanelLeftClose className="size-3.5" />
                </button>
              </div>
              {/* Change list */}
              <div className="flex-1 overflow-y-auto">
                {/* Summary pseudo-item */}
                <button
                  onClick={() => setSelectedId(null)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 border-b border-slate-200 dark:border-slate-700 transition-all",
                    "hover:bg-white dark:hover:bg-slate-800/60",
                    showSummary
                      ? "bg-white dark:bg-slate-800 border-l-[3px] border-l-primary shadow-sm"
                      : "border-l-[3px] border-l-transparent"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="size-3.5 text-primary shrink-0" />
                    <span className="text-[11px] font-black uppercase tracking-widest text-foreground/90">Summary Overview</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                    {isFormUpdate
                      ? `${docGroups.length} affected document${docGroups.length !== 1 ? "s" : ""} · ${allImpacts.length} edits`
                      : `All ${allChanges.length} changes at a glance · ${allImpacts.length} SOP actions`}
                  </p>
                </button>

                {/* UC1: document-centric register (one tile per affected doc) */}
                {isFormUpdate ? (
                  docGroups.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground italic">No documents affected.</div>
                  ) : (
                    docGroups.map((g) => {
                      const key = g.sopId ?? `__nokey_${g.sopTitle}`;
                      const isSelected = selectedId === key;
                      const approvedCount = g.impacts.filter((i: any) => i.status === "approved").length;
                      const allApproved = approvedCount === g.impacts.length && g.impacts.length > 0;
                      const cleanTitle = (g.sopTitle ?? "").replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedId(key)}
                          className={cn(
                            "w-full text-left px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 transition-all",
                            "hover:bg-white dark:hover:bg-slate-800/60",
                            isSelected
                              ? "bg-white dark:bg-slate-800 border-l-[3px] border-l-primary shadow-sm"
                              : "border-l-[3px] border-l-transparent",
                            allApproved && !isSelected && "bg-emerald-50/40 dark:bg-emerald-900/10"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="font-semibold text-[11px] text-foreground truncate">{cleanTitle}</span>
                            <span className={cn(
                              "text-[8px] font-black px-1 py-0.5 rounded inline-flex items-center gap-0.5 shrink-0",
                              allApproved ? "bg-emerald-100 text-emerald-700" :
                              approvedCount > 0 ? "bg-blue-100 text-blue-700" :
                                                  "bg-slate-100 text-slate-600"
                            )}>
                              {allApproved ? <CheckCircle2 className="size-2.5" /> : <Circle className="size-2.5" />}
                              {approvedCount}/{g.impacts.length}
                            </span>
                          </div>
                          <p className="text-[10px] text-muted-foreground leading-snug">
                            {g.impacts.length} edit{g.impacts.length !== 1 ? "s" : ""} to apply
                          </p>
                          {!g.sopId && (
                            <p className="mt-1 text-[9px] font-semibold text-amber-600 inline-flex items-center gap-1">
                              <AlertTriangle className="size-2.5" /> Not in KB
                            </p>
                          )}
                        </button>
                      );
                    })
                  )
                ) : allChanges.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground italic">No changes extracted.</div>
                ) : (
                  allChanges.map(c => {
                    const isSelected = selectedId === c.id;
                    const isNew = !c.old_requirement || (c.old_requirement as string).toLowerCase().startsWith("n/a");
                    const roll = changeStatusRollup(c.chapter_ref);
                    const headline = (c.change_summary ?? "").trim() || c.chapter_ref;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "w-full text-left px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 transition-all",
                          "hover:bg-white dark:hover:bg-slate-800/60",
                          isSelected
                            ? "bg-white dark:bg-slate-800 border-l-[3px] border-l-primary shadow-sm"
                            : "border-l-[3px] border-l-transparent",
                          roll.allApproved && !isSelected && "bg-emerald-50/40 dark:bg-emerald-900/10"
                        )}
                      >
                        {/* Top row: impact + status pills */}
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className={cn(
                            "text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
                            c.impact === "high" ? "bg-rose-100 text-rose-700" :
                            c.impact === "medium" ? "bg-amber-100 text-amber-700" :
                            "bg-emerald-100 text-emerald-700"
                          )}>{c.impact}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {isNew && (
                              <span className="inline-flex items-center gap-0.5 text-[8px] font-bold text-emerald-600 bg-emerald-100 px-1 py-0.5 rounded">
                                <Sparkles className="size-2.5" /> NEW
                              </span>
                            )}
                            {roll.total > 0 && (
                              <span className={cn(
                                "text-[8px] font-black px-1 py-0.5 rounded inline-flex items-center gap-0.5",
                                roll.allApproved ? "bg-emerald-100 text-emerald-700" :
                                roll.allDecided  ? "bg-amber-100 text-amber-700" :
                                roll.decided > 0 ? "bg-blue-100 text-blue-700" :
                                                   "bg-slate-100 text-slate-600"
                              )}>
                                {roll.allApproved
                                  ? <CheckCircle2 className="size-2.5" />
                                  : roll.decided > 0
                                    ? <CircleDot className="size-2.5" />
                                    : <Circle className="size-2.5" />}
                                {roll.decided}/{roll.total}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Headline — short description */}
                        <p className="text-[12px] font-semibold leading-snug text-foreground line-clamp-2">{headline}</p>
                        {/* Subline — paragraph reference */}
                        <p className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">{c.chapter_ref}</p>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            )}

            {/* ── Right: Summary or Change/Doc Detail ──────────────────── */}
            <div className="flex-1 overflow-y-auto bg-background">
              {showSummary ? (
                <SummaryOverview
                  changes={allChanges}
                  impacts={allImpacts}
                  summary={summary}
                  newPolicyName={newPolicyName}
                  oldPolicyName={oldPolicyName}
                  sopById={sopById}
                  onSelectChange={(id) => setSelectedId(id)}
                  changeStatusRollup={changeStatusRollup}
                />
              ) : isFormUpdate && selectedDocGroup ? (
                <DocAmendmentPanel
                  docGroup={selectedDocGroup}
                  formFieldChanges={formFieldChanges}
                  sopById={sopById}
                  reportId={reportId}
                  formId={summary?.form_id ?? newPolicyName}
                />
              ) : selectedChange ? (
                <ChangeDetailPanel
                  change={selectedChange}
                  impacts={impactsForChange(selectedChange.chapter_ref)}
                  oldPolicyName={oldPolicyName}
                  newPolicyName={newPolicyName}
                  reportId={reportId}
                  sopById={sopById}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select {isFormUpdate ? "a document" : "a change"} from the register on the left.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <GapTable impacts={allImpacts} sopById={sopById} reportId={reportId} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanSopTitle(title: string | null | undefined): string {
  if (!title) return "Unknown document";
  return title.replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
}

export function ExecutiveSummary({ value }: { value: any }) {
  const bullets: string[] = Array.isArray(value)
    ? value.filter((b: any) => typeof b === "string" && b.trim().length > 0)
    : typeof value === "string" && value.trim()
      ? value.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim().length > 0)
      : [];

  if (bullets.length === 0) return null;
  return (
    <ul className="space-y-1.5 list-disc pl-5 marker:text-primary/60">
      {bullets.map((b, i) => (
        <li key={i} className="text-sm leading-relaxed">{b.trim()}</li>
      ))}
    </ul>
  );
}

function DiffText({ side, oldText, newText }: { side: "old" | "new"; oldText: string; newText: string }) {
  const segs = side === "old" ? diffOld(oldText, newText) : diffNew(oldText, newText);
  return (
    <>
      {segs.map((s, i) => {
        if (s.type === "common") return <span key={i}>{s.text}</span>;
        if (s.type === "removed")
          return <span key={i} className="bg-rose-200 dark:bg-rose-900/50 text-rose-900 dark:text-rose-200 line-through decoration-rose-700/60 rounded px-0.5">{s.text}</span>;
        return <span key={i} className="bg-emerald-200 dark:bg-emerald-900/50 text-emerald-900 dark:text-emerald-100 font-semibold rounded px-0.5">{s.text}</span>;
      })}
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

// ── Summary Overview ─────────────────────────────────────────────────────────

function SummaryOverview({
  changes, impacts, summary, newPolicyName, oldPolicyName, sopById,
  onSelectChange, changeStatusRollup,
}: {
  changes: any[];
  impacts: any[];
  summary: any;
  newPolicyName: string;
  oldPolicyName: string;
  sopById: Map<string, any>;
  onSelectChange: (id: string) => void;
  changeStatusRollup: (chapter_ref: string) => {
    total: number; decided: number; approved: number; allApproved: boolean; allDecided: boolean;
  };
}) {
  const totalImpacts = impacts.length;
  const approvedImpacts = impacts.filter(i => i.status === "approved").length;
  const routedImpacts = impacts.filter(i => i.status === "routed").length;
  const rejectedImpacts = impacts.filter(i => i.status === "rejected").length;
  const pendingImpacts = totalImpacts - approvedImpacts - routedImpacts - rejectedImpacts;
  const progressPct = totalImpacts === 0 ? 0 : Math.round(((approvedImpacts + routedImpacts + rejectedImpacts) / totalImpacts) * 100);

  // Group impacts by SOP doc title
  const docMap = new Map<string, { count: number; approved: number; sopId?: string }>();
  for (const imp of impacts) {
    const sop = imp.sop_id ? sopById.get(imp.sop_id) : undefined;
    const title = (sop?.title ?? imp.sop_title ?? "Unmatched")
      .replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
    const existing = docMap.get(title) ?? { count: 0, approved: 0, sopId: sop?.id };
    existing.count += 1;
    if (imp.status === "approved") existing.approved += 1;
    docMap.set(title, existing);
  }
  const docList = Array.from(docMap.entries()).sort((a, b) => b[1].count - a[1].count);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b bg-card">
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-primary mb-1">
          <LayoutGrid className="size-3" /> Summary Overview
        </div>
        <h1 className="font-display text-xl font-bold leading-tight">{newPolicyName}</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Benchmarked against <span className="font-semibold">{oldPolicyName}</span> ·{" "}
          {changes.length} regulatory changes mapped to {totalImpacts} SOP actions
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">

          {/* Progress bar */}
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Triage Progress</div>
              <div className="text-xs font-bold">{progressPct}%</div>
            </div>
            <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-3">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <ProgressStat label="Approved" count={approvedImpacts} color="text-emerald-600" />
              <ProgressStat label="Routed" count={routedImpacts} color="text-amber-600" />
              <ProgressStat label="Rejected" count={rejectedImpacts} color="text-slate-500" />
              <ProgressStat label="Pending" count={pendingImpacts} color="text-blue-600" />
            </div>
          </div>

          {/* Executive summary */}
          {summary.executive && (
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">Executive Summary</div>
              <div className="rounded-xl border bg-card p-4 text-sm leading-relaxed text-foreground/85">
                <ExecutiveSummary value={summary.executive} />
              </div>
            </div>
          )}

          {/* Affected internal documents */}
          {docList.length > 0 && (
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">
                Affected Internal Documents ({docList.length})
              </div>
              <div className="rounded-xl border bg-card overflow-hidden divide-y">
                {docList.map(([title, info]) => (
                  <div key={title} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{title}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {info.count} {info.count === 1 ? "amendment" : "amendments"} · {info.approved} approved
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {info.approved === info.count && info.count > 0 && (
                        <CheckCircle2 className="size-4 text-emerald-600" />
                      )}
                      <div className="text-xs font-mono text-muted-foreground">{info.approved}/{info.count}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Changes table */}
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">
              All Changes ({changes.length}) — click to review
            </div>
            <div className="rounded-xl border bg-card overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground w-24">Clause</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground">Change</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground w-16">Impact</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground w-20">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {changes.map(c => {
                    const roll = changeStatusRollup(c.chapter_ref);
                    return (
                      <tr
                        key={c.id}
                        onClick={() => onSelectChange(c.id)}
                        className="cursor-pointer hover:bg-muted/40 transition-colors"
                      >
                        <td className="px-3 py-2.5 font-mono font-bold align-top">{c.chapter_ref}</td>
                        <td className="px-3 py-2.5 text-foreground/80 leading-snug">
                          <div className="line-clamp-2">{c.change_summary}</div>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <span className={cn(
                            "text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
                            c.impact === "high" ? "bg-rose-100 text-rose-700" :
                            c.impact === "medium" ? "bg-amber-100 text-amber-700" :
                            "bg-emerald-100 text-emerald-700"
                          )}>{c.impact}</span>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {roll.total === 0 ? (
                            <span className="text-[10px] text-muted-foreground italic">no SOPs</span>
                          ) : (
                            <span className={cn(
                              "text-[10px] font-bold inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
                              roll.allApproved ? "bg-emerald-100 text-emerald-700" :
                              roll.allDecided  ? "bg-amber-100 text-amber-700" :
                              roll.decided > 0 ? "bg-blue-100 text-blue-700" :
                                                 "bg-slate-100 text-slate-600"
                            )}>
                              {roll.allApproved ? <CheckCircle2 className="size-2.5" /> : <Circle className="size-2.5" />}
                              {roll.decided}/{roll.total}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function ProgressStat({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div>
      <div className={cn("text-base font-display font-black leading-none", color)}>{count}</div>
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-semibold mt-0.5">{label}</div>
    </div>
  );
}

function StatPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div>
      <div className={cn("text-base font-display font-black leading-none", color)}>{count}</div>
      <div className="text-[8px] uppercase tracking-widest text-muted-foreground font-semibold mt-0.5">{label}</div>
    </div>
  );
}

function ChangeDetailPanel({
  change, impacts, oldPolicyName, newPolicyName, reportId, sopById,
}: {
  change: any; impacts: any[]; oldPolicyName: string; newPolicyName: string; reportId: string; sopById: Map<string, any>;
}) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const isNew = !change.old_requirement || (change.old_requirement as string).toLowerCase().startsWith("n/a");

  async function setImpactStatus(id: string, status: "approved" | "rejected" | "routed") {
    try {
      await upd({ data: { id, status } });
      toast.success(`Marked as ${status}`);
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update");
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Header bar ─────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-4 border-b bg-card flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-mono font-bold text-xl tracking-tight">{change.chapter_ref}</span>
            <Badge className={cn("px-2.5 py-0.5 rounded-full text-[10px] font-black tracking-widest shrink-0", impactClasses(change.impact))}>
              {(change.impact as string).toUpperCase()}
            </Badge>
            {isNew && (
              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 px-2.5 py-0.5 rounded-full text-[10px] font-black tracking-widest gap-1">
                <Sparkles className="size-2.5" /> NEW OBLIGATION
              </Badge>
            )}
          </div>
          {change.change_summary && (
            <p className="text-sm text-muted-foreground leading-snug max-w-2xl">{change.change_summary}</p>
          )}
        </div>
        {change.tone_shift && (
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full border bg-card text-xs font-medium text-muted-foreground">
            <ArrowRightLeft className="size-3 opacity-60" />
            {change.tone_shift}
          </div>
        )}
      </div>

      {/* ── Scrollable body ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">

          {/* ── Legal refs ──────────────────────────────────────── */}
          {((change.legal_refs?.length ?? 0) > 0 || (change.related_instruments?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {(change.legal_refs ?? []).map((r: string) => (
                <Badge key={r} variant="outline" className="text-xs gap-1 font-mono">
                  <Scale className="size-3 opacity-60" />{r}
                </Badge>
              ))}
              {(change.related_instruments ?? []).map((r: string) => (
                <Badge key={r} variant="outline" className="text-xs bg-slate-50">{r}</Badge>
              ))}
            </div>
          )}

          {/* ── Before / After ──────────────────────────────────── */}
          {isNew ? (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 bg-emerald-50 dark:bg-emerald-900/40 border-b border-emerald-200 dark:border-emerald-800">
                <Sparkles className="size-3.5 text-emerald-700 dark:text-emerald-400" />
                <span className="text-xs font-black uppercase tracking-widest text-emerald-800 dark:text-emerald-300">New Obligation</span>
                <span className="text-xs text-emerald-700/60 ml-1">— introduced in {newPolicyName}</span>
              </div>
              <div className="p-5 text-sm leading-relaxed font-medium bg-emerald-50/30 dark:bg-emerald-950/10">
                <MD>{change.new_requirement}</MD>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 rounded-xl border overflow-hidden">
              {/* OLD */}
              <div className="border-b lg:border-b-0 lg:border-r">
                <div className="flex items-center gap-2 px-4 py-2.5 bg-rose-50 dark:bg-rose-900/30 border-b border-rose-100 dark:border-rose-800">
                  <div className="size-4 rounded-full bg-rose-600 grid place-items-center shrink-0">
                    <span className="text-[7px] font-black text-white leading-none">OLD</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-black uppercase tracking-widest text-rose-800 dark:text-rose-300">Before · </span>
                    <span className="text-[10px] text-rose-600/70 dark:text-rose-400/60 truncate">{oldPolicyName}</span>
                  </div>
                </div>
                <div className="p-5 text-sm leading-relaxed text-foreground/75 bg-rose-50/20 dark:bg-rose-950/10 min-h-[100px] whitespace-pre-wrap">
                  <DiffText side="old" oldText={change.old_requirement ?? ""} newText={change.new_requirement ?? ""} />
                </div>
              </div>
              {/* NEW */}
              <div>
                <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-100 dark:border-blue-800">
                  <div className="size-4 rounded-full bg-blue-600 grid place-items-center shrink-0">
                    <span className="text-[7px] font-black text-white leading-none">NEW</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-black uppercase tracking-widest text-blue-800 dark:text-blue-300">After · </span>
                    <span className="text-[10px] text-blue-600/70 dark:text-blue-400/60 truncate">{newPolicyName}</span>
                  </div>
                </div>
                <div className="p-5 text-sm leading-relaxed font-medium bg-blue-50/20 dark:bg-blue-950/10 min-h-[100px] whitespace-pre-wrap">
                  <DiffText side="new" oldText={change.old_requirement ?? ""} newText={change.new_requirement ?? ""} />
                </div>
              </div>
            </div>
          )}

          {/* ── Impacted internal policies ───────────────────────── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Impacted Internal Policies
              </h2>
              <div className="h-px flex-1 bg-border" />
              {impacts.length > 0 && (
                <span className="text-[10px] font-semibold text-muted-foreground">{impacts.length} found</span>
              )}
            </div>

            {impacts.length === 0 ? (
              <div className="flex items-center gap-2.5 p-4 rounded-xl border border-dashed text-sm text-muted-foreground">
                <AlertCircle className="size-4 shrink-0 opacity-50" />
                No matching internal SOP for this clause. Ensure relevant policies are indexed in the Knowledge Base.
              </div>
            ) : (
              <div className="space-y-3">
                {impacts.map((imp: any) => (
                  <ImpactCard key={imp.id} imp={imp} sopDoc={sopById.get(imp.sop_id)} onSetStatus={setImpactStatus} />
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function ImpactCard({
  imp, sopDoc, onSetStatus,
}: {
  imp: any;
  sopDoc?: { title?: string; file_url?: string | null; doc_type?: string; version?: string };
  onSetStatus: (id: string, s: "approved" | "rejected" | "routed") => void;
}) {
  const [editMode, setEditMode] = useState(false);
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const [editedText, setEditedText] = useState(imp.edited_text ?? imp.replace_text ?? "");

  async function saveEdit() {
    try {
      await upd({ data: { id: imp.id, edited_text: editedText } });
      toast.success("Draft saved");
      qc.invalidateQueries({ queryKey: ["impacts"] });
      setEditMode(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    }
  }

  const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section";
  const changeTypeLabel = (imp.change_type as string ?? "review").replace(/_/g, " ");
  const currentStatus: string = imp.status ?? "pending";
  const fileUrl = sopDoc?.file_url ?? null;
  const docTitle = cleanSopTitle(sopDoc?.title ?? imp.sop_title);
  const isUnmatched = !imp.sop_id;

  const statusBorderClass: Record<string, string> = {
    approved: "border-emerald-200 dark:border-emerald-800/50",
    rejected: "border-slate-200 dark:border-slate-800 opacity-70",
    routed: "border-amber-200 dark:border-amber-800/50",
    pending: "",
  };

  return (
    <div className={cn("rounded-xl border bg-card overflow-hidden transition-all", statusBorderClass[currentStatus] ?? "")}>
      {/* Card header */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b bg-slate-50/60 dark:bg-slate-900/40">
        <div className="min-w-0 flex-1 space-y-1">
          {/* Row 1: doc title + Not in KB badge */}
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {fileUrl ? (
              <a href={fileUrl} target="_blank" rel="noreferrer"
                className="font-semibold text-sm text-primary hover:underline underline-offset-2 truncate flex items-center gap-1 min-w-0">
                <span className="truncate">{docTitle}</span>
                <ExternalLink className="size-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="font-semibold text-sm truncate">{docTitle}</span>
            )}
            {isUnmatched && (
              <span className="shrink-0 inline-flex items-center gap-1 text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
                <AlertTriangle className="size-2.5" /> Not in KB
              </span>
            )}
          </div>
          {/* Row 2: location (line / page / section) */}
          {(imp.line_range || imp.paragraph || (imp.page && imp.page > 0)) && (
            <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-1.5 flex-wrap">
              {imp.line_range && <span className="text-primary/80">Line {imp.line_range}</span>}
              {imp.page > 0 && <span className="text-muted-foreground/60">· Page {imp.page}</span>}
              {imp.paragraph && <span className="text-muted-foreground/70">· {imp.paragraph}</span>}
            </div>
          )}
          {/* Row 3: action description headline (the "what to do" line) */}
          {imp.action_description && (
            <div className="text-xs font-semibold text-foreground leading-snug pt-1">
              {imp.action_description}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className={cn(
            "text-[9px] font-bold uppercase tracking-wide",
            isInsertion ? "bg-amber-100 text-amber-800 border-amber-200" : ""
          )}>{changeTypeLabel}</Badge>
          {currentStatus !== "pending" && (
            <Badge variant="outline" className={cn("text-[9px] font-bold capitalize",
              currentStatus === "approved" ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
              currentStatus === "routed" ? "bg-amber-100 text-amber-800 border-amber-300" :
              "bg-slate-100 text-slate-500 border-slate-200"
            )}>
              {currentStatus}
            </Badge>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-4 space-y-3">
        {isInsertion ? (
          <>
            {/* Insert location */}
            <div>
              <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-black text-muted-foreground mb-1.5">
                <ArrowDownToLine className="size-3" /> Insert location
              </div>
              <div className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">
                <MoveDown className="size-3.5 text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-[11px] font-mono font-semibold text-foreground/70">{imp.paragraph || "End of section"}</div>
                  {imp.find_text ? (
                    <div className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed italic line-clamp-2">
                      "…{imp.find_text.slice(0, 120)}{imp.find_text.length > 120 ? "…" : ""}"
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-muted-foreground">Insert after the paragraph above</div>
                  )}
                </div>
              </div>
            </div>
            {/* Draft insertion */}
            <div>
              <div className="text-[9px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
                <Sparkles className="size-3" /> Draft insertion
              </div>
              {editMode ? (
                <textarea
                  className="w-full text-xs font-mono p-3 rounded-lg border bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px]"
                  value={editedText}
                  onChange={e => setEditedText(e.target.value)}
                />
              ) : (
                <div className="text-xs leading-relaxed bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 p-3 rounded-lg font-mono text-foreground/90">
                  {imp.edited_text ?? imp.replace_text}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Find */}
            {imp.find_text && (
              <div>
                <div className="text-[9px] uppercase tracking-widest font-black text-rose-600 dark:text-rose-400 mb-1.5">
                  Find — current text to replace <span className="text-muted-foreground font-normal normal-case">(deletions struck through)</span>
                </div>
                <div className="text-xs leading-relaxed bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/40 p-3 rounded-lg font-mono text-foreground/85 whitespace-pre-wrap">
                  <DiffText side="old" oldText={imp.find_text ?? ""} newText={imp.edited_text ?? imp.replace_text ?? ""} />
                </div>
              </div>
            )}
            {/* Replace */}
            <div>
              <div className="text-[9px] uppercase tracking-widest font-black text-blue-600 dark:text-blue-400 mb-1.5">
                Replace with — amended text {!editMode && <span className="text-muted-foreground font-normal normal-case">(additions highlighted)</span>}
              </div>
              {editMode ? (
                <textarea
                  className="w-full text-xs font-mono p-3 rounded-lg border bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px]"
                  value={editedText}
                  onChange={e => setEditedText(e.target.value)}
                />
              ) : (
                <div className="text-xs leading-relaxed bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-3 rounded-lg font-mono text-foreground/90 whitespace-pre-wrap">
                  <DiffText side="new" oldText={imp.find_text ?? ""} newText={imp.edited_text ?? imp.replace_text ?? ""} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-t bg-slate-50/40 dark:bg-slate-900/20 flex-wrap">
        {editMode ? (
          <>
            <Button size="sm" onClick={saveEdit} className="h-7 text-xs">Save draft</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditMode(false)} className="h-7 text-xs">Cancel</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditMode(true)} className="h-7 text-xs gap-1">
              <FileText className="size-3" /> Edit draft
            </Button>
            <div className="h-3.5 w-px bg-border mx-0.5" />
            <Button size="sm" variant="ghost" onClick={() => onSetStatus(imp.id, "approved")}
              className={cn("h-7 text-xs gap-1", currentStatus === "approved" && "text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20")}>
              <CheckCircle2 className="size-3" /> Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSetStatus(imp.id, "routed")}
              className={cn("h-7 text-xs gap-1", currentStatus === "routed" && "text-amber-700 bg-amber-50 dark:bg-amber-900/20")}>
              <UserCheck className="size-3" /> Route
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSetStatus(imp.id, "rejected")}
              className={cn("h-7 text-xs gap-1 text-muted-foreground", currentStatus === "rejected" && "text-slate-500 bg-slate-100 dark:bg-slate-800")}>
              <XCircle className="size-3" /> Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── SOP Gap Register table ────────────────────────────────────────────────────

// ── UC1 Document-centric amendment panel ─────────────────────────────────────

function DocAmendmentPanel({
  docGroup, formFieldChanges, sopById, reportId, formId,
}: {
  docGroup: { sopId: string | null; sopTitle: string; impacts: any[] };
  formFieldChanges: { label: string; oldValue: string; newValue: string }[];
  sopById: Map<string, any>;
  reportId: string;
  formId: string;
}) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const sopDoc = docGroup.sopId ? sopById.get(docGroup.sopId) : undefined;
  const cleanTitle = (docGroup.sopTitle ?? "").replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
  const fileUrl = sopDoc?.file_url ?? null;

  async function setImpactStatus(id: string, status: "approved" | "rejected" | "routed") {
    try {
      await upd({ data: { id, status } });
      toast.success(`Marked as ${status}`);
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update");
    }
  }

  async function approveAll() {
    if (!confirm(`Approve all ${docGroup.impacts.length} edits for "${cleanTitle}"?`)) return;
    try {
      await Promise.all(
        docGroup.impacts
          .filter((i: any) => i.status !== "approved")
          .map((i: any) => upd({ data: { id: i.id, status: "approved" } }))
      );
      toast.success(`Approved all edits for ${cleanTitle}`);
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error(e?.message ?? "Bulk approve failed");
    }
  }

  const allApproved = docGroup.impacts.every((i: any) => i.status === "approved");

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-4 border-b bg-card flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-[10px] font-black uppercase tracking-widest text-primary">Document amendment plan</div>
          <div className="flex items-center gap-2 flex-wrap">
            {fileUrl ? (
              <a href={fileUrl} target="_blank" rel="noreferrer"
                className="font-display text-xl font-bold tracking-tight hover:underline inline-flex items-center gap-1.5">
                {cleanTitle}
                <ExternalLink className="size-4 opacity-60" />
              </a>
            ) : (
              <h2 className="font-display text-xl font-bold tracking-tight">{cleanTitle}</h2>
            )}
            {!docGroup.sopId && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
                <AlertTriangle className="size-3" /> Not in KB
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {docGroup.impacts.length} amendment{docGroup.impacts.length !== 1 ? "s" : ""} required to align with the updated form
          </p>
        </div>
        {!allApproved && (
          <Button size="sm" onClick={approveAll} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white">
            <CheckCircle2 className="size-3.5" /> Approve all
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-5">

          {/* ── What changed in the form (compact reference) ───── */}
          {formFieldChanges.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-700 mb-2 inline-flex items-center gap-1.5">
                <FileEdit className="size-3" /> Form metadata changes — {formId}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                {formFieldChanges.map((f, i) => (
                  <div key={i} className="rounded border bg-white px-2 py-1.5">
                    <div className="font-bold text-amber-900 uppercase tracking-wide text-[9px]">{f.label}</div>
                    <div className="font-mono text-foreground/60 line-through text-[10px] truncate" title={f.oldValue}>{f.oldValue}</div>
                    <div className="font-mono text-emerald-700 font-semibold text-[10px] truncate" title={f.newValue}>↓ {f.newValue}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Impacted Edits (within this single document) ───── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Edits to apply within this document
              </h3>
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold text-muted-foreground">{docGroup.impacts.length} edit{docGroup.impacts.length !== 1 ? "s" : ""}</span>
            </div>

            <div className="space-y-3">
              {docGroup.impacts.map((imp: any) => (
                <ImpactCard key={imp.id} imp={imp} sopDoc={sopDoc} onSetStatus={setImpactStatus} />
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function GapTable({ impacts, sopById, reportId }: { impacts: any[]; sopById: Map<string, any>; reportId: string }) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "routed" | "rejected">("all");

  async function setStatus(id: string, status: "approved" | "rejected" | "routed") {
    await upd({ data: { id, status } });
    toast.success(`Marked as ${status}`);
    qc.invalidateQueries({ queryKey: ["impacts", reportId] });
  }

  const statusOrder: Record<string, number> = { pending: 0, routed: 1, approved: 2, rejected: 3 };
  const sorted = [...impacts].sort((a, b) => {
    const sA = statusOrder[a.status ?? "pending"] ?? 0;
    const sB = statusOrder[b.status ?? "pending"] ?? 0;
    return sA !== sB ? sA - sB : (a.position ?? 0) - (b.position ?? 0);
  });

  const filtered = filter === "all" ? sorted : sorted.filter(i => (i.status ?? "pending") === filter);

  const unmatchedCount = impacts.filter(i => !i.sop_id).length;

  const tally = {
    pending: impacts.filter(i => !i.status || i.status === "pending").length,
    routed: impacts.filter(i => i.status === "routed").length,
    approved: impacts.filter(i => i.status === "approved").length,
    rejected: impacts.filter(i => i.status === "rejected").length,
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 px-6 py-3 border-b bg-card flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {(["all", "pending", "routed", "approved", "rejected"] as const).map(f => (
            <button key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold transition-colors border",
                filter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:border-primary/50"
              )}
            >
              {f === "all" ? `All (${impacts.length})` :
               f === "pending" ? `Pending (${tally.pending})` :
               f === "routed" ? `Routed (${tally.routed})` :
               f === "approved" ? `Approved (${tally.approved})` :
               `Rejected (${tally.rejected})`}
            </button>
          ))}
        </div>
        {unmatchedCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5" />
            {unmatchedCount} not matched to KB documents
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-card border-b">
              <th className="text-left px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-8">#</th>
              <th className="text-left px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Document / Section</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-28">Type</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-36">Regulation Clause</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-16">Page</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-24">Status</th>
              <th className="text-right px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground w-32">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground italic">
                  No items in this category.
                </td>
              </tr>
            ) : filtered.map((imp, idx) => {
              const sopDoc = imp.sop_id ? sopById.get(imp.sop_id) : undefined;
              const docTitle = cleanSopTitle(sopDoc?.title ?? imp.sop_title) || "—";
              const fileUrl = sopDoc?.file_url ?? null;
              const currentStatus: string = imp.status ?? "pending";
              const meta = changeTypeMeta(imp.change_type);
              const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section";

              return (
                <tr key={imp.id}
                  className={cn(
                    "transition-colors hover:bg-muted/40",
                    currentStatus === "approved" && "bg-emerald-50/30 dark:bg-emerald-950/10",
                    currentStatus === "rejected" && "opacity-60"
                  )}
                >
                  {/* # */}
                  <td className="px-4 py-3 text-muted-foreground font-mono">{idx + 1}</td>

                  {/* Document / Section */}
                  <td className="px-4 py-3 max-w-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {fileUrl ? (
                        <a href={fileUrl} target="_blank" rel="noreferrer"
                          className="font-semibold text-primary hover:underline underline-offset-2 truncate flex items-center gap-1 min-w-0">
                          <span className="truncate">{docTitle}</span>
                          <ExternalLink className="size-3 shrink-0 opacity-60" />
                        </a>
                      ) : (
                        <span className="font-semibold truncate">{docTitle}</span>
                      )}
                      {!imp.sop_id && (
                        <span className="shrink-0 text-[9px] font-bold text-amber-600 bg-amber-100 px-1 py-0.5 rounded">unmatched</span>
                      )}
                    </div>
                    {imp.action_description && (
                      <div className="text-[11px] font-medium text-foreground mt-0.5 truncate">{imp.action_description}</div>
                    )}
                    {(imp.line_range || imp.paragraph) && (
                      <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                        {imp.line_range && <span className="text-primary/70">L{imp.line_range} </span>}
                        {imp.paragraph}
                      </div>
                    )}
                  </td>

                  {/* Type */}
                  <td className="px-3 py-3">
                    <Badge variant="outline" className={cn("text-[9px] font-bold uppercase tracking-wide whitespace-nowrap", meta.classes)}>
                      {meta.label}
                    </Badge>
                  </td>

                  {/* Clause */}
                  <td className="px-3 py-3">
                    <span className="font-mono text-[10px] text-muted-foreground">{imp.chapter ?? "—"}</span>
                  </td>

                  {/* Page */}
                  <td className="px-3 py-3">
                    {imp.page && imp.page > 0
                      ? <span className="font-mono text-[10px] font-semibold">p.{imp.page}</span>
                      : <span className="text-[10px] text-muted-foreground/40">—</span>
                    }
                  </td>

                  {/* Status */}
                  <td className="px-3 py-3">
                    <span className={cn(
                      "text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full",
                      currentStatus === "approved" ? "bg-emerald-100 text-emerald-800" :
                      currentStatus === "routed" ? "bg-amber-100 text-amber-800" :
                      currentStatus === "rejected" ? "bg-slate-100 text-slate-500" :
                      "bg-slate-100 text-slate-600"
                    )}>{currentStatus}</span>
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <button onClick={() => setStatus(imp.id, "approved")}
                        title="Approve"
                        className={cn("p-1.5 rounded transition-colors",
                          currentStatus === "approved"
                            ? "text-emerald-600 bg-emerald-100"
                            : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"
                        )}>
                        <CheckCircle2 className="size-3.5" />
                      </button>
                      <button onClick={() => setStatus(imp.id, "routed")}
                        title="Route to Legal"
                        className={cn("p-1.5 rounded transition-colors",
                          currentStatus === "routed"
                            ? "text-amber-600 bg-amber-100"
                            : "text-muted-foreground hover:text-amber-600 hover:bg-amber-50"
                        )}>
                        <UserCheck className="size-3.5" />
                      </button>
                      <button onClick={() => setStatus(imp.id, "rejected")}
                        title="Reject"
                        className={cn("p-1.5 rounded transition-colors",
                          currentStatus === "rejected"
                            ? "text-slate-500 bg-slate-100"
                            : "text-muted-foreground hover:text-red-500 hover:bg-red-50"
                        )}>
                        <XCircle className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
