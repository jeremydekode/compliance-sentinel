import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { runCreditRiskAnalysis } from "@/lib/compliance.functions";
import {
  CREDIT_RISK_SEGMENTS,
  type CreditRiskAnalysis,
  type CreditRiskIndicator,
  type CreditRiskFinding,
} from "@/lib/gemini";
import { downloadCreditRiskDocx } from "@/lib/credit-docx";
import { PdfHighlight } from "@/components/pdf-highlight";
import { CreditChat } from "@/components/credit-chat";
import Markdown from "react-markdown";
import { formatDate } from "@/lib/format";
import { computeCost, formatUsd, formatTokens, type TokenUsage } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft,
  MessageSquare,
  ChevronDown,
  Activity,
  Newspaper,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  FileText,
  Sparkles,
  Info,
  Coins,
  Download,
  HelpCircle,
  ScrollText,
  Quote,
  CheckCircle2,
  XCircle,
  CircleDot,
  BookOpen,
  ExternalLink,
  FileSearch,
} from "lucide-react";

export const Route = createFileRoute("/credit/$reportId")({
  component: CreditReportPage,
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

const IND_META: Record<
  CreditRiskIndicator,
  { label: string; classes: string; dot: string; tile: string; icon: typeof ShieldAlert; rank: number }
> = {
  high: {
    label: "High risk",
    classes: "bg-rose-100 text-rose-800 border-rose-200",
    dot: "bg-rose-500",
    tile: "border-rose-200 bg-rose-50/60 text-rose-700",
    icon: ShieldAlert,
    rank: 0,
  },
  probe: {
    label: "Probe",
    classes: "bg-amber-100 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
    tile: "border-amber-200 bg-amber-50/60 text-amber-700",
    icon: ShieldQuestion,
    rank: 1,
  },
  low: {
    label: "Low",
    classes: "bg-emerald-100 text-emerald-800 border-emerald-200",
    dot: "bg-emerald-500",
    tile: "border-emerald-200 bg-emerald-50/60 text-emerald-700",
    icon: ShieldCheck,
    rank: 2,
  },
};

const ALERT_META: Record<
  "pass" | "fail" | "probe",
  { label: string; classes: string; icon: typeof CheckCircle2 }
> = {
  pass: { label: "Pass", classes: "bg-emerald-100 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
  fail: { label: "Fail", classes: "bg-rose-100 text-rose-800 border-rose-200", icon: XCircle },
  probe: { label: "Probe", classes: "bg-amber-100 text-amber-800 border-amber-200", icon: CircleDot },
};

const FIN_SEV: Record<"high" | "medium" | "low", { dot: string }> = {
  high: { dot: "bg-rose-500" },
  medium: { dot: "bg-amber-500" },
  low: { dot: "bg-slate-400" },
};

// ── helpers ────────────────────────────────────────────────────────────────

/** Strip the noisy "Hong Leong Bank Berhad Mail Fwd/Re" prefix from KB titles. */
function cleanCaseTitle(t: string): string {
  return (
    t
      .replace(/^hong leong bank berhad mail (fwd|re)\s*/i, "")
      .replace(/\s{2,}/g, " ")
      .trim() || t
  );
}

/** Split "<observation>. This mirrors [Case XX] logic, which warns that <lesson>." */
function splitFinding(finding: string): { observation: string; lesson: string } {
  const idx = finding.search(/this mirrors/i);
  if (idx === -1) return { observation: finding.trim(), lesson: "" };
  const observation = finding.slice(0, idx).trim().replace(/[.\s]+$/, "");
  const rest = finding.slice(idx);
  const warnIdx = rest.search(/which warns that/i);
  let lesson = warnIdx === -1 ? "" : rest.slice(warnIdx + "which warns that".length).trim();
  lesson = lesson.replace(/^[,:\s]+/, "");
  if (lesson) lesson = lesson.charAt(0).toUpperCase() + lesson.slice(1);
  return { observation: observation || finding.trim(), lesson };
}

/** Bold the match terms inside a block of text (case-insensitive, exact term). */
function Highlighted({ text, terms }: { text: string; terms?: string[] }) {
  const clean = (terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!text) return null;
  if (clean.length === 0) return <>{text}</>;
  const escaped = clean
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        p && clean.some((t) => t.toLowerCase() === p.toLowerCase()) ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 font-semibold text-amber-900">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/* Markdown styling for the executive-summary narrative (prose + bold bullets). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NARRATIVE_MD: any = {
  p: ({ children }: any) => <p className="mb-3 break-inside-avoid">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-3 space-y-1.5 break-inside-avoid">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-3 space-y-1.5 break-inside-avoid">{children}</ol>,
  li: ({ children }: any) => <li className="leading-snug break-inside-avoid">{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
};

/** Calm, readable section heading (sentence case) — replaces all-caps eyebrows. */
function SectionHeading({
  icon: Icon,
  children,
  sub,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <h2 className="font-bold text-base tracking-tight flex items-center gap-2">
        {Icon && <Icon className="size-4 text-red-600 shrink-0" />}
        {children}
      </h2>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** Small inline tag showing where a mitigation comes from. */
function MitigationTag({
  source,
  reference,
}: {
  source: "case" | "policy" | "best_practice";
  reference?: string;
}) {
  const cls =
    source === "case"
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : source === "policy"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : "bg-slate-50 text-slate-600 border-slate-200";
  const label =
    source === "case"
      ? reference
        ? cleanCaseTitle(reference)
        : "case"
      : source === "policy"
        ? reference || "policy"
        : "best practice";
  return (
    <Badge variant="outline" className={cn("text-[9px] font-medium align-middle ml-0.5", cls)}>
      {label}
    </Badge>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

function CreditReportPage() {
  const { reportId } = Route.useParams();
  const qc = useQueryClient();
  const runAnalysisFn = useServerFn(runCreditRiskAnalysis);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [filter, setFilter] = useState<"all" | CreditRiskIndicator>("all");
  const [chatOpen, setChatOpen] = useState(false);
  const [selected, setSelected] = useState<CreditRiskFinding | null>(null);
  const startedRef = useRef(false);

  const report = useQuery({
    queryKey: ["credit_report", reportId],
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
  const analysis: CreditRiskAnalysis | undefined = sj.credit_analysis;

  async function runAnalysis() {
    setFailed(false);
    setAnalyzing(true);
    startedRef.current = true;
    try {
      await runAnalysisFn({ data: { reportId } });
      await qc.invalidateQueries({ queryKey: ["credit_report", reportId] });
    } catch (e: any) {
      setFailed(true);
      toast.error("Credit risk analysis didn't finish", { description: e?.message?.slice(0, 200) });
    } finally {
      setAnalyzing(false);
    }
  }

  // Auto-run once for a freshly created report.
  useEffect(() => {
    if (startedRef.current) return;
    if (report.isLoading || !report.data) return;
    if (sj.pending_analysis) runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.isLoading, report.data]);

  async function handleDownload() {
    if (!analysis || downloading) return;
    setDownloading(true);
    try {
      await downloadCreditRiskDocx(analysis, {
        borrowerName: sj.borrower_name ?? (report.data as any)?.title ?? "Applicant",
        sourceFilename: sj.source_filename,
        generatedAt: formatDate(new Date().toISOString()),
      });
    } catch (e: any) {
      toast.error("Couldn't generate the Word document", { description: e?.message?.slice(0, 200) });
    } finally {
      setDownloading(false);
    }
  }

  // ── early returns ──
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
  const title = ((report.data as any).title as string) ?? "Credit application";
  const borrower = sj.borrower_name ?? title;
  const runFailed = failed || sj.credit_status === "failed";
  const isAnalyzing = analyzing || (sj.pending_analysis && !startedRef.current);

  if (isAnalyzing) {
    return (
      <AppShell>
        <CreditAnalyzingView borrower={borrower} failed={false} error={null} onRetry={runAnalysis} />
      </AppShell>
    );
  }
  if (runFailed || !analysis) {
    return (
      <AppShell>
        <CreditAnalyzingView
          borrower={borrower}
          failed
          error={sj.credit_error ?? null}
          onRetry={runAnalysis}
        />
      </AppShell>
    );
  }

  // ── completed render ──
  const byKey = new Map(analysis.riskTable.map((f) => [f.segment, f] as const));
  const counts = { high: 0, probe: 0, low: 0 } as Record<CreditRiskIndicator, number>;
  for (const { key } of CREDIT_RISK_SEGMENTS) counts[byKey.get(key)?.indicator ?? "low"]++;

  // High-risk first, then probe, then low; within a tier, higher confidence first.
  const ordered = CREDIT_RISK_SEGMENTS.map(({ key, label }) => ({ key, label, finding: byKey.get(key) }));
  ordered.sort((a, b) => {
    const r = IND_META[a.finding?.indicator ?? "low"].rank - IND_META[b.finding?.indicator ?? "low"].rank;
    return r !== 0 ? r : (b.finding?.confidence ?? 0) - (a.finding?.confidence ?? 0);
  });
  const shown = ordered.filter((o) => filter === "all" || (o.finding?.indicator ?? "low") === filter);

  // For the recap: the prose verdict (lead, before the "Key concerns" list) +
  // a structured pairing of each flagged concern with its mitigation plan.
  const narrative = analysis.riskNarrative || "";
  const kIdx = narrative.search(/\n\*\*\s*Key concern/i);
  const narrLead = kIdx > 0 ? narrative.slice(0, kIdx).trim() : narrative;
  const concerns = ordered.filter((o) => o.finding && (o.finding.indicator ?? "low") !== "low");

  const overall = IND_META[analysis.overallRisk] ?? IND_META.probe;
  const usage: TokenUsage | undefined = sj.usage;
  const cost = usage ? computeCost(usage) : null;

  return (
    <AppShell>
      <div className="p-8 max-w-[1200px] mx-auto space-y-6">
        {/* header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to="/reports"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3" /> All credit analyses
            </Link>
            <div className="flex items-center gap-3 mt-1">
              <h1 className="text-3xl font-bold tracking-tight truncate">{borrower}</h1>
              <Badge
                variant="outline"
                className={cn("font-bold text-[11px] uppercase tracking-wide shrink-0", overall.classes)}
              >
                <span className={cn("size-1.5 rounded-full mr-1.5", overall.dot)} />
                Overall · {overall.label}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Credit Risk Alert · screened across 8 dimensions — open any flag to see the source page in
              the application and the case it mirrors.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => setChatOpen(true)}
              className="gap-2 border-red-200 text-red-700 hover:bg-red-50"
            >
              <MessageSquare className="size-4" /> Ask AI
            </Button>
            <Button
              onClick={handleDownload}
              disabled={downloading}
              className="gap-2 bg-red-600 hover:bg-red-700 text-white"
            >
              {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Download .docx
            </Button>
            <Button variant="outline" onClick={runAnalysis} className="gap-2">
              <RefreshCw className="size-4" /> Re-run
            </Button>
          </div>
        </div>

        {/* provenance strip */}
        <Card className="p-0 overflow-hidden glass-card">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-border/60">
            <Provenance icon={<FileText className="size-4" />} label="Source" value={sj.source_filename ?? "—"} />
            <Provenance
              icon={<ScrollText className="size-4" />}
              label="Cases referenced"
              value={String(analysis.referencesUsed?.length ?? 0)}
            />
            <Provenance icon={<ShieldAlert className="size-4" />} label="High-risk flags" value={String(counts.high)} />
            <Provenance
              icon={<Sparkles className="size-4" />}
              label="Analysed"
              value={cost ? formatUsd(cost.usd) : "done"}
              info={cost ? <CostBreakdown usage={usage!} /> : undefined}
            />
          </div>
        </Card>

        {/* counts — click to filter */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <CountTile
            indicator="high"
            count={counts.high}
            active={filter === "high"}
            onClick={() => setFilter((f) => (f === "high" ? "all" : "high"))}
            desc="Significant policy mismatch or a clear match to a historical failure."
          />
          <CountTile
            indicator="probe"
            count={counts.probe}
            active={filter === "probe"}
            onClick={() => setFilter((f) => (f === "probe" ? "all" : "probe"))}
            desc="Ambiguous data, thin margins, or something needing verification."
          />
          <CountTile
            indicator="low"
            count={counts.low}
            active={filter === "low"}
            onClick={() => setFilter((f) => (f === "low" ? "all" : "low"))}
            desc="Aligns with policy — no historical red-flag pattern."
          />
        </div>

        {/* application overview — the factual borrower/facilities summary */}
        <Card className="p-5 glass-card space-y-2">
          <SectionHeading icon={FileText}>Application overview</SectionHeading>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
            {analysis.applicationSummary || "—"}
          </p>
        </Card>

        {/* risk radar — side-by-side findings */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-lg tracking-tight">Risk Radar</h2>
              <span className="text-xs text-muted-foreground">
                · sorted by severity — click a risk for the detail; view source for the PDFs
              </span>
            </div>
            {filter !== "all" && (
              <button
                onClick={() => setFilter("all")}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Showing {filter} only · clear filter
              </button>
            )}
          </div>
          <div className="space-y-2">
            {shown.map(({ key, label, finding }) => (
              <TriageRow key={key} label={label} finding={finding} onView={() => finding && setSelected(finding)} />
            ))}
          </div>
        </div>

        {/* financial checks — forensic anomalies/inconsistencies in the statements */}
        {(analysis.financialAnomalies?.length ?? 0) > 0 && (
          <Card className="p-5 glass-card space-y-3">
            <SectionHeading icon={Activity} sub="inconsistencies & anomalies in the financial statements">
              Financial checks
            </SectionHeading>
            <div className="space-y-2">
              {analysis.financialAnomalies!.map((a, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
                  <span
                    className={cn("size-2 rounded-full mt-1.5 shrink-0", (FIN_SEV[a.severity] ?? FIN_SEV.medium).dot)}
                    title={`${a.severity} severity`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{a.label}</span>
                      <Badge variant="outline" className="text-[9px] uppercase tracking-wide bg-muted/50 text-muted-foreground">
                        {a.category}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5 leading-snug">{a.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* adverse news — external negative screening (Google Search grounded) */}
        {analysis.adverseNews && (analysis.adverseNews.summary || (analysis.adverseNews.sources?.length ?? 0) > 0) && (
          <Card className="p-5 glass-card space-y-3">
            <SectionHeading icon={Newspaper} sub="external web / news screening">
              Adverse news screening
            </SectionHeading>
            {analysis.adverseNews.summary && (
              <div className="text-sm leading-relaxed text-foreground/90">
                <Markdown components={NARRATIVE_MD}>{analysis.adverseNews.summary}</Markdown>
              </div>
            )}
            {(analysis.adverseNews.sources?.length ?? 0) > 0 && (
              <div className="space-y-1 pt-2 border-t">
                <div className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">Sources</div>
                <ul className="space-y-0.5">
                  {analysis.adverseNews.sources.slice(0, 8).map((s, i) => (
                    <li key={i} className="text-xs min-w-0">
                      <a
                        href={s.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1 max-w-full"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{s.title}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {/* policy alerts */}
        {analysis.policyAlerts.length > 0 && (
          <Card className="p-5 glass-card space-y-3">
            <SectionHeading icon={ShieldCheck}>Policy &amp; credit-note alerts</SectionHeading>
            <div className="space-y-2">
              {analysis.policyAlerts.map((a, i) => {
                const am = ALERT_META[a.status] ?? ALERT_META.probe;
                const AmIcon = am.icon;
                return (
                  <div key={i} className="flex items-start gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
                    <Badge
                      variant="outline"
                      className={cn("font-bold text-[10px] uppercase tracking-wide shrink-0 mt-0.5", am.classes)}
                    >
                      <AmIcon className="size-3 mr-1" />
                      {am.label}
                    </Badge>
                    <div className="min-w-0 text-sm">
                      {a.reference && <span className="font-semibold">{a.reference} — </span>}
                      <span className="text-muted-foreground">{a.description}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* edge cases */}
        {(analysis.edgeCases.assumptions.length > 0 || analysis.edgeCases.ambiguities.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {analysis.edgeCases.assumptions.length > 0 && (
              <EdgeCard title="Assumptions made" items={analysis.edgeCases.assumptions} tone="slate" />
            )}
            {analysis.edgeCases.ambiguities.length > 0 && (
              <EdgeCard title="Ambiguities / missing data" items={analysis.edgeCases.ambiguities} tone="amber" />
            )}
          </div>
        )}

        {/* probe questions */}
        {analysis.probeQuestions.length > 0 && (
          <Card className="p-5 glass-card space-y-3">
            <SectionHeading icon={HelpCircle}>Questions for the CD Manager</SectionHeading>
            <ol className="space-y-2">
              {analysis.probeQuestions.map((q, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span className="shrink-0 size-5 rounded-full bg-red-100 text-red-700 grid place-items-center text-[11px] font-bold mt-0.5">
                    {i + 1}
                  </span>
                  <span>{q}</span>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {/* references */}
        {analysis.referencesUsed.length > 0 && (
          <Card className="p-5 glass-card space-y-3">
            <SectionHeading icon={ScrollText}>References used</SectionHeading>
            <div className="flex flex-wrap gap-1.5">
              {analysis.referencesUsed.map((r, i) => (
                <Badge key={i} variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 font-semibold">
                  <ScrollText className="size-3 mr-1" />
                  {cleanCaseTitle(r)}
                </Badge>
              ))}
            </div>
          </Card>
        )}

        {/* overall recap — verdict prose, then each concern paired with its mitigation plan */}
        {narrative && (
          <Card className="p-5 glass-card space-y-4">
            <SectionHeading icon={Quote}>Overall recap</SectionHeading>
            {narrLead && (
              <div className="text-[15px] leading-relaxed text-foreground/90 max-w-3xl">
                <Markdown components={NARRATIVE_MD}>{narrLead}</Markdown>
              </div>
            )}

            {concerns.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground">
                  Key concerns &amp; mitigation plan
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <div className="hidden sm:grid grid-cols-[1fr_1.25fr] gap-4 px-3.5 py-2 bg-muted/40 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    <span>Concern</span>
                    <span>Mitigation plan</span>
                  </div>
                  <div className="divide-y">
                    {concerns.map(({ key, label, finding }) => {
                      const im = IND_META[finding!.indicator];
                      const mits = finding!.mitigations ?? [];
                      return (
                        <div key={key} className="grid sm:grid-cols-[1fr_1.25fr] gap-1.5 sm:gap-4 px-3.5 py-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                              <span className={cn("size-1.5 rounded-full shrink-0", im.dot)} />
                              {label}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 leading-snug">
                              {finding!.headline || splitFinding(finding!.finding).observation}
                            </p>
                          </div>
                          {mits.length > 0 ? (
                            <ul className="space-y-1.5">
                              {mits.map((mi, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-[13px] leading-snug">
                                  <CheckCircle2 className="size-3.5 text-emerald-600 mt-0.5 shrink-0" />
                                  <span>
                                    {mi.action} <MitigationTag source={mi.source} reference={mi.reference} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">
                              Mitigation pending — re-run to generate.
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </Card>
        )}

        <p className="text-[11px] text-muted-foreground italic px-1">
          Risk highlighting only — this report does not constitute an approve/reject decision. Each
          finding mirrors a historical case in the internal knowledge base; verify against source
          documents before acting.
        </p>
      </div>

      <EvidenceModal
        finding={selected}
        borrower={borrower}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
      />

      <CreditChat open={chatOpen} onOpenChange={setChatOpen} reportId={reportId} borrower={borrower} />
    </AppShell>
  );
}

// ── sub-components ───────────────────────────────────────────────────────────

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

function CostBreakdown({ usage }: { usage: TokenUsage }) {
  const cost = computeCost(usage);
  return (
    <div className="space-y-2">
      <div className="font-bold text-sm flex items-center gap-1.5">
        <Coins className="size-3.5 text-red-600" /> Run cost
      </div>
      <div className="space-y-1 text-muted-foreground">
        <CostRow label="Model" value={cost.model} />
        <CostRow label="Model calls" value={String(cost.calls)} />
        <CostRow label={`Input · ${formatTokens(cost.inputTokens)} tokens`} value={formatUsd(cost.inputUsd)} />
        <CostRow
          label={`Output · ${formatTokens(cost.outputTokens + cost.thinkingTokens)} tokens`}
          value={formatUsd(cost.outputUsd)}
        />
      </div>
      <div className="border-t pt-1.5 flex items-center justify-between font-bold">
        <span>Total</span>
        <span className="tabular-nums">{formatUsd(cost.usd)}</span>
      </div>
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

function CountTile({
  indicator,
  count,
  desc,
  active,
  onClick,
}: {
  indicator: CreditRiskIndicator;
  count: number;
  desc: string;
  active: boolean;
  onClick: () => void;
}) {
  const m = IND_META[indicator];
  const Icon = m.icon;
  return (
    <button onClick={onClick} className="text-left">
      <Card className={cn("p-5 border transition-all hover:shadow-sm", m.tile, active && "ring-2 ring-offset-1 ring-current")}>
        <div className="flex items-center gap-2">
          <Icon className="size-5" />
          <span className="text-3xl font-black tabular-nums">{count}</span>
        </div>
        <div className="font-bold text-sm mt-1 text-foreground">
          {m.label}
          <span className="font-normal text-muted-foreground"> · {active ? "filtering" : "click to filter"}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </Card>
    </button>
  );
}

/** A single risk dimension as a side-by-side card: application observation (left)
 *  next to the KB case it mirrors (right), with the matching terms bolded. */
function TriageRow({
  label,
  finding,
  onView,
}: {
  label: string;
  finding?: CreditRiskFinding;
  onView: () => void;
}) {
  const [open, setOpen] = useState(false);
  const indicator = finding?.indicator ?? "low";
  const m = IND_META[indicator];
  const { observation, lesson } = finding ? splitFinding(finding.finding) : { observation: "", lesson: "" };
  const caseLabel = finding?.traceReference ? cleanCaseTitle(finding.traceReference) : "";
  const hasSource = !!(finding?.evidence?.applicationFileUrl || finding?.evidence?.caseFileUrl);
  // Show the detail ("what we found") in the row itself — the risk readable at a
  // glance. Why-it-matters, the case it mirrors, and the source live in expand.
  const detail = observation || finding?.headline || "No KB-referenced concern surfaced for this dimension.";
  const terms = (finding?.matchTerms ?? []).filter(Boolean);
  const mitigations = finding?.mitigations ?? [];

  return (
    <Card className={cn("p-0 overflow-hidden glass-card", indicator === "low" && !open && "opacity-75")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full grid grid-cols-[3.5rem_2.25rem_11.5rem_minmax(0,1fr)_1rem_1rem] gap-3 items-start px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <Badge
          variant="outline"
          className={cn("font-bold text-[10px] uppercase tracking-wide w-[54px] justify-center mt-0.5", m.classes)}
        >
          {m.label}
        </Badge>
        <span className="text-[11px] text-muted-foreground tabular-nums text-right mt-1" title="Evidence confidence">
          {typeof finding?.confidence === "number" ? `${finding.confidence}%` : ""}
        </span>
        <span className="font-bold text-sm truncate mt-0.5">{label}</span>
        <span className="text-[13px] text-foreground/85 leading-snug line-clamp-2 min-w-0">{detail}</span>
        <span
          className="mt-0.5 text-blue-500"
          title={finding?.traceReference ? `Mirrors ${finding.traceReference} — expand for details` : undefined}
        >
          {finding?.traceReference ? <BookOpen className="size-4" /> : null}
        </span>
        <ChevronDown
          className={cn("size-4 text-muted-foreground transition-transform mt-0.5", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="border-t bg-muted/10 px-4 py-3.5 space-y-3 text-sm">
          <ul className="space-y-2.5 leading-relaxed">
            {lesson && (
              <li className="flex gap-2.5">
                <span className="size-1.5 rounded-full bg-amber-500 mt-[7px] shrink-0" />
                <span>
                  <span className="font-semibold">Why it matters: </span>
                  {lesson}
                </span>
              </li>
            )}
            <li className="flex gap-2.5">
              <span
                className={cn(
                  "size-1.5 rounded-full mt-[7px] shrink-0",
                  finding?.traceReference ? "bg-blue-500" : "bg-muted-foreground/40",
                )}
              />
              {finding?.traceReference ? (
                <span>
                  <span className="font-semibold text-blue-800">
                    Mirrors {caseLabel}
                    {finding.evidence?.casePage != null ? ` (p.${finding.evidence.casePage})` : ""}:{" "}
                  </span>
                  <span className="italic text-blue-950/80">“{finding.traceExcerpt}”</span>
                </span>
              ) : (
                <span>
                  <span className="font-semibold">Precedent: </span>
                  <span className="text-muted-foreground">
                    No close historical case — flagged on the application alone.
                  </span>
                </span>
              )}
            </li>
          </ul>

          {mitigations.length > 0 && (
            <div className="space-y-1.5 rounded-lg bg-emerald-50/50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                <ShieldCheck className="size-3.5" /> Recommended mitigations
              </div>
              <ul className="space-y-1.5">
                {mitigations.map((mi, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle2 className="size-3.5 text-emerald-600 mt-0.5 shrink-0" />
                    <span>
                      {mi.action} <MitigationTag source={mi.source} reference={mi.reference} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {terms.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground mr-1">
                Key signals
              </span>
              {terms.map((t, i) => (
                <Badge key={i} variant="outline" className="text-[10px] bg-muted/50 font-medium">
                  {t}
                </Badge>
              ))}
            </div>
          )}

          {hasSource && (
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onView();
              }}
              className="h-7 gap-1.5 text-xs border-blue-200 text-blue-700 hover:bg-blue-50"
            >
              <FileSearch className="size-3.5" /> View source on PDF
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Modal: the finding next to BOTH source PDFs, each jumped to the cited page. */
function EvidenceModal({
  finding,
  borrower,
  open,
  onOpenChange,
}: {
  finding: CreditRiskFinding | null;
  borrower: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const m = finding ? IND_META[finding.indicator] : IND_META.low;
  const ev = finding?.evidence ?? {};
  const { lesson } = finding ? splitFinding(finding.finding) : { lesson: "" };
  const segLabel =
    CREDIT_RISK_SEGMENTS.find((s) => s.key === finding?.segment)?.label ?? finding?.segment ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[96vw] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className={cn("size-2.5 rounded-full", m.dot)} />
            {segLabel}
            {finding && (
              <Badge variant="outline" className={cn("font-bold text-[10px] uppercase tracking-wide", m.classes)}>
                {m.label}
              </Badge>
            )}
            <span className="text-sm font-normal text-muted-foreground">· {borrower}</span>
          </DialogTitle>
          {lesson && (
            <DialogDescription className="text-left">
              <span className="font-semibold text-foreground/70">Why it matters: </span>
              {lesson}
            </DialogDescription>
          )}
        </DialogHeader>

        {finding && (
          <div className={cn("grid gap-4", finding.traceReference ? "md:grid-cols-2" : "grid-cols-1")}>
            <SourcePanel
              tone="app"
              title="Credit application"
              page={ev.applicationPage}
              url={ev.applicationFileUrl}
              quote={finding.applicationQuote || splitFinding(finding.finding).observation}
              terms={finding.matchTerms}
              caption={ev.applicationPage ? `Found on page ${ev.applicationPage}` : "Cited from the application"}
            />
            {finding.traceReference ? (
              <SourcePanel
                tone="kb"
                title={`Knowledge base · ${cleanCaseTitle(finding.traceReference)}`}
                page={ev.casePage}
                url={ev.caseFileUrl}
                quote={finding.traceExcerpt}
                terms={finding.matchTerms}
                caption={ev.caseChapter ? ev.caseChapter : finding.traceReference}
              />
            ) : (
              <div className="rounded-lg border border-dashed grid place-items-center text-center p-6 text-xs text-muted-foreground">
                <div>
                  <BookOpen className="size-5 mx-auto mb-1.5 opacity-40" />
                  No close historical precedent in the knowledge base for this dimension — flagged on
                  the application alone.
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourcePanel({
  tone,
  title,
  page,
  url,
  quote,
  terms,
  caption,
}: {
  tone: "app" | "kb";
  title: string;
  page?: number;
  url?: string;
  quote: string;
  terms?: string[];
  caption: string;
}) {
  const isKb = tone === "kb";
  return (
    <div className={cn("rounded-lg border overflow-hidden flex flex-col", isKb && "border-blue-200")}>
      <div
        className={cn(
          "px-3 py-2 flex items-center gap-2 border-b",
          isKb ? "bg-blue-50 text-blue-800 border-blue-200" : "bg-muted/40",
        )}
      >
        {isKb ? <BookOpen className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
        <span className="text-xs font-bold truncate" title={title}>
          {title}
        </span>
        {page != null && (
          <span className={cn("text-[10px] font-semibold shrink-0", isKb ? "text-blue-600" : "text-muted-foreground")}>
            p.{page}
          </span>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] inline-flex items-center gap-1 hover:underline shrink-0"
          >
            <ExternalLink className="size-3" /> Open PDF
          </a>
        )}
      </div>

      {url ? (
        <PdfHighlight url={url} page={page} quote={quote} height={360} />
      ) : (
        <div className="h-[200px] grid place-items-center text-center px-4 text-xs text-muted-foreground">
          Source file not available for inline preview — see the cited text below.
        </div>
      )}

      <div className={cn("px-3 py-2.5 border-t text-sm leading-snug", isKb ? "bg-blue-50/40" : "bg-muted/20")}>
        <div className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground mb-1">{caption}</div>
        <p className={cn(isKb && "[font-family:var(--font-serif,_Georgia,_serif)] italic text-blue-950/80")}>
          {isKb ? "“" : ""}
          <Highlighted text={quote} terms={terms} />
          {isKb ? "”" : ""}
        </p>
      </div>
    </div>
  );
}

function EdgeCard({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "slate" | "amber";
}) {
  const dot = tone === "amber" ? "bg-amber-500" : "bg-slate-400";
  return (
    <Card className="p-5 glass-card space-y-3">
      <h2 className="font-bold text-base tracking-tight flex items-center gap-2">
        <span className={cn("size-2 rounded-full shrink-0", dot)} />
        {title}
      </h2>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <span className={cn("size-1.5 rounded-full mt-1.5 shrink-0", dot)} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CreditAnalyzingView({
  borrower,
  failed,
  error,
  onRetry,
}: {
  borrower: string;
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
          <ArrowLeft className="size-3" /> All credit analyses
        </Link>
        {failed ? (
          <>
            <div className="size-14 mx-auto rounded-2xl bg-rose-100 text-rose-600 grid place-items-center">
              <AlertTriangle className="size-7" />
            </div>
            <div className="space-y-1">
              <h2 className="font-bold text-lg">Analysis didn't finish</h2>
              <p className="text-sm text-muted-foreground">
                The risk screening for <span className="font-medium text-foreground">{borrower}</span>{" "}
                didn't complete. The application is saved — you can try again.
              </p>
              {error && (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-2">
                  {error}
                </p>
              )}
            </div>
            <Button onClick={onRetry} className="gap-2 bg-red-600 hover:bg-red-700 text-white">
              <RefreshCw className="size-4" /> Retry
            </Button>
          </>
        ) : (
          <>
            <div className="relative mx-auto w-fit">
              <div className="absolute inset-0 bg-red-500/20 rounded-full blur-2xl animate-pulse" />
              <div className="relative size-16 rounded-2xl border bg-card grid place-items-center shadow-sm">
                <Loader2 className="size-8 text-red-600 animate-spin" strokeWidth={1.75} />
              </div>
            </div>
            <div className="space-y-1">
              <h2 className="font-bold text-lg">Screening {borrower}</h2>
              <p className="text-sm text-muted-foreground">
                Reading the application, matching it across 8 risk dimensions, and tracing every flag
                back to a historical case in the knowledge base.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              This usually takes under a minute. You can keep this tab open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
