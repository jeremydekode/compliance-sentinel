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
import { PdfViewer } from "@/components/pdf-viewer";
import { ExactEditor } from "@/components/onlyoffice-editor";
import { FindingsRail, RestructurePanel, ChangesRail } from "@/components/simplify-findings";
import { AuditHealthDashboard, SimplifyChangesDashboard, RedraftDashboard, FindingsAnalyticsDashboard } from "@/components/simplify-health";
import type { FindingSeverity } from "@/lib/recommend";
import { findingNeedsInput, findingInputSuggestion } from "@/lib/recommend";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  runSimplifyV2Report,
  setSimplificationDecision,
  bulkSetSimplificationDecision,
  applySimplifyV2Report,
  bulkSetV2FindingDecision,
  requestTargetedEdit,
  getRedraftPdf,
  getSourcePdf,
  finalizeEdit,
  buildFinalDocument,
  saveDecisionInputs,
  generateExecSummaryV2,
} from "@/lib/compliance.functions";
import type { Finding } from "@/lib/recommend";
import { SIMPLIFY_TYPE_LABEL } from "@/lib/simplify";
import type { VerifiedAction, ActionDecision } from "@/lib/simplify";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, ArrowRight, Loader2, RotateCcw, Check, X, Sparkles, SearchCheck, FileEdit,
  FileDown, AlertTriangle, Link2Off, Quote, Info, Wand2, PenLine,
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

/**
 * The text to HIGHLIGHT for a change. The change report's "after" is often a
 * description that wraps the real new wording in quotes — e.g.
 *   Consolidate both statements into a single clause: "Trustees shall bill…"
 * Only the quoted clause actually appears in the document, so anchor on that:
 * prefer the longest quoted span; else the text after the last instruction colon;
 * else the whole string.
 */
function editAnchorText(after: unknown): string {
  const s = String(after ?? "").trim();
  if (!s) return "";
  const quoted = [...s.matchAll(/[‘“"']([^’”"']{12,})[’”"']/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted.sort((a, b) => b.length - a.length)[0];
  const afterColon = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1).trim() : s;
  return afterColon.length >= 12 ? afterColon : s;
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
  // "edits" view: which change is selected, and which of the change highlights
  // DocViewer could anchor in the restructured document.
  const [editActiveId, setEditActiveId] = useState<string | null>(null);
  const [editAnchor, setEditAnchor] = useState<Record<string, boolean>>({});
  // Reviewer decisions (findingId → value) for fixes needing a value only the
  // org can supply — entered inline on the finding cards, fed into generation.
  // Persisted to the report as the reviewer types (debounced) so the work
  // survives reloads, sessions, and — via quote matching — re-runs.
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const saveInputsFn = useServerFn(saveDecisionInputs);
  const decisionsHydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);
  function updateDecision(id: string, v: string) {
    setDecisions((d) => {
      const next = { ...d, [id]: v };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveInputsFn({ data: { reportId, inputs: next } }).catch(() => { /* retried on next keystroke */ });
      }, 800);
      return next;
    });
  }
  // "exact" view: the redraft rendered as a real PDF (pdf.js) — faithful to Word.
  const getPdf = useServerFn(getRedraftPdf);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  // Exact PDF of the ORIGINAL source doc — available during review, before any
  // redraft. `docExact` toggles the Document view between the interactive
  // (docx-preview, with clickable finding highlights) and exact (PDF) renders.
  const getSrcPdf = useServerFn(getSourcePdf);
  const [srcPdfUrl, setSrcPdfUrl] = useState<string | null>(null);
  const [srcPdfBusy, setSrcPdfBusy] = useState(false);
  const [docExact, setDocExact] = useState(false);
  // "editor": the exact in-app OnlyOffice editor. Which docx it edits:
  const [editorTarget, setEditorTarget] = useState<"redraft" | "source" | "final">("final");
  const buildFinal = useServerFn(buildFinalDocument);
  const [finalBusy, setFinalBusy] = useState(false);
  // Executive summary — fetched once per mount when the dashboard shows; the
  // server returns the cached copy (zero AI) unless the findings changed.
  const genExec = useServerFn(generateExecSummaryV2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [execSum, setExecSum] = useState<any | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  const execRequested = useRef(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editorDocUrl, setEditorDocUrl] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const finalizeEditFn = useServerFn(finalizeEdit);
  // Each mode LANDS on its dashboard (the management-level view); "review" is
  // the R&E review workspace (exact PDF w/ highlighted amendments + finding
  // cards); "document" is the legacy drill-down; "compare" is the side-by-side;
  // "edits" reviews every change made; "exact" is the faithful PDF render;
  // "editor" is exact editing.
  const [view, setView] = useState<"dashboard" | "review" | "document" | "compare" | "edits" | "exact" | "editor">("dashboard");
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

  // Hydrate saved decision inputs ONCE per mount (locally-typed values win).
  useEffect(() => {
    if (decisionsHydrated.current || !report.data) return;
    decisionsHydrated.current = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = ((report.data as any)?.summary_json?.decisionInputs ?? {}) as Record<string, string>;
    if (Object.keys(saved).length) setDecisions((d) => ({ ...saved, ...d }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.data]);

  // Executive summary: request once when the R&E dashboard first shows.
  // Server-side cache makes repeats free; a fresh generation (~$0.01–0.02)
  // happens only when the finding set changed, and it lands in the cost ledger.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sjNow = ((report.data as any)?.summary_json ?? {}) as Record<string, any>;
    const findingsNow = Array.isArray(sjNow.findings) ? sjNow.findings : [];
    if (execRequested.current || sjNow.workflow_mode !== "recommend_edit" || !findingsNow.length) return;
    execRequested.current = true;
    setExecBusy(true);
    genExec({ data: { reportId } })
      .then((r) => {
        setExecSum(r);
        if (!r.cached) qc.invalidateQueries({ queryKey: ["report", reportId] }); // refresh cost ledger
      })
      .catch(() => { /* summary is decorative — never block the dashboard */ })
      .finally(() => setExecBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.data]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sj = ((report.data as any)?.summary_json ?? {}) as any;
  const workflowMode: string = sj.workflow_mode ?? "simplify";
  const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
  const actions: VerifiedAction[] = Array.isArray(sj.actions) ? sj.actions : [];

  /** Did the run actually land, regardless of what the HTTP call reported?
   *  A long audit can outlive the request (gateway/proxy timeout, dropped
   *  connection) while the server-side run completes and writes its results.
   *  Treating that as a failure told the user "the analysis failed" on a
   *  SUCCESSFUL run — and an obliging re-run billed them for a second audit
   *  they already had. So the report row, not the response, is the source of
   *  truth. */
  async function runLanded(): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from("analysis_reports").select("summary_json").eq("id", reportId).single();
      if (error || !data) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = ((data.summary_json as any) ?? {}) as any;
      return !s.pending_analysis && s.simplification_status === "ok";
    } catch {
      return false;
    }
  }

  async function runAnalysis() {
    setFailed(false);
    setAnalyzing(true);
    startedRef.current = true;
    try {
      const r = await runFn({ data: { reportId } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      if (r.status !== "ok" && !(await runLanded())) setFailed(true);
    } catch {
      if (!(await runLanded())) setFailed(true);
    } finally {
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
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

  // Review-workspace highlights on the EXACT PDF: violet = needs your input,
  // severity colors = AI amendments. Same ids as the finding cards so click
  // syncs both ways.
  const pdfHighlights = useMemo(() => {
    if (workflowMode !== "recommend_edit") return [];
    return findings
      .filter((f) => f.verification?.status !== "rejected")
      .map((f) => {
        const quote = (f.evidence?.[0]?.quote ?? "").trim();
        if (!quote) return null;
        const kind = findingNeedsInput(f)
          ? ("input" as const)
          : ((["critical", "high", "medium", "info"].includes(f.severity) ? f.severity : "medium") as
              "critical" | "high" | "medium" | "info");
        return { id: f.id, text: quote, kind };
      })
      .filter((h): h is { id: string; text: string; kind: "input" | "critical" | "high" | "medium" | "info" } => !!h);
  }, [workflowMode, findings]);

  // Is the cached final document still current? Mirrors the server's basis
  // (accepted ids + effective inputs) so the button can honestly say "opens
  // instantly — no AI" vs "will re-derive (~1–2 min)".
  const finalUpToDate = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basis = (sj.finalDoc as any)?.basis;
    if (!basis || !sj.finalDoc?.url) return false;
    const acceptedF = findings.filter((f) => f.decision === "accepted" && f.verification?.status !== "rejected");
    const ids = acceptedF.map((f) => f.id).sort();
    const saved = (sj.decisionInputs ?? {}) as Record<string, string>;
    const inputs: Record<string, string> = {};
    for (const f of acceptedF) {
      const typed = decisions[f.id]?.trim();
      const sv = saved[f.id]?.trim();
      if (typed) inputs[f.id] = typed;
      else if (sv) inputs[f.id] = sv;
      else if (findingNeedsInput(f)) {
        const s = findingInputSuggestion(f)?.trim();
        if (s) inputs[f.id] = s;
      }
    }
    return JSON.stringify(ids) === JSON.stringify(basis.ids ?? [])
      && JSON.stringify(inputs) === JSON.stringify(basis.inputs ?? {});
  }, [sj.finalDoc, sj.decisionInputs, findings, decisions]);

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

  // Open the EXACT (PDF) view — convert the redraft once (cached), then render
  // it with pdf.js.
  async function openExact() {
    setView("exact");
    if (pdfUrl || (restructure?.pdfUrl && restructure.pdfFromUrl === restructure.downloadUrl)) {
      if (!pdfUrl && restructure?.pdfUrl) setPdfUrl(restructure.pdfUrl);
      return;
    }
    setPdfBusy(true);
    try {
      const r = await getPdf({ data: { reportId } });
      setPdfUrl(r.pdfUrl);
    } catch (e) {
      toast.error("Couldn't build the exact view", { description: (e as Error)?.message });
    } finally {
      setPdfBusy(false);
    }
  }

  // Open the exact in-app editor (OnlyOffice) for a document.
  function openEditor(target: "redraft" | "source" | "final") {
    setEditKey(null);
    setEditorDocUrl(null);
    setEditorTarget(target);
    setView("editor");
  }

  // THE FINAL DOCUMENT: derive one verifiable edit per accepted finding
  // (reviewer decisions baked in), apply them to the ORIGINAL docx as tracked
  // changes + comments, then open the result in the exact editor. Cached
  // server-side; rebuilds only when the accepted set or inputs change.
  async function openFinal() {
    setFinalBusy(true);
    try {
      const typed: Record<string, string> = {};
      for (const [k, v] of Object.entries(decisions)) if (v.trim()) typed[k] = v.trim();
      const r = await buildFinal({ data: { reportId, ...(Object.keys(typed).length ? { userInputs: typed } : {}) } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      const failed = (r.unresolved?.length ?? 0) + (r.skipped?.length ?? 0);
      if (failed > 0) {
        toast.info(`${r.appliedCount} of ${r.totalAccepted} accepted fixes applied as tracked changes`, {
          description: `${failed} need manual attention — the applied ones carry rationale comments in the margin.`,
        });
      }
      openEditor("final");
    } catch (e) {
      toast.error("Couldn't build the final document", { description: (e as Error)?.message });
    } finally {
      setFinalBusy(false);
    }
  }

  // Leave the editor: force-save and WAIT until the file has actually landed in
  // storage, so reopening (or the exact/PDF views) shows the newest version —
  // not the one-behind copy OnlyOffice would otherwise leave mid-save.
  async function closeEditor() {
    if (editKey) {
      setSavingEdit(true);
      try { await finalizeEditFn({ data: { reportId, key: editKey } }); }
      catch { /* proceed regardless */ }
      setSavingEdit(false);
    }
    // Invalidate caches so the exact/PDF/interactive views refetch the new file.
    setSrcPdfUrl(null);
    setPdfUrl(null);
    await qc.invalidateQueries({ queryKey: ["report", reportId] });
    setView("dashboard");
  }

  // Ensure the exact source PDF exists (convert once, cached), then land in the
  // review workspace: exact PDF w/ highlighted amendments + the finding cards.
  async function openReview() {
    setView("review");
    if (srcPdfUrl) return;
    if (sj.sourcePdfUrl && sj.sourcePdfFromUrl === sourceUrl) {
      setSrcPdfUrl(sj.sourcePdfUrl);
      return;
    }
    setSrcPdfBusy(true);
    try {
      const r = await getSrcPdf({ data: { reportId } });
      setSrcPdfUrl(r.pdfUrl);
    } catch (e) {
      // Stay in the review workspace: the PdfViewer shows its error state and
      // the finding cards remain fully usable.
      toast.error("Couldn't build the exact document view", {
        description: (e as Error)?.message,
      });
    } finally {
      setSrcPdfBusy(false);
    }
  }

  // Toggle the Document view between interactive (highlights) and exact (PDF).
  // Converting the source docx once, on first switch to Exact; cached after.
  async function toggleDocExact(exact: boolean) {
    setDocExact(exact);
    if (!exact) return;
    if (srcPdfUrl || (sj.sourcePdfUrl && sj.sourcePdfFromUrl === sourceUrl)) {
      if (!srcPdfUrl && sj.sourcePdfUrl) setSrcPdfUrl(sj.sourcePdfUrl);
      return;
    }
    setSrcPdfBusy(true);
    try {
      const r = await getSrcPdf({ data: { reportId } });
      setSrcPdfUrl(r.pdfUrl);
    } catch (e) {
      toast.error("Couldn't build the exact view", { description: (e as Error)?.message });
      setDocExact(false);
    } finally {
      setSrcPdfBusy(false);
    }
  }

  // Every edit the redraft made — section, before → after, and why. Powers the
  // "Review edits" view: a per-section list plus (best-effort) highlights of the
  // new wording in the restructured document.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeReport: any[] = Array.isArray(restructure?.changeReport) ? restructure.changeReport : [];
  const editHighlights: DocHighlight[] = changeReport
    .map((c, i) => ({ id: String(i), text: editAnchorText(c.after), altText: String(c.before ?? ""), kind: "edit" as const }))
    .filter((h) => h.text.trim().length >= 8 || h.altText.trim().length >= 8);

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
          {(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const log: any[] = Array.isArray(sj.costLog) ? sj.costLog : [];
            const total = log.length ? log.reduce((a, e) => a + (Number(e.usd) || 0), 0) : Number(sj.cost?.usd ?? 0);
            if (!(total > 0)) return null;
            const breakdown = log.length
              ? `Cumulative AI spend — ${log.length} operation(s):\n` + [...log].reverse().map((e) =>
                  `• ${e.op} — $${Number(e.usd).toFixed(2)}${e.at ? ` (${new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : ""}`,
                ).join("\n")
              : "AI cost of the last run (per-operation ledger starts with the next AI operation)";
            return (
              <span
                title={breakdown}
                className="text-[10px] text-muted-foreground inline-flex items-center gap-1 shrink-0 cursor-help"
              >
                <Info className="size-3" /> ${total.toFixed(2)}{log.length > 1 ? ` · ${log.length} ops` : ""}
              </span>
            );
          })()}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {autoStep === "accepting" && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-200 px-2 py-1 text-[11px] font-semibold">
                <Loader2 className="size-3 animate-spin" />
                Pre-selecting verified fixes…
              </span>
            )}
            {reviewReady && !sj.finalDoc?.url && !autoStep && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 text-amber-800 ring-1 ring-amber-200 px-2 py-1 text-[11px] font-semibold">
                Review amendments, then open the Final document
              </span>
            )}
            {/* view toggle: dashboard ↔ review workspace (R&E) / document (simplify) */}
            <div className="flex rounded-lg border overflow-hidden text-[11px] font-medium">
              {(workflowMode === "recommend_edit" ? (["dashboard", "review"] as const) : (["dashboard", "document"] as const)).map((v) => (
                <button
                  key={v}
                  onClick={() => (v === "review" ? openReview() : setView(v))}
                  className={cn(
                    "px-2.5 py-1 transition-colors capitalize",
                    view === v ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/50",
                    v !== "dashboard" && "border-l",
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
            {/* Primary entry point — review & edit the exact document with the AI
                findings as comments. Front-and-centre above the summary. */}
            {workflowMode === "recommend_edit" && (
              <div className={cn("px-6 pt-6 grid gap-3", findings.some((f) => f.decision === "accepted") && "lg:grid-cols-2")}>
                <button
                  onClick={openReview}
                  className="w-full rounded-2xl border-2 border-indigo-300 dark:border-indigo-800 bg-gradient-to-r from-indigo-50 to-fuchsia-50 dark:from-indigo-950/30 dark:to-fuchsia-950/20 p-5 flex items-center gap-4 hover:shadow-md transition-shadow text-left group"
                >
                  <div className="size-12 rounded-xl bg-indigo-600 grid place-items-center shrink-0">
                    <SearchCheck className="size-6 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-bold text-indigo-900 dark:text-indigo-200">Review amendments &amp; inputs</div>
                    <div className="text-sm text-indigo-700/80 dark:text-indigo-300/70">
                      The exact document with all {findings.length} proposed amendment{findings.length === 1 ? "" : "s"} highlighted — areas needing your input in purple. Decide, fill in, then generate.
                    </div>
                  </div>
                  <ArrowRight className="size-5 text-indigo-500 group-hover:translate-x-1 transition-transform shrink-0" />
                </button>
                {findings.some((f) => f.decision === "accepted") && (
                  <button
                    onClick={openFinal}
                    disabled={finalBusy}
                    className="w-full rounded-2xl border-2 border-emerald-300 dark:border-emerald-800 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 p-5 flex items-center gap-4 hover:shadow-md transition-shadow text-left group disabled:opacity-70"
                  >
                    <div className="size-12 rounded-xl bg-emerald-600 grid place-items-center shrink-0">
                      {finalBusy ? <Loader2 className="size-6 text-white animate-spin" /> : <PenLine className="size-6 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-bold text-emerald-900 dark:text-emerald-200">
                        {finalBusy ? "Building final document…" : "Open final document"}
                      </div>
                      <div className="text-sm text-emerald-700/80 dark:text-emerald-300/70">
                        {finalBusy
                          ? "Deriving each accepted fix and applying it to the original as tracked changes — takes 1–2 minutes."
                          : finalUpToDate
                            ? "Up to date — opens instantly, no AI cost. Tracked changes on the original, rationale in comments."
                            : sj.finalDoc?.url
                              ? "Decisions changed since the last build — will re-derive and re-apply (~1–2 min, one AI run)."
                              : "Every accepted fix applied to the ORIGINAL document as Word tracked changes (~1–2 min, one AI run)."}
                      </div>
                    </div>
                    <ArrowRight className="size-5 text-emerald-500 group-hover:translate-x-1 transition-transform shrink-0" />
                  </button>
                )}
              </div>
            )}
            {workflowMode === "simplify" ? (
              <SimplifyChangesDashboard
                reportId={reportId}
                actions={actions}
                structure={sj.structure ?? null}
                sourceUrl={sourceUrl}
                onView={(id) => { setActiveId(id); setView("document"); }}
                onDrill={() => setView("document")}
              />
            ) : workflowMode === "recommend_edit" ? (
              /* Proper landing dashboard: charts + core issues. Triage lives in
                 the review workspace; generation lives in its rail — no
                 duplicated panels or findings lists here. */
              <>
                <FindingsAnalyticsDashboard
                  findings={findings}
                  restructure={restructure}
                  execSummary={execSum ?? sj.execSummary ?? null}
                  execBusy={execBusy}
                  finalDoc={sj.finalDoc ?? null}
                />
                {restructure && (
                  <RedraftDashboard
                    restructure={restructure}
                    findings={findings}
                    structure={sj.structure ?? null}
                    sourceUrl={sourceUrl}
                    onCompare={() => setView("compare")}
                    onDrill={openReview}
                  />
                )}
              </>
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
        ) : view === "edits" && restructure?.downloadUrl ? (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
            {/* restructured document with each edit highlighted */}
            <div className="min-h-0 min-w-0 border-r flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b bg-emerald-50/60 dark:bg-emerald-950/20 shrink-0">
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">Restructured — edits highlighted</span>
                <button onClick={() => setView("dashboard")} className="text-[11px] text-muted-foreground hover:text-foreground">← Back to dashboard</button>
              </div>
              <DocViewer
                fileUrl={restructure.downloadUrl}
                highlights={editHighlights}
                activeId={editActiveId}
                onSelect={setEditActiveId}
                onAnchorStatus={setEditAnchor}
                className="flex-1"
              />
            </div>
            <ChangesRail
              changes={changeReport}
              activeId={editActiveId}
              anchorStatus={editAnchor}
              onSelect={setEditActiveId}
            />
          </div>
        ) : view === "exact" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b bg-emerald-50/60 dark:bg-emerald-950/20 shrink-0">
              <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                Exact document — faithful PDF render (as Word sees it)
              </span>
              <button onClick={() => setView("dashboard")} className="text-[11px] text-muted-foreground hover:text-foreground">← Back to dashboard</button>
            </div>
            {pdfBusy ? (
              <div className="flex-1 grid place-items-center">
                <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  Building the exact PDF… (a few seconds)
                </div>
              </div>
            ) : (
              <PdfViewer fileUrl={pdfUrl} className="flex-1" />
            )}
          </div>
        ) : view === "editor" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
            <div className="flex items-center justify-between px-3 py-1.5 border-b bg-indigo-50/60 dark:bg-indigo-950/20 shrink-0 gap-2">
              <span className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 truncate">
                {editorTarget === "final"
                  ? "Final document — tracked changes on the original · removals struck through · rationale in comments · saves automatically"
                  : editorTarget === "redraft"
                    ? "Restructured draft — rebuilt document · change comments in margin · saves automatically"
                    : "Exact editor — original document · findings as comments · edits save automatically"}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {editorDocUrl && (
                  <a href={editorDocUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1">
                      <FileDown className="size-3" /> Download
                    </Button>
                  </a>
                )}
                <button
                  onClick={closeEditor}
                  disabled={savingEdit}
                  className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {savingEdit ? "Saving…" : "← Back to dashboard"}
                </button>
              </div>
            </div>
            <ExactEditor reportId={reportId} target={editorTarget} onKey={setEditKey} onDocUrl={setEditorDocUrl} className="flex-1" />
            {savingEdit && (
              <div className="absolute inset-0 z-20 grid place-items-center bg-background/70 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Loader2 className="size-4 animate-spin" /> Saving your edits…
                </div>
              </div>
            )}
          </div>
        ) : view === "review" ? (
          /* ── Review workspace: exact PDF w/ highlighted amendments + cards ── */
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="min-h-0 min-w-0 border-r flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/40 shrink-0 gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[11px] font-semibold text-muted-foreground shrink-0">
                    Exact document — amendments highlighted
                  </span>
                  {/* legend */}
                  <div className="hidden md:flex items-center gap-2.5 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-purple-500/60" /> Needs your input</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-red-500/60" /> Critical</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-orange-500/60" /> High</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-amber-500/60" /> Medium</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-sky-400/60" /> Info</span>
                  </div>
                </div>
                <button onClick={() => setView("dashboard")} className="text-[11px] text-muted-foreground hover:text-foreground shrink-0">
                  ← Dashboard
                </button>
              </div>
              {srcPdfBusy ? (
                <div className="flex-1 grid place-items-center">
                  <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                    Building the exact document… (a few seconds, first time only)
                  </div>
                </div>
              ) : (
                <PdfViewer
                  fileUrl={srcPdfUrl}
                  highlights={pdfHighlights}
                  activeId={activeId}
                  onSelect={setActiveId}
                  onAnchorStatus={setAnchorStatus}
                  className="flex-1"
                />
              )}
            </div>

            {/* decision rail: generate at top, finding cards below */}
            <div className="min-h-0 min-w-0 flex flex-col bg-card/30">
              {workflowMode === "recommend_edit" && (
                <RestructurePanel
                  reportId={reportId}
                  findings={findings}
                  restructure={restructure}
                  apply={sj.apply ?? null}
                  comparing={false}
                  onCompareToggle={(on) => setView(on ? "compare" : "review")}
                  onGenerated={() => qc.invalidateQueries({ queryKey: ["report", reportId] })}
                  onApplied={() => qc.invalidateQueries({ queryKey: ["report", reportId] })}
                  onReviewEdits={() => setView("edits")}
                  onExactView={openExact}
                  onEditExact={openFinal}
                  onOpenDraft={() => openEditor("redraft")}
                  decisions={decisions}
                />
              )}
              <div className="flex-1 min-h-0">
                <FindingsRail
                  reportId={reportId}
                  findings={findings}
                  activeId={activeId}
                  anchorStatus={anchorStatus}
                  onSelect={setActiveId}
                  severityFilter={severityFilter}
                  onSeverityFilterChange={setSeverityFilter}
                  decisions={decisions}
                  onDecisionChange={updateDecision}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* document viewer */}
            <div className="min-h-0 min-w-0 border-r flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/40 shrink-0 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-semibold text-muted-foreground shrink-0">Document</span>
                  {/* Interactive (highlights) ⇄ Exact (faithful PDF) toggle */}
                  <div className="inline-flex rounded-md border overflow-hidden shrink-0">
                    <button
                      onClick={() => toggleDocExact(false)}
                      className={cn("px-2 py-0.5 text-[10px] font-semibold transition-colors",
                        !docExact ? "bg-fuchsia-600 text-white" : "text-muted-foreground hover:bg-muted")}
                    >
                      Interactive
                    </button>
                    <button
                      onClick={() => toggleDocExact(true)}
                      className={cn("px-2 py-0.5 text-[10px] font-semibold transition-colors border-l",
                        docExact ? "bg-emerald-600 text-white" : "text-muted-foreground hover:bg-muted")}
                    >
                      Exact
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => openEditor("source")}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
                  >
                    <PenLine className="size-3" /> Edit exact
                  </button>
                  <EditWithAiButton
                    reportId={reportId}
                    workflowMode={workflowMode}
                    onApplied={(id) => setActiveId(id)}
                  />
                </div>
              </div>
              {docExact ? (
                srcPdfBusy ? (
                  <div className="flex-1 grid place-items-center">
                    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                      Building the exact document… (a few seconds)
                    </div>
                  </div>
                ) : (
                  <PdfViewer
                    fileUrl={srcPdfUrl}
                    highlights={pdfHighlights}
                    activeId={activeId}
                    onSelect={setActiveId}
                    onAnchorStatus={setAnchorStatus}
                    className="flex-1"
                  />
                )
              ) : (
                <DocViewer
                  fileUrl={sourceUrl}
                  highlights={highlights}
                  activeId={activeId}
                  onSelect={setActiveId}
                  onAnchorStatus={setAnchorStatus}
                  className="flex-1"
                />
              )}
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
                  {/* Generating the redraft is the PRIMARY action of this mode,
                      so it sits at the top of the rail where it is visible
                      without scrolling. Below the findings list it was pushed
                      off-screen by a long list and overlapped by the Rudy
                      button — reviewers could not find it. */}
                  {workflowMode === "recommend_edit" && (
                    <RestructurePanel
                      reportId={reportId}
                      findings={findings}
                      restructure={restructure}
                      apply={sj.apply ?? null}
                      comparing={view === "compare"}
                      onCompareToggle={(on) => setView(on ? "compare" : "document")}
                      onGenerated={() => qc.invalidateQueries({ queryKey: ["report", reportId] })}
                      onApplied={() => qc.invalidateQueries({ queryKey: ["report", reportId] })}
                        onReviewEdits={() => setView("edits")}
                        onExactView={openExact}
                        onEditExact={openFinal}
                  onOpenDraft={() => openEditor("redraft")}
                        decisions={decisions}
                    />
                  )}
                  <div className="flex-1 min-h-0">
                    <FindingsRail
                      reportId={reportId}
                      findings={findings}
                      activeId={activeId}
                      anchorStatus={anchorStatus}
                      onSelect={setActiveId}
                      severityFilter={severityFilter}
                      onSeverityFilterChange={setSeverityFilter}
                      decisions={decisions}
                      onDecisionChange={updateDecision}
                    />
                  </div>
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

// ── "Edit with AI" — free-text-instruction-driven targeted edit ─────────────
// Distinct from the per-finding pencil edit (which only refines an already-
// discovered finding's fix): this scans the WHOLE document for passages
// relevant to an arbitrary reviewer instruction and proposes new ones,
// running through the same verification gate as the initial audit before
// anything is added to the rail.

function EditWithAiButton({
  reportId, workflowMode, onApplied,
}: {
  reportId: string;
  workflowMode: string;
  onApplied: (id: string) => void;
}) {
  const qc = useQueryClient();
  const editFn = useServerFn(requestTargetedEdit);
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = instruction.trim();
    if (trimmed.length < 3) return;
    setBusy(true);
    try {
      const r = await editFn({ data: { reportId, instruction: trimmed } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      if (workflowMode === "simplify") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idx = (r as any).addedIndexes?.[0];
        if (typeof idx === "number") onApplied(`a-${idx}`);
        toast.success(`Added ${(r as any).addedIndexes?.length ?? 1} suggested edit(s)`, {
          description: "Review it in the rail on the right.",
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = (r as any).addedIds?.[0];
        if (typeof id === "string") onApplied(id);
        toast.success(`Added ${(r as any).addedIds?.length ?? 1} suggested finding(s)`, {
          description: "Review it in the rail on the right.",
        });
      }
      setInstruction("");
      setOpen(false);
    } catch (e) {
      toast.error("Couldn't produce an edit", { description: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={() => setOpen(true)}
      >
        <Wand2 className="size-3 mr-1" /> Edit with AI
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit with AI</DialogTitle>
          <DialogDescription>
            Describe the change you want. The AI scans the whole document for relevant
            passages and proposes edits — every suggestion is verified against the
            document before it's added to the rail.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          placeholder='e.g. "Tighten the indemnity cap to a fixed amount" or "Flag every place that references the old notice period"'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
          rows={4}
          maxLength={2000}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || instruction.trim().length < 3}>
            {busy ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Wand2 className="size-3.5 mr-1.5" />}
            {busy ? "Scanning document…" : "Suggest edit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
