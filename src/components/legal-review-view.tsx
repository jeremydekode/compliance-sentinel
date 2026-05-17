import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  finalizeLegalSignOff,
  updateImpact,
} from "@/lib/compliance.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MD } from "@/components/md";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import {
  Scale, CheckCircle2, XCircle, AlertTriangle, ArrowLeft, Sparkles,
  ChevronDown, ChevronRight, Shield, FileText, ExternalLink, Gavel,
  TrendingUp, Eye, AlertCircle, Loader2, ArrowRightLeft,
} from "lucide-react";
import { toast } from "sonner";

function cleanSopTitle(title: string | null | undefined): string {
  if (!title) return "Unknown document";
  return title.replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "").trim();
}

function ExecBullets({ value }: { value: any }) {
  const bullets: string[] = Array.isArray(value)
    ? value.filter((b: any) => typeof b === "string" && b.trim().length > 0)
    : typeof value === "string" && value.trim()
      ? value.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim().length > 0)
      : [];
  if (bullets.length === 0) return null;
  return (
    <ul className="space-y-1.5 list-disc pl-5 marker:text-violet-500/60">
      {bullets.map((b, i) => (
        <li key={i} className="text-sm leading-relaxed text-foreground/85">{b.trim()}</li>
      ))}
    </ul>
  );
}

export function LegalReviewView({
  report, changes, impacts, sopById,
}: {
  report: any;
  changes: any[];
  impacts: any[];
  sopById: Map<string, any>;
}) {
  const qc = useQueryClient();
  const finLegal = useServerFn(finalizeLegalSignOff);
  const upd = useServerFn(updateImpact);
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [expandedRouted, setExpandedRouted] = useState<string | null>(null);

  const summary = (report.summary_json ?? {}) as any;
  const status = report.status as string;

  const routedItems = useMemo(() => impacts.filter(i => i.status === "routed"), [impacts]);
  const approvedItems = useMemo(() => impacts.filter(i => i.status === "approved"), [impacts]);

  // Risk signal heuristics
  const hardenedMandates = useMemo(() => changes.filter(c => {
    const t = (c.tone_shift ?? "").toLowerCase();
    return t.includes("mandate") || t.includes("shall") || t.includes("must") || t.includes("prescriptive") || t.includes("guidance");
  }), [changes]);
  const newObligations = useMemo(() => changes.filter(c =>
    !c.old_requirement || (c.old_requirement as string).toLowerCase().startsWith("n/a")
  ), [changes]);
  const scopeChanges = useMemo(() => changes.filter(c => {
    const s = `${c.change_summary ?? ""} ${c.tone_shift ?? ""}`.toLowerCase();
    return s.includes("scope") || s.includes("expand") || s.includes("third party") || s.includes("third-party") || s.includes("broaden");
  }), [changes]);
  const highImpactCount = changes.filter(c => c.impact === "high").length;

  // Group approved items by document
  const groupedApproved = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const imp of approvedItems) {
      const doc = cleanSopTitle(sopById.get(imp.sop_id)?.title ?? imp.sop_title) || "Unmatched";
      if (!map.has(doc)) map.set(doc, []);
      map.get(doc)!.push(imp);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [approvedItems, sopById]);

  async function signOff() {
    setBusy("signoff");
    try {
      await finLegal({ data: { reportId: report.id } });
      toast.success("Sign-off recorded · batch released for execution");
      qc.invalidateQueries({ queryKey: ["report", report.id] });
    } catch (e: any) {
      toast.error(e?.message ?? "Sign-off failed");
    } finally {
      setBusy(null);
    }
  }

  async function updateRoutedStatus(id: string, newStatus: "approved" | "rejected") {
    try {
      await upd({ data: { id, status: newStatus } });
      toast.success(newStatus === "approved" ? "Approved by Legal" : "Rejected — returned to Compliance");
      qc.invalidateQueries({ queryKey: ["impacts", report.id] });
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed");
    }
  }

  // States that aren't appropriate for legal yet
  if (status === "pending_validation" || status === "draft" || status === "pending_review") {
    return <NotYetForLegal report={report} />;
  }

  const isReadOnly = status !== "pending_legal";
  const allRoutedDecided = routedItems.every(i => i.status === "approved" || i.status === "rejected");

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-b from-violet-50/30 via-background to-background dark:from-violet-950/10">
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div className="px-6 py-3 border-b bg-card/80 backdrop-blur sticky top-0 z-10">
        <Link to="/reports" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-3" /> All submissions
        </Link>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">

        {/* ── Brief header ─────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="space-y-1.5 min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-400">
              <Gavel className="size-3" /> Legal Review Brief
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-black tracking-tight leading-tight">{report.title}</h1>
            <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
              Submitted by Compliance on {formatDate(report.created_at)}. Review the {routedItems.length} {routedItems.length === 1 ? "item" : "items"} flagged for your attention,
              then sign off the consolidated Change Notice to release it for execution.
            </p>
          </div>
          {!isReadOnly && (
            <div className="shrink-0">
              <Button
                onClick={signOff}
                disabled={busy === "signoff" || !allRoutedDecided}
                size="lg"
                className="gap-2 bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-500/20"
              >
                {busy === "signoff" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                Sign Off &amp; Release for Execution
              </Button>
              {!allRoutedDecided && (
                <div className="text-[10px] text-amber-700 mt-1.5 flex items-center gap-1 justify-end">
                  <AlertTriangle className="size-3" /> Decide on all routed items first
                </div>
              )}
            </div>
          )}
          {isReadOnly && (
            <Badge variant="outline" className="text-xs gap-1.5 bg-emerald-50 text-emerald-700 border-emerald-200">
              <CheckCircle2 className="size-3" />
              Already signed off
            </Badge>
          )}
        </div>

        {/* ── Key facts strip ──────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <FactCard label="Regulation" value={report.policy_name ?? "—"} icon={<Shield className="size-3.5" />} />
          <FactCard label="Effective From" value={summary.effective_date ?? "Refer to policy"} icon={<TrendingUp className="size-3.5" />} />
          <FactCard
            label="Total Items"
            value={impacts.length}
            sub={`${changes.length} regulatory changes`}
            icon={<FileText className="size-3.5" />}
          />
          <FactCard
            label="Needs Your Review"
            value={routedItems.length}
            sub={routedItems.length > 0 ? "Routed by Compliance" : "Nothing routed"}
            icon={<Eye className="size-3.5" />}
            highlight={routedItems.length > 0}
          />
        </div>

        {/* ── Executive briefing ───────────────────────────────── */}
        {summary.executive && (
          <Card className="p-5 bg-card border-l-4 border-l-violet-500">
            <div className="text-[10px] uppercase tracking-widest font-black text-violet-700 dark:text-violet-400 mb-2">
              Compliance Officer's Briefing
            </div>
            <ExecBullets value={summary.executive} />
          </Card>
        )}

        {/* ── Legal risk signals ───────────────────────────────── */}
        <div>
          <div className="text-[10px] uppercase tracking-widest font-black text-muted-foreground mb-3 flex items-center gap-2">
            <AlertTriangle className="size-3" /> Legal Risk Signals
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <RiskCard
              count={highImpactCount}
              label="High-Impact Changes"
              sub="Material obligation shifts"
              color="rose"
              items={changes.filter(c => c.impact === "high").slice(0, 4).map(c => c.chapter_ref)}
            />
            <RiskCard
              count={hardenedMandates.length}
              label="Hardened Mandates"
              sub="Guidance → 'shall' / 'must'"
              color="amber"
              items={hardenedMandates.slice(0, 4).map(c => c.chapter_ref)}
            />
            <RiskCard
              count={newObligations.length}
              label="New Obligations"
              sub="No prior baseline"
              color="emerald"
              items={newObligations.slice(0, 4).map(c => c.chapter_ref)}
            />
            <RiskCard
              count={scopeChanges.length}
              label="Scope Expansions"
              sub="Coverage widened"
              color="blue"
              items={scopeChanges.slice(0, 4).map(c => c.chapter_ref)}
            />
          </div>
        </div>

        {/* ── Items routed for your review ──────────────────────── */}
        {routedItems.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-widest font-black text-amber-700 flex items-center gap-2">
                <AlertCircle className="size-3.5" /> Routed for your review ({routedItems.length})
              </div>
              {!isReadOnly && (
                <div className="text-[10px] text-muted-foreground">
                  Approve to include in sign-off · Reject to return to Compliance
                </div>
              )}
            </div>
            <div className="space-y-2.5">
              {routedItems.map((imp) => {
                const expanded = expandedRouted === imp.id;
                const sop = sopById.get(imp.sop_id);
                const docTitle = cleanSopTitle(sop?.title ?? imp.sop_title);
                const correspondingChange = changes.find(c => (c.chapter_ref ?? "").trim().toLowerCase() === (imp.chapter ?? "").trim().toLowerCase());
                const decided = imp.status === "approved" || imp.status === "rejected";

                return (
                  <Card key={imp.id} className={cn(
                    "overflow-hidden transition-all border-l-4",
                    decided ? "border-l-emerald-400 opacity-90" : "border-l-amber-400"
                  )}>
                    <button
                      onClick={() => setExpandedRouted(expanded ? null : imp.id)}
                      className="w-full px-4 py-3 flex items-start gap-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      <div className="shrink-0 mt-0.5">
                        {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold">{imp.chapter ?? "—"}</span>
                          {correspondingChange && (
                            <Badge className={cn("text-[9px] font-black uppercase tracking-widest",
                              correspondingChange.impact === "high" ? "bg-rose-100 text-rose-700 border-rose-200" :
                              correspondingChange.impact === "medium" ? "bg-amber-100 text-amber-700 border-amber-200" :
                              "bg-emerald-100 text-emerald-700 border-emerald-200"
                            )}>{correspondingChange.impact}</Badge>
                          )}
                          {correspondingChange?.tone_shift && (
                            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                              <ArrowRightLeft className="size-2.5" />{correspondingChange.tone_shift}
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium mt-1">{docTitle}</div>
                        {correspondingChange?.change_summary && (
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{correspondingChange.change_summary}</div>
                        )}
                      </div>
                      {decided && (
                        <Badge variant="outline" className={cn("shrink-0 text-[9px] font-bold uppercase",
                          imp.status === "approved" ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-slate-100 text-slate-500"
                        )}>
                          {imp.status === "approved" ? "Approved" : "Returned"}
                        </Badge>
                      )}
                    </button>

                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 border-t bg-slate-50/30 dark:bg-slate-900/20">
                        {correspondingChange && (
                          <div className="pt-3">
                            <div className="text-[9px] uppercase tracking-widest font-black text-violet-700 mb-1.5">Regulatory basis</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="text-xs p-2.5 rounded-lg bg-rose-50 border border-rose-100">
                                <div className="text-[9px] font-bold uppercase tracking-wide text-rose-700 mb-1">Was</div>
                                {correspondingChange.old_requirement?.toLowerCase().startsWith("n/a")
                                  ? <em className="text-muted-foreground">No prior requirement</em>
                                  : correspondingChange.old_requirement}
                              </div>
                              <div className="text-xs p-2.5 rounded-lg bg-blue-50 border border-blue-100">
                                <div className="text-[9px] font-bold uppercase tracking-wide text-blue-700 mb-1">Now</div>
                                <MD>{correspondingChange.new_requirement}</MD>
                              </div>
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="text-[9px] uppercase tracking-widest font-black text-muted-foreground mb-1.5">
                            Proposed amendment to <span className="text-foreground">{docTitle}</span>
                            {sop?.file_url && (
                              <a href={sop.file_url} target="_blank" rel="noreferrer" className="ml-2 text-primary hover:underline inline-flex items-center gap-1">
                                Open <ExternalLink className="size-2.5" />
                              </a>
                            )}
                          </div>
                          {imp.find_text && (
                            <div className="text-xs p-2.5 rounded-lg bg-rose-50 border border-rose-100 font-mono mb-1.5">
                              <div className="text-[9px] font-bold uppercase text-rose-700 mb-1">Find</div>
                              {imp.find_text}
                            </div>
                          )}
                          <div className="text-xs p-2.5 rounded-lg bg-emerald-50 border border-emerald-100 font-mono">
                            <div className="text-[9px] font-bold uppercase text-emerald-700 mb-1">Replace with</div>
                            {imp.edited_text ?? imp.replace_text}
                          </div>
                        </div>

                        {!isReadOnly && (
                          <div className="flex items-center gap-2 pt-2">
                            <Button
                              size="sm" onClick={() => updateRoutedStatus(imp.id, "approved")}
                              className={cn("h-8 gap-1.5 text-xs",
                                imp.status === "approved" && "bg-emerald-600 hover:bg-emerald-700"
                              )}
                            >
                              <CheckCircle2 className="size-3.5" /> Approve for sign-off
                            </Button>
                            <Button
                              size="sm" variant="outline" onClick={() => updateRoutedStatus(imp.id, "rejected")}
                              className="h-8 gap-1.5 text-xs"
                            >
                              <XCircle className="size-3.5" /> Return to Compliance
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Approved batch (pre-cleared) ──────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-widest font-black text-emerald-700 flex items-center gap-2">
              <CheckCircle2 className="size-3.5" /> Pre-Cleared by Compliance ({approvedItems.length})
            </div>
            <div className="text-[10px] text-muted-foreground">Inspectable — no action required for sign-off</div>
          </div>
          {approvedItems.length === 0 ? (
            <Card className="p-5 text-sm text-muted-foreground text-center italic">
              No items pre-cleared by Compliance.
            </Card>
          ) : (
            <div className="space-y-2">
              {groupedApproved.map(([docTitle, items]) => {
                const expanded = expandedDoc === docTitle;
                const sop = items[0] ? sopById.get(items[0].sop_id) : undefined;
                return (
                  <Card key={docTitle} className="overflow-hidden">
                    <button
                      onClick={() => setExpandedDoc(expanded ? null : docTitle)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      {expanded ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{docTitle}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {items.length} {items.length === 1 ? "amendment" : "amendments"} ·{" "}
                          {items.filter(i => i.change_type === "insertion" || i.change_type === "new_section").length} insertions ·{" "}
                          {items.filter(i => i.change_type === "find_replace").length} find/replace
                        </div>
                      </div>
                      {sop?.file_url && (
                        <a href={sop.file_url} target="_blank" rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 shrink-0">
                          Open source <ExternalLink className="size-2.5" />
                        </a>
                      )}
                    </button>

                    {expanded && (
                      <div className="border-t bg-slate-50/30 dark:bg-slate-900/20 divide-y">
                        {items.map((imp: any) => (
                          <div key={imp.id} className="px-4 py-3 text-xs">
                            <div className="flex items-center gap-2 flex-wrap mb-1.5">
                              <span className="font-mono font-bold">{imp.chapter}</span>
                              {imp.paragraph && <span className="text-muted-foreground">· {imp.paragraph}</span>}
                              {imp.page > 0 && <span className="text-muted-foreground font-mono">· p.{imp.page}</span>}
                              <Badge variant="outline" className="text-[9px] font-bold uppercase ml-auto">
                                {(imp.change_type ?? "review").replace(/_/g, " ")}
                              </Badge>
                            </div>
                            {imp.find_text && (
                              <div className="text-[11px] p-2 rounded bg-rose-50 border border-rose-100 font-mono text-foreground/75 mb-1">
                                <span className="text-[9px] font-bold uppercase text-rose-700 mr-1">FIND:</span>
                                {imp.find_text.slice(0, 200)}{imp.find_text.length > 200 && "…"}
                              </div>
                            )}
                            <div className="text-[11px] p-2 rounded bg-emerald-50 border border-emerald-100 font-mono">
                              <span className="text-[9px] font-bold uppercase text-emerald-700 mr-1">{imp.change_type === "insertion" || imp.change_type === "new_section" ? "INSERT" : "REPLACE"}:</span>
                              {(imp.edited_text ?? imp.replace_text ?? "").slice(0, 300)}{(imp.edited_text ?? imp.replace_text ?? "").length > 300 && "…"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Decision footer ──────────────────────────────────── */}
        {!isReadOnly && (
          <Card className="p-5 bg-violet-50/60 border-violet-200 dark:bg-violet-950/20">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-1">
                <div className="font-display font-bold text-violet-900 dark:text-violet-300">Ready to sign off?</div>
                <p className="text-xs text-violet-900/70 dark:text-violet-400/70 max-w-xl">
                  Signing off releases the full batch to Operations for execution.
                  The Instruction Memo with verbatim Find/Replace blocks will be issuable in the Execute &amp; Publish stage.
                </p>
              </div>
              <Button
                onClick={signOff}
                disabled={busy === "signoff" || !allRoutedDecided}
                size="lg"
                className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
              >
                {busy === "signoff" ? <Loader2 className="size-4 animate-spin" /> : <Gavel className="size-4" />}
                Sign Off &amp; Release
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FactCard({
  label, value, sub, icon, highlight,
}: { label: string; value: string | number; sub?: string; icon?: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={cn(
      "rounded-xl border p-3 bg-card transition-colors",
      highlight && "border-amber-300 bg-amber-50/40 dark:bg-amber-900/10"
    )}>
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-black text-muted-foreground">
        {icon}{label}
      </div>
      <div className={cn("font-display text-xl font-black tracking-tight mt-1 leading-none", highlight && "text-amber-700")}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-1 truncate">{sub}</div>}
    </div>
  );
}

function RiskCard({
  count, label, sub, color, items,
}: {
  count: number; label: string; sub: string; color: "rose" | "amber" | "emerald" | "blue";
  items: string[];
}) {
  const palette = {
    rose:    { ring: "border-rose-200",    bg: "bg-rose-50/40",    text: "text-rose-700",    chip: "bg-rose-100 text-rose-700" },
    amber:   { ring: "border-amber-200",   bg: "bg-amber-50/40",   text: "text-amber-700",   chip: "bg-amber-100 text-amber-700" },
    emerald: { ring: "border-emerald-200", bg: "bg-emerald-50/40", text: "text-emerald-700", chip: "bg-emerald-100 text-emerald-700" },
    blue:    { ring: "border-blue-200",    bg: "bg-blue-50/40",    text: "text-blue-700",    chip: "bg-blue-100 text-blue-700" },
  }[color];

  return (
    <div className={cn("rounded-xl border p-3.5", palette.ring, palette.bg)}>
      <div className="flex items-baseline gap-2">
        <div className={cn("font-display text-3xl font-black tracking-tight leading-none", palette.text)}>{count}</div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-foreground/80">{label}</div>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">{sub}</div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2.5">
          {items.map((i, idx) => (
            <span key={idx} className={cn("text-[9px] font-mono font-bold px-1.5 py-0.5 rounded", palette.chip)}>
              {i}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function NotYetForLegal({ report }: { report: any }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <Card className="max-w-md p-8 text-center space-y-3">
        <div className="size-12 rounded-full bg-blue-100 grid place-items-center mx-auto">
          <Sparkles className="size-5 text-blue-700" />
        </div>
        <h2 className="font-display font-bold text-lg">Not ready for Legal yet</h2>
        <p className="text-sm text-muted-foreground">
          The Compliance team is still triaging this report. You'll see it here once they
          submit the Change Notice for legal sign-off.
        </p>
        <div className="pt-2">
          <Link to="/reports" className="text-xs text-primary hover:underline">
            ← Back to submissions
          </Link>
        </div>
        <div className="pt-3 border-t text-xs text-muted-foreground">
          <span className="font-semibold">Current status:</span> {report.status}
        </div>
      </Card>
    </div>
  );
}
