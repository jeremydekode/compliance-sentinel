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
  const applyFn = useServerFn(applySimplificationReport);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [localDecisions, setLocalDecisions] = useState<Record<number, ActionDecision>>({});
  const [openGroups, setOpenGroups] = useState<Record<ReviewGroup, boolean>>({
    auto: false,
    review: true,
    quarantined: false,
  });
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

  async function runAnalysis() {
    setFailed(false);
    setAnalyzing(true);
    startedRef.current = true;
    try {
      const r = await runSimplify({ data: { reportId } });
      setLocalDecisions({}); // decisions are recomputed by the run
      await qc.invalidateQueries({ queryKey: ["simplify_report", reportId] });
      if (r.status !== "ok") setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setAnalyzing(false);
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
          <Button variant="outline" onClick={runAnalysis} className="gap-2 shrink-0">
            <RefreshCw className="size-4" /> Re-run
          </Button>
        </div>

        {/* provenance strip */}
        <Card className="p-0 overflow-hidden glass-card">
          <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-y sm:divide-y-0 divide-border/60">
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
              icon={<Coins className="size-4" />}
              label="Est. cost"
              value={sj.cost ? formatUsd(sj.cost.usd) : "—"}
              info={sj.cost ? <CostBreakdown cost={sj.cost} /> : undefined}
            />
            <Provenance
              icon={<Sparkles className="size-4" />}
              label="Analysed"
              value={sj.last_run_at ? formatDate(sj.last_run_at) : "—"}
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

        {/* the three collapsible review groups */}
        {actions.length === 0 ? (
          <Card className="p-16 text-center text-sm text-muted-foreground glass-card">
            No simplification actions were produced.
          </Card>
        ) : (
          <div className="space-y-3">
            {GROUP_ORDER.map((grp) => (
              <ReviewSection
                key={grp}
                group={grp}
                items={groups[grp]}
                open={openGroups[grp]}
                onOpenChange={(o) => setOpenGroups((g) => ({ ...g, [grp]: o }))}
                decisionOf={decisionOf}
                onDecide={decide}
              />
            ))}
          </div>
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
  const disabled = applying || acceptedCount === 0;
  return (
    <Card className="p-5 border-violet-200/60 glass-card">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1 min-w-[260px]">
          <div className="font-bold text-sm flex items-center gap-2">
            <Wand2 className="size-4 text-violet-600" /> Generate amended copy
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Applies the <span className="font-bold text-foreground">{acceptedCount}</span> accepted
            change{acceptedCount === 1 ? "" : "s"} to a copy of the source — every replacement
            highlighted, with a Word/Drive comment carrying the original "Before:" text.
          </p>
          {apply && (
            <div className="mt-3 text-xs space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className="bg-emerald-50 text-emerald-800 border-emerald-200 font-bold text-[10px]"
                >
                  Applied {apply.appliedCount} / {apply.totalAccepted}
                </Badge>
                {apply.skipped?.length > 0 && (
                  <Badge
                    variant="outline"
                    className="bg-amber-50 text-amber-800 border-amber-200 font-bold text-[10px]"
                  >
                    {apply.skipped.length} skipped
                  </Badge>
                )}
                {apply.appliedAt && (
                  <span className="text-muted-foreground">
                    — {formatDate(apply.appliedAt)}
                  </span>
                )}
              </div>
              {apply.skipped?.length > 0 && (
                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground select-none">
                    Show edits the locator couldn't anchor
                  </summary>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5">
                    {apply.skipped
                      .slice(0, 12)
                      .map((s: { reason: string; before?: string }, i: number) => (
                        <li key={i}>
                          "{(s.before ?? "").slice(0, 80)}…" — {s.reason}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {apply ? (
            <>
              <Button
                asChild
                className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
              >
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
              <Button
                variant="outline"
                onClick={onApply}
                disabled={disabled}
                className="gap-2"
              >
                {applying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Re-apply
              </Button>
            </>
          ) : (
            <Button
              onClick={onApply}
              disabled={disabled}
              className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
            >
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
          )}
        </div>
      </div>
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

function ChangeRow({
  action,
  decision,
  onDecide,
}: {
  action: VerifiedAction;
  decision: ActionDecision;
  onDecide: (d: ActionDecision) => void;
}) {
  const tm = TYPE_META[action.type] ?? {
    label: action.type,
    classes: "bg-muted text-foreground border-border",
  };
  const status = action.verification?.status ?? "review";
  const sm = STATUS_META[status];
  const isDelete = action.type === "delete_redundant";
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

        {/* before → after */}
        <div className="space-y-2">
          <div className="rounded-lg border border-rose-200/70 bg-rose-50/50 px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest font-black text-rose-700/70 mb-0.5">
              Before
            </div>
            <p className="text-sm text-rose-950/80 whitespace-pre-wrap break-words">
              {action.before || "—"}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/50 px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest font-black text-emerald-700/70 mb-0.5">
              After
            </div>
            <p className="text-sm text-emerald-950/80 whitespace-pre-wrap break-words">
              {isDelete && !action.after ? (
                <span className="italic text-emerald-700/60">— clause removed —</span>
              ) : (
                action.after || "—"
              )}
            </p>
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
