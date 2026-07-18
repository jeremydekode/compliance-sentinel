// ============================================================================
// SIMPLIFY V2 — per-mode result dashboards (the management-level Level-1 view).
// Full-width responsive card grid. Each item card carries three actions:
//   👁 View — popup of the document scrolled to the highlighted text, with an
//             info rail (reason, evidence, suggested fix) beside it;
//   ✓ Accept — records the decision right from the card (or the popup);
//   ✎ Edit  — refine the suggested fix / replacement text before accepting.
// The header's Document toggle remains the full review workspace.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import type { Finding, FindingSeverity } from "@/lib/recommend";
import { FINDING_CATEGORY_META } from "@/lib/recommend";
import { SIMPLIFY_TYPE_LABEL, type VerifiedAction } from "@/lib/simplify";
import {
  setV2FindingDecision,
  updateV2FindingFix,
  setSimplificationDecision,
  updateV2ActionAfter,
} from "@/lib/compliance.functions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DocViewer, type DocHighlight } from "@/components/doc-viewer";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  AlertOctagon, AlertTriangle, CircleAlert, Info, ShieldCheck, ArrowRight,
  FileDown, Scissors, ListChecks, CheckCircle2, Layers, TrendingDown, Quote,
  Eye, Wrench, Check, Pencil, RotateCcw, Loader2,
} from "lucide-react";

// ── shared bits ──────────────────────────────────────────────────────────────

const SEV_META: Record<FindingSeverity, { label: string; icon: React.ElementType; tile: string; bar: string; accent: string; chip: string }> = {
  critical: { label: "Critical", icon: AlertOctagon, tile: "border-red-200 bg-red-50 text-red-700", bar: "bg-red-500", accent: "bg-red-500", chip: "bg-red-100 text-red-700 ring-red-200" },
  high:     { label: "High",     icon: AlertTriangle, tile: "border-orange-200 bg-orange-50 text-orange-700", bar: "bg-orange-500", accent: "bg-orange-500", chip: "bg-orange-100 text-orange-700 ring-orange-200" },
  medium:   { label: "Medium",   icon: CircleAlert, tile: "border-amber-200 bg-amber-50 text-amber-700", bar: "bg-amber-500", accent: "bg-amber-400", chip: "bg-amber-100 text-amber-700 ring-amber-200" },
  info:     { label: "Info",     icon: Info, tile: "border-blue-200 bg-blue-50 text-blue-700", bar: "bg-blue-400", accent: "bg-blue-400", chip: "bg-blue-100 text-blue-700 ring-blue-200" },
};

const SEV_WEIGHT: Record<FindingSeverity, number> = { critical: 8, high: 4, medium: 2, info: 1 };
const SEV_ORDER: FindingSeverity[] = ["critical", "high", "medium", "info"];

const TYPE_LABEL = SIMPLIFY_TYPE_LABEL;

interface SectionHeat {
  heading: string;
  count: number;
  weighted: number;
  worst: FindingSeverity | null;
}

/** Aggregates findings up the heading hierarchy: every level>1 heading rolls
 *  into its nearest preceding level-1 ancestor (by document order). */
function buildSectionHeat(
  findings: Finding[],
  sections: { level: number; heading: string; order: number }[],
): { heat: SectionHeat[]; clean: string[] } {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const minLevel = ordered.length ? Math.min(...ordered.map((s) => s.level)) : 1;
  const tops = ordered.filter((s) => s.level === minLevel);
  const norm = (s: string) => s.trim().toLowerCase();
  const ancestorOf = new Map<string, string>();
  let currentTop: string | null = null;
  for (const s of ordered) {
    if (s.level === minLevel) currentTop = s.heading;
    if (currentTop) ancestorOf.set(norm(s.heading), currentTop);
  }

  const buckets = new Map<string, { count: number; weighted: number; worst: FindingSeverity | null }>();
  for (const t of tops) buckets.set(t.heading, { count: 0, weighted: 0, worst: null });

  for (const f of findings) {
    if (f.verification.status === "rejected") continue;
    const evSection = norm(f.evidence[0]?.section ?? "");
    let top = ancestorOf.get(evSection);
    if (!top && evSection) {
      const hit = ordered.find((s) => norm(s.heading).includes(evSection) || evSection.includes(norm(s.heading)));
      if (hit) top = ancestorOf.get(norm(hit.heading));
    }
    if (!top) continue;
    const b = buckets.get(top);
    if (!b) continue;
    b.count++;
    b.weighted += SEV_WEIGHT[f.severity];
    if (!b.worst || SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(b.worst)) b.worst = f.severity;
  }

  const heat: SectionHeat[] = [];
  const clean: string[] = [];
  for (const t of tops) {
    const b = buckets.get(t.heading)!;
    if (b.count === 0) clean.push(t.heading);
    else heat.push({ heading: t.heading, ...b });
  }
  heat.sort((a, b) => b.weighted - a.weighted);
  return { heat, clean };
}

function StatTile({ icon: Icon, value, label, className, onClick, active }: {
  icon: React.ElementType; value: string | number; label: string; className?: string; onClick?: () => void; active?: boolean;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "rounded-xl border px-4 py-3 text-left w-full",
        onClick && "transition-all hover:scale-[1.02] active:scale-[0.99] cursor-pointer",
        active && "ring-2 ring-primary/50",
        className,
      )}
    >
      <Icon className="size-4 opacity-70" />
      <div className="text-2xl font-black mt-1 leading-none">{value}</div>
      <div className="text-[11px] font-medium mt-1 opacity-80">{label}</div>
    </Comp>
  );
}

// ── fix editor (shared by cards and the popup rail) ─────────────────────────

/** Suggested-fix / replacement-text block with an edit mode. `editing` is
 *  CONTROLLED by the parent so the card's ✎ button can toggle it. */
function FixEditor({
  label, value, editing, onEditingChange, onSave, busy, tone = "primary",
}: {
  label: string;
  value: string;
  editing: boolean;
  onEditingChange: (e: boolean) => void;
  onSave: (text: string) => Promise<void>;
  busy: boolean;
  tone?: "primary" | "emerald";
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value, editing]);
  const toneCls = tone === "emerald"
    ? "bg-emerald-50/60 border-emerald-100"
    : "bg-primary/5 border-primary/15";
  const labelCls = tone === "emerald" ? "text-emerald-600" : "text-primary";

  return (
    <div className={cn("rounded-lg border px-2.5 py-1.5", toneCls)}>
      <div className={cn("text-[10px] font-bold mb-0.5 flex items-center gap-1", labelCls)}>
        <Wrench className="size-3" /> {label}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            className="w-full text-[11px] leading-relaxed p-2 rounded-md border bg-card focus:outline-none focus:ring-1 focus:ring-primary resize-y"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy || !text.trim()}
              onClick={async () => { await onSave(text.trim()); onEditingChange(false); }}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 mr-0.5" />} Save
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => onEditingChange(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-[11px] leading-relaxed whitespace-pre-wrap">{value || "—"}</div>
      )}
    </div>
  );
}

/** The card/popup action row: View · Accept(✓) · Edit(✎). */
function ItemActions({
  onView, accepted, onToggleAccept, onEdit, busy, compact,
}: {
  onView?: () => void;
  accepted: boolean;
  onToggleAccept: () => void;
  onEdit: () => void;
  busy: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {onView && (
        <Button size="sm" className={cn("text-xs gap-1.5 flex-1", compact ? "h-7" : "h-8")} onClick={onView}>
          <Eye className="size-3.5" /> View in document
        </Button>
      )}
      <Button
        size="sm"
        variant={accepted ? "default" : "outline"}
        title={accepted ? "Accepted — click to undo" : "Accept"}
        className={cn(
          "px-0 shrink-0",
          compact ? "h-7 w-7" : "h-8 w-8",
          accepted && "bg-emerald-600 hover:bg-emerald-700 text-white",
          !onView && "flex-1 gap-1.5 px-2 w-auto",
        )}
        disabled={busy}
        onClick={onToggleAccept}
      >
        {accepted ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
        {!onView && (accepted ? "Undo accept" : "Accept")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        title="Edit the suggested fix"
        className={cn("px-0 shrink-0", compact ? "h-7 w-7" : "h-8 w-8")}
        disabled={busy}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" />
      </Button>
    </div>
  );
}

// ── document peek dialog ─────────────────────────────────────────────────────

/**
 * "View in document" popup: document on the left auto-scrolled to the item's
 * highlighted text; an info rail on the right with the reason, evidence and
 * the suggested fix — including the same ✓ accept and ✎ edit actions as the
 * card, so the popup is a complete review surface for one item.
 */
function DocPeekDialog({
  open, onClose, fileUrl, anchor, title, chip, rail, onOpenFull,
}: {
  open: boolean;
  onClose: () => void;
  fileUrl: string | null;
  anchor: DocHighlight | null;
  title: string;
  chip?: { label: string; className: string };
  rail: React.ReactNode;
  onOpenFull?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl w-[94vw] h-[86vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-3 border-b shrink-0 space-y-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            {chip && (
              <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ring-1", chip.className)}>
                {chip.label}
              </span>
            )}
            <span className="truncate">{title}</span>
            {onOpenFull && (
              <Button size="sm" variant="outline" className="ml-auto h-7 px-2.5 text-xs shrink-0" onClick={() => { onClose(); onOpenFull(); }}>
                Open full review
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-h-0 min-w-0 border-r overflow-hidden">
            {open && (
              <DocViewer
                fileUrl={fileUrl}
                highlights={anchor ? [anchor] : []}
                activeId={anchor?.id ?? null}
                className="h-full"
              />
            )}
          </div>
          <div className="min-h-0 min-w-0 overflow-y-auto bg-card/40 p-4 space-y-3 break-words">
            {rail}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── AUDIT dashboard ──────────────────────────────────────────────────────────

export function AuditHealthDashboard({
  reportId, findings, structure, sourceUrl, onView, onDrill,
}: {
  reportId: string;
  findings: Finding[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structure: any | null;
  sourceUrl: string | null;
  /** Jump to the FULL document review focused on one finding. */
  onView: (findingId: string) => void;
  onDrill: (severity: FindingSeverity | "all") => void;
}) {
  const qc = useQueryClient();
  const setDecision = useServerFn(setV2FindingDecision);
  const saveFix = useServerFn(updateV2FindingFix);
  const [filter, setFilter] = useState<FindingSeverity | "all">("all");
  const [peekId, setPeekId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // card OR popup fix editor
  const [busyId, setBusyId] = useState<string | null>(null);

  const live = findings.filter((f) => f.verification.status !== "rejected");
  const counts = useMemo(() => {
    const c: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
    for (const f of live) c[f.severity]++;
    return c;
  }, [live]);
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of live) m.set(f.category, (m.get(f.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [live]);
  const maxCat = byCategory[0]?.[1] ?? 1;

  const sections: { level: number; heading: string; order: number }[] = structure?.sections ?? [];
  const { heat, clean } = useMemo(() => buildSectionHeat(live, sections), [live, sections]);
  const maxHeat = heat[0]?.weighted ?? 1;

  const visible = useMemo(
    () => (filter === "all" ? live : live.filter((f) => f.severity === filter)),
    [live, filter],
  );

  // Live-resolved peeked finding: mutations refresh the report → this re-renders.
  const peeked = peekId ? findings.find((f) => f.id === peekId) ?? null : null;

  async function toggleAccept(f: Finding) {
    setBusyId(f.id);
    try {
      const decision = f.decision === "accepted" ? "pending" : "accepted";
      await setDecision({ data: { reportId, findingId: f.id, decision } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't save decision", { description: e?.message });
    } finally {
      setBusyId(null);
    }
  }

  async function persistFix(f: Finding, text: string) {
    setBusyId(f.id);
    try {
      await saveFix({ data: { reportId, findingId: f.id, suggestedFix: text } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      toast.success("Suggested fix updated");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't save fix", { description: e?.message });
    } finally {
      setBusyId(null);
    }
  }

  const healthy = counts.critical === 0 && counts.high === 0;
  const verdict = live.length === 0
    ? "This document checked out clean — the audit found nothing that needs attention."
    : healthy
      ? "This document is fundamentally sound — no critical or high-severity issues. The items below are quality improvements, not risks."
      : `${counts.critical + counts.high} issue${counts.critical + counts.high === 1 ? "" : "s"} need${counts.critical + counts.high === 1 ? "s" : ""} attention before this document can be relied on.`;

  return (
    <div className="p-6 space-y-6">
      {/* ── summary band ── */}
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_1fr]">
        <div className="space-y-3">
          <div className={cn(
            "rounded-2xl border p-5 flex items-start gap-4",
            healthy ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60",
          )}>
            {healthy
              ? <ShieldCheck className="size-8 text-emerald-600 shrink-0" />
              : <AlertOctagon className="size-8 text-red-500 shrink-0" />}
            <div>
              <div className="text-lg font-bold">{healthy ? "Document health: good" : "Document health: needs attention"}</div>
              <p className="text-sm text-muted-foreground mt-0.5">{verdict}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Every finding below is verified against the document's own text — unverifiable ones are quarantined, never counted.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {SEV_ORDER.map((s) => (
              <StatTile
                key={s}
                icon={SEV_META[s].icon}
                value={counts[s]}
                label={SEV_META[s].label}
                className={cn(SEV_META[s].tile, counts[s] === 0 && "opacity-45")}
                active={filter === s}
                onClick={counts[s] > 0 ? () => setFilter(filter === s ? "all" : s) : undefined}
              />
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Issue types</div>
          {byCategory.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
          <div className="space-y-2">
            {byCategory.map(([cat, n]) => (
              <div key={cat}>
                <div className="flex justify-between text-xs mb-0.5">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <span className="font-medium">{(FINDING_CATEGORY_META as any)[cat]?.label ?? cat}</span>
                  <span className="text-muted-foreground">{n}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-fuchsia-500" style={{ width: `${(n / maxCat) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Where issues concentrate</div>
          {heat.length === 0 && <p className="text-xs text-muted-foreground">No section-level concentration.</p>}
          <div className="space-y-1.5">
            {heat.slice(0, 7).map((h) => (
              <div key={h.heading} className="flex items-center gap-2">
                <div
                  className={cn("h-4 rounded", h.worst ? SEV_META[h.worst].bar : "bg-muted")}
                  style={{ width: `${Math.max(8, (h.weighted / maxHeat) * 90)}px`, opacity: 0.85 }}
                />
                <span className="text-xs truncate flex-1" title={h.heading}>{h.heading}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">{h.count}</span>
              </div>
            ))}
          </div>
          {clean.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 mb-1.5 flex items-center gap-1">
                <CheckCircle2 className="size-3" /> Clean ({clean.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {clean.slice(0, 6).map((c) => (
                  <span key={c} className="rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[10px] text-emerald-800 max-w-[160px] truncate" title={c}>
                    {c}
                  </span>
                ))}
                {clean.length > 6 && <span className="text-[10px] text-muted-foreground">+{clean.length - 6} more</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── finding cards grid ── */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          {filter === "all" ? `All findings (${visible.length})` : `${SEV_META[filter].label} findings (${visible.length})`}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onDrill(filter)}>
          Open document review <ArrowRight className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visible.map((f) => {
          const meta = SEV_META[f.severity];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catMeta = (FINDING_CATEGORY_META as any)[f.category];
          return (
            <div key={f.id} className="rounded-2xl border bg-card overflow-hidden flex flex-col shadow-sm">
              <div className={cn("h-1.5", meta.accent)} />
              <div className="p-4 flex-1 flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ring-1", meta.chip)}>
                    <meta.icon className="size-3" /> {meta.label}
                  </span>
                  <span title={catMeta?.hint} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                    {catMeta?.label ?? f.category}
                  </span>
                  {f.decision === "accepted" && (
                    <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
                      <Check className="size-3" /> Accepted
                    </span>
                  )}
                  {f.decision === "dismissed" && (
                    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground ring-1 ring-border">
                      Dismissed
                    </span>
                  )}
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">{f.id}</span>
                </div>

                <div className="text-sm font-bold leading-snug">{f.title}</div>
                {f.description && (
                  <p className="text-xs text-muted-foreground leading-relaxed">{f.description}</p>
                )}

                <div className="space-y-1.5">
                  {f.evidence.slice(0, 2).map((e, i) => (
                    <div key={i} className="rounded-lg bg-muted/50 border border-border/60 px-2.5 py-1.5">
                      <div className="text-[10px] font-semibold text-muted-foreground mb-0.5 flex items-center gap-1">
                        <Quote className="size-3" /> {e.section}
                      </div>
                      <div className="text-[11px] italic leading-relaxed line-clamp-3">“{e.quote}”</div>
                    </div>
                  ))}
                  {f.evidence.length > 2 && (
                    <div className="text-[10px] text-muted-foreground">+{f.evidence.length - 2} more location(s)</div>
                  )}
                </div>

                <FixEditor
                  label="Suggested fix"
                  value={f.suggestedFix}
                  editing={editingId === f.id && !peekId}
                  onEditingChange={(e) => setEditingId(e ? f.id : null)}
                  onSave={(t) => persistFix(f, t)}
                  busy={busyId === f.id}
                />

                <div className="mt-auto pt-1.5 flex items-center gap-2">
                  <div className="flex-1">
                    <ItemActions
                      onView={() => setPeekId(f.id)}
                      accepted={f.decision === "accepted"}
                      onToggleAccept={() => toggleAccept(f)}
                      onEdit={() => setEditingId(editingId === f.id ? null : f.id)}
                      busy={busyId === f.id}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0" title="Model confidence">{f.confidence}%</span>
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full text-center py-10">Nothing at this severity.</p>
        )}
      </div>

      {/* ── popup: doc + info rail with the SAME actions ── */}
      <DocPeekDialog
        open={!!peeked}
        onClose={() => { setPeekId(null); setEditingId(null); }}
        fileUrl={sourceUrl}
        anchor={peeked ? { id: peeked.id, text: peeked.evidence[0]?.quote ?? "", kind: peeked.severity } : null}
        title={peeked?.title ?? ""}
        chip={peeked ? { label: SEV_META[peeked.severity].label, className: SEV_META[peeked.severity].chip } : undefined}
        onOpenFull={peeked ? () => onView(peeked.id) : undefined}
        rail={peeked && (
          <>
            {peeked.description && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Reason</div>
                <p className="text-xs leading-relaxed">{peeked.description}</p>
              </div>
            )}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Evidence</div>
              <div className="space-y-1.5">
                {peeked.evidence.map((e, i) => (
                  <div key={i} className="rounded-lg bg-muted/50 border border-border/60 px-2.5 py-1.5">
                    <div className="text-[10px] font-semibold text-muted-foreground mb-0.5 flex items-center gap-1">
                      <Quote className="size-3" /> {e.section}
                    </div>
                    <div className="text-[11px] italic leading-relaxed">“{e.quote}”</div>
                  </div>
                ))}
              </div>
            </div>
            <FixEditor
              label="Suggested fix"
              value={peeked.suggestedFix}
              editing={editingId === peeked.id && !!peekId}
              onEditingChange={(e) => setEditingId(e ? peeked.id : null)}
              onSave={(t) => persistFix(peeked, t)}
              busy={busyId === peeked.id}
            />
            <ItemActions
              accepted={peeked.decision === "accepted"}
              onToggleAccept={() => toggleAccept(peeked)}
              onEdit={() => setEditingId(editingId === peeked.id ? null : peeked.id)}
              busy={busyId === peeked.id}
            />
          </>
        )}
      />
    </div>
  );
}

// ── SIMPLIFY dashboard ───────────────────────────────────────────────────────

export function SimplifyChangesDashboard({
  reportId, actions, structure, sourceUrl, onView, onDrill,
}: {
  reportId: string;
  actions: VerifiedAction[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structure: any | null;
  sourceUrl: string | null;
  /** Jump to the FULL document review focused on one edit ("a-<index>"). */
  onView: (highlightId: string) => void;
  onDrill: () => void;
}) {
  const qc = useQueryClient();
  const setDecision = useServerFn(setSimplificationDecision);
  const saveAfter = useServerFn(updateV2ActionAfter);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [peekIndex, setPeekIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);

  const indexed = actions.map((action, index) => ({ action, index }));
  const live = indexed.filter((x) => x.action.verification?.status !== "rejected");
  const accepted = live.filter((x) => x.action.decision === "accepted");
  const pending = live.filter((x) => (x.action.decision ?? "pending") === "pending");

  const wordCount: number = structure?.wordCount ?? 0;
  const stats = useMemo(() => {
    const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
    const base = accepted.length > 0 ? accepted : live;
    const removed = base.reduce((acc, x) => acc + Math.max(0, countWords(x.action.before) - countWords(x.action.after ?? "")), 0);
    const byType = new Map<string, number>();
    for (const x of live) byType.set(x.action.type, (byType.get(x.action.type) ?? 0) + 1);
    return {
      removed,
      potential: accepted.length === 0,
      pct: wordCount > 0 ? Math.round((removed / wordCount) * 100) : null,
      byType: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [live, accepted, wordCount]);

  const visible = typeFilter === "all" ? live : live.filter((x) => x.action.type === typeFilter);
  const peeked = peekIndex !== null ? actions[peekIndex] ?? null : null;

  async function toggleAccept(index: number, action: VerifiedAction) {
    setBusyIndex(index);
    try {
      const decision = action.decision === "accepted" ? "pending" : "accepted";
      await setDecision({ data: { reportId, index, decision } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't save decision", { description: e?.message });
    } finally {
      setBusyIndex(null);
    }
  }

  async function persistAfter(index: number, text: string) {
    setBusyIndex(index);
    try {
      await saveAfter({ data: { reportId, index, after: text } });
      await qc.invalidateQueries({ queryKey: ["report", reportId] });
      toast.success("Replacement text updated");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't save edit", { description: e?.message });
    } finally {
      setBusyIndex(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* summary band */}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 flex items-start gap-4">
          <Scissors className="size-8 text-violet-600 shrink-0" />
          <div>
            <div className="text-lg font-bold">
              {stats.pct !== null
                ? `${stats.potential ? "Up to " : ""}${stats.pct}% shorter — ~${stats.removed.toLocaleString()} of ${wordCount.toLocaleString()} words ${stats.potential ? "can go" : "removed"}`
                : `${live.length} verified simplification${live.length === 1 ? "" : "s"} proposed`}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {pending.length > 0
                ? `${accepted.length} accepted · ${pending.length} awaiting review. Every edit is anchored to the source text.`
                : `All decided — ${accepted.length} accepted. Export from the document view.`}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <StatTile icon={ListChecks} value={live.length} label="Verified edits" className="border-violet-200 bg-violet-50 text-violet-700" />
          <StatTile icon={CheckCircle2} value={accepted.length} label="Accepted" className="border-emerald-200 bg-emerald-50 text-emerald-700" />
          <StatTile icon={TrendingDown} value={stats.pct !== null ? `${stats.pct}%` : "—"} label={stats.potential ? "Potential cut" : "Reduction"} className="border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700" />
        </div>
      </div>

      {/* type filter + open review */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setTypeFilter("all")}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors",
              typeFilter === "all" ? "bg-primary text-primary-foreground ring-primary" : "bg-muted text-muted-foreground ring-border hover:text-foreground")}
          >
            All {live.length}
          </button>
          {stats.byType.map(([t, n]) => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? "all" : t)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors",
                typeFilter === t ? "bg-violet-600 text-white ring-violet-600" : "bg-muted text-muted-foreground ring-border hover:text-foreground")}
            >
              {TYPE_LABEL[t] ?? t} {n}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onDrill}>
          Open document review <ArrowRight className="size-3.5" />
        </Button>
      </div>

      {/* edit cards grid */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visible.map(({ action, index }) => {
          const decision = action.decision ?? "pending";
          return (
            <div key={index} className="rounded-2xl border bg-card overflow-hidden flex flex-col shadow-sm">
              <div className="h-1.5 bg-violet-500" />
              <div className="p-4 flex-1 flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700 ring-1 ring-violet-200">
                    {TYPE_LABEL[action.type] ?? action.type}
                  </span>
                  {decision === "accepted" && (
                    <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
                      <Check className="size-3" /> Accepted
                    </span>
                  )}
                  {decision === "rejected" && (
                    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground ring-1 ring-border">
                      Rejected
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground">{action.confidence}%</span>
                </div>
                {action.section && (
                  <div className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1">
                    <Quote className="size-3" /> {action.section}
                  </div>
                )}
                <div className="rounded-lg bg-red-50/60 border border-red-100 px-2.5 py-1.5">
                  <div className="text-[10px] font-bold text-red-400 mb-0.5">Before</div>
                  <div className="text-[11px] leading-relaxed line-clamp-3 line-through decoration-red-300">{action.before}</div>
                </div>
                <FixEditor
                  label="After (replacement)"
                  value={action.after ?? ""}
                  editing={editingIndex === index && peekIndex === null}
                  onEditingChange={(e) => setEditingIndex(e ? index : null)}
                  onSave={(t) => persistAfter(index, t)}
                  busy={busyIndex === index}
                  tone="emerald"
                />
                {action.rationale && (
                  <p className="text-[11px] text-muted-foreground italic leading-relaxed line-clamp-2">{action.rationale}</p>
                )}
                <div className="mt-auto pt-1.5">
                  <ItemActions
                    onView={() => setPeekIndex(index)}
                    accepted={decision === "accepted"}
                    onToggleAccept={() => toggleAccept(index, action)}
                    onEdit={() => setEditingIndex(editingIndex === index ? null : index)}
                    busy={busyIndex === index}
                  />
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full text-center py-10">No edits of this type.</p>
        )}
      </div>

      {/* popup: doc + info rail with the SAME actions */}
      <DocPeekDialog
        open={peeked !== null}
        onClose={() => { setPeekIndex(null); setEditingIndex(null); }}
        fileUrl={sourceUrl}
        anchor={peeked && peekIndex !== null ? { id: `a-${peekIndex}`, text: peeked.before, kind: "edit" } : null}
        title={peeked?.section || (peeked ? (TYPE_LABEL[peeked.type] ?? peeked.type) : "")}
        chip={peeked ? { label: TYPE_LABEL[peeked.type] ?? peeked.type, className: "bg-violet-100 text-violet-700 ring-violet-200" } : undefined}
        onOpenFull={peekIndex !== null ? () => onView(`a-${peekIndex}`) : undefined}
        rail={peeked && peekIndex !== null && (
          <>
            {peeked.rationale && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Reason</div>
                <p className="text-xs leading-relaxed">{peeked.rationale}</p>
              </div>
            )}
            <div className="rounded-lg bg-red-50/60 border border-red-100 px-2.5 py-1.5">
              <div className="text-[10px] font-bold text-red-400 mb-0.5">Before</div>
              <div className="text-[11px] leading-relaxed line-through decoration-red-300">{peeked.before}</div>
            </div>
            <FixEditor
              label="After (replacement)"
              value={peeked.after ?? ""}
              editing={editingIndex === peekIndex && peekIndex !== null}
              onEditingChange={(e) => setEditingIndex(e ? peekIndex : null)}
              onSave={(t) => persistAfter(peekIndex, t)}
              busy={busyIndex === peekIndex}
              tone="emerald"
            />
            <ItemActions
              accepted={peeked.decision === "accepted"}
              onToggleAccept={() => toggleAccept(peekIndex, peeked)}
              onEdit={() => setEditingIndex(editingIndex === peekIndex ? null : peekIndex)}
              busy={busyIndex === peekIndex}
            />
          </>
        )}
      />
    </div>
  );
}

// ── REDRAFT / post-generation dashboard ──────────────────────────────────────

export function RedraftDashboard({
  restructure, findings, structure, sourceUrl, onCompare, onDrill,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restructure: any;
  findings: Finding[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structure: any | null;
  sourceUrl: string | null;
  onCompare: () => void;
  onDrill: () => void;
}) {
  const [peek, setPeek] = useState<{ id: string; title: string; text: string; kind: DocHighlight["kind"]; chip?: { label: string; className: string }; reason?: string; after?: string } | null>(null);
  const preservation = restructure?.preservation;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeReport: any[] = Array.isArray(restructure?.changeReport) ? restructure.changeReport : [];
  const accepted = findings.filter((f) => f.decision === "accepted");
  const findingById = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);
  const pct = preservation?.sourceClaims
    ? Math.round((preservation.preserved / preservation.sourceClaims) * 100)
    : null;

  return (
    <div className="p-6 space-y-6">
      {/* summary band */}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50/60 p-5 flex items-start gap-4">
          <Layers className="size-8 text-fuchsia-600 shrink-0" />
          <div className="flex-1">
            <div className="text-lg font-bold">
              Restructured — {changeReport.length} change{changeReport.length === 1 ? "" : "s"} from {accepted.length} accepted finding{accepted.length === 1 ? "" : "s"}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Original logo, headers and styles preserved. Content integrity below is measured, not assumed.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button size="sm" onClick={onCompare} className="gap-1.5 h-8 text-xs">
                Compare side-by-side <ArrowRight className="size-3.5" />
              </Button>
              {restructure?.downloadUrl && (
                <a href={restructure.downloadUrl} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs"><FileDown className="size-3.5" /> Clean copy</Button>
                </a>
              )}
              {restructure?.annotatedUrl && (
                <a href={restructure.annotatedUrl} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs"><FileDown className="size-3.5" /> With comments</Button>
                </a>
              )}
              <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={onDrill}>
                Findings detail
              </Button>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <StatTile
            icon={ShieldCheck}
            value={pct !== null ? `${pct}%` : "—"}
            label={`Content preserved (${preservation?.preserved ?? "?"}/${preservation?.sourceClaims ?? "?"})`}
            className={cn(preservation?.lost?.length === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}
          />
          <StatTile icon={ListChecks} value={changeReport.length} label="Documented changes" className="border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700" />
          <StatTile icon={CheckCircle2} value={preservation?.repairIterations ?? 0} label="Self-repair passes" className="border-blue-200 bg-blue-50 text-blue-700" />
        </div>
      </div>

      {preservation?.lost?.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="text-xs font-bold text-amber-800 mb-1.5">
            {preservation.lost.length} claim(s) could not be re-verified in the output — review before circulating:
          </div>
          <ul className="space-y-1">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {preservation.lost.slice(0, 8).map((l: any, i: number) => (
              <li key={i} className="text-[11px] text-amber-900 italic">[{l.section}] “{l.quote}”</li>
            ))}
          </ul>
        </div>
      )}

      {/* amendment cards grid */}
      <div className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
        Amendments ({changeReport.length})
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {changeReport.map((c: any, i: number) => {
          const f = findingById.get(c.findingId);
          const sev = f ? SEV_META[f.severity] : null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catMeta = f ? (FINDING_CATEGORY_META as any)[f.category] : null;
          const anchorText = c.before || f?.evidence?.[0]?.quote || "";
          return (
            <div key={i} className="rounded-2xl border bg-card overflow-hidden flex flex-col shadow-sm">
              <div className={cn("h-1.5", sev?.accent ?? "bg-fuchsia-400")} />
              <div className="p-4 flex-1 flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {sev && (
                    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ring-1", sev.chip)}>
                      <sev.icon className="size-3" /> {sev.label}
                    </span>
                  )}
                  {catMeta && (
                    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                      {catMeta.label}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">{c.findingId}</span>
                </div>
                {c.section && (
                  <div className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1">
                    <Quote className="size-3" /> {c.section}
                  </div>
                )}
                <div className="text-sm font-bold leading-snug">{c.summary || "Change applied"}</div>
                {c.before && (
                  <div className="rounded-lg bg-red-50/60 border border-red-100 px-2.5 py-1.5">
                    <div className="text-[10px] font-bold text-red-400 mb-0.5">Before</div>
                    <div className="text-[11px] leading-relaxed line-clamp-3 line-through decoration-red-300">{c.before}</div>
                  </div>
                )}
                {c.after && (
                  <div className="rounded-lg bg-emerald-50/60 border border-emerald-100 px-2.5 py-1.5">
                    <div className="text-[10px] font-bold text-emerald-500 mb-0.5">After</div>
                    <div className="text-[11px] leading-relaxed line-clamp-3 text-emerald-900">{c.after}</div>
                  </div>
                )}
                {f?.description && (
                  <p className="text-[11px] text-muted-foreground italic leading-relaxed line-clamp-2">{f.description}</p>
                )}
                {anchorText && (
                  <div className="mt-auto pt-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 w-full text-xs gap-1.5"
                      onClick={() => setPeek({
                        id: c.findingId ?? `chg-${i}`,
                        title: c.summary || "Original location",
                        text: anchorText,
                        kind: f?.severity ?? "medium",
                        chip: sev ? { label: sev.label, className: sev.chip } : undefined,
                        reason: f?.description,
                        after: c.after,
                      })}
                    >
                      <Eye className="size-3.5" /> View original location
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {changeReport.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full text-center py-10">No change log recorded.</p>
        )}
      </div>

      <DocPeekDialog
        open={!!peek}
        onClose={() => setPeek(null)}
        fileUrl={sourceUrl}
        anchor={peek ? { id: peek.id, text: peek.text, kind: peek.kind } : null}
        title={peek?.title ?? ""}
        chip={peek?.chip}
        rail={peek && (
          <>
            {peek.reason && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Reason</div>
                <p className="text-xs leading-relaxed">{peek.reason}</p>
              </div>
            )}
            <div className="rounded-lg bg-red-50/60 border border-red-100 px-2.5 py-1.5">
              <div className="text-[10px] font-bold text-red-400 mb-0.5">Original (highlighted in the document)</div>
              <div className="text-[11px] leading-relaxed">{peek.text}</div>
            </div>
            {peek.after && (
              <div className="rounded-lg bg-emerald-50/60 border border-emerald-100 px-2.5 py-1.5">
                <div className="text-[10px] font-bold text-emerald-500 mb-0.5">Now reads (in the restructured copy)</div>
                <div className="text-[11px] leading-relaxed text-emerald-900">{peek.after}</div>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              This change is already applied in the restructured document — nothing to accept here.
            </p>
          </>
        )}
      />
    </div>
  );
}
