import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MD } from "@/components/md";
import { impactClasses } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sortChangesByPriority, diffWords, deriveSuggestedAction, autoBoldExecBullet } from "@/lib/change-utils";
import {
  FileText, ShieldCheck, Calendar, Activity,
  LayoutGrid, ListTree, ArrowRight, AlertCircle,
  FileSearch, Sparkles, TrendingUp, ArrowRightLeft
} from "lucide-react";

interface Props {
  report: any;
  changes: any[];
  impacts?: any[];
  view: "summary" | "table";
}

export function OverviewTab({ report, changes, impacts = [], view }: Props) {
  const summary = report?.summary_json ?? {};
  const counts = {
    high: changes.filter((c) => c.impact === "high").length,
    medium: changes.filter((c) => c.impact === "medium").length,
    low: changes.filter((c) => c.impact === "low").length,
  };

  // Map: chapter (normalised) -> list of full impact records (with location)
  const impactsByChapter = new Map<string, any[]>();
  for (const imp of impacts) {
    const key = (imp.chapter ?? "").trim().toLowerCase();
    if (!key) continue;
    const arr = impactsByChapter.get(key) ?? [];
    arr.push(imp);
    impactsByChapter.set(key, arr);
  }
  const impactsForChange = (chapter_ref: string): any[] => {
    const k = (chapter_ref ?? "").trim().toLowerCase();
    return impactsByChapter.get(k) ?? [];
  };

  // Sort: matched first, then HIGH → MED → LOW, then by SOP count desc
  const sortedChanges = sortChangesByPriority(changes, impactsForChange);

  if (view === "table") return <TableView changes={sortedChanges} impactsForChange={impactsForChange} />;
  
  const isSimulated = summary.is_simulated;

  return (
    <Accordion type="multiple" defaultValue={["s1", "s2", "s3", "s4", "s6"]} className="space-y-6">
      {isSimulated && (
        <Card className="p-4 bg-amber-500/10 border-amber-500/30 border glass-card animate-in-fade">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-full bg-amber-500/20 grid place-items-center shrink-0">
              <AlertCircle className="size-4 text-amber-600" />
            </div>
            <div className="text-sm">
              <span className="font-bold text-amber-900 dark:text-amber-400">Simulator Mode Active:</span>{" "}
              <span className="text-amber-800/80 dark:text-amber-400/80">
                The Google Gemini API account is currently suspended ({summary.simulator_reason}). 
                This report is served using high-fidelity 
                regulatory simulation to demonstrate the "Compliance Sentinel" Intelligence Engine.
              </span>
            </div>
          </div>
        </Card>
      )}

      <Slide id="s1" title="Executive Summary" icon={ShieldCheck}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in-fade">
          <BentoStat icon={FileText} label="Clauses Before" value={summary.before_count ?? "—"} />
          <BentoStat icon={TrendingUp} label="Clauses After" value={summary.after_count ?? "—"} />
          <BentoStat icon={Calendar} label="Effective Date" value={summary.effective_date ?? "—"} small />
          
          <Card className="md:col-span-3 p-5 glass-card border-primary/20 relative overflow-hidden bg-gradient-to-br from-primary/[0.02] to-transparent">
            <div className="flex items-center gap-3 mb-4">
              <div className="size-8 rounded-lg bg-primary/10 grid place-items-center shadow-inner">
                <Sparkles className="size-4 text-primary" />
              </div>
              <div>
                <h3 className="text-[10px] uppercase tracking-[0.2em] font-black text-primary/70">Intelligence Overview</h3>
                <h2 className="text-base font-display font-bold tracking-tight">Executive Regulatory Brief</h2>
              </div>
            </div>
            <div className="text-sm leading-relaxed font-medium text-foreground/90">
              {(() => {
                const bullets: string[] = Array.isArray(summary.executive)
                  ? summary.executive.filter((b: any) => typeof b === "string" && b.trim())
                  : typeof summary.executive === "string" && summary.executive.trim()
                    ? summary.executive.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x: string) => x.trim())
                    : [];
                return bullets.length > 0
                  ? <ul className="list-disc pl-5 space-y-2 marker:text-primary">{bullets.map((b, i) => <li key={i}><MD>{autoBoldExecBullet(b.trim())}</MD></li>)}</ul>
                  : <MD>{(summary.executive as any) ?? ""}</MD>;
              })()}
            </div>
          </Card>

          <Card className="md:col-span-3 p-5 glass-card bg-slate-950/[0.02] dark:bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-4">
              <div className="size-7 rounded-lg bg-amber-500/10 grid place-items-center">
                <Activity className="size-3.5 text-amber-600" />
              </div>
              <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Immediate Actions</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {(summary.immediate_actions ?? []).map((a: string, i: number) => (
                <div key={i} className="flex gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-white/20">
                  <span className="text-primary font-bold font-display text-base opacity-40 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                  <p className="text-xs font-medium leading-snug">{a}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Slide>

      <Slide id="s2" title="Key Changes & Tone Shift" icon={Activity}>
        <div className="space-y-4">
          {sortedChanges.map((c) => {
            const affected = impactsForChange(c.chapter_ref);
            const oldPolicyName = (summary as any)?.old_policy_name ?? undefined;
            const labels = diffLabels(c, report?.policy_name, oldPolicyName);
            const isNew = labels.kind === "new";
            const suggested = deriveSuggestedAction(c);
            return (
              <Card key={c.id} className="p-0 glass-card overflow-hidden border-primary/10">
                {/* Card header */}
                <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center shrink-0">
                      <Activity className="size-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-display font-bold text-base tracking-tight">{c.chapter_ref}</h3>
                      {c.change_summary && (
                        <p className="text-xs text-muted-foreground leading-snug mt-0.5">{c.change_summary}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.tone_shift && (
                      <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white dark:bg-slate-800 border text-[10px] font-semibold text-muted-foreground">
                        <ArrowRightLeft className="size-3 opacity-60" />
                        {c.tone_shift}
                      </div>
                    )}
                    <Badge className={cn("px-3 py-0.5 rounded-full text-[10px] font-black tracking-widest", impactClasses(c.impact))}>
                      {c.impact.toUpperCase()}
                    </Badge>
                  </div>
                </div>

                <div className="p-5 space-y-4">
                  <ChangeMeta change={c} />

                  {/* Suggested action — verb-led, scannable */}
                  <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 dark:bg-emerald-950/20 dark:border-emerald-800 px-4 py-3">
                    <Sparkles className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-300 mb-0.5">Suggested action</div>
                      <div className="text-sm text-emerald-900 dark:text-emerald-100 font-medium leading-snug">{suggested}</div>
                    </div>
                  </div>

                  {/* Before / After panels */}
                  {isNew ? (
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-100/80 dark:bg-emerald-900/30 border-b border-emerald-200 dark:border-emerald-800">
                        <Sparkles className="size-3.5 text-emerald-700 dark:text-emerald-400" />
                        <span className="text-[10px] uppercase tracking-widest font-black text-emerald-800 dark:text-emerald-300">
                          New obligation — {labels.afterLabel}
                        </span>
                      </div>
                      <div className="p-4 text-sm leading-relaxed text-foreground/90 font-medium">
                        <MD>{c.new_requirement}</MD>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-100/80 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700">
                        <span className="text-[10px] uppercase tracking-widest font-black text-slate-700 dark:text-slate-300">
                          What changed — {labels.beforeLabel} → {labels.afterLabel}
                        </span>
                        <span className="text-[9px] text-muted-foreground inline-flex items-center gap-1">
                          <span className="inline-block size-2 rounded-sm bg-rose-200 dark:bg-rose-900/50 border border-rose-300" /> removed
                          <span className="inline-block size-2 rounded-sm bg-emerald-200 dark:bg-emerald-900/50 border border-emerald-300 ml-1.5" /> added
                        </span>
                      </div>
                      <div className="p-4 text-sm leading-relaxed font-mono whitespace-pre-wrap">
                        <DiffInline oldText={c.old_requirement ?? ""} newText={c.new_requirement ?? ""} />
                      </div>
                    </div>
                  )}

                  <DiffSourceFooter labels={labels} />
                  <AffectedSOPs impacts={affected} />
                </div>
              </Card>
            );
          })}
        </div>
      </Slide>

      <Slide id="s3" title="Structural Changes" icon={ListTree}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StructBlock label="New Sections" tone="emerald" items={summary.structural?.added ?? []} icon={Sparkles} />
          <StructBlock label="Renamed" tone="blue" items={summary.structural?.renamed ?? []} icon={FileSearch} />
          <StructBlock label="Restructured" tone="amber" items={summary.structural?.restructured ?? []} icon={Activity} />
        </div>
      </Slide>

      <Slide id="s4" title="Impact Assessment" icon={LayoutGrid}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ImpactCount level="high" count={counts.high} label="High Impact" />
            <ImpactCount level="medium" count={counts.medium} label="Medium Impact" />
            <ImpactCount level="low" count={counts.low} label="Low Impact" />
          </div>
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Chapter</TableHead>
                  <TableHead className="w-[14%]">Pages</TableHead>
                  <TableHead>Legal & Related Instruments</TableHead>
                  <TableHead className="w-[22%]">Affected SOP File(s)</TableHead>
                  <TableHead className="w-[110px]">Impact</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.map((c) => {
                  const affected = impactsForChange(c.chapter_ref);
                  return (
                    <TableRow key={c.id} className="align-top">
                      <TableCell className="font-medium">{c.chapter_ref}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.pages ?? "—"}</TableCell>
                      <TableCell>
                        <RefList label="Legal" items={c.legal_refs} />
                        <RefList label="Related" items={c.related_instruments} />
                      </TableCell>
                      <TableCell>
                        {affected.length === 0 ? (
                          <span className="text-xs text-muted-foreground italic">
                            No matching SOP in Knowledge Base
                          </span>
                        ) : (
                          <ul className="space-y-1.5">
                            {affected.map((imp: any, i: number) => (
                              <li key={imp.id ?? i} className="text-[11px] leading-snug">
                                <div className="font-medium">{imp.sop_title}</div>
                                <div className="text-muted-foreground">
                                  {[imp.paragraph, imp.page ? `p. ${imp.page}` : null, imp.line_range ? `ll. ${imp.line_range}` : null]
                                    .filter(Boolean).join(" · ")}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={impactClasses(c.impact)}>
                          {c.impact.toUpperCase()}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </div>
      </Slide>

      <Slide id="s6" title="Recommended Next Steps">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(summary.timeline ?? []).map((p: any, i: number) => (
            <Card key={i} className="p-5 flex flex-col">
              <div className="flex items-center gap-3 mb-3">
                <div className="size-10 rounded-full bg-primary text-primary-foreground grid place-items-center font-display font-semibold shrink-0">
                  {i + 1}
                </div>
                <div className="min-w-0">
                  <div className="font-display font-semibold leading-tight">{p.phase}</div>
                  <div className="text-xs text-muted-foreground">{p.window}</div>
                </div>
              </div>
              {p.focus && <p className="text-sm leading-relaxed text-muted-foreground">{p.focus}</p>}
              {Array.isArray(p.bullets) && p.bullets.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm">
                  {p.bullets.map((b: string, bi: number) => (
                    <li key={bi} className="flex gap-2">
                      <span className="text-primary mt-0.5">•</span>
                      <span className="leading-snug">{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      </Slide>
    </Accordion>
  );
}

function diffLabels(c: any, newPolicyName?: string, oldPolicyName?: string) {
  const newDoc = newPolicyName || "updated policy";
  const oldDoc = oldPolicyName || "previous version";
  const isNewRequirement =
    !c?.old_requirement ||
    c.old_requirement === "N/A" ||
    (c.old_requirement as string).toLowerCase().startsWith("n/a");

  if (isNewRequirement) {
    return {
      kind: "new" as const,
      showBefore: false,
      beforeLabel: "",
      afterLabel: `New requirement (per ${newDoc})`,
      footer: `New obligation introduced in ${newDoc} — no equivalent existed in ${oldDoc}.`,
      comparedAgainst: [] as string[],
    };
  }
  return {
    kind: "document" as const,
    showBefore: true,
    beforeLabel: `Previous wording (per ${oldDoc})`,
    afterLabel: `Updated wording (per ${newDoc})`,
    footer: oldPolicyName
      ? `Compared ${newDoc} against ${oldDoc} from Knowledge Base.`
      : `Diff extracted from ${newDoc}.`,
    comparedAgainst: oldPolicyName ? [oldDoc] : [],
  };
}

function DiffInline({ oldText, newText }: { oldText: string; newText: string }) {
  const segs = diffWords(oldText ?? "", newText ?? "");
  return (
    <span>
      {segs.map((s, i) => {
        if (s.type === "eq") return <span key={i}>{s.text}</span>;
        if (s.type === "del") return <span key={i} className="bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 line-through decoration-rose-400 decoration-2 rounded px-0.5">{s.text}</span>;
        return <span key={i} className="bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 font-semibold rounded px-0.5">{s.text}</span>;
      })}
    </span>
  );
}

function DiffSourceFooter({ labels }: { labels: ReturnType<typeof diffLabels> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "text-[9px] uppercase tracking-wide",
            labels.kind === "document" && "bg-blue-50 text-blue-900 border-blue-200",
            labels.kind === "new" && "bg-emerald-50 text-emerald-900 border-emerald-200",
          )}
        >
          {labels.kind === "document" ? "KB comparison" : "New mandate"}
        </Badge>
        <span className="leading-snug">{labels.footer}</span>
      </div>
      {labels.kind === "document" && labels.comparedAgainst.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="font-medium">Compared against:</span>
          {labels.comparedAgainst.map((d: string) => (
            <Badge key={d} variant="outline" className="text-[10px] font-normal bg-card">
              {d}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function Slide({ id, title, icon: Icon, children }: { id: string; title: string; icon?: any; children: React.ReactNode }) {
  return (
    <AccordionItem value={id} className="border-0">
      <Card className="p-0 overflow-hidden shadow-none border-0 bg-transparent">
        <AccordionTrigger className="px-2 py-4 hover:no-underline rounded-xl hover:bg-accent/50 transition-all data-[state=open]:mb-4 group">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm grid place-items-center text-primary group-data-[state=open]:bg-primary group-data-[state=open]:text-white transition-colors">
              {Icon && <Icon className="size-5" />}
            </div>
            <span className="font-display font-bold text-lg tracking-tight text-foreground/90">{title}</span>
          </div>
        </AccordionTrigger>
        <AccordionContent className="pb-4 pt-1">
          {children}
        </AccordionContent>
      </Card>
    </AccordionItem>
  );
}

function BentoStat({ label, value, icon: Icon, small }: { label: string; value: any; icon?: any; small?: boolean }) {
  return (
    <Card className="p-4 glass-card group hover:border-primary/30 transition-all">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-bold">{label}</div>
        <div className="size-7 rounded-lg bg-slate-100 dark:bg-slate-800 grid place-items-center group-hover:bg-primary/10 group-hover:text-primary transition-colors">
          {Icon && <Icon className="size-3.5 opacity-70" />}
        </div>
      </div>
      <div className={cn("font-display font-bold tracking-tighter", small ? "text-xl" : "text-3xl")}>
        {value}
      </div>
    </Card>
  );
}

function StructBlock({ label, items, tone, icon: Icon }: { label: string; items: string[]; tone: "emerald" | "blue" | "amber"; icon?: any }) {
  const tones = {
    emerald: "from-emerald-50 to-emerald-100/30 border-emerald-200 text-emerald-900 dark:from-emerald-950/20 dark:to-emerald-900/10 dark:border-emerald-800 dark:text-emerald-300",
    blue: "from-blue-50 to-blue-100/30 border-blue-200 text-blue-900 dark:from-blue-950/20 dark:to-blue-900/10 dark:border-blue-800 dark:text-blue-300",
    amber: "from-amber-50 to-amber-100/30 border-amber-200 text-amber-900 dark:from-amber-950/20 dark:to-amber-900/10 dark:border-amber-800 dark:text-amber-300",
  };
  
  return (
    <Card className={cn("p-6 border bg-gradient-to-br shadow-sm", tones[tone])}>
      <div className="flex items-center gap-2 mb-4">
        <div className="size-7 rounded-lg bg-white/50 dark:bg-black/20 grid place-items-center">
          {Icon && <Icon className="size-4 opacity-70" />}
        </div>
        <div className="text-[10px] uppercase tracking-widest font-bold opacity-70">{label}</div>
      </div>
      <ul className="space-y-2.5">
        {items.length === 0 && <li className="text-xs italic opacity-50">None identified</li>}
        {items.map((it, i) => (
          <li key={i} className="text-sm font-medium flex gap-2">
            <span className="opacity-40">•</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ImpactCount({ level, count, label }: { level: "high" | "medium" | "low"; count: number; label: string }) {
  const colors = {
    high: "bg-red-500/10 text-red-600 border-red-200 dark:border-red-900",
    medium: "bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-900",
    low: "bg-emerald-500/10 text-emerald-600 border-emerald-200 dark:border-emerald-900",
  };
  
  return (
    <Card className={cn("p-8 glass-card border-2 flex flex-col items-center justify-center text-center", colors[level])}>
      <div className="text-6xl font-display font-black tracking-tighter mb-1">{count}</div>
      <div className="text-xs uppercase tracking-[0.2em] font-bold opacity-80">{label}</div>
    </Card>
  );
}

function AffectedSOPs({ impacts }: { impacts: any[] }) {
  if (impacts.length === 0) {
    return (
      <div className="mt-6 flex items-center gap-2 p-3 rounded-lg bg-slate-100/50 dark:bg-slate-800/50 border border-dashed text-[11px] text-muted-foreground">
        <AlertCircle className="size-3" />
        No matching internal SOP found for this clause.
      </div>
    );
  }
  return (
    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
          Impacted internal policies
        </div>
        <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
      </div>
      <div className="space-y-2">
        {impacts.map((imp, i) => {
          const loc = [
            imp.paragraph,
            imp.page ? `p. ${imp.page}` : null,
          ].filter(Boolean).join(" · ");
          return (
            <div key={imp.id ?? i} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-100 dark:border-slate-800">
              <div>
                <div className="text-xs font-semibold text-foreground/90 truncate">{imp.sop_title}</div>
                {loc && <div className="text-[10px] text-muted-foreground">{loc}</div>}
              </div>
              <Badge variant="secondary" className="text-[9px] font-bold uppercase tracking-tight h-5 shrink-0">
                {imp.change_type?.replace(/_/g, " ") || "Review"}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChangeMeta({ change }: { change: any }) {
  const hasAny = change.pages || (change.legal_refs?.length ?? 0) > 0 || (change.related_instruments?.length ?? 0) > 0;
  if (!hasAny) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <MetaCell label="Pages" value={change.pages || "—"} icon={FileText} />
      <MetaCell label="Legal Ref" value={(change.legal_refs ?? []).join(" · ") || "—"} icon={ShieldCheck} />
      <MetaCell label="Related" value={(change.related_instruments ?? []).join(" · ") || "—"} icon={ListTree} />
    </div>
  );
}

function MetaCell({ label, value, icon: Icon }: { label: string; value: string; icon?: any }) {
  return (
    <div className="p-3 rounded-xl border bg-slate-50/50 dark:bg-slate-900/50">
      <div className="flex items-center gap-1.5 mb-1.5">
        {Icon && <Icon className="size-3 text-muted-foreground" />}
        <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">{label}</div>
      </div>
      <div className="text-xs font-semibold tracking-tight truncate">{value}</div>
    </div>
  );
}

function RefList({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="text-[11px] leading-tight mb-1 last:mb-0">
      <span className="text-muted-foreground font-medium mr-1">{label}:</span>
      <span className="font-medium">{items.join(" · ")}</span>
    </div>
  );
}

function TableView({
  changes,
  impactsForChange,
}: {
  changes: any[];
  impactsForChange: (chapter_ref: string) => any[];
}) {
  return (
    <Card className="p-0 overflow-hidden glass-card border-0 shadow-2xl">
      <Table>
        <TableHeader className="bg-slate-50 dark:bg-slate-900/50">
          <TableRow className="hover:bg-transparent border-slate-200 dark:border-slate-800">
            <TableHead className="w-[140px] font-bold text-foreground">Chapter</TableHead>
            <TableHead className="w-[90px] font-bold text-foreground">Pages</TableHead>
            <TableHead className="font-bold text-foreground">Old Requirement</TableHead>
            <TableHead className="font-bold text-foreground">New Requirement</TableHead>
            <TableHead className="w-[170px] font-bold text-foreground">Legal & Related</TableHead>
            <TableHead className="w-[200px] font-bold text-foreground">Impacted Policies</TableHead>
            <TableHead className="w-[80px] font-bold text-foreground">Impact</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changes.map((c) => {
            const affected = impactsForChange(c.chapter_ref);
            return (
              <TableRow key={c.id} className="align-top border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                <TableCell className="font-bold">{c.chapter_ref}</TableCell>
                <TableCell className="text-[11px] text-muted-foreground font-medium">{c.pages ?? "—"}</TableCell>
                <TableCell className="text-xs leading-relaxed opacity-60 italic">{c.old_requirement}</TableCell>
                <TableCell className="text-xs leading-relaxed font-medium"><MD>{c.new_requirement ?? ""}</MD></TableCell>
                <TableCell className="text-[11px]">
                  <RefList label="Legal" items={c.legal_refs} />
                  <RefList label="Related" items={c.related_instruments} />
                  {(!c.legal_refs?.length && !c.related_instruments?.length) && (
                    <span className="text-muted-foreground italic">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {affected.length === 0 ? (
                    <span className="text-muted-foreground italic opacity-50">— None found</span>
                  ) : (
                    <div className="space-y-2">
                      {affected.map((imp: any, i: number) => (
                        <div key={imp.id ?? i} className="text-[11px] leading-tight">
                          <div className="font-bold text-primary/80">{imp.sop_title}</div>
                          <div className="text-muted-foreground text-[10px] mt-0.5">
                            {[imp.paragraph, imp.page ? `p. ${imp.page}` : null].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn("px-2 py-0.5 rounded-full text-[9px] font-bold", impactClasses(c.impact))}>
                    {c.impact.toUpperCase()}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
