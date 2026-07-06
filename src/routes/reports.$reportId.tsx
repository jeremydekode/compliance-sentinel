import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApprovalWorkflow } from "@/components/approval-workflow";
import { AmendmentPanel } from "@/components/amendment-panel";
import { LegalReviewView } from "@/components/legal-review-view";
import { useRole } from "@/lib/role";
import { useAuth } from "@/lib/auth";
import { MD } from "@/components/md";
import { exportExcel, exportHtmlPresentation } from "@/lib/exports";
import { impactClasses, formatDate, statusMeta, changeTypeMeta } from "@/lib/format";
import { sortChangesByPriority, autoBoldExecBullet } from "@/lib/change-utils";
import { updateImpact, bulkApproveReady, generateAmendedDraft, startRegulatoryRerun, mapRegulatoryChange, finalizeRegulatoryReport, rerunFormUpdateReport, analyzeDocForForm, finalizeFormUpdateReport, writeImpactToDoc, createPolicyChangeReport } from "@/lib/compliance.functions";
import { cn } from "@/lib/utils";
import { diffOld, diffNew } from "@/lib/text-diff";
import {
  ArrowLeft, FileSpreadsheet, Presentation, Loader2,
  ArrowRightLeft, CheckCircle2, XCircle, UserCheck,
  Scale, FileText, AlertCircle, Sparkles, ExternalLink,
  ArrowDownToLine, MoveDown, AlertTriangle, LayoutGrid,
  CircleDot, Circle, RefreshCw, PanelLeftClose, PanelLeftOpen, FileEdit,
  MessageSquarePlus, FilePlus2, Replace, ShieldPlus, History,
  ChevronDown, Download,
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
  // selectedId: null = Summary view; in byChange mode it's a change UUID,
  // in byDocument mode it's the doc-group key (`sopId` or `__nokey_<title>`).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Left panel grouping: by regulatory change (default) or by affected SOP doc.
  const [viewMode, setViewMode] = useState<"byChange" | "byDocument">("byChange");
  // How the amended-draft renders replaces: keep originals red+strike (review),
  // or delete originals and insert the new text clean (finalised look).
  const [draftMode, setDraftMode] = useState<"clean" | "trackChanges">("trackChanges");
  const [activeTab, setActiveTab] = useState<"analysis" | "gaps">("analysis");
  const [exporting, setExporting] = useState<null | "xlsx" | "html">(null);
  const [rerunning, setRerunning] = useState(false);
  const [approvingReady, setApprovingReady] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [registerCollapsed, setRegisterCollapsed] = useState(false);
  // Auto-analysis: a freshly created report carries summary_json.pending_analysis,
  // so the report page itself runs the analysis (the upload screen navigates here
  // immediately rather than blocking on a loader).
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [autoRunFailed, setAutoRunFailed] = useState(false);
  // Stage 4 progress — non-null while the report is revealed and changes are
  // still being mapped to documents (the slim banner at the top of the report).
  const [mapping, setMapping] = useState<{ done: number; total: number } | null>(null);
  const autoRunStartedRef = useRef(false);
  const bulkApprove = useServerFn(bulkApproveReady);
  const genDraft = useServerFn(generateAmendedDraft);
  const startRegRerun = useServerFn(startRegulatoryRerun);
  const mapChange = useServerFn(mapRegulatoryChange);
  const finalizeReg = useServerFn(finalizeRegulatoryReport);
  const rerunForm = useServerFn(rerunFormUpdateReport);
  const analyzeDocFn = useServerFn(analyzeDocForForm);
  const finalizeFn = useServerFn(finalizeFormUpdateReport);
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
        .select("id,title,doc_type,version,file_url,drive_view_url,drive_file_id,drive_mime_type")
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
  const readyCount = allImpacts.filter(
    (i: any) => typeof i.confidence === "number" && i.confidence >= 90 && (i.status ?? "pending") === "pending",
  ).length;
  const approvedCount = allImpacts.filter((i: any) => (i.status ?? "pending") === "approved").length;
  const summary = ((report.data?.summary_json) ?? {}) as any;
  const amendedDrafts: any[] = Array.isArray(summary.amended_drafts) ? summary.amended_drafts : [];
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

  // Regulatory By-Document grouping: every affected SOP doc with all impacts
  // hitting it across every regulatory change. Same shape as UC1's docGroups
  // so the left-panel tile rendering is shared.
  const docGroupsRegulatory = useMemo(() => {
    if (isFormUpdate) return [];
    const map = new Map<string, { sopId: string | null; sopTitle: string; impacts: any[] }>();
    for (const imp of allImpacts) {
      const key = imp.sop_id ?? `__nokey_${imp.sop_title}`;
      if (!map.has(key)) map.set(key, { sopId: imp.sop_id, sopTitle: imp.sop_title, impacts: [] });
      map.get(key)!.impacts.push(imp);
    }
    return Array.from(map.values()).sort((a, b) => b.impacts.length - a.impacts.length);
  }, [allImpacts, isFormUpdate]);

  /** Switches the left-panel grouping and resets selection back to Summary. */
  function switchViewMode(mode: "byChange" | "byDocument") {
    if (mode === viewMode) return;
    setViewMode(mode);
    setSelectedId(null);
  }

  // Kick the analysis once when a freshly created report lands here. The ref
  // guard makes this fire exactly once per mount even as the query refetches.
  useEffect(() => {
    if (autoRunStartedRef.current) return;
    if (report.isLoading || !report.data) return;
    const sj = ((report.data as any).summary_json ?? {}) as any;
    if (!sj.pending_analysis || sj.uc1_form_update) return;
    launchAutoAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.isLoading, report.data]);

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

  // Analysis-in-progress view — shown while this report's analysis runs (either
  // a fresh upload that auto-started, or a retry). Replaces the report body so
  // the user sees live progress instead of an empty report.
  if (autoAnalyzing || autoRunFailed || (summary.pending_analysis && !autoRunStartedRef.current)) {
    return (
      <AppShell>
        <RegulatoryAnalyzingView
          title={report.data.title}
          progress={null}
          failed={autoRunFailed}
          onRetry={launchAutoAnalysis}
        />
      </AppShell>
    );
  }

  const oldPolicyName: string = summary.old_policy_name ?? "Previous version";
  const newPolicyName: string = report.data.policy_name ?? "Updated policy";
  const s = statusMeta(report.data.status);

  const formFieldChanges: { label: string; oldValue: string; newValue: string }[] = summary?.field_changes ?? [];

  // null selectedId = Summary view; otherwise show the specific change/doc
  const showSummary = selectedId === null;
  const selectedChange = showSummary || isFormUpdate ? null : (allChanges.find(c => c.id === selectedId) ?? null);
  const selectedDocGroup = isFormUpdate && !showSummary ? docGroups.find((d) => (d.sopId ?? `__nokey_${d.sopTitle}`) === selectedId) : null;
  // In regulatory By-Document mode, selectedId is the doc-group key.
  const selectedDocGroupRegulatory =
    !isFormUpdate && viewMode === "byDocument" && !showSummary
      ? docGroupsRegulatory.find((d) => (d.sopId ?? `__nokey_${d.sopTitle}`) === selectedId) ?? null
      : null;

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

  // Priority-sorted change list used by the side panel
  const sortedChanges = sortChangesByPriority(allChanges, impactsForChange);

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

  // Shared regulatory orchestration — one call per SOP (full-document, no
  // chunking), run in PARALLEL. A failed SOP is retried 3× then flagged. Used
  // by both the auto-run on a fresh upload and the manual Re-run button.
  // Stages 1-3 (extract → summary → route) run in startRegRerun; onExtracted
  // fires when they finish so the report can be revealed. Stage 4 maps each
  // change to its routed documents, in parallel, reporting progress.
  async function runRegulatoryAnalysis(
    onExtracted?: (total: number) => void,
    onMapProgress?: (done: number, total: number) => void,
  ) {
    // Stage 1 — extract the regulatory changes. An empty result is almost
    // always a transient AI-model overload, so retry the whole call once (a
    // fresh server invocation) before accepting it.
    let started = await startRegRerun({ data: { reportId } });
    if ((started.changeCount ?? 0) === 0) {
      console.warn("Stage 1 returned 0 changes — retrying extraction once…");
      started = await startRegRerun({ data: { reportId } });
    }
    const { reportId: rid, changes } = started;
    onExtracted?.(changes.length);
    let regDone = 0;
    const coverage = await Promise.all(changes.map(async (ch) => {
      let status = "failed";
      let impactCount = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await mapChange({ data: { reportId: rid, changeId: ch.id } });
          status = res?.status ?? "mapped";
          impactCount = res?.impactCount ?? 0;
          if (status !== "failed") break;
        } catch (err: any) {
          console.warn(`Mapping attempt ${attempt} failed for ${ch.chapter_ref}:`, err?.message);
          status = "failed";
        }
      }
      regDone++;
      onMapProgress?.(regDone, changes.length);
      return { title: ch.chapter_ref, status, impactCount };
    }));
    return await finalizeReg({ data: { reportId: rid, coverage } });
  }

  function launchAutoAnalysis() {
    autoRunStartedRef.current = true;
    setAutoRunFailed(false);
    setAutoAnalyzing(true);
    setMapping(null);
    (async () => {
      let revealed = false;
      try {
        await runRegulatoryAnalysis(
          (total) => {
            // Stages 1-3 done — reveal the report; Stage 4 fills in the rest.
            revealed = true;
            setAutoAnalyzing(false);
            setMapping({ done: 0, total });
            qc.invalidateQueries({ queryKey: ["report", reportId] });
            qc.invalidateQueries({ queryKey: ["changes", reportId] });
          },
          (done, total) => {
            setMapping({ done, total });
            qc.invalidateQueries({ queryKey: ["impacts", reportId] });
          },
        );
        qc.invalidateQueries({ queryKey: ["report", reportId] });
        qc.invalidateQueries({ queryKey: ["changes", reportId] });
        qc.invalidateQueries({ queryKey: ["impacts", reportId] });
        toast.success("Analysis complete");
      } catch (e: any) {
        if (!revealed) setAutoRunFailed(true);
        toast.error("Analysis failed", { description: e?.message });
      } finally {
        setAutoAnalyzing(false);
        setMapping(null);
      }
    })();
  }

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
      let result: { changesCount: number; impactCount: number };
      if (isFormUpdate) {
        // Per-document re-analysis — each doc is its own call so none can time out.
        const { reportId: rid, docsToAnalyze } = await rerunForm({ data: { reportId } });
        const coverage: { title: string; status: string }[] = [];
        for (let i = 0; i < docsToAnalyze.length; i++) {
          const d = docsToAnalyze[i];
          toast.message(`Re-analysing ${i + 1}/${docsToAnalyze.length}: ${d.title}…`, { id: "uc1-rerun", duration: 60000 });
          // Retry a doc that comes back "failed" (dropped connection / API
          // error) — up to 3 attempts — so it is never silently skipped.
          let status = "failed";
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await analyzeDocFn({ data: { reportId: rid, docId: d.docId } });
              status = res?.status ?? "analyzed";
              if (status !== "failed") break;
            } catch (err: any) {
              console.warn(`Re-analysis attempt ${attempt} failed for ${d.title}:`, err?.message);
              status = "failed";
            }
          }
          coverage.push({ title: d.title, status });
        }
        toast.dismiss("uc1-rerun");
        result = await finalizeFn({ data: { reportId: rid, coverage } });
      } else {
        toast.message("Extracting regulatory changes…", { id: "reg-rerun", duration: 240000 });
        result = await runRegulatoryAnalysis(
          (total) => toast.message(`Mapping ${total} change${total === 1 ? "" : "s"} to documents…`, { id: "reg-rerun", duration: 240000 }),
          (done, total) => toast.message(`Mapped ${done}/${total} change${total === 1 ? "" : "s"}…`, { id: "reg-rerun", duration: 240000 }),
        );
        toast.dismiss("reg-rerun");
      }
      toast.success(`Re-analysis complete: ${result.changesCount} change${result.changesCount !== 1 ? "s" : ""}, ${result.impactCount} edit${result.impactCount !== 1 ? "s" : ""}`);
      qc.invalidateQueries({ queryKey: ["report", reportId] });
      qc.invalidateQueries({ queryKey: ["changes", reportId] });
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error("Re-analysis failed", { description: e?.message });
    } finally {
      setRerunning(false);
    }
  }

  async function handleGenerateDraft() {
    if (generatingDraft) return;
    const approved = allImpacts.filter((i: any) => (i.status ?? "pending") === "approved").length;
    if (approved === 0) { toast.message("Approve impacts first, then generate the amended draft."); return; }
    if (!confirm(`Generate an amended draft copy for ${approved} approved impact${approved === 1 ? "" : "s"}?\n\nThis copies each affected SOP and applies the changes to the COPY — the live documents are not touched.`)) return;
    setGeneratingDraft(true);
    try {
      const r = await genDraft({ data: { reportId, renderMode: draftMode } });
      const made = r.drafts.length;
      toast.success(
        made > 0
          ? `Amended draft ready — ${made} document${made === 1 ? "" : "s"} copied and edited`
          : "No drafts generated",
        { description: r.skipped.length ? `${r.skipped.length} skipped` : undefined },
      );
      qc.invalidateQueries({ queryKey: ["report", reportId] });
    } catch (e: any) {
      toast.error("Draft generation failed", { description: e?.message });
    } finally {
      setGeneratingDraft(false);
    }
  }

  async function handleApproveReady() {
    if (approvingReady) return;
    const ready = allImpacts.filter(
      (i: any) => typeof i.confidence === "number" && i.confidence >= 90 && (i.status ?? "pending") === "pending",
    ).length;
    if (ready === 0) { toast.message("No pending high-confidence impacts to fast-track."); return; }
    if (!confirm(`Fast-track approve ${ready} high-confidence impact${ready === 1 ? "" : "s"} (≥90%)?\n\nThe lower-confidence impacts stay for individual review.`)) return;
    setApprovingReady(true);
    try {
      const r = await bulkApprove({ data: { reportId, minConfidence: 90 } });
      toast.success(`Approved ${r.approved} high-confidence impact${r.approved === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error("Bulk approve failed", { description: e?.message });
    } finally {
      setApprovingReady(false);
    }
  }

  // ── Head of Legal view ────────────────────────────────────────
  if (role === "legal") {
    return (
      <AppShell>
        <div className="flex flex-col overflow-hidden" style={{ height: "calc(100vh - 3.5rem)" }}>
          {amendedDrafts.length > 0 && (
            <div className="shrink-0 px-4 sm:px-6 py-2 border-b bg-card">
              <AmendedDraftPanel drafts={amendedDrafts} />
            </div>
          )}
          <div className="flex-1 min-h-0">
            <LegalReviewView
              report={report.data}
              changes={allChanges}
              impacts={allImpacts}
              sopById={sopById}
            />
          </div>
        </div>
      </AppShell>
    );
  }

  // ── Compliance Officer view (default) ─────────────────────────
  return (
    <AppShell>
      <div className="flex flex-col overflow-hidden" style={{ height: "calc(100vh - 3.5rem)" }}>

        {/* ── Top strip ─────────────────────────────────────────────── */}
        <div className="shrink-0 px-4 sm:px-6 py-1.5 border-b bg-card flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
            <Link to="/reports" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0">
              <ArrowLeft className="size-3" /><span className="hidden sm:inline"> All</span>
            </Link>
            <span className="text-muted-foreground/30 text-xs hidden sm:inline">/</span>
            <h1 className="font-display font-bold text-sm leading-tight truncate">{report.data.title}</h1>
            <Badge variant="outline" className={cn("text-[10px] shrink-0", s.classes)}>{s.label}</Badge>
            <span className="text-[11px] text-muted-foreground hidden lg:inline shrink-0">{formatDate(report.data.created_at)}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="outline" size="sm" disabled={rerunning} className="h-7 text-xs gap-1.5"
              onClick={handleRerun}
              title={isFormUpdate ? "Re-run form propagation with the latest engine" : "Re-run AI analysis on this report (replaces current changes)"}>
              {rerunning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              <span className="hidden sm:inline">{rerunning ? "Re-analysing…" : "Re-run"}</span>
            </Button>
            {readyCount > 0 && (
              <Button size="sm" disabled={approvingReady}
                className="h-7 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={handleApproveReady}
                title="Fast-track: approve every pending impact with ≥90% confidence in one click">
                {approvingReady ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
                <span>Approve {readyCount} ready</span>
              </Button>
            )}
            {approvedCount > 0 && (
              <>
                {/* Draft mode — Track Changes (review) vs Clean (finalised). */}
                <div className="hidden md:flex items-center gap-0.5 p-0.5 rounded-md border bg-card h-7">
                  <button
                    type="button"
                    onClick={() => setDraftMode("trackChanges")}
                    disabled={generatingDraft}
                    className={cn(
                      "px-2 h-6 text-[10px] font-bold uppercase tracking-wider rounded transition-colors",
                      draftMode === "trackChanges"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                    title="Original kept in red strike-through, new in yellow — a track-changes review copy"
                  >
                    Track Changes
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftMode("clean")}
                    disabled={generatingDraft}
                    className={cn(
                      "px-2 h-6 text-[10px] font-bold uppercase tracking-wider rounded transition-colors",
                      draftMode === "clean"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                    title="Original removed; new text replaces it highlighted yellow — a finalised draft"
                  >
                    Clean
                  </button>
                </div>
                <Button size="sm" variant="outline" disabled={generatingDraft}
                  className="h-7 text-xs gap-1.5"
                  onClick={handleGenerateDraft}
                  title={
                    draftMode === "clean"
                      ? "Copy each affected SOP and CLEANLY apply the approved changes to the copy (finalised look) — the live documents are never touched"
                      : "Copy each affected SOP and apply the approved changes to the copy in TRACK-CHANGES form (original red+strike, new yellow) — the live documents are never touched"
                  }>
                  {generatingDraft ? <Loader2 className="size-3 animate-spin" /> : <FileEdit className="size-3" />}
                  <span className="hidden sm:inline">Generate amended draft</span>
                </Button>
              </>
            )}
            <div className="h-4 w-px bg-border mx-0.5" />
            <Button variant="outline" size="sm" disabled={!!exporting} className="h-7 px-2"
              title="Export presentation (HTML)"
              onClick={() => runExport("html", () => exportHtmlPresentation(report.data, allChanges, allImpacts))}>
              {exporting === "html" ? <Loader2 className="size-3 animate-spin" /> : <Presentation className="size-3" />}
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} className="h-7 px-2"
              title="Export to Excel"
              onClick={() => runExport("xlsx", () => exportExcel(report.data, allChanges, allImpacts))}>
              {exporting === "xlsx" ? <Loader2 className="size-3 animate-spin" /> : <FileSpreadsheet className="size-3" />}
            </Button>
          </div>
        </div>

        {/* ── Stage 4 mapping progress (report is live; edits filling in) ── */}
        {mapping && (
          <div className="shrink-0 px-4 sm:px-6 py-1.5 bg-primary/5 border-b border-primary/15 flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />
            <span className="font-medium text-foreground">
              Mapping regulatory changes to your documents — {mapping.done} of {mapping.total}
            </span>
            <span className="text-muted-foreground hidden sm:inline">
              · the SOP Gap Register fills in as each change is mapped
            </span>
          </div>
        )}

        {/* ── Approval workflow ──────────────────────────────────────── */}
        <div className="shrink-0">
          <ApprovalWorkflow report={report.data} />
        </div>

        {/* ── Audit history (workflow_events) ────────────────────────── */}
        <div className="shrink-0">
          <WorkflowHistory reportId={reportId} />
        </div>

        {/* ── Amended draft copies (versioned — live docs untouched) ──── */}
        {amendedDrafts.length > 0 && (
          <div className="shrink-0 px-4 sm:px-6 pt-2">
            <AmendedDraftPanel drafts={amendedDrafts} />
          </div>
        )}

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
                {/* By Change / By Document toggle — regulatory workspaces only */}
                {!isFormUpdate && (
                  <div className="flex items-center gap-1 p-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30">
                    <button
                      type="button"
                      onClick={() => switchViewMode("byChange")}
                      className={cn(
                        "flex-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors",
                        viewMode === "byChange"
                          ? "bg-foreground text-background shadow-sm"
                          : "text-muted-foreground hover:bg-slate-200 dark:hover:bg-slate-800",
                      )}
                    >
                      By Change
                    </button>
                    <button
                      type="button"
                      onClick={() => switchViewMode("byDocument")}
                      className={cn(
                        "flex-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors",
                        viewMode === "byDocument"
                          ? "bg-foreground text-background shadow-sm"
                          : "text-muted-foreground hover:bg-slate-200 dark:hover:bg-slate-800",
                      )}
                    >
                      By Document
                    </button>
                  </div>
                )}
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
                ) : viewMode === "byDocument" ? (
                  docGroupsRegulatory.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground italic">No affected documents.</div>
                  ) : (
                    docGroupsRegulatory.map((g) => {
                      const key = g.sopId ?? `__nokey_${g.sopTitle}`;
                      const isSelected = selectedId === key;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const approvedCount = g.impacts.filter((i: any) => i.status === "approved").length;
                      const allApproved = approvedCount === g.impacts.length && g.impacts.length > 0;
                      const cleanTitle = (g.sopTitle ?? "").replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const changes = new Set(g.impacts.map((i: any) => i.chapter)).size;
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
                            allApproved && !isSelected && "bg-emerald-50/40 dark:bg-emerald-900/10",
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
                            {g.impacts.length} edit{g.impacts.length !== 1 ? "s" : ""} across {changes} change{changes !== 1 ? "s" : ""}
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
                  sortedChanges.map(c => {
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
              ) : selectedDocGroupRegulatory ? (
                <RegulatoryDocPanel
                  docGroup={selectedDocGroupRegulatory}
                  sopDoc={sopById.get(selectedDocGroupRegulatory.sopId ?? "")}
                  allChanges={allChanges}
                  reportId={reportId}
                />
              ) : selectedChange ? (
                <ChangeDetailPanel
                  change={selectedChange}
                  impacts={impactsForChange(selectedChange.chapter_ref)}
                  oldPolicyName={oldPolicyName}
                  newPolicyName={newPolicyName}
                  reportId={reportId}
                  workspaceId={(report.data as any)?.workspace_id ?? "rmit"}
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

/** Full-screen state shown while a report's analysis runs (or after it fails). */
function RegulatoryAnalyzingView({
  title, progress, failed, onRetry,
}: {
  title: string;
  progress: { done: number; total: number } | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid place-items-center p-8" style={{ minHeight: "calc(100vh - 3.5rem)" }}>
      <div className="w-full max-w-md text-center space-y-6">
        <Link to="/reports" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-3" /> All Analyses
        </Link>

        {failed ? (
          <>
            <div className="size-14 mx-auto rounded-2xl bg-rose-100 text-rose-600 grid place-items-center">
              <AlertTriangle className="size-7" />
            </div>
            <div className="space-y-1">
              <h2 className="font-display font-bold text-lg">Analysis didn't finish</h2>
              <p className="text-sm text-muted-foreground">
                Something interrupted the run for{" "}
                <span className="font-medium text-foreground">{title}</span>. Your document
                is saved — you can try again.
              </p>
            </div>
            <Button onClick={onRetry} className="gap-2">
              <RefreshCw className="size-4" /> Retry analysis
            </Button>
          </>
        ) : (
          <>
            <div className="relative mx-auto w-fit">
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl animate-pulse" />
              <div className="relative size-16 rounded-2xl border bg-card grid place-items-center shadow-sm">
                <Loader2 className="size-8 text-primary animate-spin" strokeWidth={1.75} />
              </div>
            </div>
            <div className="space-y-1">
              <h2 className="font-display font-bold text-lg">Analysing {title}</h2>
              <p className="text-sm text-muted-foreground">
                {total > 0
                  ? "Comparing each internal SOP against the regulation."
                  : "Reading the regulation and gathering internal SOPs…"}
              </p>
            </div>
            {total > 0 && (
              <div className="space-y-2">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs font-semibold text-muted-foreground tabular-nums">
                  {done} of {total} document{total === 1 ? "" : "s"} analysed
                </p>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/70">
              This usually takes a minute or two. You can keep this tab open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function cleanSopTitle(title: string | null | undefined): string {
  if (!title) return "Unknown document";
  return title.replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
}

/** Turns a snake_case event name into a readable phrase ("signed_off" → "Signed off"). */
function humanizeEvent(event: string | null | undefined): string {
  const e = (event ?? "").trim();
  if (!e) return "Event";
  const spaced = e.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Compact audit trail for a report, sourced from the service-role-written
 * workflow_events table. Read with the browser supabase client (any authed user
 * may READ under the role-only RLS). Tolerates an empty or missing table — the
 * strip simply doesn't render when there's nothing to show.
 */
function WorkflowHistory({ reportId }: { reportId: string }) {
  const events = useQuery({
    queryKey: ["workflow_events", reportId],
    queryFn: async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("workflow_events")
        .select("event, from_status, to_status, actor_email, detail, created_at")
        .eq("report_id", reportId)
        .order("created_at", { ascending: false }),
  });

  const rows: any[] = events.data?.data ?? [];
  if (events.isLoading || rows.length === 0) return null;

  return (
    <details className="px-4 sm:px-6 py-1 border-b bg-card/60">
      <summary className="flex items-center gap-2 cursor-pointer select-none text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
        <History className="size-3" /> History
        <span className="font-semibold normal-case tracking-normal text-muted-foreground/70">({rows.length})</span>
      </summary>
      <ul className="mt-2 space-y-1 max-h-44 overflow-y-auto">
        {rows.map((ev, i) => {
          const status =
            ev.from_status && ev.to_status && ev.from_status !== ev.to_status
              ? `${statusMeta(ev.from_status).label} → ${statusMeta(ev.to_status).label}`
              : ev.to_status
                ? statusMeta(ev.to_status).label
                : null;
          return (
            <li key={i} className="flex items-baseline gap-2 text-[11px] leading-snug">
              <span className="font-semibold text-foreground shrink-0">{ev.actor_email ?? "system"}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-foreground/80">{humanizeEvent(ev.event)}</span>
              {status && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-muted-foreground">{status}</span>
                </>
              )}
              <span className="text-muted-foreground/50">·</span>
              <span className="text-muted-foreground tabular-nums shrink-0 ml-auto">
                {ev.created_at ? formatDate(ev.created_at) : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
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
        <li key={i} className="text-sm leading-relaxed">
          <MD>{autoBoldExecBullet(b.trim())}</MD>
        </li>
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
          {changes.length > 0
            ? <>Benchmarked against <span className="font-semibold">{oldPolicyName}</span> · {changes.length} regulatory changes mapped to {totalImpacts} SOP actions</>
            : <>{totalImpacts} SOP amendment{totalImpacts !== 1 ? "s" : ""} identified against this regulation</>}
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

          {/* Coverage warnings — documents that couldn't be fully verified */}
          {Array.isArray(summary.coverage_warnings) && summary.coverage_warnings.length > 0 && (
            <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-2">
                <AlertTriangle className="size-3.5" /> Needs a manual check ({summary.coverage_warnings.length})
              </div>
              <p className="text-xs text-amber-800 dark:text-amber-300/90 mb-2 leading-relaxed">
                These documents reference the form but could not be fully verified automatically — review them by hand to be sure nothing was missed.
              </p>
              <ul className="space-y-1">
                {summary.coverage_warnings.map((c: { title: string; status: string }) => (
                  <li key={c.title} className="text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
                    <span className="font-semibold">{c.title}</span>
                    <span className="text-[10px] uppercase tracking-wide opacity-70">
                      {c.status === "failed" ? "could not analyse" : "no edit produced"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Reviewed & conformant — SOPs analysed with no amendment needed */}
          {Array.isArray(summary.reviewed_clean) && summary.reviewed_clean.length > 0 && (
            <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 mb-2">
                <CheckCircle2 className="size-3.5" /> Reviewed — no amendment needed ({summary.reviewed_clean.length})
              </div>
              <p className="text-xs text-emerald-800 dark:text-emerald-300/90 mb-2 leading-relaxed">
                These documents were analysed against the regulation and are already conformant — no change required.
              </p>
              <ul className="space-y-1">
                {summary.reviewed_clean.map((title: string) => (
                  <li key={title} className="text-xs text-emerald-900 dark:text-emerald-200 font-semibold">{title}</li>
                ))}
              </ul>
            </div>
          )}

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

          {/* Changes table — only when a delta extraction produced changes */}
          {changes.length > 0 && (
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
          )}

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

/** Bold the clause-reference tokens (S 12.1, Appendix 11, Section 17…) so the
 *  reader's eye lands on WHERE in a long clause the obligation sits. */
function boldClauseRefs(text: string): string {
  return String(text ?? "")
    .replace(/\b[SGP] ?\d+\.\d+(?:\([a-z0-9]+\))?/g, (m) => `**${m}**`)
    .replace(/\bAppendix \d+\b/g, (m) => `**${m}**`)
    .replace(/\bSection \d+\b/g, (m) => `**${m}**`);
}

function ChangeDetailPanel({
  change, impacts, oldPolicyName, newPolicyName, reportId, workspaceId, sopById,
}: {
  change: any; impacts: any[]; oldPolicyName: string; newPolicyName: string; reportId: string; workspaceId: string; sopById: Map<string, any>;
}) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const raisePolicyChange = useServerFn(createPolicyChangeReport);
  const nav = useNavigate();
  const isNew = !change.old_requirement || (change.old_requirement as string).toLowerCase().startsWith("n/a");
  const [showFull, setShowFull] = useState(false);
  const [raising, setRaising] = useState(false);

  // Role gate — viewers can't raise a policy change. Mounted-gated so SSR and
  // the first client paint agree before the real role resolves.
  const auth = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const canRaisePolicyChange = mounted && !auth.loading && (auth.role === "member" || auth.role === "super_admin");

  async function handleRaisePolicyChange() {
    if (raising) return;
    setRaising(true);
    try {
      const { reportId: newId } = await raisePolicyChange({
        data: {
          workspace: workspaceId as any,
          title: "Policy change — " + (change.chapter_ref ?? "manual"),
          description: change.change_summary ?? change.summary ?? "",
          sourceChangeId: change.id,
        },
      });
      toast.success("Policy change created");
      nav({ to: "/reports/$reportId", params: { reportId: newId } });
    } catch (e: any) {
      toast.error("Could not raise policy change", { description: e?.message });
    } finally {
      setRaising(false);
    }
  }
  // Amendments with a concrete clause reference are the priority — sort them up,
  // then by confidence. "General"/unanchored impacts fall to the bottom.
  const sortedImpacts = [...impacts].sort((a: any, b: any) => {
    const hasRef = (i: any) => {
      const p = String(i.paragraph ?? "").trim();
      return p && !/^general/i.test(p) ? 1 : 0;
    };
    return hasRef(b) - hasRef(a) || (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
  });

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
        <div className="shrink-0 flex items-center gap-2">
          {change.tone_shift && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border bg-card text-xs font-medium text-muted-foreground">
              <ArrowRightLeft className="size-3 opacity-60" />
              {change.tone_shift}
            </div>
          )}
          {canRaisePolicyChange && (
            <Button
              variant="outline"
              size="sm"
              disabled={raising}
              onClick={handleRaisePolicyChange}
              className="gap-1.5 h-8 text-xs border-primary/30 text-primary hover:bg-primary/5"
              title="Open an internal policy-change workflow seeded from this regulatory change"
            >
              {raising ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldPlus className="size-3.5" />}
              <span className="hidden sm:inline">Raise Policy Change</span>
            </Button>
          )}
        </div>
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

          {/* ── Regulatory text — summary inline, full clause in a popup ── */}
          <div className={cn(
            "rounded-xl border p-4 flex items-start justify-between gap-4",
            isNew
              ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/10"
              : "border-blue-200 bg-blue-50/30 dark:border-blue-800 dark:bg-blue-950/10",
          )}>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                {isNew && <Sparkles className="size-3 text-emerald-600" />}
                {isNew ? "New Obligation" : "What changed"}
              </div>
              <p className="text-sm leading-snug text-foreground/80">
                {change.change_summary || change.chapter_ref}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 h-8 text-xs"
              onClick={() => setShowFull(true)}
            >
              <FileText className="size-3.5" /> View full clause
            </Button>
          </div>

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
                {sortedImpacts.map((imp: any) => (
                  <ImpactCard key={imp.id} imp={imp} sopDoc={sopById.get(imp.sop_id)} onSetStatus={setImpactStatus} />
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      <Dialog open={showFull} onOpenChange={setShowFull}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{change.chapter_ref}</DialogTitle>
          </DialogHeader>
          {isNew ? (
            <div className="text-sm leading-relaxed">
              <div className="text-[10px] font-black uppercase tracking-widest text-emerald-700 mb-2">
                New obligation — introduced in {newPolicyName}
              </div>
              <MD>{boldClauseRefs(change.new_requirement ?? "")}</MD>
            </div>
          ) : (
            <div className="space-y-3 text-sm leading-relaxed">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-rose-700 mb-1">
                  Before · {oldPolicyName}
                </div>
                <div className="rounded-lg border border-rose-100 bg-rose-50/30 dark:bg-rose-950/10 p-3 whitespace-pre-wrap text-foreground/75">
                  <DiffText side="old" oldText={change.old_requirement ?? ""} newText={change.new_requirement ?? ""} />
                </div>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-blue-700 mb-1">
                  After · {newPolicyName}
                </div>
                <div className="rounded-lg border border-blue-100 bg-blue-50/30 dark:bg-blue-950/10 p-3 whitespace-pre-wrap font-medium">
                  <DiffText side="new" oldText={change.old_requirement ?? ""} newText={change.new_requirement ?? ""} />
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Versioned amended-draft copies — collapsible, with Drive links or DOCX download. */
function AmendedDraftPanel({ drafts }: { drafts: any[] }) {
  const [open, setOpen] = useState(false);
  if (!drafts || drafts.length === 0) return null;
  const isDriveUrl = (url: string) =>
    /docs\.google\.com|drive\.google\.com/.test(url ?? "");
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 dark:bg-violet-950/20 dark:border-violet-900 overflow-hidden">
      {/* ── Header / toggle ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-violet-100/50 dark:hover:bg-violet-900/30 transition-colors"
      >
        <FileEdit className="size-3.5 text-violet-700 dark:text-violet-300 shrink-0" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">
          Amended draft copies
        </span>
        <span className="text-[11px] font-normal normal-case text-violet-700/60 dark:text-violet-400/60">
          · {drafts.length} doc{drafts.length !== 1 ? "s" : ""}{open ? " — compare against the original, then sign off" : ""}
        </span>
        <ChevronDown className={cn(
          "size-3.5 text-violet-600 dark:text-violet-400 ml-auto shrink-0 transition-transform duration-200",
          open && "rotate-180"
        )} />
      </button>

      {/* ── Rows ── */}
      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          {drafts.map((d: any, i: number) => {
            const driveOriginal = d.originalUrl && isDriveUrl(d.originalUrl);
            const driveDraft = d.draftUrl && isDriveUrl(d.draftUrl);
            return (
              <div key={i} className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs">
                <span className="font-medium truncate min-w-0">{cleanSopTitle(d.sopTitle)}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-muted-foreground">
                    {d.applied}/{d.impactCount} change{d.impactCount === 1 ? "" : "s"} applied
                  </span>
                  {d.originalUrl && (
                    driveOriginal ? (
                      <a href={d.originalUrl} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline underline-offset-2">
                        <ExternalLink className="size-3 opacity-60" /> Original
                      </a>
                    ) : (
                      <a href={d.originalUrl} download
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline underline-offset-2">
                        <Download className="size-3 opacity-60" /> Original
                      </a>
                    )
                  )}
                  {d.draftUrl && (
                    driveDraft ? (
                      <a href={d.draftUrl} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 font-semibold text-violet-700 dark:text-violet-300 hover:underline underline-offset-2">
                        <ExternalLink className="size-3 opacity-70" /> Amended draft
                      </a>
                    ) : (
                      <a href={d.draftUrl} download
                        className="inline-flex items-center gap-1 font-semibold text-violet-700 dark:text-violet-300 hover:underline underline-offset-2">
                        <Download className="size-3 opacity-70" /> Download draft
                      </a>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ImpactCard({
  imp, sopDoc, onSetStatus,
}: {
  imp: any;
  sopDoc?: { title?: string; file_url?: string | null; drive_view_url?: string | null; doc_type?: string; version?: string; drive_file_id?: string | null; drive_mime_type?: string | null };
  onSetStatus: (id: string, s: "approved" | "rejected" | "routed") => void;
}) {
  const [editMode, setEditMode] = useState(false);
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const writeToDoc = useServerFn(writeImpactToDoc);
  const [editedText, setEditedText] = useState(imp.edited_text ?? imp.replace_text ?? "");
  const [applying, setApplying] = useState<null | "comment" | "insert" | "replace">(null);
  const isFromDrive = !!sopDoc?.drive_file_id;
  const alreadyInserted = !!imp.inserted_at || !!imp.drive_comment_id;

  async function applyToSource(mode: "comment" | "insert" | "replace") {
    if (!isFromDrive || applying) return;
    setApplying(mode);
    try {
      // When the impact has already been applied, send `force` so the server
      // bypasses the alreadyApplied short-circuit and Re-inserts cleanly.
      const r = await writeToDoc({ data: { impactId: imp.id, mode, force: alreadyInserted } });
      const hl = "highlighted" in r && r.highlighted ? " — highlighted in yellow" : "";
      const occ = "occurrences" in r && typeof r.occurrences === "number" && r.occurrences > 1
        ? ` (${r.occurrences} locations)` : "";
      toast.success(
        r.alreadyApplied
          ? "Already applied to the source document"
          : r.method === "comment"
            ? "Comment added to the source document"
            : r.method === "replace"
              ? `Text replaced in the Google Doc${occ}${hl}`
              : `Amendment inserted into the Google Doc${occ}${hl}`,
      );
      qc.invalidateQueries({ queryKey: ["impacts"] });
    } catch (e: any) {
      toast.error(`${mode[0].toUpperCase()}${mode.slice(1)} failed`, { description: e?.message });
    } finally {
      setApplying(null);
    }
  }

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

  const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section" || imp.change_type === "contextual";
  const changeTypeLabel = (imp.change_type as string ?? "review").replace(/_/g, " ");
  const currentStatus: string = imp.status ?? "pending";
  const fileUrl = sopDoc?.drive_view_url ?? sopDoc?.file_url ?? null;
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
          {/* Row 2: location badges (line / page / section / cell description) */}
          {(imp.line_range || imp.page > 0 || imp.paragraph || imp.action_description) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {imp.line_range && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium bg-primary/10 text-primary border border-primary/20">
                  Line {imp.line_range}
                </span>
              )}
              {imp.page > 0 && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                  Page {imp.page}
                </span>
              )}
              {imp.paragraph && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                  {imp.paragraph}
                </span>
              )}
              {imp.action_description && (
                <span className="text-[10px] text-muted-foreground/70">
                  {imp.action_description}
                </span>
              )}
            </div>
          )}
          {/* Why this placement — the AI's rationale for the clause it chose */}
          {imp.justification && (
            <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground mt-1.5">
              <AlertCircle className="size-3 shrink-0 mt-0.5 text-sky-500" />
              <span><span className="font-semibold text-foreground/70">Why here:</span> {imp.justification}</span>
            </div>
          )}
          {/* Row 3: version-skip or other warning */}
          {imp.warning && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
              <span className="mt-0.5 shrink-0">⚠</span>
              <span>{imp.warning}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {typeof imp.confidence === "number" && (
            <Badge variant="outline" className={cn(
              "text-[9px] font-bold tabular-nums",
              imp.confidence >= 90 ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
              imp.confidence >= 70 ? "bg-amber-100 text-amber-800 border-amber-300" :
              "bg-rose-100 text-rose-800 border-rose-300"
            )} title={imp.confidence >= 90 ? "High confidence — eligible for fast-track approval" : "Needs review"}>
              {imp.confidence}% conf
            </Badge>
          )}
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
                  {imp.find_text && !imp.find_text.startsWith("[") ? (
                    <div className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed italic line-clamp-2">
                      "…{imp.find_text.slice(0, 120)}{imp.find_text.length > 120 ? "…" : ""}"
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-muted-foreground">No exact anchor — inserted at the section heading above (highlighted)</div>
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
            {alreadyInserted && (
              <span className="inline-flex items-center gap-1 h-7 px-2 text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 rounded-md">
                <CheckCircle2 className="size-3" /> Applied
              </span>
            )}
            {!alreadyInserted && (
              <Button size="sm" variant="ghost"
                onClick={() => applyToSource("comment")}
                disabled={!isFromDrive || !!applying}
                title={isFromDrive ? "Add this amendment as a comment in the source document" : "This SOP isn't synced from Drive"}
                className="h-7 text-xs gap-1">
                {applying === "comment" ? <Loader2 className="size-3 animate-spin" /> : <MessageSquarePlus className="size-3" />}
                Comment
              </Button>
            )}
            <Button size="sm" variant="ghost"
              onClick={() => applyToSource("insert")}
              disabled={!isFromDrive || !!applying}
              title={isFromDrive ? (alreadyInserted ? "Re-insert the amended text — re-applies to the Google Doc" : "Insert the amended text into the Google Doc, right after the found statement (highlighted)") : "This SOP isn't synced from Drive"}
              className="h-7 text-xs gap-1">
              {applying === "insert" ? <Loader2 className="size-3 animate-spin" /> : <FilePlus2 className="size-3" />}
              {alreadyInserted ? "Re-insert" : "Insert"}
            </Button>
            <Button size="sm" variant="ghost"
              onClick={() => applyToSource("replace")}
              disabled={!isFromDrive || !!applying}
              title={isFromDrive ? (alreadyInserted ? "Re-replace — re-runs the swap in the Google Doc" : "Replace the found text in the Google Doc with the amended text (highlighted)") : "This SOP isn't synced from Drive"}
              className="h-7 text-xs gap-1">
              {applying === "replace" ? <Loader2 className="size-3 animate-spin" /> : <Replace className="size-3" />}
              {alreadyInserted ? "Re-replace" : "Replace"}
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
  const fileUrl = sopDoc?.drive_view_url ?? sopDoc?.file_url ?? null;

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

            {docGroup.impacts.length > 1 && (() => {
              const hasToc = docGroup.impacts.some(
                (i: any) => i.paragraph?.includes("TABLE OF CONTENTS") || i.action_description?.toLowerCase().includes("toc")
              );
              return (
                <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-800 dark:text-blue-300 mb-3">
                  <span className="mt-0.5 shrink-0">ℹ</span>
                  <span>
                    This document has {docGroup.impacts.length} separate change points.
                    {hasToc && " Locations including TOC and section heading entries are content/TOC page changes — confirm all are updated."}
                  </span>
                </div>
              );
            })()}
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
  const writeToDoc = useServerFn(writeImpactToDoc);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "routed" | "rejected">("all");
  const [insertingId, setInsertingId] = useState<string | null>(null);

  async function insertIntoSource(impactId: string) {
    setInsertingId(impactId);
    try {
      const r = await writeToDoc({ data: { impactId, mode: "comment" } });
      toast.success(
        r.alreadyApplied
          ? "Already applied to the source document"
          : "Comment added to the source document",
      );
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
    } catch (e: any) {
      toast.error("Comment failed", { description: e?.message });
    } finally {
      setInsertingId(null);
    }
  }

  async function setStatus(id: string, status: "approved" | "rejected" | "routed") {
    await upd({ data: { id, status } });
    toast.success(`Marked as ${status}`);
    qc.invalidateQueries({ queryKey: ["impacts", reportId] });
  }

  const statusOrder: Record<string, number> = { pending: 0, routed: 1, approved: 2, rejected: 3 };
  // Amendments anchored to a concrete clause reference are the priority — sort
  // them to the top; "General"/unanchored ones fall below.
  const refRank = (i: any) => {
    const p = String(i.paragraph ?? "").trim();
    return p && !/^general/i.test(p) ? 0 : 1;
  };
  const sorted = [...impacts].sort((a, b) => {
    const rA = refRank(a), rB = refRank(b);
    if (rA !== rB) return rA - rB;
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
              const fileUrl = sopDoc?.drive_view_url ?? sopDoc?.file_url ?? null;
              const currentStatus: string = imp.status ?? "pending";
              const meta = changeTypeMeta(imp.change_type);
              const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section" || imp.change_type === "contextual";

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
                      {(() => {
                        const sop = imp.sop_id ? sopById.get(imp.sop_id) : undefined;
                        const fromDrive = !!sop?.drive_file_id;
                        const inserted = !!imp.inserted_at || !!imp.drive_comment_id;
                        return (
                          <button
                            onClick={() => fromDrive && !inserted && insertIntoSource(imp.id)}
                            disabled={!fromDrive || inserted || insertingId === imp.id}
                            title={
                              inserted ? "Already inserted as a comment in source doc"
                              : !fromDrive ? "Source SOP isn't synced from Drive"
                              : "Insert as comment in source doc"
                            }
                            className={cn("p-1.5 rounded transition-colors",
                              inserted
                                ? "text-blue-600 bg-blue-100"
                                : !fromDrive
                                  ? "text-muted-foreground/40 cursor-not-allowed"
                                  : "text-muted-foreground hover:text-blue-600 hover:bg-blue-50"
                            )}
                          >
                            {insertingId === imp.id
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <MessageSquarePlus className="size-3.5" />}
                          </button>
                        );
                      })()}
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

/**
 * Regulatory By-Document panel — shows every amendment hitting one SOP,
 * grouped by their source regulatory change. Mirrors ChangeDetailPanel's
 * status-update pattern and re-uses ImpactCard so the per-impact controls
 * (Approve/Reject/Insert/Re-insert) work identically.
 */
function RegulatoryDocPanel({
  docGroup,
  sopDoc,
  allChanges,
  reportId,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docGroup: { sopId: string | null; sopTitle: string; impacts: any[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sopDoc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allChanges: any[];
  reportId: string;
}) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);

  async function setImpactStatus(id: string, status: "approved" | "rejected" | "routed") {
    try {
      await upd({ data: { id, status } });
      toast.success(`Marked as ${status}`);
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update");
    }
  }

  // Group this doc's impacts by their source change (chapter_ref).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grouped = new Map<string, any[]>();
  for (const imp of docGroup.impacts) {
    const chapter = String(imp.chapter ?? "").trim() || "—";
    if (!grouped.has(chapter)) grouped.set(chapter, []);
    grouped.get(chapter)!.push(imp);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeByChapter = new Map<string, any>();
  for (const c of allChanges) changeByChapter.set(c.chapter_ref, c);

  const cleanTitle = (docGroup.sopTitle ?? "")
    .replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "")
    .trim();
  const fileUrl = sopDoc?.drive_view_url ?? sopDoc?.file_url ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const approvedCount = docGroup.impacts.filter((i: any) => i.status === "approved").length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingCount = docGroup.impacts.filter((i: any) => !i.status || i.status === "pending").length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rejectedCount = docGroup.impacts.filter((i: any) => i.status === "rejected").length;

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      {/* Header */}
      <div>
        {fileUrl ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-base font-bold text-primary hover:underline"
          >
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{cleanTitle}</span>
            <ExternalLink className="size-3 opacity-60 shrink-0" />
          </a>
        ) : (
          <h2 className="text-base font-bold flex items-center gap-1.5">
            <FileText className="size-4" />
            {cleanTitle}
          </h2>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {docGroup.impacts.length} amendment{docGroup.impacts.length !== 1 ? "s" : ""} from{" "}
          {grouped.size} regulatory change{grouped.size !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
          <span>
            <span className="font-black text-emerald-700 tabular-nums">{approvedCount}</span> approved
          </span>
          <span>
            <span className="font-black text-amber-700 tabular-nums">{pendingCount}</span> pending
          </span>
          <span>
            <span className="font-black text-rose-700 tabular-nums">{rejectedCount}</span> rejected
          </span>
        </div>
        {!docGroup.sopId && (
          <p className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
            <AlertTriangle className="size-3.5" /> This SOP isn't in the KB — edits cannot be applied to the source.
          </p>
        )}
      </div>

      {/* Impacts grouped by source change */}
      {[...grouped.entries()].map(([chapter, imps]) => {
        const change = changeByChapter.get(chapter);
        const headline = (change?.change_summary as string)?.trim() || chapter;
        const impactLevel = change?.impact ?? "low";
        return (
          <section key={chapter} className="space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-200 dark:border-slate-700">
              <span
                className={cn(
                  "text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded shrink-0",
                  impactLevel === "high"
                    ? "bg-rose-100 text-rose-700"
                    : impactLevel === "medium"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-emerald-100 text-emerald-700",
                )}
              >
                {impactLevel}
              </span>
              <span className="text-sm font-semibold truncate flex-1">{headline}</span>
              <span className="font-mono text-[10px] text-muted-foreground shrink-0">{chapter}</span>
            </div>
            <div className="space-y-3">
              {imps.map((imp) => (
                <ImpactCard
                  key={imp.id}
                  imp={imp}
                  sopDoc={sopDoc}
                  onSetStatus={setImpactStatus}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
