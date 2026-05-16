import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { MD } from "@/components/md";
import { impactClasses } from "@/lib/format";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/reports/$reportId/present")({
  component: Present,
  head: () => ({ meta: [{ title: "Presentation · Compliance AI" }] }),
});

function Present() {
  const { reportId } = Route.useParams();
  const report = useQuery({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analysis_reports").select("*").eq("id", reportId).single();
      if (error) throw error;
      return data;
    },
  });
  const changes = useQuery({
    queryKey: ["changes", reportId],
    queryFn: async () => {
      const { data } = await supabase
        .from("regulatory_changes").select("*").eq("report_id", reportId).order("position");
      return data ?? [];
    },
  });
  const impactsQ = useQuery({
    queryKey: ["impacts", reportId],
    queryFn: async () => {
      const { data } = await supabase
        .from("sop_impacts").select("*").eq("report_id", reportId).order("position");
      return data ?? [];
    },
  });

  if (report.isLoading) return <div className="p-10">Loading…</div>;
  if (!report.data) throw notFound();
  const r: any = report.data;
  const s: any = r.summary_json ?? {};
  const c = changes.data ?? [];
  const impacts = impactsQ.data ?? [];
  const impactsByChapter = new Map<string, any[]>();
  for (const imp of impacts) {
    const key = String(imp.chapter ?? "").trim().toLowerCase();
    if (!key) continue;
    const arr = impactsByChapter.get(key) ?? [];
    arr.push(imp);
    impactsByChapter.set(key, arr);
  }
  const impactsForChapter = (ref: string) =>
    impactsByChapter.get(String(ref ?? "").trim().toLowerCase()) ?? [];
  const counts = {
    high: c.filter((x) => x.impact === "high").length,
    medium: c.filter((x) => x.impact === "medium").length,
    low: c.filter((x) => x.impact === "low").length,
  };

  return (
    <div className="bg-background min-h-screen">
      <div className="no-print sticky top-0 bg-card border-b z-10 px-6 py-3 flex justify-between items-center">
        <div className="font-display font-semibold">{r.title}</div>
        <Button onClick={() => window.print()} className="gap-2">
          <Printer className="size-4" /> Print / Save as PDF
        </Button>
      </div>

      <div className="max-w-[1400px] mx-auto p-8 space-y-8">
        <SlideBox n={1} title="Executive Summary">
          <div className="grid grid-cols-3 gap-6">
            <Stat label="Clauses Before" value={s.before_count ?? "—"} />
            <Stat label="Clauses After" value={s.after_count ?? "—"} />
            <Stat label="Effective Date" value={s.effective_date ?? "—"} />
          </div>
          <div className="mt-6 p-6 bg-primary/5 border border-primary/20 rounded-xl">
            <MD>{s.executive ?? ""}</MD>
          </div>
          <div className="mt-4">
            <h3 className="font-display font-semibold mb-2">Immediate Actions</h3>
            <ol className="space-y-2 text-base">
              {(s.immediate_actions ?? []).map((a: string, i: number) => (
                <li key={i}><span className="font-semibold text-primary">{i + 1}.</span> {a}</li>
              ))}
            </ol>
          </div>
        </SlideBox>

        <SlideBox n={2} title="Key Changes & Tone Shift">
          <div className="grid grid-cols-2 gap-5">
            {c.slice(0, 4).map((ch) => {
              const labels = diffLabels(ch, r.policy_name);
              const affected = impactsForChapter(ch.chapter_ref);
              return (
                <div key={ch.id} className="p-5 border rounded-xl bg-card">
                  <div className="flex justify-between items-center mb-3">
                    <div className="font-display font-semibold">{ch.chapter_ref}</div>
                    <Badge variant="outline" className={impactClasses(ch.impact)}>{ch.impact.toUpperCase()}</Badge>
                  </div>
                  {labels.showBefore && (
                    <>
                      <div className="text-xs text-muted-foreground mb-1">{labels.beforeLabel}</div>
                      <div className="text-sm bg-muted p-3 rounded mb-3">{ch.old_requirement}</div>
                    </>
                  )}
                  <div className="text-xs text-muted-foreground mb-1">{labels.afterLabel}</div>
                  <div className="text-sm bg-primary/5 border border-primary/20 p-3 rounded"><MD>{ch.new_requirement ?? ""}</MD></div>
                  <div className="mt-3 text-[11px] text-muted-foreground rounded border bg-muted/30 px-2.5 py-1.5 leading-snug">
                    {labels.footer}
                    {labels.kind === "kb" && labels.comparedAgainst.length > 0 && (
                      <div className="mt-1">
                        <span className="font-medium">Compared against: </span>
                        {labels.comparedAgainst.join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 pt-3 border-t border-dashed">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      Affected SOP file(s)
                    </div>
                    {affected.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground italic">No matching SOP found in your Knowledge Base.</div>
                    ) : (
                      <ul className="space-y-1.5">
                        {affected.map((imp: any, i: number) => {
                          const loc = [
                            imp.paragraph,
                            imp.page ? `p. ${imp.page}` : null,
                            imp.line_range ? `ll. ${imp.line_range}` : null,
                            imp.change_type ? String(imp.change_type).replace(/_/g, " ") : null,
                          ].filter(Boolean).join(" · ");
                          return (
                            <li key={imp.id ?? i} className="text-[11px] leading-snug">
                              <span className="font-medium">{imp.sop_title}</span>
                              {loc && <span className="text-muted-foreground"> — {loc}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </SlideBox>

        <SlideBox n={3} title="Structural Changes">
          <div className="grid grid-cols-3 gap-5">
            <Block label="New Sections" tone="bg-emerald-50 border-emerald-200" items={s.structural?.added ?? []} />
            <Block label="Renamed" tone="bg-blue-50 border-blue-200" items={s.structural?.renamed ?? []} />
            <Block label="Restructured" tone="bg-amber-50 border-amber-200" items={s.structural?.restructured ?? []} />
          </div>
        </SlideBox>

        <SlideBox n={4} title="Impact Breakdown">
          <div className="grid grid-cols-3 gap-5">
            <BigStat n={counts.high} label="High" cls={impactClasses("high")} />
            <BigStat n={counts.medium} label="Medium" cls={impactClasses("medium")} />
            <BigStat n={counts.low} label="Low" cls={impactClasses("low")} />
          </div>
        </SlideBox>

        <SlideBox n={5} title="Impact Assessment Summary">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-primary text-primary-foreground">
                <th className="text-left p-3 rounded-tl-lg">Chapter</th>
                <th className="text-left p-3 rounded-tr-lg w-48">Impact Level</th>
              </tr>
            </thead>
            <tbody>
              {c.map((ch, i) => (
                <tr key={ch.id} className={i % 2 ? "bg-muted/40" : ""}>
                  <td className="p-3 border-t font-medium">{ch.chapter_ref}</td>
                  <td className="p-3 border-t">
                    <Badge variant="outline" className={impactClasses(ch.impact)}>{ch.impact.toUpperCase()}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SlideBox>

        <SlideBox n={6} title="Recommended Next Steps">
          <div className="grid grid-cols-3 gap-5">
            {(s.timeline ?? []).map((p: any, i: number) => (
              <div key={i} className="p-5 border rounded-xl bg-card flex flex-col">
                <div className="size-12 rounded-full bg-primary text-primary-foreground grid place-items-center font-display font-bold text-lg mb-3">
                  {i + 1}
                </div>
                <div className="font-display font-semibold">{p.phase}</div>
                <div className="text-xs text-muted-foreground">{p.window}</div>
                {p.focus && <p className="text-sm mt-3 text-muted-foreground leading-relaxed">{p.focus}</p>}
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
              </div>
            ))}
          </div>
        </SlideBox>
      </div>
    </div>
  );
}

function SlideBox({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="slide bg-card border rounded-2xl p-8 shadow-sm">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b">
        <div className="size-10 rounded-lg bg-primary text-primary-foreground grid place-items-center font-display font-bold">
          {n}
        </div>
        <h2 className="font-display text-2xl font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}
function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="p-5 border rounded-xl">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-3xl font-display font-semibold mt-2">{value}</div>
    </div>
  );
}
function BigStat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className={`p-6 rounded-xl border ${cls}`}>
      <div className="text-6xl font-display font-bold">{n}</div>
      <div className="mt-2 font-medium">{label} Impact</div>
    </div>
  );
}
function Block({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div className={`p-5 border rounded-xl ${tone}`}>
      <div className="font-display font-semibold mb-2">{label}</div>
      <ul className="space-y-1.5 text-sm">
        {items.length === 0 && <li className="text-muted-foreground italic">None</li>}
        {items.map((x, i) => <li key={i}>• {x}</li>)}
      </ul>
    </div>
  );
}

function diffLabels(c: any, policyName?: string) {
  const src = c?.diff_source ?? "document";
  const doc = policyName || "this regulatory document";
  if (src === "new") {
    return {
      kind: "new" as const,
      showBefore: false,
      beforeLabel: "",
      afterLabel: "New requirement",
      footer: `New mandate introduced by ${doc} — no prior wording exists.`,
      comparedAgainst: [] as string[],
    };
  }
  if (src === "kb") {
    return {
      kind: "kb" as const,
      showBefore: true,
      beforeLabel: "Current state (per Knowledge Base)",
      afterLabel: `New requirement (per ${doc})`,
      footer: `Reconstructed by comparing ${doc} against your Knowledge Base.`,
      comparedAgainst: (c?.compared_against ?? []) as string[],
    };
  }
  return {
    kind: "document" as const,
    showBefore: true,
    beforeLabel: `Previous wording (per ${doc})`,
    afterLabel: `Updated wording (per ${doc})`,
    footer: `Diff is stated directly inside ${doc}.`,
    comparedAgainst: [] as string[],
  };
}
