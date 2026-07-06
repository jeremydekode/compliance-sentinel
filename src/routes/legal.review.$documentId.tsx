import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  getLegalDocument,
  reviewLegalDocument,
  acceptClauseSuggestion,
  createAmendedVersion,
  addDocumentAnnotation,
  deleteDocumentAnnotation,
} from "@/lib/legal.functions";
import {
  ArrowLeft,
  Bot,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  FileText,
  Sparkles,
  Check,
  Copy,
  Gauge,
  RotateCcw,
  GitBranch,
  MessageSquarePlus,
  X,
  MessageSquare,
  Trash2,
} from "lucide-react";

export const Route = createFileRoute("/legal/review/$documentId")({
  component: CoPilotReview,
  head: () => ({ meta: [{ title: "Document Review · Legal CMS" }] }),
});

const SEV = {
  red_flag:  { label: "Risk",     icon: ShieldAlert,   text: "text-red-600 dark:text-red-400",       chip: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",       ring: "border-red-300/70 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20", mark: "bg-red-200/50 dark:bg-red-900/40" },
  caution:   { label: "Caution",  icon: AlertTriangle, text: "text-amber-600 dark:text-amber-400",   chip: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", ring: "border-amber-300/70 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20", mark: "bg-amber-200/50 dark:bg-amber-900/40" },
  compliant: { label: "OK",       icon: CheckCircle2,  text: "text-emerald-600 dark:text-emerald-400", chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", ring: "border-emerald-300/70 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20", mark: "bg-emerald-200/40 dark:bg-emerald-900/30" },
} as const;

type Sev = keyof typeof SEV;

function riskBand(score: number) {
  if (score >= 67) return { label: "High risk", color: "text-red-600 dark:text-red-400", stroke: "stroke-red-500" };
  if (score >= 34) return { label: "Elevated", color: "text-amber-600 dark:text-amber-400", stroke: "stroke-amber-500" };
  return { label: "Low risk", color: "text-emerald-600 dark:text-emerald-400", stroke: "stroke-emerald-500" };
}

function RiskGauge({ score }: { score: number }) {
  const band = riskBand(score);
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return (
    <div className="flex items-center gap-3">
      <div className="relative size-16 shrink-0">
        <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
          <circle cx="32" cy="32" r={r} className="fill-none stroke-muted" strokeWidth="6" />
          <circle cx="32" cy="32" r={r} className={cn("fill-none transition-all", band.stroke)} strokeWidth="6" strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <span className="text-lg font-bold tabular-nums">{score}</span>
        </div>
      </div>
      <div>
        <div className={cn("text-sm font-bold", band.color)}>{band.label}</div>
        <div className="text-[10px] text-muted-foreground">AI exposure score · 0–100</div>
      </div>
    </div>
  );
}

function ExposureBars({ exposure }: { exposure: Record<string, string> }) {
  const cats = [
    { key: "financial", label: "Financial" },
    { key: "regulatory", label: "Regulatory" },
    { key: "operational", label: "Operational" },
    { key: "reputational", label: "Reputational" },
  ];
  const lvl: Record<string, { w: string; c: string }> = {
    high:   { w: "w-full",  c: "bg-red-500" },
    medium: { w: "w-2/3",   c: "bg-amber-500" },
    low:    { w: "w-1/3",   c: "bg-emerald-500" },
  };
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {cats.map((cat) => {
        const v = (exposure?.[cat.key] ?? "low").toLowerCase();
        const meta = lvl[v] ?? lvl.low;
        return (
          <div key={cat.key} className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-20 shrink-0">{cat.label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={cn("h-full rounded-full", meta.w, meta.c)} />
            </div>
            <span className="text-[9px] font-semibold uppercase tracking-wider w-12 text-right text-muted-foreground">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

// Highlight the reviewed clause excerpts inside the contract text (the "continuous
// highlighting" of the deck). Falls back to plain text when excerpts don't match.
function HighlightedContract({ text, clauses, activeIdx, onPick }: {
  text: string; clauses: any[]; activeIdx: number | null; onPick: (i: number) => void;
}) {
  const segments = useMemo(() => {
    if (!text) return null;
    const marks: Array<{ start: number; end: number; idx: number }> = [];
    clauses.forEach((c, i) => {
      const ex = (c.excerpt ?? "").trim();
      if (ex.length < 6) return;
      const at = text.indexOf(ex);
      if (at >= 0) marks.push({ start: at, end: at + ex.length, idx: i });
    });
    marks.sort((a, b) => a.start - b.start);
    // drop overlaps
    const clean = marks.filter((m, i) => i === 0 || m.start >= marks[i - 1].end);
    const out: Array<{ t: string; idx: number | null }> = [];
    let cur = 0;
    for (const m of clean) {
      if (m.start > cur) out.push({ t: text.slice(cur, m.start), idx: null });
      out.push({ t: text.slice(m.start, m.end), idx: m.idx });
      cur = m.end;
    }
    if (cur < text.length) out.push({ t: text.slice(cur), idx: null });
    return out;
  }, [text, clauses]);

  if (!text) {
    // No extracted text (e.g. scanned PDF) — show the clause excerpts as the doc.
    return (
      <div className="space-y-3">
        <p className="text-[11px] text-muted-foreground italic">Full text isn't extractable for this file — showing the clauses the AI flagged.</p>
        {clauses.map((c, i) => (
          <div key={i} onClick={() => onPick(i)} className={cn("rounded-lg border p-3 cursor-pointer transition-colors", activeIdx === i ? "border-indigo-400 bg-indigo-50/40 dark:bg-indigo-950/20" : "hover:bg-muted/30")}>
            <div className="text-[10px] font-bold text-muted-foreground mb-1">{c.ref}</div>
            <p className="text-xs italic">"{c.excerpt}"</p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="text-xs leading-relaxed whitespace-pre-wrap font-serif text-foreground/90">
      {segments!.map((s, i) =>
        s.idx === null ? (
          <span key={i}>{s.t}</span>
        ) : (
          <mark
            key={i}
            onClick={() => onPick(s.idx!)}
            title={clauses[s.idx!]?.ref}
            className={cn(
              "rounded px-0.5 cursor-pointer transition-all",
              (SEV[clauses[s.idx!]?.severity as Sev] ?? SEV.caution).mark,
              activeIdx === s.idx && "ring-2 ring-indigo-400"
            )}
          >
            {s.t}
          </mark>
        )
      )}
    </div>
  );
}

// Redline renderer for an amended draft: parses the four control-char markers
// (DEL open/close = /, INS open/close = /) into
// strikethrough deletions and highlighted insertions.
function RedlineContract({ redline, flashIdx }: { redline: string; flashIdx: number | null }) {
  const D_O = String.fromCharCode(1), D_C = String.fromCharCode(2), I_O = String.fromCharCode(3), I_C = String.fromCharCode(4);
  const raw: Array<{ t: "text" | "del" | "ins"; x: string }> = [];
  let buf = "";
  let mode: "text" | "del" | "ins" = "text";
  const flush = (as: "text" | "del" | "ins") => { if (buf) { raw.push({ t: as, x: buf }); buf = ""; } };
  for (const ch of redline) {
    if (ch === D_O) { flush(mode); mode = "del"; }
    else if (ch === D_C) { flush("del"); mode = "text"; }
    else if (ch === I_O) { flush(mode); mode = "ins"; }
    else if (ch === I_C) { flush("ins"); mode = "text"; }
    else buf += ch;
  }
  flush(mode);
  // Annotate each insertion with its ordinal so the Amendment History can jump to it.
  let insCount = 0;
  const segs = raw.map((s) => ({ ...s, insIdx: s.t === "ins" ? insCount++ : -1 }));
  return (
    <div className="text-xs leading-relaxed whitespace-pre-wrap font-serif text-foreground/90">
      {segs.map((s, i) =>
        s.t === "del" ? (
          <del key={i} className="text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 line-through decoration-red-400">{s.x}</del>
        ) : s.t === "ins" ? (
          <ins
            key={i}
            id={`redline-ins-${s.insIdx}`}
            className={cn(
              "text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-900/40 no-underline font-semibold rounded-sm px-0.5 scroll-mt-24 transition-shadow",
              flashIdx === s.insIdx && "ring-2 ring-indigo-500 ring-offset-1"
            )}
          >
            {s.x}
          </ins>
        ) : (
          <span key={i}>{s.x}</span>
        )
      )}
    </div>
  );
}

function CoPilotReview() {
  const { documentId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const getDoc = useServerFn(getLegalDocument);
  const reviewFn = useServerFn(reviewLegalDocument);
  const acceptFn = useServerFn(acceptClauseSuggestion);
  const versionFn = useServerFn(createAmendedVersion);

  const { data, isLoading } = useQuery({
    queryKey: ["legal-doc", documentId],
    queryFn: () => getDoc({ data: { document_id: documentId } }),
  });

  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [showRedline, setShowRedline] = useState(true);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);

  // Jump from an Amendment History item to the matching insertion in the redline.
  function jumpToChange(i: number) {
    setShowRedline(true);
    setFlashIdx(i);
    setTimeout(() => {
      document.getElementById(`redline-ins-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    setTimeout(() => setFlashIdx((cur) => (cur === i ? null : cur)), 2000);
  }

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["legal-doc", documentId] });
  }

  const accept = useMutation({
    mutationFn: (p: { clause_index: number; accepted: boolean }) =>
      acceptFn({ data: { document_id: documentId, ...p } }),
    onSuccess: (_r, p) => { toast.success(p.accepted ? "Suggestion marked for the amended draft" : "Suggestion dismissed"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const genVersion = useMutation({
    mutationFn: () => versionFn({ data: { document_id: documentId } }),
    onSuccess: (newDoc: any) => {
      toast.success(`Amended draft created — ${newDoc.file_name}`);
      // Open the new draft in the viewer so the applied changes are immediately visible.
      navigate({ to: "/legal/review/$documentId", params: { documentId: newDoc.id } });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not generate version"),
  });

  // Highlight-to-comment
  const annotateFn = useServerFn(addDocumentAnnotation);
  const delAnnFn = useServerFn(deleteDocumentAnnotation);
  const [selection, setSelection] = useState("");
  const [annNote, setAnnNote] = useState("");

  const annotate = useMutation({
    mutationFn: () => annotateFn({ data: { document_id: documentId, quote: selection, comment: annNote.trim() } }),
    onSuccess: () => { toast.success("Comment added"); setSelection(""); setAnnNote(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed to add comment"),
  });
  const delAnn = useMutation({
    mutationFn: (index: number) => delAnnFn({ data: { document_id: documentId, index } }),
    onSuccess: () => { toast.success("Comment removed"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  function captureSelection() {
    const sel = typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
    if (sel.length >= 3) setSelection(sel.slice(0, 2000));
  }

  async function runReview() {
    setReviewing(true);
    try {
      await reviewFn({ data: { document_id: documentId } });
      toast.success("AI review complete");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Review failed");
    } finally {
      setReviewing(false);
    }
  }

  if (isLoading || !data) {
    return (
      <AppShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  const doc: any = data.document;
  const matter: any = data.matter;
  const review: any = doc.ai_review;
  const clauses: any[] = review?.clauses ?? [];
  const score: number = typeof review?.riskScore === "number" ? review.riskScore : (
    clauses.some((c) => c.severity === "red_flag") ? 75 : clauses.some((c) => c.severity === "caution") ? 45 : 15
  );
  const accepted = clauses.filter((c) => c.accepted).length;
  const findings = clauses.filter((c) => c.severity !== "compliant");
  const annotations: any[] = Array.isArray(review?.annotations) ? review.annotations : [];
  const redlineText: string = String(review?.redlineText ?? "");
  const changes: any[] = Array.isArray(review?.changes) ? review.changes : [];
  const isAmended = redlineText.length > 0 || changes.length > 0;
  // The document content — extracted server-side so it shows even before any AI review.
  const docText: string = String((data as any).text ?? review?.documentText ?? "");

  return (
    <AppShell>
      <div className="flex flex-col h-screen">
        {/* Header */}
        <div className="flex items-center gap-3 border-b bg-background/95 px-6 py-2.5 sticky top-0 z-10 backdrop-blur shrink-0">
          <Link to="/legal/$matterId" params={{ matterId: matter?.id ?? "" }} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="size-3" /> {matter?.reference_number ?? "Matter"}
          </Link>
          <span className="text-muted-foreground/30">/</span>
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="size-3.5 text-muted-foreground shrink-0" />
            <h1 className="text-sm font-bold truncate">{doc.file_name}</h1>
          </div>
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200/60">
            <Bot className="size-2.5" /> Document Review
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {review && !isAmended && (
              <Button
                size="sm"
                className="h-7 text-[11px] gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                disabled={accepted === 0 || genVersion.isPending}
                onClick={() => genVersion.mutate()}
                title={accepted === 0 ? "Apply at least one suggestion first" : "Create an amended version from the applied suggestions"}
              >
                {genVersion.isPending ? <Loader2 className="size-3 animate-spin" /> : <GitBranch className="size-3" />}
                Generate amended version{accepted > 0 ? ` (${accepted})` : ""}
              </Button>
            )}
            {review ? (
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1.5" disabled={reviewing} onClick={runReview}>
                {reviewing ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Re-run
              </Button>
            ) : (
              <Button size="sm" className="h-7 text-[11px] gap-1.5" disabled={reviewing} onClick={runReview}>
                {reviewing ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Run AI review
              </Button>
            )}
          </div>
        </div>

        {(
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_380px] min-h-0">
            {/* LEFT — contract editor */}
            <div className="overflow-y-auto border-r">
              <div className="max-w-3xl mx-auto p-6">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{isAmended ? "Amended Draft" : "Contract"}</span>
                  {isAmended ? (
                    <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5">
                      <button
                        onClick={() => setShowRedline(true)}
                        className={cn("px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors", showRedline ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        Historical edits
                      </button>
                      <button
                        onClick={() => setShowRedline(false)}
                        className={cn("px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors", !showRedline ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        Clean
                      </button>
                    </div>
                  ) : (
                    <span className="text-[10px] text-muted-foreground/60">· click a highlight for the AI note</span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60 ml-auto"><span className="text-indigo-600 dark:text-indigo-400">select text to comment</span></span>
                </div>
                {isAmended && showRedline && (
                  <div className="mb-2 flex items-center gap-3 text-[10px]">
                    <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-2 rounded-sm bg-red-100 dark:bg-red-900/40 line-through" /> <del className="text-red-600 dark:text-red-400">removed</del></span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-2 rounded-sm bg-emerald-100 dark:bg-emerald-900/40" /> <ins className="text-emerald-700 dark:text-emerald-300 no-underline font-semibold">new term</ins></span>
                  </div>
                )}
                <div className="rounded-xl border bg-card p-5" onMouseUp={captureSelection}>
                  {isAmended && showRedline && redlineText ? (
                    <RedlineContract redline={redlineText} flashIdx={flashIdx} />
                  ) : docText ? (
                    <HighlightedContract text={docText} clauses={clauses} activeIdx={activeIdx} onPick={setActiveIdx} />
                  ) : (
                    <p className="text-xs text-muted-foreground italic py-8 text-center">
                      Document content isn't extractable in the browser (e.g. a scanned image PDF). Download to view, or run AI review for a clause summary.
                    </p>
                  )}
                </div>

                {/* Selection → comment composer */}
                {selection && (
                  <div className="mt-3 rounded-xl border-2 border-indigo-300 dark:border-indigo-800 bg-card p-3 space-y-2 sticky bottom-3 shadow-lg">
                    <div className="flex items-center gap-2">
                      <MessageSquarePlus className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">Comment on selection</span>
                      <button onClick={() => { setSelection(""); setAnnNote(""); }} className="ml-auto text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
                    </div>
                    <p className="text-[11px] italic text-muted-foreground border-l-2 border-indigo-300 pl-2 line-clamp-2">"{selection}"</p>
                    <textarea
                      autoFocus
                      value={annNote}
                      onChange={(e) => setAnnNote(e.target.value)}
                      rows={2}
                      placeholder="Your comment on this passage…"
                      className="w-full rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => { setSelection(""); setAnnNote(""); }} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
                      <Button size="sm" className="h-7 text-[11px] gap-1.5" disabled={!annNote.trim() || annotate.isPending} onClick={() => annotate.mutate()}>
                        {annotate.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Add comment
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT — AI Co-Pilot sidebar */}
            <div className="overflow-y-auto bg-muted/20">
              <div className="p-4 space-y-3">
                {!review && (
                  <div className="rounded-xl border-2 border-dashed border-indigo-200 dark:border-indigo-900 bg-card p-5 text-center">
                    <div className="size-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 grid place-items-center mx-auto mb-2.5">
                      <Bot className="size-5 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <p className="text-sm font-semibold">Analyze this document</p>
                    <p className="text-[11px] text-muted-foreground mt-1 mb-3 leading-relaxed">
                      Run the AI clause-by-clause review to get a risk score, exposure breakdown, and suggested edits for this document.
                    </p>
                    <Button size="sm" className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700" disabled={reviewing} onClick={runReview}>
                      {reviewing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Run AI review
                    </Button>
                    <p className="text-[10px] text-muted-foreground/60 mt-3">You can also just read the document on the left and add comments — no analysis required.</p>
                  </div>
                )}
                {review && (<>
                {/* Amendment history — old term → new term + the rationale that was accepted */}
                {changes.length > 0 && (
                  <div className="rounded-xl border border-indigo-200/60 dark:border-indigo-900 bg-card overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-indigo-200/40 dark:border-indigo-900/60">
                      <GitBranch className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">Amendment History</span>
                      <span className="text-[10px] text-muted-foreground/60 ml-auto">{changes.length} change{changes.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="divide-y max-h-[340px] overflow-y-auto">
                      {changes.map((ch: any, i: number) => (
                        <button
                          key={i}
                          onClick={() => jumpToChange(i)}
                          className="w-full text-left p-3 space-y-1.5 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-colors block"
                          title="Jump to this change in the document"
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-bold">{ch.ref}</span>
                            {ch.category && <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">{ch.category}</span>}
                            {ch.located === false
                              ? <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">appended</span>
                              : <span className="ml-auto text-[9px] text-indigo-500">jump →</span>}
                          </div>
                          <p className="text-[11px] leading-relaxed">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-red-500 mr-1">Was</span>
                            <del className="text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 line-through decoration-red-400 px-0.5">{ch.before}</del>
                          </p>
                          <p className="text-[11px] leading-relaxed">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 mr-1">Now</span>
                            <ins className="text-emerald-700 dark:text-emerald-300 bg-emerald-100/60 dark:bg-emerald-900/30 no-underline font-semibold px-0.5">{ch.after}</ins>
                          </p>
                          {ch.comment && (
                            <p className="text-[10px] text-muted-foreground leading-relaxed pt-0.5">
                              <span className="font-semibold">Why:</span> {ch.comment}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* Risk evaluation */}
                <div className="rounded-xl border bg-card p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Gauge className="size-3.5 text-muted-foreground" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Risk Evaluation</span>
                  </div>
                  <RiskGauge score={score} />
                  {review.exposure && <ExposureBars exposure={review.exposure} />}
                  {review.summary && <p className="text-[11px] leading-relaxed text-foreground/80 pt-1 border-t">{review.summary}</p>}
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground pt-1">
                    <span className="inline-flex items-center gap-1"><ShieldAlert className="size-3 text-red-500" /> {clauses.filter((c) => c.severity === "red_flag").length} risks</span>
                    <span className="inline-flex items-center gap-1"><AlertTriangle className="size-3 text-amber-500" /> {clauses.filter((c) => c.severity === "caution").length} cautions</span>
                    <span className="inline-flex items-center gap-1"><Check className="size-3 text-emerald-500" /> {accepted} applied</span>
                  </div>
                </div>

                {/* Findings + suggested edits (original doc only; amended drafts show Amendment History) */}
                {!isAmended && (
                <div className="flex items-center gap-2 px-1">
                  <Sparkles className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">AI Suggestions</span>
                  <span className="text-[10px] text-muted-foreground/60 ml-auto">{findings.length} to review</span>
                </div>
                )}

                {!isAmended && findings.map((c) => {
                  const idx = clauses.indexOf(c);
                  const sev = SEV[c.severity as Sev] ?? SEV.caution;
                  return (
                    <div
                      key={idx}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={cn("rounded-xl border p-3 space-y-2 transition-all", sev.ring, activeIdx === idx && "ring-2 ring-indigo-400")}
                    >
                      <div className="flex items-center gap-2">
                        <sev.icon className={cn("size-3.5 shrink-0", sev.text)} />
                        <span className="text-[11px] font-bold">{c.ref}</span>
                        <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider", sev.chip)}>{sev.label}</span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-foreground/85">{c.comment}</p>
                      {c.suggestion && (
                        <div className="rounded-lg bg-background border border-dashed p-2.5">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Sparkles className="size-3 text-indigo-500" />
                            <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Suggested edit</span>
                            <button
                              onClick={() => { navigator.clipboard?.writeText(c.suggestion); toast.success("Copied"); }}
                              className="ml-auto text-muted-foreground hover:text-foreground" title="Copy"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                          <p className="text-[11px] leading-relaxed text-foreground/90">{c.suggestion}</p>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        {c.accepted ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="size-3" /> Applied to draft
                          </span>
                        ) : c.suggestion ? (
                          <Button size="sm" className="h-6 text-[10px] gap-1 bg-indigo-600 hover:bg-indigo-700" disabled={accept.isPending} onClick={() => accept.mutate({ clause_index: idx, accepted: true })}>
                            <Check className="size-3" /> Apply edit
                          </Button>
                        ) : null}
                        {c.accepted && (
                          <button onClick={() => accept.mutate({ clause_index: idx, accepted: false })} className="text-[10px] text-muted-foreground hover:text-foreground">undo</button>
                        )}
                        {c.category && <span className="ml-auto text-[9px] text-muted-foreground/60 uppercase tracking-wider">{c.category}</span>}
                      </div>
                    </div>
                  );
                })}

                {!isAmended && findings.length === 0 && (
                  <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 text-center">
                    <CheckCircle2 className="size-5 text-emerald-500 mx-auto mb-1.5" />
                    <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">No issues flagged</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">The draft aligns with the company's playbook positions.</p>
                  </div>
                )}
                </>)}

                {/* Reviewer comments (highlight-to-comment) */}
                {annotations.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-1 pt-2">
                      <MessageSquare className="size-3.5 text-muted-foreground" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Reviewer Comments</span>
                      <span className="text-[10px] text-muted-foreground/60 ml-auto">{annotations.length}</span>
                    </div>
                    {annotations.map((a: any, i: number) => (
                      <div key={i} className="rounded-xl border bg-card p-3 space-y-1.5">
                        <p className="text-[11px] italic text-muted-foreground border-l-2 border-indigo-300 pl-2 line-clamp-3">"{a.quote}"</p>
                        <p className="text-[11px] leading-relaxed text-foreground/90">{a.comment}</p>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{a.author ?? "Reviewer"}</span>
                          <button onClick={() => delAnn.mutate(i)} className="ml-auto text-muted-foreground hover:text-red-500" title="Delete comment">
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
