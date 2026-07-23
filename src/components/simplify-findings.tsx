// ============================================================================
// SIMPLIFY V2 — findings rail + restructure panel.
// The right-hand review rail for Recommendation / Recommend & Edit reports:
// severity-sorted finding cards with verbatim evidence, Accept/Dismiss, bulk
// actions, honest verified-only counts, and (recommend_edit) the stage-gated
// "Generate restructured document" panel with change report + content-
// preservation results.
// ============================================================================

import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import {
  setV2FindingDecision,
  bulkSetV2FindingDecision,
  generateRestructuredV2Document,
  applyFindingsInPlaceV2Report,
  resolveRedraftPlaceholders,
} from "@/lib/compliance.functions";
import { FINDING_CATEGORY_META, findingNeedsInput, findingInputLabel, findingInputSuggestion, type Finding, type FindingSeverity } from "@/lib/recommend";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Check, X, RotateCcw, AlertTriangle, AlertOctagon, Info, CircleAlert,
  Loader2, FileDown, Sparkles, Quote, Link2Off, ShieldCheck, ChevronDown, PenLine, FileText,
} from "lucide-react";

// ── severity presentation ────────────────────────────────────────────────────

const SEVERITY_META: Record<FindingSeverity, { label: string; icon: React.ElementType; chip: string }> = {
  critical: { label: "Critical", icon: AlertOctagon, chip: "bg-red-100 text-red-700 ring-red-200" },
  high:     { label: "High",     icon: AlertTriangle, chip: "bg-orange-100 text-orange-700 ring-orange-200" },
  medium:   { label: "Medium",   icon: CircleAlert, chip: "bg-amber-100 text-amber-700 ring-amber-200" },
  info:     { label: "Info",     icon: Info, chip: "bg-blue-100 text-blue-700 ring-blue-200" },
};

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "info"];

function SeverityChip({ severity }: { severity: FindingSeverity }) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1", meta.chip)}>
      <Icon className="size-3" /> {meta.label}
    </span>
  );
}

function CategoryChip({ category }: { category: Finding["category"] }) {
  const meta = FINDING_CATEGORY_META[category];
  return (
    <span
      title={meta?.hint}
      className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border"
    >
      {meta?.label ?? category}
    </span>
  );
}

// ── one finding card ─────────────────────────────────────────────────────────

function FindingCard({
  finding, active, anchored, busy, onSelect, onDecide, decisionValue, onDecisionChange,
}: {
  finding: Finding;
  active: boolean;
  anchored: boolean | undefined;
  busy: boolean;
  onSelect: () => void;
  onDecide: (decision: Finding["decision"]) => void;
  /** For fixes needing a value only the org can supply — the reviewer's input,
   *  fed into the redraft. Present only when the parent wires it up. */
  decisionValue?: string;
  onDecisionChange?: (value: string) => void;
}) {
  const needsInput = !!onDecisionChange && findingNeedsInput(finding);
  const quarantined = finding.verification.status === "rejected";
  const decided = finding.decision !== "pending";
  return (
    <div
      onClick={onSelect}
      className={cn(
        "rounded-xl border bg-card p-3 space-y-2 cursor-pointer transition-colors",
        active ? "border-primary ring-1 ring-primary/30" : "hover:border-primary/40",
        quarantined && "opacity-60",
        finding.decision === "accepted" && "border-emerald-300 bg-emerald-50/40",
        finding.decision === "dismissed" && "border-border bg-muted/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityChip severity={finding.severity} />
        <CategoryChip category={finding.category} />
        {finding.source === "deterministic" && (
          <span title="Found by exact document scanning, not AI" className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
            <ShieldCheck className="size-3" /> Exact
          </span>
        )}
        {anchored === false && !quarantined && (
          <span title="Couldn't locate this text in the rendered document — review from the quotes below" className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">
            <Link2Off className="size-3" /> No anchor
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">{finding.id}</span>
      </div>

      <div className="text-sm font-semibold leading-snug">{finding.title}</div>
      {finding.description && (
        <p className="text-xs text-muted-foreground leading-relaxed">{finding.description}</p>
      )}

      <div className="space-y-1.5">
        {finding.evidence.map((e, i) => (
          <div key={i} className="rounded-lg bg-muted/60 border border-border/60 px-2.5 py-1.5">
            <div className="text-[10px] font-medium text-muted-foreground mb-0.5 flex items-center gap-1">
              <Quote className="size-3" /> {e.section}
            </div>
            <div className="text-xs italic leading-relaxed">“{e.quote}”</div>
          </div>
        ))}
      </div>

      {finding.suggestedFix && (
        <div className="rounded-lg bg-primary/5 border border-primary/15 px-2.5 py-1.5">
          <div className="text-[10px] font-semibold text-primary mb-0.5">Suggested fix</div>
          <div className="text-xs leading-relaxed">{finding.suggestedFix}</div>
        </div>
      )}

      {needsInput && !quarantined && (
        <div className="rounded-lg border border-amber-300/70 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
          <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <PenLine className="size-3" /> Your decision — {findingInputLabel(finding)}
          </div>
          <textarea
            value={decisionValue ?? findingInputSuggestion(finding)}
            onChange={(e) => onDecisionChange?.(e.target.value)}
            placeholder={findingInputSuggestion(finding) || "Enter value…"}
            rows={Math.min(6, Math.max(1, Math.ceil((decisionValue ?? findingInputSuggestion(finding)).length / 42)))}
            className="w-full rounded-md border bg-background px-2 py-1 text-[12px] leading-snug resize-y focus:outline-none focus:ring-2 focus:ring-amber-500/30"
          />
          <p className="text-[9px] text-amber-700/70 dark:text-amber-400/70">Applied to this fix when you Generate redraft. Leave blank to have the draft flag it instead.</p>
        </div>
      )}

      {quarantined ? (
        <div className="text-[11px] text-muted-foreground italic">
          Quarantined — {finding.verification.note ?? "evidence not found in the document."}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
          {!decided ? (
            <>
              <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => onDecide("accepted")}>
                <Check className="size-3.5 mr-1" /> Accept
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => onDecide("dismissed")}>
                <X className="size-3.5 mr-1" /> Dismiss
              </Button>
            </>
          ) : (
            <>
              <span className={cn("text-[11px] font-medium", finding.decision === "accepted" ? "text-emerald-700" : "text-muted-foreground")}>
                {finding.decision === "accepted" ? "Accepted" : "Dismissed"}
              </span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground" disabled={busy} onClick={() => onDecide("pending")}>
                <RotateCcw className="size-3 mr-1" /> Undo
              </Button>
            </>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">{finding.confidence}%</span>
        </div>
      )}
    </div>
  );
}

// ── findings rail ────────────────────────────────────────────────────────────

export function FindingsRail({
  reportId, findings, activeId, anchorStatus, onSelect,
  severityFilter: severityFilterProp, onSeverityFilterChange,
  decisions, onDecisionChange,
}: {
  reportId: string;
  findings: Finding[];
  activeId: string | null;
  anchorStatus: Record<string, boolean>;
  onSelect: (id: string | null) => void;
  /** Optionally controlled from outside (the health dashboard's tiles drill
   *  into the document view pre-filtered to a severity). */
  severityFilter?: FindingSeverity | "all";
  onSeverityFilterChange?: (s: FindingSeverity | "all") => void;
  /** Reviewer decisions (findingId → value) for input-needing fixes, edited
   *  inline on each card and fed into the redraft. */
  decisions?: Record<string, string>;
  onDecisionChange?: (findingId: string, value: string) => void;
}) {
  const qc = useQueryClient();
  const setDecision = useServerFn(setV2FindingDecision);
  const bulkDecision = useServerFn(bulkSetV2FindingDecision);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [severityFilterLocal, setSeverityFilterLocal] = useState<FindingSeverity | "all">("all");
  const severityFilter = severityFilterProp ?? severityFilterLocal;
  const setSeverityFilter = onSeverityFilterChange ?? setSeverityFilterLocal;

  const live = findings.filter((f) => f.verification.status !== "rejected");
  const quarantined = findings.filter((f) => f.verification.status === "rejected");
  const pending = live.filter((f) => f.decision === "pending");
  const accepted = live.filter((f) => f.decision === "accepted");

  const visible = useMemo(
    () => (severityFilter === "all" ? live : live.filter((f) => f.severity === severityFilter)),
    [live, severityFilter],
  );

  async function decide(findingId: string, decision: Finding["decision"]) {
    setBusyId(findingId);
    try {
      await setDecision({ data: { reportId, findingId, decision } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
    } catch (e) {
      toast.error("Could not save decision", { description: (e as Error)?.message });
    } finally {
      setBusyId(null);
    }
  }

  async function bulk(decision: "accepted" | "dismissed", ids?: string[]) {
    setBusyId("__bulk__");
    try {
      const r = await bulkDecision({ data: { reportId, decision, findingIds: ids } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      toast.success(`${r.changed} finding(s) ${decision}`);
    } catch (e) {
      toast.error("Bulk update failed", { description: (e as Error)?.message });
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    const c: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
    for (const f of live) c[f.severity]++;
    return c;
  }, [live]);

  return (
    <div className="flex flex-col h-full">
      {/* header: honest counts + severity filter */}
      <div className="px-3 pt-3 pb-2 border-b space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">
            {live.length} finding{live.length === 1 ? "" : "s"}
            <span className="text-muted-foreground font-normal"> · {accepted.length} accepted · {pending.length} open</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setSeverityFilter("all")}
            className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition-colors",
              severityFilter === "all" ? "bg-primary text-primary-foreground ring-primary" : "bg-muted text-muted-foreground ring-border hover:text-foreground")}
          >
            All
          </button>
          {SEVERITY_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => setSeverityFilter(severityFilter === s ? "all" : s)}
              className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition-colors",
                severityFilter === s ? SEVERITY_META[s].chip : "bg-muted text-muted-foreground ring-border hover:text-foreground")}
            >
              {SEVERITY_META[s].label} {counts[s]}
            </button>
          ))}
        </div>
        {pending.length > 0 && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busyId !== null}
              onClick={() => bulk("accepted", pending.map((f) => f.id))}>
              <Check className="size-3 mr-1" /> Accept all open
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground" disabled={busyId !== null}
              onClick={() => bulk("dismissed", pending.map((f) => f.id))}>
              <X className="size-3 mr-1" /> Dismiss all open
            </Button>
          </div>
        )}
      </div>

      {/* cards — pb-20 keeps the last card clear of the floating Ask Rudy
          button, which is fixed to the bottom-right and would otherwise sit
          on top of it. */}
      <div className="flex-1 overflow-y-auto p-3 pb-20 space-y-2.5">
        {visible.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            {live.length === 0 ? "No verified findings — the document audit came back clean." : "No findings at this severity."}
          </p>
        )}
        {visible.map((f) => (
          <FindingCard
            key={f.id}
            finding={f}
            active={activeId === f.id}
            anchored={anchorStatus[f.id]}
            busy={busyId !== null}
            onSelect={() => onSelect(activeId === f.id ? null : f.id)}
            onDecide={(d) => decide(f.id, d)}
            decisionValue={decisions?.[f.id]}
            onDecisionChange={onDecisionChange ? (v) => onDecisionChange(f.id, v) : undefined}
          />
        ))}
        {quarantined.length > 0 && (
          <QuarantineGroup findings={quarantined} />
        )}
      </div>
    </div>
  );
}

function QuarantineGroup({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-2 border-t">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground py-1">
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        Quarantined ({findings.length}) — evidence not verifiable, never counted
      </button>
      {open && (
        <div className="space-y-2 mt-1">
          {findings.map((f) => (
            <div key={f.id} className="rounded-lg border bg-muted/40 p-2.5 opacity-70">
              <div className="flex items-center gap-1.5 mb-1">
                <SeverityChip severity={f.severity} />
                <CategoryChip category={f.category} />
              </div>
              <div className="text-xs font-medium">{f.title}</div>
              <div className="text-[11px] text-muted-foreground italic mt-0.5">{f.verification.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── restructure panel (Recommend & Edit stage 2) ─────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function RestructurePanel({
  reportId, findings, restructure, apply, onGenerated, onApplied, onCompareToggle, comparing, onReviewEdits, onExactView, onEditExact, onOpenDraft, decisions,
}: {
  reportId: string;
  findings: Finding[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restructure: any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: any | null;
  onGenerated: () => void;
  onApplied: () => void;
  onCompareToggle: (on: boolean) => void;
  comparing: boolean;
  /** Open the "Review edits" view (present only in the document-view rail). */
  onReviewEdits?: () => void;
  /** Open the EXACT (PDF) render of the redraft. */
  onExactView?: () => void;
  /** Open the FINAL DOCUMENT (tracked changes on the original). */
  onEditExact?: () => void;
  /** Open the generated redraft in the exact editor. */
  onOpenDraft?: () => void;
  /** Reviewer decisions (findingId → value) entered inline on the finding cards,
   *  passed into generation so the redraft bakes them in. */
  decisions?: Record<string, string>;
}) {
  const generate = useServerFn(generateRestructuredV2Document);
  const applyInPlace = useServerFn(applyFindingsInPlaceV2Report);
  const [running, setRunning] = useState<null | "redraft" | "apply">(null);
  const accepted = findings.filter(
    (f) => f.decision === "accepted" && f.verification.status !== "rejected",
  );
  // Accepted findings whose fix needs a value only the org can decide (an
  // acronym's full form, an owner…). The reviewer fills these inline on the
  // finding cards; here we just count the unfilled ones as a nudge.
  const decisionFindings = accepted.filter(findingNeedsInput);
  const decisionValue = (f: Finding) => decisions?.[f.id] ?? findingInputSuggestion(f);
  const unfilled = decisionFindings.filter((f) => !decisionValue(f).trim()).length;

  async function run() {
    setRunning("redraft");
    try {
      const userInputs: Record<string, string> = {};
      for (const f of decisionFindings) {
        const v = decisionValue(f).trim();
        if (v) userInputs[f.id] = v;
      }
      await generate({ data: { reportId, ...(Object.keys(userInputs).length ? { userInputs } : {}) } });
      toast.success("Restructured document generated");
      onGenerated();
    } catch (e) {
      toast.error("Generation failed", { description: (e as Error)?.message });
    } finally {
      setRunning(null);
    }
  }

  async function runApply(exportMode: "clean" | "annotated") {
    setRunning("apply");
    try {
      const r = await applyInPlace({ data: { reportId, exportMode } });
      const skippedTotal = (r.skipped?.length ?? 0) + (r.ineligible?.length ?? 0);
      toast.success(`Applied ${r.appliedCount}/${r.totalAccepted} accepted finding(s) in place`, {
        description: skippedTotal > 0 ? `${skippedTotal} need manual review — see below.` : "Original formatting preserved exactly.",
      });
      onApplied();
    } catch (e) {
      toast.error("Apply failed", { description: (e as Error)?.message });
    } finally {
      setRunning(null);
    }
  }

  const preservation = restructure?.preservation;
  const pct = preservation?.sourceClaims
    ? Math.round((preservation.preserved / preservation.sourceClaims) * 100)
    : null;
  const needsReview = [...(apply?.ineligible ?? []), ...(apply?.skipped ?? [])];

  return (
    <TooltipProvider delayDuration={150}>
      {/* Compact toolbar: two primary actions with their explanations moved to
          tooltips, and all results/downloads folded into a small strip — so the
          panel no longer freezes half the rail and the findings list keeps the
          room to review. */}
      <div className="border-b bg-card/60 px-3 py-2 space-y-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-[13px] font-semibold">Apply accepted fixes</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="How the two modes differ">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px] text-[11px] leading-relaxed">
              Two ways to apply the same accepted findings. <b>Apply in place</b> keeps the original file exact and only swaps changed sentences. <b>Generate redraft</b> rebuilds the body (can reorganise/insert) but you'll re-apply fine layout before issuing.
            </TooltipContent>
          </Tooltip>
          <span className="ml-auto text-[11px] text-muted-foreground">{accepted.length} accepted</span>
        </div>

        {/* Nudge: the actual inputs live on the finding cards below; here we just
            flag how many still need a decision before generating. */}
        {decisionFindings.length > 0 && (
          <div className="rounded-lg border border-amber-300/70 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-1.5 flex items-start gap-1.5">
            <PenLine className="size-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <p className="text-[10px] text-amber-800/90 dark:text-amber-300/90 leading-relaxed">
              {unfilled > 0
                ? <><b>{unfilled} of {decisionFindings.length} fixes need a decision.</b> Fill each finding's amber "Your decision" box below (a suggestion is pre-filled), then Generate — the redraft bakes them in. Leave one blank and the draft flags it instead.</>
                : <>All {decisionFindings.length} decision{decisionFindings.length !== 1 ? "s" : ""} filled — Generate redraft applies them.</>}
            </p>
          </div>
        )}

        <div className="flex gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" className="flex-1 h-8 text-xs gap-1.5" variant={apply ? "outline" : "default"}
                disabled={accepted.length === 0 || running !== null} onClick={() => runApply("clean")}>
                {running === "apply" ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
                {apply ? "Re-apply in place" : "Apply in place"}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
              Swaps each finding's quoted text for its fix directly in the original file — exact original styling, headers and layout preserved. Findings that insert new content or span multiple locations are skipped and listed for manual review, never guessed at.
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" className="flex-1 h-8 text-xs gap-1.5" variant={restructure ? "outline" : "default"}
                disabled={accepted.length === 0 || running !== null} onClick={run}>
                {running === "redraft" ? <Loader2 className="size-3.5 animate-spin" /> : restructure ? <RotateCcw className="size-3.5" /> : <Sparkles className="size-3.5" />}
                {running === "redraft" ? "Generating…" : restructure ? "Regenerate redraft" : "Generate redraft"}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
              Rebuilds the document body with every accepted fix applied, carrying over the template, headers, footers, tables and figures. The body is regenerated, so expect to re-apply house numbering and fine layout before issuing. Every source claim is checked against the output; losses are reported, never hidden.
            </TooltipContent>
          </Tooltip>
        </div>
        {accepted.length === 0 && (
          <p className="text-[10px] text-muted-foreground">Accept at least one finding below to enable these.</p>
        )}

        {(apply || restructure) && (
          <div className="rounded-lg border bg-card px-2 py-1.5 space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] flex-wrap">
              {apply && (
                <span className={cn("font-medium", needsReview.length === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                  In-place {apply.appliedCount}/{apply.totalAccepted}
                </span>
              )}
              {restructure && preservation && (
                <span className={cn("font-medium", preservation.lost.length === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                  Redraft {preservation.preserved}/{preservation.sourceClaims}{pct !== null ? ` (${pct}%)` : ""}
                </span>
              )}
              {restructure && (
                <div className="ml-auto flex gap-1">
                  {onOpenDraft && restructure.downloadUrl && (
                    <Button size="sm" className="h-6 px-2 text-[10px] gap-1 bg-fuchsia-600 hover:bg-fuchsia-700 text-white" onClick={onOpenDraft}>
                      <PenLine className="size-3" /> Open draft
                    </Button>
                  )}
                  {onReviewEdits && (restructure.changeReport?.length ?? 0) > 0 && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1" onClick={onReviewEdits}>
                      <Sparkles className="size-3" /> Review edits ({restructure.changeReport.length})
                    </Button>
                  )}
                  {onExactView && restructure.downloadUrl && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1" onClick={onExactView}>
                      <FileText className="size-3" /> Exact view
                    </Button>
                  )}
                  <Button size="sm" variant={comparing ? "default" : "outline"} className="h-6 px-2 text-[10px]" onClick={() => onCompareToggle(!comparing)}>
                    {comparing ? "Exit compare" : "Compare"}
                  </Button>
                </div>
              )}
            </div>

            {/* THE payoff action — full-width and loud, not a chip in a row.
                Needs only accepted findings (it applies them to the ORIGINAL);
                no redraft required. */}
            {onEditExact && findings.some((f) => f.decision === "accepted") && (
              <Button
                size="sm"
                className="w-full h-8 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"
                onClick={onEditExact}
              >
                <PenLine className="size-3.5" /> Open final document
              </Button>
            )}

            <div className="flex gap-1 flex-wrap">
              {restructure?.downloadUrl && (
                <a href={restructure.downloadUrl} target="_blank" rel="noreferrer" className="flex-1 min-w-[88px]">
                  <Button size="sm" variant="outline" className="w-full h-6 px-2 text-[10px] gap-1"><FileDown className="size-3" /> Redraft</Button>
                </a>
              )}
              {apply?.cleanUrl && (
                <a href={apply.cleanUrl} target="_blank" rel="noreferrer" className="flex-1 min-w-[88px]">
                  <Button size="sm" variant="outline" className="w-full h-6 px-2 text-[10px] gap-1"><FileDown className="size-3" /> In-place</Button>
                </a>
              )}
            </div>

            {/* Verbose detail — collapsed so it never eats the findings room. */}
            <details className="group">
              <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground inline-flex items-center gap-1 select-none">
                <ChevronDown className="size-3 transition-transform group-open:rotate-180" /> Manual review, downloads &amp; change report
              </summary>
              <div className="mt-2 space-y-2">
                {needsReview.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-2 py-1.5">
                    <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">{needsReview.length} in-place edit(s) need manual review</div>
                    <ul className="mt-1 space-y-1">
                      {needsReview.map((n, i) => (
                        <li key={i} className="text-[11px] italic text-amber-900/80 dark:text-amber-200/80">
                          {n.title ? `${n.title} — ` : ""}{n.reason ?? `"${n.before}" — not found in a single paragraph`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preservation && (preservation.repairIterations > 0 || (preservation.figuresInSource ?? 0) > 0 || preservation.lost.length > 0 || (preservation.invented?.length ?? 0) > 0) && (
                  <div className="text-[11px] text-muted-foreground space-y-0.5">
                    {preservation.repairIterations > 0 && <div>{preservation.repairIterations} repair pass(es) run.</div>}
                    {typeof preservation.figuresInSource === "number" && preservation.figuresInSource > 0 && (
                      <div className={preservation.figuresCarried >= preservation.figuresInSource ? "" : "font-semibold text-amber-700 dark:text-amber-400"}>
                        {preservation.figuresCarried >= preservation.figuresInSource
                          ? `All ${preservation.figuresInSource} figure(s) carried over.`
                          : `⚠ ${preservation.figuresInSource - preservation.figuresCarried} of ${preservation.figuresInSource} figure(s) NOT carried over — re-insert before issuing.`}
                      </div>
                    )}
                    {preservation.lost.length > 0 && (
                      <details><summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-400">{preservation.lost.length} claim(s) not re-verified</summary>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        <ul className="mt-1 space-y-1">{preservation.lost.map((l: any, i: number) => <li key={i} className="italic">[{l.section}] “{l.quote}”</li>)}</ul>
                      </details>
                    )}
                    {preservation.invented?.length > 0 && (
                      <details><summary className="cursor-pointer font-medium">{preservation.invented.length} unmatched new statement(s)</summary>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        <ul className="mt-1 space-y-1">{preservation.invented.map((l: any, i: number) => <li key={i} className="italic">[{l.section}] “{l.quote}”</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}

                {/* secondary (with-comments) downloads */}
                <div className="flex gap-1 flex-wrap">
                  {restructure?.annotatedUrl && (
                    <a href={restructure.annotatedUrl} target="_blank" rel="noreferrer" className="flex-1 min-w-[110px]">
                      <Button size="sm" variant="ghost" className="w-full h-6 px-2 text-[10px] gap-1"><FileDown className="size-3" /> Redraft + comments</Button>
                    </a>
                  )}
                  {apply && (
                    <Button size="sm" variant="ghost" className="flex-1 min-w-[110px] h-6 px-2 text-[10px] gap-1" disabled={running !== null || accepted.length === 0} onClick={() => runApply("annotated")}>
                      <FileDown className="size-3" /> {apply.annotatedUrl ? "In-place + comments" : "In-place + comments"}
                    </Button>
                  )}
                </div>

                {Array.isArray(restructure?.changeReport) && restructure.changeReport.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">Change report ({restructure.changeReport.length})</summary>
                    <div className="mt-1.5 space-y-1.5 max-h-56 overflow-y-auto">
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {restructure.changeReport.map((c: any, i: number) => (
                        <div key={i} className="rounded-lg border bg-muted/40 px-2 py-1.5 text-[11px]">
                          <div className="font-mono text-[10px] text-muted-foreground">{c.findingId} · {c.section}</div>
                          <div className="font-medium">{c.summary}</div>
                          {c.before && <div className="text-muted-foreground line-through mt-0.5">“{c.before}”</div>}
                          {c.after && <div className="text-emerald-700 mt-0.5">“{c.after}”</div>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </details>
          </div>
        )}

        {restructure && Array.isArray(restructure.placeholders) && restructure.placeholders.length > 0 && (
          <PlaceholderInputs reportId={reportId} placeholders={restructure.placeholders} onResolved={onGenerated} />
        )}
      </div>
    </TooltipProvider>
  );
}

// ── changes rail (Recommend & Edit — "Review edits") ─────────────────────────
// Lists every edit the redraft made, grouped by section: what changed
// (before → after) and WHY, so a reviewer can evaluate each one. Clicking a
// change selects it (the restructured DocViewer scrolls to and highlights the
// new wording where it could be anchored).
export function ChangesRail({ changes, activeId, anchorStatus, onSelect }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: any[];
  activeId: string | null;
  anchorStatus: Record<string, boolean>;
  onSelect: (id: string) => void;
}) {
  // Group by section, preserving first-seen order.
  const sections: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bySection = new Map<string, { c: any; idx: number }[]>();
  changes.forEach((c, i) => {
    const s = String(c.section || "—");
    if (!bySection.has(s)) { bySection.set(s, []); sections.push(s); }
    bySection.get(s)!.push({ c, idx: i });
  });

  return (
    <div className="min-h-0 min-w-0 flex flex-col bg-card/30">
      <div className="shrink-0 px-3 py-2 border-b bg-card/60">
        <div className="text-[13px] font-semibold flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" /> Edits in this redraft
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {changes.length} change{changes.length !== 1 ? "s" : ""} across {sections.length} section{sections.length !== 1 ? "s" : ""} — what changed and why. Click one to jump to it.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {changes.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">No recorded changes for this redraft.</p>
        )}
        {sections.map((section) => (
          <div key={section} className="space-y-1.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-1 pt-1">{section}</div>
            {bySection.get(section)!.map(({ c, idx }) => {
              const id = String(idx);
              const located = anchorStatus[id];
              return (
                <button
                  key={idx}
                  onClick={() => onSelect(id)}
                  className={cn("w-full text-left rounded-xl border p-2.5 space-y-1 transition-colors block",
                    activeId === id ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/20 ring-1 ring-indigo-300" : "hover:bg-muted/40")}
                >
                  <div className="flex items-center gap-1.5">
                    {c.findingId && <span className="text-[9px] font-mono text-muted-foreground">{c.findingId}</span>}
                    {located === false
                      ? <span className="ml-auto text-[9px] font-medium text-amber-600 dark:text-amber-400" title="The new wording couldn't be pinpointed in the document">not located</span>
                      : located === true ? <span className="ml-auto text-[9px] text-indigo-500">jump →</span> : null}
                  </div>
                  {c.summary && <div className="text-[11px] font-medium leading-snug">Why: {c.summary}</div>}
                  {c.before && (
                    <p className="text-[11px] leading-relaxed">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-red-500 mr-1">Was</span>
                      <del className="text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 line-through decoration-red-400 px-0.5">{c.before}</del>
                    </p>
                  )}
                  {c.after && (
                    <p className="text-[11px] leading-relaxed">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 mr-1">Now</span>
                      <ins className="text-emerald-700 dark:text-emerald-300 bg-emerald-100/60 dark:bg-emerald-900/30 no-underline px-0.5">{c.after}</ins>
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── placeholder inputs (Recommend & Edit — "Requires your input") ─────────────
// The redraft commits concrete edits but flags values a human must decide with
// [CONFIRM: …] markers (an owner role, an acronym's full name). This surfaces
// each one as a fillable field; applying writes the values into the document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function PlaceholderInputs({ reportId, placeholders, onResolved }: {
  reportId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  placeholders: any[];
  onResolved: () => void;
}) {
  const resolve = useServerFn(resolveRedraftPlaceholders);
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(placeholders.map((p) => [p.token, p.value ?? p.suggested ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  if (!placeholders || placeholders.length === 0) return null;
  const pending = placeholders.filter((p) => !p.resolved);

  async function apply() {
    // Only send fields the reviewer actually changed/filled and that aren't
    // already applied.
    const toSend: Record<string, string> = {};
    for (const p of placeholders) {
      const v = (values[p.token] ?? "").trim();
      if (v && !p.resolved) toSend[p.token] = v;
    }
    if (Object.keys(toSend).length === 0) { toast.info("Nothing new to apply."); return; }
    setBusy(true);
    try {
      await resolve({ data: { reportId, values: toSend } });
      toast.success("Your values were written into the redraft");
      onResolved();
    } catch (e) {
      toast.error("Couldn't apply your inputs", { description: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-300/70 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <PenLine className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-[13px] font-semibold text-amber-800 dark:text-amber-300">Requires your input</span>
        <span className="ml-auto text-[11px] text-amber-700/80 dark:text-amber-400/80">{pending.length} to fill</span>
      </div>
      <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80 leading-relaxed">
        The redraft applied these edits but needs a decision from you (an owner, an acronym's full name…). Fill each, then apply to write them into the document.
      </p>
      <div className="space-y-2.5">
        {placeholders.map((p, i) => (
          <div key={i} className="rounded-lg border bg-card px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{p.section}</span>
              {p.resolved && <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"><Check className="size-3" /> applied</span>}
            </div>
            {p.context && (
              <p className="text-[11px] italic text-muted-foreground leading-relaxed">
                …{String(p.context).replace(p.token, `【${p.value ?? "…"}】`)}…
              </p>
            )}
            <input
              value={values[p.token] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [p.token]: e.target.value }))}
              placeholder={p.suggested}
              disabled={p.resolved || busy}
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-amber-500/30 disabled:opacity-60"
            />
          </div>
        ))}
      </div>
      <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={busy || pending.length === 0} onClick={apply}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        {busy ? "Writing into the document…" : "Apply inputs & update redraft"}
      </Button>
    </div>
  );
}
