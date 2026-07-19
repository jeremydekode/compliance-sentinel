import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import {
  runSimplificationReport,
  setSimplificationDecision,
  bulkSetSimplificationDecision,
  applySimplificationReport,
} from "@/lib/compliance.functions";
import { reviewGroup } from "@/lib/simplify";
import type {
  VerifiedAction,
  VerificationStatus,
  ActionDecision,
  ReviewGroup,
} from "@/lib/simplify";
import { formatDate } from "@/lib/format";
import { formatUsd, formatTokens, GEMINI_PRICE, type RunCost } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  FileText,
  Hash,
  Table2,
  Type,
  Sparkles,
  Info,
  Coins,
  ChevronDown,
  Check,
  X,
  Wand2,
  Download,
  ExternalLink,
  Copy,
  Image as ImageIcon,
} from "lucide-react";

export const Route = createFileRoute("/simplify/$reportId")({
  component: SimplifyReportPage,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-10 text-sm text-destructive">{error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-10">Report not found.</div>
    </AppShell>
  ),
});

// ── presentation maps ────────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; classes: string }> = {
  delete_redundant: {
    label: "Remove redundancy",
    classes: "bg-rose-100 text-rose-800 border-rose-200",
  },
  merge: { label: "Merge", classes: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  to_bullets: { label: "To bullets", classes: "bg-sky-100 text-sky-800 border-sky-200" },
  plain_english: {
    label: "Plain English",
    classes: "bg-violet-100 text-violet-800 border-violet-200",
  },
  shorten: { label: "Shorten", classes: "bg-amber-100 text-amber-800 border-amber-200" },
  table_restructure: {
    label: "Restructure table",
    classes: "bg-teal-100 text-teal-800 border-teal-200",
  },
};

/** Edit-type filter tabs for quick navigation. "Streamline" groups the
 *  structural-tightening / de-duplication edit types. */
const EDIT_TABS: { key: string; label: string; types: string[] | null }[] = [
  { key: "all", label: "All", types: null },
  { key: "duplicates", label: "Duplicates", types: ["delete_redundant", "merge"] },
  { key: "streamline", label: "Streamline", types: ["delete_redundant", "merge", "to_bullets"] },
  { key: "shorten", label: "Shorten", types: ["shorten"] },
  { key: "plain_english", label: "Plain English", types: ["plain_english"] },
  { key: "tables", label: "Tables", types: ["table_restructure"] },
];

/** Cross-section de-duplication carries rule "De-duplication". */
const isDedup = (a: { rule?: string }) => a.rule === "De-duplication";

/** Whether an action belongs under a filter tab. De-dup gets its OWN "Duplicates"
 *  tab and is excluded from "Streamline" so the two reading modes stay distinct. */
function inTab(key: string, a: { type: string; rule?: string }): boolean {
  if (key === "all") return true;
  if (key === "duplicates") return isDedup(a);
  if (key === "streamline")
    return !isDedup(a) && ["delete_redundant", "merge", "to_bullets"].includes(a.type);
  const tab = EDIT_TABS.find((t) => t.key === key);
  return tab?.types ? tab.types.includes(a.type) : true;
}

const STATUS_META: Record<VerificationStatus, { label: string; classes: string; dot: string }> = {
  verified: {
    label: "Verified",
    classes: "bg-emerald-100 text-emerald-800 border-emerald-200",
    dot: "bg-emerald-500",
  },
  review: {
    label: "Close match",
    classes: "bg-amber-100 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
  },
  rejected: {
    label: "Not in document",
    classes: "bg-rose-100 text-rose-800 border-rose-200",
    dot: "bg-rose-500",
  },
};

const TILE_TONE: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50/60 text-emerald-700",
  amber: "border-amber-200 bg-amber-50/60 text-amber-700",
  rose: "border-rose-200 bg-rose-50/60 text-rose-700",
};

const GROUP_META: Record<
  ReviewGroup,
  { title: string; subtitle: string; tone: "emerald" | "amber" | "rose" }
> = {
  auto: {
    title: "Auto-accepted",
    subtitle: "Verified against the document and high-confidence (>90%) — applied automatically.",
    tone: "emerald",
  },
  review: {
    title: "Needs review",
    subtitle: "Lower confidence or a close (non-exact) match — accept or reject each one.",
    tone: "amber",
  },
  quarantined: {
    title: "Quarantined",
    subtitle: "Not found in the document — the AI invented these. Never applied.",
    tone: "rose",
  },
};

const GROUP_ORDER: ReviewGroup[] = ["auto", "review", "quarantined"];

// ── page ─────────────────────────────────────────────────────────────────────

function SimplifyReportPage() {
  const { reportId } = Route.useParams();
  const qc = useQueryClient();
  const runSimplify = useServerFn(runSimplificationReport);
  const saveDecision = useServerFn(setSimplificationDecision);
  const bulkDecision = useServerFn(bulkSetSimplificationDecision);
  const applyFn = useServerFn(applySimplificationReport);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [mode, setMode] = useState<"thorough" | "quick">("thorough");
  const [localDecisions, setLocalDecisions] = useState<Record<number, ActionDecision>>({});
  const [openGroups, setOpenGroups] = useState<Record<ReviewGroup, boolean>>({
    auto: false,
    review: true,
    quarantined: false,
  });
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [figuresOpen, setFiguresOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const startedRef = useRef(false);

  const report = useQuery({
    queryKey: ["simplify_report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analysis_reports")
        .select("*")
        .eq("id", reportId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sj = ((report.data as any)?.summary_json ?? {}) as any;
  const actions: VerifiedAction[] = Array.isArray(sj.actions) ? sj.actions : [];

  function decisionOf(index: number, action: VerifiedAction): ActionDecision {
    return localDecisions[index] ?? action.decision ?? "pending";
  }

  async function decide(index: number, action: VerifiedAction, decision: ActionDecision) {
    const prev = decisionOf(index, action);
    if (prev === decision) return;
    setLocalDecisions((d) => ({ ...d, [index]: decision }));
    try {
      await saveDecision({ data: { reportId, index, decision } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setLocalDecisions((d) => ({ ...d, [index]: prev }));
      toast.error("Couldn't save that decision", { description: e?.message });
    }
  }

  async function runAnalysis(runMode?: "thorough" | "quick") {
    setFailed(false);
    setAnalyzing(true);
    startedRef.current = true;
    try {
      // No explicit mode (auto-run) → server uses the report's stored mode.
      const r = await runSimplify({ data: { reportId, ...(runMode ? { mode: runMode } : {}) } });
      setLocalDecisions({}); // decisions are recomputed by the run
      await qc.invalidateQueries({ queryKey: ["simplify_report", reportId] });
      if (r.status !== "ok") setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setAnalyzing(false);
    }
  }

  async function acceptAllPending() {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const r = await bulkDecision({ data: { reportId, decision: "accepted" } });
      setLocalDecisions({}); // server is now the source of truth
      await qc.invalidateQueries({ queryKey: ["simplify_report", reportId] });
      toast.success(`Accepted ${r.changed} edit${r.changed === 1 ? "" : "s"}`);
    } catch (e: any) {
      toast.error("Couldn't accept all", { description: e?.message?.slice(0, 160) });
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyNow() {
    if (applying) return;
    setApplying(true);
    try {
      const r = await applyFn({ data: { reportId } });
      const skipped = r.skipped?.length ?? 0;
      toast.success(`Applied ${r.appliedCount} of ${r.totalAccepted} change${r.totalAccepted === 1 ? "" : "s"}`, {
        description: skipped > 0 ? `${skipped} edit(s) couldn't be located in the document` : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["simplify_report", reportId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't generate amended copy", { description: e?.message?.slice(0, 200) });
    } finally {
      setApplying(false);
    }
  }

  // Reflect the report's last-used mode in the toggle once it loads.
  useEffect(() => {
    if (sj.simplify_mode === "thorough" || sj.simplify_mode === "quick") setMode(sj.simplify_mode);
  }, [sj.simplify_mode]);

  // Auto-run once for a freshly created report.
  useEffect(() => {
    if (startedRef.current) return;
    if (report.isLoading || !report.data) return;
    if (sj.pending_analysis) runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.isLoading, report.data]);

  // ── early returns (no hooks below) ──
  if (report.isLoading) {
    return (
      <AppShell>
        <div className="p-8 space-y-4 animate-pulse">
          <div className="h-4 bg-muted rounded w-32" />
          <div className="h-8 bg-muted rounded w-2/5" />
          <div className="h-24 bg-muted rounded-xl" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 bg-muted rounded-xl" />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }
  if (!report.data) throw notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const title = ((report.data as any).title as string) ?? "Document";
  const runFailed = failed || sj.simplification_status === "failed";

  if (analyzing || (sj.pending_analysis && !startedRef.current)) {
    return (
      <AppShell>
        <SimplifyAnalyzingView title={title} failed={false} error={null} onRetry={runAnalysis} />
      </AppShell>
    );
  }
  if (runFailed) {
    return (
      <AppShell>
        <SimplifyAnalyzingView
          title={title}
          failed
          error={sj.simplification_error ?? null}
          onRetry={runAnalysis}
        />
      </AppShell>
    );
  }

  const structure = sj.structure ?? null;
  const crossCheck = sj.cross_check ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const figureReviews: any[] = Array.isArray(sj.figure_reviews) ? sj.figure_reviews : [];

  // Partition by review group, keeping each action's stored index for decisions.
  const indexed = actions.map((action, index) => ({ action, index }));
  const groups: Record<ReviewGroup, { action: VerifiedAction; index: number }[]> = {
    auto: [],
    review: [],
    quarantined: [],
  };
  for (const item of indexed) groups[reviewGroup(item.action)].push(item);

  const decisions = indexed.map((x) => decisionOf(x.index, x.action));
  const acceptedCount = decisions.filter((d) => d === "accepted").length;
  const pendingCount = decisions.filter((d) => d === "pending").length;
  const rejectedCount = decisions.filter((d) => d === "rejected").length;

  return (
    <AppShell>
      <div className="p-8 max-w-[1400px] mx-auto space-y-6">
        {/* header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to="/reports"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3" /> All documents
            </Link>
            <h1 className="text-3xl font-bold tracking-tight mt-1 truncate">{title}</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Document simplification · verifiable redline — every proposed edit is anchored back to
              the source.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-lg border overflow-hidden text-xs font-medium">
              <button
                type="button"
                onClick={() => setMode("thorough")}
                title="Evaluate every paragraph and table cell — most comprehensive, slower, more API calls."
                className={cn(
                  "px-2.5 py-2 transition-colors",
                  mode === "thorough" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/50",
                )}
              >
                Thorough
              </button>
              <button
                type="button"
                onClick={() => setMode("quick")}
                title="Fast pass — a curated set of high-confidence edits. Far fewer API calls."
                className={cn(
                  "px-2.5 py-2 border-l transition-colors",
                  mode === "quick" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/50",
                )}
              >
                Quick
              </button>
            </div>
            <Button variant="outline" onClick={() => runAnalysis(mode)} className="gap-2">
              <RefreshCw className="size-4" /> Re-run
            </Button>
          </div>
        </div>

        {/* document summary — executive overview of the whole document, up top */}
        {sj.document_summary && (
          <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
            <Card className="p-0 overflow-hidden glass-card">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-9 rounded-lg grid place-items-center shrink-0 border border-violet-200 bg-violet-50/60 text-violet-700">
                      <FileText className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm">Document summary</div>
                      <div className="text-xs text-muted-foreground">
                        What this document covers — at a glance, before the edits.
                      </div>
                    </div>
                  </div>
                  <ChevronDown
                    className={cn("size-4 text-muted-foreground shrink-0 transition-transform", summaryOpen && "rotate-180")}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="border-t border-border/50 px-5 py-4 text-sm leading-relaxed [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_ul]:space-y-1 [&_p]:mb-2 [&_p:last-child]:mb-0">
                  <Markdown>{sj.document_summary}</Markdown>
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}

        {/* provenance strip — cost is intentionally NOT a top-level tile; the
            run cost lives behind the ⓘ on Analysed to keep the surface clean. */}
        <Card className="p-0 overflow-hidden glass-card">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-border/60">
            <Provenance
              icon={<Hash className="size-4" />}
              label="Words"
              value={structure ? num(structure.wordCount) : "—"}
            />
            <Provenance
              icon={<FileText className="size-4" />}
              label="Sections"
              value={structure ? num(structure.sections?.length ?? 0) : "—"}
            />
            <Provenance
              icon={<Table2 className="size-4" />}
              label="Tables"
              value={structure ? num(structure.tableCount) : "—"}
            />
            <Provenance
              icon={<Sparkles className="size-4" />}
              label="Analysed"
              value={sj.last_run_at ? formatDate(sj.last_run_at) : "—"}
              info={sj.cost ? <CostBreakdown cost={sj.cost} /> : undefined}
            />
          </div>
        </Card>

        {/* headline — the three apply groups */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <VerifyTile
            tone="emerald"
            icon={<ShieldCheck className="size-5" />}
            count={groups.auto.length}
            label="Auto-accepted"
            desc="Verified and high-confidence — applied automatically."
          />
          <VerifyTile
            tone="amber"
            icon={<ShieldAlert className="size-5" />}
            count={groups.review.length}
            label="Needs review"
            desc="Lower confidence or a close match — you decide."
          />
          <VerifyTile
            tone="rose"
            icon={<ShieldX className="size-5" />}
            count={groups.quarantined.length}
            label="Quarantined"
            desc="Not in the document — invented by the AI, never applied."
          />
        </div>

        {crossCheck?.unmatchedLabels?.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">{crossCheck.unmatchedLabels.length} action(s)</span>{" "}
              cite a section that does not match any heading in the document:{" "}
              <span className="font-mono">{crossCheck.unmatchedLabels.slice(0, 6).join(", ")}</span>
              {crossCheck.unmatchedLabels.length > 6 && " …"}
            </div>
          </div>
        )}

        {/* triage summary */}
        {actions.length > 0 && (
          <div className="flex items-center gap-5 text-xs text-muted-foreground px-1">
            <span>
              <span className="font-black text-emerald-700 tabular-nums">{acceptedCount}</span> to
              apply
            </span>
            <span>
              <span className="font-black text-amber-700 tabular-nums">{pendingCount}</span> pending
              review
            </span>
            <span>
              <span className="font-black text-rose-700 tabular-nums">{rejectedCount}</span>{" "}
              rejected
            </span>
            {pendingCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={acceptAllPending}
                disabled={bulkBusy}
                className="ml-auto h-7 gap-1.5 text-xs"
              >
                {bulkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Accept all {pendingCount} pending
              </Button>
            )}
          </div>
        )}

        {/* apply — generate the amended copy */}
        {actions.length > 0 && (
          <ApplyCard
            acceptedCount={acceptedCount}
            applying={applying}
            onApply={applyNow}
            apply={sj.apply}
          />
        )}

        {/* review groups with edit-type filter tabs for quick navigation */}
        {actions.length === 0 ? (
          <Card className="p-16 text-center text-sm text-muted-foreground glass-card">
            No simplification actions were produced.
          </Card>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 flex-wrap px-1">
              {EDIT_TABS.map((tab) => {
                const count = indexed.filter((x) => inTab(tab.key, x.action)).length;
                const active = typeFilter === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setTypeFilter(tab.key)}
                    disabled={tab.key !== "all" && count === 0}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5",
                      active ? "bg-violet-600 text-white" : "bg-card border hover:bg-muted/50",
                      tab.key !== "all" && count === 0 && "opacity-40 cursor-default",
                    )}
                  >
                    {tab.label}
                    <span className={cn("tabular-nums text-[11px]", active ? "text-white/80" : "text-muted-foreground")}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            {typeFilter === "duplicates" ? (
              <DedupClusters
                items={indexed.filter((x) => isDedup(x.action))}
                decisionOf={decisionOf}
                onDecide={decide}
              />
            ) : (
              GROUP_ORDER.map((grp) => {
                const items = groups[grp].filter((x) => inTab(typeFilter, x.action));
                if (typeFilter !== "all" && items.length === 0) return null;
                return (
                  <ReviewSection
                    key={grp}
                    group={grp}
                    items={items}
                    open={typeFilter !== "all" ? true : openGroups[grp]}
                    onOpenChange={(o) => setOpenGroups((g) => ({ ...g, [grp]: o }))}
                    decisionOf={decisionOf}
                    onDecide={decide}
                  />
                );
              })
            )}
          </div>
        )}

        {/* figure & chart amendments — distinct from text redlines (applied as Word
            comments); collapsed, at the bottom so the apply flow stays reachable up top */}
        {figureReviews.length > 0 && (
          <Collapsible open={figuresOpen} onOpenChange={setFiguresOpen}>
            <Card className="p-0 overflow-hidden glass-card">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-9 rounded-lg grid place-items-center shrink-0 border border-violet-200 bg-violet-50/60 text-violet-700">
                      <ImageIcon className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm">
                        Figure &amp; chart amendments{" "}
                        <span className="text-muted-foreground font-medium tabular-nums">· {figureReviews.length}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Images can't be redlined — added as Word comments on each figure in the amended copy.
                      </div>
                    </div>
                  </div>
                  <ChevronDown
                    className={cn("size-4 text-muted-foreground shrink-0 transition-transform", figuresOpen && "rotate-180")}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="border-t border-border/50 p-4 space-y-3">
                  {figureReviews.map((f: any, fi: number) => (
                    <div key={fi} className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs space-y-1.5">
                      <div className="font-medium">
                        {f.name || `Figure ${fi + 1}`}
                        {f.figureType ? (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {f.figureType}
                          </span>
                        ) : null}
                      </div>
                      {f.summary ? <div className="text-muted-foreground">{f.summary}</div> : null}
                      <ul className="space-y-1">
                        {(f.suggestions ?? []).map((s: any, si: number) => (
                          <li key={si} className="leading-snug">
                            {s.where ? <span className="text-muted-foreground">[{s.where}] </span> : null}
                            <span className="line-through decoration-rose-400 text-rose-700">{s.current}</span>
                            {" → "}
                            <span className="text-emerald-700">{s.proposed}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}
      </div>
    </AppShell>
  );
}

// ── sub-components ───────────────────────────────────────────────────────────

function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function Provenance({
  icon,
  label,
  value,
  info,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  info?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 flex items-center gap-3">
      <div className="size-9 rounded-lg bg-muted grid place-items-center text-muted-foreground shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-1">
          {label}
          {info && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground/60 hover:text-foreground transition-colors"
                  aria-label={`${label} breakdown`}
                >
                  <Info className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 text-xs">
                {info}
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className="text-lg font-bold tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

/** Popover content: the metered token breakdown behind a run's cost. */
function CostBreakdown({ cost }: { cost: RunCost }) {
  return (
    <div className="space-y-2">
      <div className="font-bold text-sm flex items-center gap-1.5">
        <Coins className="size-3.5 text-violet-600" /> Run cost
      </div>
      <div className="space-y-1 text-muted-foreground">
        <CostRow label="Model" value={cost.model} />
        <CostRow label="Model calls" value={String(cost.calls)} />
        <CostRow
          label={`Input · ${formatTokens(cost.inputTokens)} tokens`}
          value={formatUsd(cost.inputUsd)}
        />
        <CostRow
          label={`Output · ${formatTokens(cost.outputTokens + cost.thinkingTokens)} tokens`}
          value={formatUsd(cost.outputUsd)}
        />
      </div>
      <div className="border-t pt-1.5 flex items-center justify-between font-bold">
        <span>Total</span>
        <span className="tabular-nums">{formatUsd(cost.usd)}</span>
      </div>
      <p className="text-[10px] text-muted-foreground/80 leading-snug pt-1">
        Token counts are exact (from the API). Price assumes {GEMINI_PRICE.model} at $
        {GEMINI_PRICE.inputUsdPer1M}/1M input and ${GEMINI_PRICE.outputUsdPer1M}/1M output —
        editable in pricing.ts.
      </p>
    </div>
  );
}

function CostRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate">{label}</span>
      <span className="font-medium text-foreground tabular-nums shrink-0">{value}</span>
    </div>
  );
}

function VerifyTile({
  tone,
  icon,
  count,
  label,
  desc,
}: {
  tone: string;
  icon: React.ReactNode;
  count: number;
  label: string;
  desc: string;
}) {
  return (
    <Card className={cn("p-5 border", TILE_TONE[tone])}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-3xl font-black tabular-nums">{count}</span>
      </div>
      <div className="font-bold text-sm mt-1 text-foreground">{label}</div>
      <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
    </Card>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApplyResult = any;

/** The "Generate amended copy" card — runs the apply server fn for the accepted
 *  changes and surfaces the result (download link for local, Drive link for Drive),
 *  including a list of any edits the locator couldn't anchor. */
function ApplyCard({
  acceptedCount,
  applying,
  onApply,
  apply,
}: {
  acceptedCount: number;
  applying: boolean;
  onApply: () => void;
  apply: ApplyResult | undefined;
}) {
  const [open, setOpen] = useState(false);
  const disabled = applying || acceptedCount === 0;
  const actionButtons = apply ? (
    <>
      <Button asChild className="gap-2 bg-violet-600 hover:bg-violet-700 text-white">
        <a
          href={apply.kind === "drive" ? apply.driveUrl : apply.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={apply.kind === "local" ? apply.downloadName : undefined}
        >
          {apply.kind === "drive" ? (
            <>
              <ExternalLink className="size-4" /> Open in Drive
            </>
          ) : (
            <>
              <Download className="size-4" /> Download .docx
            </>
          )}
        </a>
      </Button>
      <Button variant="outline" onClick={onApply} disabled={disabled} className="gap-2">
        {applying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        Re-apply
      </Button>
    </>
  ) : (
    <Button onClick={onApply} disabled={disabled} className="gap-2 bg-violet-600 hover:bg-violet-700 text-white">
      {applying ? (
        <>
          <Loader2 className="size-4 animate-spin" /> Generating…
        </>
      ) : (
        <>
          <Wand2 className="size-4" /> Generate amended copy
        </>
      )}
    </Button>
  );

  // Sticky + collapsible: the bar (with the Download/Generate action) stays
  // pinned and visible while you scroll the amendments; details collapse.
  return (
    <Card className="p-0 border-violet-200/60 glass-card sticky top-4 z-20 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <Wand2 className="size-4 text-violet-600 shrink-0" />
          <span className="font-bold text-sm shrink-0">Generate amended copy</span>
          {apply && (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-800 border-emerald-200 font-bold text-[10px] shrink-0">
              Applied {apply.appliedCount}/{apply.totalAccepted}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">
            · {acceptedCount} accepted change{acceptedCount === 1 ? "" : "s"} to apply
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        <div className="flex items-center gap-2 shrink-0">{actionButtons}</div>
      </div>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t bg-muted/10 text-xs space-y-2">
          <p className="text-muted-foreground">
            Applies the <span className="font-bold text-foreground">{acceptedCount}</span> accepted change
            {acceptedCount === 1 ? "" : "s"} to a copy of the source — every replacement highlighted, with a
            Word/Drive comment carrying the original "Before:" text.
          </p>
          {apply?.appliedAt && <div className="text-muted-foreground">Last applied {formatDate(apply.appliedAt)}</div>}
          {apply?.skipped?.length > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground select-none">
                Show {apply.skipped.length} edit(s) the locator couldn't anchor
              </summary>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                {apply.skipped.slice(0, 12).map((s: { reason: string; before?: string }, i: number) => (
                  <li key={i}>
                    "{(s.before ?? "").slice(0, 80)}…" — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function ReviewSection({
  group,
  items,
  open,
  onOpenChange,
  decisionOf,
  onDecide,
}: {
  group: ReviewGroup;
  items: { action: VerifiedAction; index: number }[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  decisionOf: (index: number, action: VerifiedAction) => ActionDecision;
  onDecide: (index: number, action: VerifiedAction, decision: ActionDecision) => void;
}) {
  const meta = GROUP_META[group];
  const icon =
    group === "auto" ? (
      <ShieldCheck className="size-4" />
    ) : group === "review" ? (
      <ShieldAlert className="size-4" />
    ) : (
      <ShieldX className="size-4" />
    );
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Card className="p-0 overflow-hidden glass-card">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full px-6 py-4 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors text-left"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={cn(
                  "size-9 rounded-lg grid place-items-center shrink-0",
                  TILE_TONE[meta.tone],
                )}
              >
                {icon}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-sm">
                  {meta.title}{" "}
                  <span className="text-muted-foreground font-medium tabular-nums">
                    · {items.length}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{meta.subtitle}</div>
              </div>
            </div>
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {items.length === 0 ? (
            <div className="px-6 py-8 text-center text-xs text-muted-foreground border-t border-border/50">
              Nothing in this group.
            </div>
          ) : (
            <div className="divide-y divide-border/50 border-t border-border/50">
              {items.map(({ action, index }) => (
                <ChangeRow
                  key={index}
                  action={action}
                  decision={decisionOf(index, action)}
                  onDecide={(d) => onDecide(index, action, d)}
                />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** Parse a canonical "Section X" from a de-dup rationale — a fallback cluster key
 *  for items produced before the model emitted a `group` topic. */
function dedupSectionKey(rationale?: string): string | null {
  if (!rationale) return null;
  const m = rationale.match(/Section\s+([A-Za-z]?\.?\d[\d.]*)/i);
  return m ? `Section ${m[1].replace(/\.$/, "")}` : null;
}

/** Cross-section duplicates, clustered by topic so related copies sit together —
 *  one glance shows "this content is repeated in N places, kept in its home section". */
function DedupClusters({
  items,
  decisionOf,
  onDecide,
}: {
  items: { action: VerifiedAction; index: number }[];
  decisionOf: (index: number, action: VerifiedAction) => ActionDecision;
  onDecide: (index: number, action: VerifiedAction, decision: ActionDecision) => void;
}) {
  if (items.length === 0) {
    return (
      <Card className="p-12 text-center text-sm text-muted-foreground glass-card">
        No cross-section duplications found.
      </Card>
    );
  }
  // Cluster by topic (the model's `group`); preserve first-seen order.
  const order: string[] = [];
  const byTopic = new Map<string, { action: VerifiedAction; index: number }[]>();
  for (const it of items) {
    const key =
      it.action.group?.trim() || dedupSectionKey(it.action.rationale) || "Other duplications";
    if (!byTopic.has(key)) {
      byTopic.set(key, []);
      order.push(key);
    }
    byTopic.get(key)!.push(it);
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground px-1">
        Same content repeated across sections, grouped by topic — each copy is removed from one
        place and kept in its canonical section.
      </p>
      {order.map((topic) => {
        const members = byTopic.get(topic)!;
        return (
          <Card key={topic} className="p-0 overflow-hidden glass-card">
            <div className="px-5 py-3.5 border-b border-border/60 bg-rose-50/40 flex items-center gap-2.5">
              <div className="size-7 rounded-md grid place-items-center shrink-0 border border-rose-200 bg-white text-rose-600">
                <Copy className="size-3.5" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{topic}</div>
                <div className="text-[11px] text-muted-foreground">
                  {members.length} duplicate cop{members.length > 1 ? "ies" : "y"} — removed, kept in
                  its source section
                </div>
              </div>
            </div>
            <div className="divide-y divide-border/50">
              {members.map(({ action, index }) => (
                <ChangeRow
                  key={index}
                  action={action}
                  decision={decisionOf(index, action)}
                  onDecide={(d) => onDecide(index, action, d)}
                />
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ChangeRow({
  action,
  decision,
  onDecide,
}: {
  action: VerifiedAction;
  decision: ActionDecision;
  onDecide: (d: ActionDecision) => void;
}) {
  // Cross-section de-dup carries rule "De-duplication" — badge it consistently as
  // "Duplicate" so it reads distinct from per-unit, within-sentence "Remove redundancy".
  const tm =
    action.rule === "De-duplication"
      ? { label: "Duplicate", classes: "bg-rose-100 text-rose-800 border-rose-200" }
      : TYPE_META[action.type] ?? {
          label: action.type,
          classes: "bg-muted text-foreground border-border",
        };
  const status = action.verification?.status ?? "review";
  const sm = STATUS_META[status];
  const isDelete = action.type === "delete_redundant";
  const isDedupAction = isDedup(action);
  const locked = status === "rejected"; // quarantined — cannot be accepted

  return (
    <div
      className={cn(
        "px-6 py-5 transition-colors",
        decision === "rejected" ? "bg-muted/20" : "hover:bg-muted/20",
      )}
    >
      <div className={cn(decision === "rejected" && "opacity-60")}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Badge
              variant="outline"
              className={cn("font-bold text-[10px] uppercase tracking-wide", tm.classes)}
            >
              <Type className="size-3 mr-1" />
              {tm.label}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground truncate">
              {action.section || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {typeof action.confidence === "number" && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                conf {action.confidence}%
              </span>
            )}
            <Badge
              variant="outline"
              className={cn("font-bold text-[10px] uppercase tracking-wide", sm.classes)}
            >
              <span className={cn("size-1.5 rounded-full mr-1.5", sm.dot)} />
              {sm.label}
            </Badge>
          </div>
        </div>

        {/* before → after — for de-dup, this reads as "duplicate removed" → "original kept here" */}
        <div className="space-y-2">
          <div className="rounded-lg border border-rose-200/70 bg-rose-50/50 px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest font-black text-rose-700/70 mb-0.5">
              {isDedupAction ? "Duplicate — removed" : "Before"}
            </div>
            <p className="text-sm text-rose-950/80 whitespace-pre-wrap break-words">
              {action.before || "—"}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/50 px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest font-black text-emerald-700/70 mb-0.5 flex items-center gap-1">
              {isDedupAction ? (
                <>
                  <Check className="size-2.5" />
                  Original — kept{action.keptSection ? ` in ${action.keptSection}` : " in source section"}
                </>
              ) : (
                "After"
              )}
            </div>
            {isDedupAction ? (
              action.keptExcerpt ? (
                <p className="text-sm text-emerald-950/80 whitespace-pre-wrap break-words">
                  {action.keptExcerpt}
                </p>
              ) : (
                <p className="text-sm text-emerald-700/70 italic">
                  {action.keptSection
                    ? `Retained in ${action.keptSection}.`
                    : "Retained elsewhere in the document."}
                </p>
              )
            ) : (
              <p className="text-sm text-emerald-950/80 whitespace-pre-wrap break-words">
                {isDelete && !action.after ? (
                  <span className="italic text-emerald-700/60">— clause removed —</span>
                ) : (
                  action.after || "—"
                )}
              </p>
            )}
          </div>
        </div>

        {/* rationale + verifier reason */}
        <div className="mt-2.5 space-y-1">
          {action.rationale && (
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{action.rule || "Reason"}:</span>{" "}
              {action.rationale}
            </p>
          )}
          {action.verification?.reason && (
            <p
              className={cn(
                "text-[11px] flex items-start gap-1",
                status === "rejected"
                  ? "text-rose-700"
                  : status === "review"
                    ? "text-amber-700"
                    : "text-emerald-700",
              )}
            >
              {status === "rejected" ? (
                <ShieldX className="size-3 mt-0.5 shrink-0" />
              ) : status === "review" ? (
                <ShieldAlert className="size-3 mt-0.5 shrink-0" />
              ) : (
                <ShieldCheck className="size-3 mt-0.5 shrink-0" />
              )}
              {action.verification.reason}
            </p>
          )}
        </div>
      </div>

      {/* decision controls */}
      <div className="mt-3 flex items-center gap-2">
        {locked ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700">
            <ShieldX className="size-3.5" /> Quarantined — will not be applied
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onDecide(decision === "accepted" ? "pending" : "accepted")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors",
                decision === "accepted"
                  ? "bg-emerald-600 text-white border-emerald-600"
                  : "bg-card border-border text-emerald-700 hover:bg-emerald-50",
              )}
            >
              <Check className="size-3.5" />
              {decision === "accepted" ? "Accepted" : "Accept"}
            </button>
            <button
              type="button"
              onClick={() => onDecide(decision === "rejected" ? "pending" : "rejected")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors",
                decision === "rejected"
                  ? "bg-rose-600 text-white border-rose-600"
                  : "bg-card border-border text-rose-700 hover:bg-rose-50",
              )}
            >
              <X className="size-3.5" />
              {decision === "rejected" ? "Rejected" : "Reject"}
            </button>
            {decision === "pending" && (
              <span className="text-[11px] font-semibold text-amber-600">
                Awaiting your decision
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SimplifyAnalyzingView({
  title,
  failed,
  error,
  onRetry,
}: {
  title: string;
  failed: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="grid place-items-center p-8" style={{ minHeight: "calc(100vh - 3.5rem)" }}>
      <div className="w-full max-w-md text-center space-y-6">
        <Link
          to="/reports"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3" /> All documents
        </Link>
        {failed ? (
          <>
            <div className="size-14 mx-auto rounded-2xl bg-rose-100 text-rose-600 grid place-items-center">
              <AlertTriangle className="size-7" />
            </div>
            <div className="space-y-1">
              <h2 className="font-bold text-lg">Simplification didn't finish</h2>
              <p className="text-sm text-muted-foreground">
                The run for <span className="font-medium text-foreground">{title}</span> didn't
                complete. Your document is saved — you can try again.
              </p>
              {error && (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-2">
                  {error}
                </p>
              )}
            </div>
            <Button onClick={onRetry} className="gap-2">
              <RefreshCw className="size-4" /> Retry
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
              <h2 className="font-bold text-lg">Simplifying {title}</h2>
              <p className="text-sm text-muted-foreground">
                Reading the document, proposing plain-English edits, and verifying every change
                against the source.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              This usually takes a minute or two. You can keep this tab open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
