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
} from "@/lib/compliance.functions";
import { FINDING_CATEGORY_META, type Finding, type FindingSeverity } from "@/lib/recommend";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Check, X, RotateCcw, AlertTriangle, AlertOctagon, Info, CircleAlert,
  Loader2, FileDown, Sparkles, Quote, Link2Off, ShieldCheck, ChevronDown, PenLine,
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
  finding, active, anchored, busy, onSelect, onDecide,
}: {
  finding: Finding;
  active: boolean;
  anchored: boolean | undefined;
  busy: boolean;
  onSelect: () => void;
  onDecide: (decision: Finding["decision"]) => void;
}) {
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
  reportId, findings, restructure, apply, onGenerated, onApplied, onCompareToggle, comparing,
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
}) {
  const generate = useServerFn(generateRestructuredV2Document);
  const applyInPlace = useServerFn(applyFindingsInPlaceV2Report);
  const [running, setRunning] = useState<null | "redraft" | "apply">(null);
  const accepted = findings.filter(
    (f) => f.decision === "accepted" && f.verification.status !== "rejected",
  );

  async function run() {
    setRunning("redraft");
    try {
      await generate({ data: { reportId } });
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
    <div className="border-b bg-card/60 p-3 space-y-2.5 shrink-0">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">Apply accepted fixes</span>
      </div>

      {/* Two ways to apply the same accepted findings: an in-place swap that
          preserves the original document byte-for-byte outside the matched
          sentences (same engine as Simplify mode), or a full section rebuild
          that can resolve findings an in-place swap can't (insertions,
          restructuring) at the cost of exact formatting fidelity. */}
      <div className="space-y-1.5">
        <Button
          className="w-full h-9 text-sm font-semibold"
          variant={apply ? "outline" : "default"}
          disabled={accepted.length === 0 || running !== null}
          onClick={() => runApply("clean")}
        >
          {running === "apply" ? (<><Loader2 className="size-4 mr-2 animate-spin" /> Applying…</>)
            : apply ? (<><PenLine className="size-4 mr-2" /> Re-apply in place</>)
            : accepted.length === 0 ? "Accept at least one finding first"
            : `Apply ${accepted.length} finding${accepted.length === 1 ? "" : "s"} in place`}
        </Button>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Swaps each finding's quoted text for its fix directly in the original file — exact
          original styling, headers and layout preserved. Findings that insert new content or
          span multiple locations are skipped and listed for manual review, never guessed at.
        </p>
      </div>

      <div className="space-y-1.5">
        {/* The action leads; the explanation follows. */}
        <Button
          className="w-full h-9 text-sm font-semibold"
          variant={restructure ? "outline" : "default"}
          disabled={accepted.length === 0 || running !== null}
          onClick={run}
        >
          {running === "redraft" ? (<><Loader2 className="size-4 mr-2 animate-spin" /> Generating — takes a few minutes…</>)
            : restructure ? (<><RotateCcw className="size-4 mr-2" /> Regenerate redraft</>)
            : accepted.length === 0 ? "Accept at least one finding first"
            : `Generate redraft from ${accepted.length} finding${accepted.length === 1 ? "" : "s"}`}
        </Button>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Rebuilds the document body with every <b>accepted</b> fix applied, carrying over
          the template, headers, footers, tables and figures. The body is regenerated, so
          expect to re-apply house numbering and fine layout before issuing it. Every source
          claim is checked against the output; losses are reported, never hidden.
        </p>
      </div>

      {apply && (
        <div className="space-y-2 rounded-lg border bg-card p-2.5">
          <div className="text-xs font-semibold flex items-center gap-1.5">
            <PenLine className="size-3.5 text-primary" /> In-place edit
          </div>
          <div className={cn("rounded-lg border px-2.5 py-2 text-xs",
            needsReview.length === 0 ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800")}>
            <div className="font-semibold">
              {apply.appliedCount}/{apply.totalAccepted} accepted finding(s) applied
            </div>
            {needsReview.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] font-medium">{needsReview.length} need manual review</summary>
                <ul className="mt-1 space-y-1">
                  {needsReview.map((n, i) => (
                    <li key={i} className="text-[11px] italic">
                      {n.title ? `${n.title} — ` : ""}{n.reason ?? `"${n.before}" — not found in a single paragraph`}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="flex gap-1.5">
            {apply.cleanUrl && (
              <a href={apply.cleanUrl} target="_blank" rel="noreferrer" className="flex-1">
                <Button size="sm" variant="outline" className="w-full h-7 px-2.5 text-xs">
                  <FileDown className="size-3.5 mr-1" /> Clean copy
                </Button>
              </a>
            )}
            <Button size="sm" variant="outline" className="flex-1 h-7 px-2.5 text-xs" disabled={running !== null || accepted.length === 0} onClick={() => runApply("annotated")}>
              <FileDown className="size-3.5 mr-1" /> {apply.annotatedUrl ? "Re-annotated copy" : "With comments"}
            </Button>
          </div>
        </div>
      )}

      {restructure && (
        <div className="space-y-2">
          {/* preservation summary — honest */}
          {preservation && (
            <div className={cn("rounded-lg border px-2.5 py-2 text-xs",
              preservation.lost.length === 0 ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800")}>
              <div className="font-semibold">
                {preservation.preserved}/{preservation.sourceClaims} source claims preserved{pct !== null ? ` (${pct}%)` : ""}
              </div>
              {preservation.repairIterations > 0 && (
                <div className="text-[11px] mt-0.5">{preservation.repairIterations} repair pass(es) run.</div>
              )}
              {/* Figures are counted separately — the claim score measures TEXT
                  only, so without this a redraft could drop every diagram and
                  still report 100% preserved. */}
              {typeof preservation.figuresInSource === "number" && preservation.figuresInSource > 0 && (
                <div className={cn("text-[11px] mt-0.5",
                  preservation.figuresCarried >= preservation.figuresInSource ? "" : "font-semibold text-amber-900")}>
                  {preservation.figuresCarried >= preservation.figuresInSource
                    ? `All ${preservation.figuresInSource} figure(s) carried over.`
                    : `⚠ ${preservation.figuresInSource - preservation.figuresCarried} of ${preservation.figuresInSource} figure(s) NOT carried over — re-insert them before issuing.`}
                </div>
              )}
              {preservation.lost.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] font-medium">{preservation.lost.length} claim(s) could not be re-verified — review before use</summary>
                  <ul className="mt-1 space-y-1">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {preservation.lost.map((l: any, i: number) => (
                      <li key={i} className="text-[11px] italic">[{l.section}] “{l.quote}”</li>
                    ))}
                  </ul>
                </details>
              )}
              {preservation.invented?.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] font-medium">{preservation.invented.length} unmatched new statement(s)</summary>
                  <ul className="mt-1 space-y-1">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {preservation.invented.map((l: any, i: number) => (
                      <li key={i} className="text-[11px] italic">[{l.section}] “{l.quote}”</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="flex gap-1.5">
            <Button size="sm" variant={comparing ? "default" : "outline"} className="h-7 px-2.5 text-xs flex-1"
              onClick={() => onCompareToggle(!comparing)}>
              {comparing ? "Exit comparison" : "Compare side-by-side"}
            </Button>
          </div>
          <div className="flex gap-1.5">
            <a href={restructure.downloadUrl} target="_blank" rel="noreferrer" className="flex-1">
              <Button size="sm" variant="outline" className="w-full h-7 px-2.5 text-xs">
                <FileDown className="size-3.5 mr-1" /> Clean copy
              </Button>
            </a>
            <a href={restructure.annotatedUrl} target="_blank" rel="noreferrer" className="flex-1">
              <Button size="sm" variant="outline" className="w-full h-7 px-2.5 text-xs">
                <FileDown className="size-3.5 mr-1" /> With comments
              </Button>
            </a>
          </div>

          {/* change report */}
          {Array.isArray(restructure.changeReport) && restructure.changeReport.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                Change report ({restructure.changeReport.length})
              </summary>
              <div className="mt-1.5 space-y-1.5 max-h-64 overflow-y-auto">
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
      )}
    </div>
  );
}
