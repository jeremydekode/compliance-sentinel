import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AIAssistant } from "@/components/ai-assistant";
import { ApprovalWorkflow } from "@/components/approval-workflow";
import { MD } from "@/components/md";
import { exportExcel, exportHtmlPresentation } from "@/lib/exports";
import { impactClasses, formatDate, statusMeta, changeTypeMeta } from "@/lib/format";
import { updateImpact } from "@/lib/compliance.functions";
import { cn } from "@/lib/utils";
import {
  ArrowLeft, FileSpreadsheet, Presentation, Loader2,
  ArrowRightLeft, CheckCircle2, XCircle, UserCheck,
  Scale, FileText, AlertCircle, Sparkles, ExternalLink,
  ArrowDownToLine, MoveDown, AlertTriangle,
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "gaps">("analysis");
  const [exporting, setExporting] = useState<null | "xlsx" | "html">(null);

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
    queryKey: ["sop_documents_all"],
    queryFn: async () => {
      const { data } = await supabase.from("sop_documents").select("id,title,doc_type,version,file_url");
      return data ?? [];
    },
  });
  const sopById = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of sopsQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [sopsQuery.data]);

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

  const allChanges = changes.data ?? [];
  const allImpacts = impacts.data ?? [];
  const summary = (report.data.summary_json ?? {}) as any;
  const oldPolicyName: string = summary.old_policy_name ?? "Previous version";
  const newPolicyName: string = report.data.policy_name ?? "Updated policy";
  const s = statusMeta(report.data.status);

  const selectedChange = allChanges.find(c => c.id === selectedId) ?? allChanges[0] ?? null;

  const impactsForChange = (chapter_ref: string) =>
    allImpacts.filter(i => (i.chapter ?? "").trim().toLowerCase() === (chapter_ref ?? "").trim().toLowerCase());

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
              {tab === "analysis" ? `Change Analysis (${allChanges.length})` : `SOP Gap Register (${allImpacts.length})`}
            </button>
          ))}
        </div>

        {/* ── Main area ─────────────────────────────────────────────── */}
        {activeTab === "analysis" ? (
          <div className="flex-1 flex min-h-0 overflow-hidden">

            {/* ── Left: Change Register ─────────────────────────────── */}
            <div className="w-64 lg:w-72 shrink-0 border-r flex flex-col overflow-hidden bg-slate-50/60 dark:bg-slate-900/30">
              {/* Stats bar */}
              <div className="px-3 py-2.5 border-b bg-card grid grid-cols-3 gap-1 text-center">
                <StatPill label="High" count={counts.high} color="text-rose-600" />
                <StatPill label="Med" count={counts.medium} color="text-amber-600" />
                <StatPill label="Low" count={counts.low} color="text-emerald-600" />
              </div>
              {/* Executive summary mini */}
              {summary.executive && (
                <div className="px-3 py-2.5 border-b text-[10px] text-muted-foreground leading-relaxed line-clamp-2">
                  {summary.executive}
                </div>
              )}
              {/* Change list */}
              <div className="flex-1 overflow-y-auto">
                {allChanges.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground italic">No changes extracted.</div>
                ) : (
                  allChanges.map(c => {
                    const isSelected = (selectedId ?? allChanges[0]?.id) === c.id;
                    const isNew = !c.old_requirement || (c.old_requirement as string).toLowerCase().startsWith("n/a");
                    const changeImpacts = impactsForChange(c.chapter_ref);
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "w-full text-left px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 transition-all",
                          "hover:bg-white dark:hover:bg-slate-800/60",
                          isSelected
                            ? "bg-white dark:bg-slate-800 border-l-[3px] border-l-primary shadow-sm"
                            : "border-l-[3px] border-l-transparent"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-mono text-[11px] font-bold text-foreground/90 truncate">{c.chapter_ref}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {changeImpacts.length > 0 && (
                              <span className="text-[8px] font-bold bg-primary/10 text-primary px-1 py-0.5 rounded">{changeImpacts.length}</span>
                            )}
                            <span className={cn(
                              "text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
                              c.impact === "high" ? "bg-rose-100 text-rose-700" :
                              c.impact === "medium" ? "bg-amber-100 text-amber-700" :
                              "bg-emerald-100 text-emerald-700"
                            )}>{c.impact}</span>
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{c.change_summary}</p>
                        {isNew && (
                          <span className="mt-1 inline-flex items-center gap-1 text-[9px] font-semibold text-emerald-600">
                            <Sparkles className="size-2.5" /> New obligation
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* ── Right: Change Detail ──────────────────────────────── */}
            <div className="flex-1 overflow-y-auto bg-background">
              {selectedChange ? (
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
                  Select a change from the register on the left.
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

      <AIAssistant reportId={reportId} />
    </AppShell>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanSopTitle(title: string | null | undefined): string {
  if (!title) return "Unknown document";
  return title.replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
                <div className="p-5 text-sm leading-relaxed text-foreground/70 bg-rose-50/20 dark:bg-rose-950/10 min-h-[100px]">
                  {change.old_requirement}
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
                <div className="p-5 text-sm leading-relaxed font-medium bg-blue-50/20 dark:bg-blue-950/10 min-h-[100px]">
                  <MD>{change.new_requirement}</MD>
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
        <div className="min-w-0 flex-1">
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
          {(imp.paragraph || (imp.page && imp.page > 0)) && (
            <div className="text-[11px] text-muted-foreground mt-0.5 font-mono flex items-center gap-1.5">
              {imp.paragraph && <span>{imp.paragraph}</span>}
              {imp.page > 0 && <span className="text-muted-foreground/60">· p.{imp.page}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[9px] font-bold uppercase tracking-wide">{changeTypeLabel}</Badge>
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
                  Find — current text to replace
                </div>
                <div className="text-xs leading-relaxed bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/40 p-3 rounded-lg font-mono text-foreground/75">
                  {imp.find_text}
                </div>
              </div>
            )}
            {/* Replace */}
            <div>
              <div className="text-[9px] uppercase tracking-widest font-black text-blue-600 dark:text-blue-400 mb-1.5">
                Replace with — amended text
              </div>
              {editMode ? (
                <textarea
                  className="w-full text-xs font-mono p-3 rounded-lg border bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px]"
                  value={editedText}
                  onChange={e => setEditedText(e.target.value)}
                />
              ) : (
                <div className="text-xs leading-relaxed bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-3 rounded-lg font-mono text-foreground/90">
                  {imp.edited_text ?? imp.replace_text}
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
                    {imp.paragraph && (
                      <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">{imp.paragraph}</div>
                    )}
                    {isInsertion && imp.find_text && (
                      <div className="mt-1 text-[10px] text-muted-foreground italic truncate">
                        After: "…{imp.find_text.slice(0, 60)}{imp.find_text.length > 60 ? "…" : ""}"
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
