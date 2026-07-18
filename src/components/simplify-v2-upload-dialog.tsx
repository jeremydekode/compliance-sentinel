// ============================================================================
// SIMPLIFY V2 — scan-first intake ("plan mode").
// Step 1: upload the document → a rapid scan (structure stats + sampled AI
// triage) runs immediately. Step 2: the scan card is shown with an
// AI-recommended intent, and the user picks the action:
//   Find gaps → recommend | Light simplify → simplify | Max simplify →
//   simplify+max profile | Full redraft → recommend_edit + auto-chain.
// The deep analysis only starts after that explicit choice — no more opening
// with 72 unrequested edits.
// ============================================================================

import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createSimplifyV2Report, createDocFromBriefReport, scanDocumentV2 } from "@/lib/compliance.functions";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Upload, Loader2, Sparkles, Wand2, SearchCheck, FileEdit, Scissors,
  FileText, Gauge, ListTree, Table2, ScrollText, FilePlus2, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Intent = "recommend" | "simplify_light" | "simplify_max" | "redraft";

const INTENTS: { id: Intent; name: string; blurb: string; icon: React.ElementType }[] = [
  { id: "recommend", name: "Find gaps", blurb: "Audit for contradictions, incomplete steps, missing info — findings report with evidence.", icon: SearchCheck },
  { id: "simplify_light", name: "Light simplify", blurb: "Plain-language edit proposals, reviewed one by one. Keeps the document's shape.", icon: Sparkles },
  { id: "simplify_max", name: "Max simplify", blurb: "Aggressive shrink — target 30%+ shorter. Every edit still verified & reviewable.", icon: Scissors },
  { id: "redraft", name: "Full redraft", blurb: "Audit, auto-apply verified fixes, regenerate a clean restructured copy.", icon: FileEdit },
];

interface ScanResult {
  stats: { words: number; estPages: number; sections: number; tables: number };
  observations: string[];
  recommended: string;
  rationale: string;
}

export function SimplifyV2UploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const createFn = useServerFn(createSimplifyV2Report);
  const createDocFn = useServerFn(createDocFromBriefReport);
  const scanFn = useServerFn(scanDocumentV2);
  const auth = useAuth();

  const [flow, setFlow] = useState<"improve" | "create">("improve");
  const [newTitle, setNewTitle] = useState("");
  const [newDocType, setNewDocType] = useState("policy");
  const [newBrief, setNewBrief] = useState("");
  const [donorId, setDonorId] = useState<string | null>(null);

  // Donor candidates — tenant-scoped DOCX-backed reports whose package (logo,
  // headers, styles) the new draft will wear.
  const donors = useQuery({
    queryKey: ["v2_donors", auth.tenantId],
    enabled: open && flow === "create" && !auth.loading,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("analysis_reports")
        .select("id, title, source_file_url, created_at")
        .eq("tenant_id", auth.tenantId)
        .not("source_file_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(30);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).filter((r) => /\.docx($|\?)/i.test(r.source_file_url));
    },
  });

  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFlow("improve");
    setNewTitle("");
    setNewDocType("policy");
    setNewBrief("");
    setDonorId(null);
    setStep(1);
    setFile(null);
    setFileUrl(null);
    setScanning(false);
    setScan(null);
    setIntent(null);
    setCustomTitle("");
    setInstruction("");
    setBusy(false);
  }

  async function pickFile(f: File) {
    setFile(f);
    setScanning(true);
    try {
      const path = `simplify-v2/${Date.now()}-${f.name}`;
      const up = await supabase.storage.from("policies").upload(path, f, {
        upsert: false,
        contentType: f.type || "application/octet-stream",
      });
      if (up.error) throw up.error;
      const url = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
      setFileUrl(url);
      const r = await scanFn({ data: { fileUrl: url } });
      setScan(r as ScanResult);
      setIntent((r.recommended as Intent) ?? "recommend");
      setStep(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't scan the document", { description: e?.message });
      setFile(null);
      setFileUrl(null);
    } finally {
      setScanning(false);
    }
  }

  async function submit() {
    if (!file || !fileUrl || !intent || busy) return;
    setBusy(true);
    try {
      const { reportId } = await createFn({
        data: {
          filename: file.name,
          fileUrl,
          customTitle: customTitle.trim() || undefined,
          instruction: instruction.trim() || undefined,
          workflowMode:
            intent === "recommend" ? "recommend"
            : intent === "redraft" ? "recommend_edit"
            : "simplify",
          ...(intent === "simplify_max" ? { simplifyProfile: "max" as const } : {}),
          ...(intent === "redraft" ? { redraftAuto: true } : {}),
        },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Could not start the analysis", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate() {
    if (!newTitle.trim() || newBrief.trim().length < 20 || !donorId || busy) return;
    setBusy(true);
    try {
      const { reportId } = await createDocFn({
        data: { title: newTitle.trim(), docType: newDocType, brief: newBrief.trim(), donorReportId: donorId },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Could not start drafting", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  const canCreateNew = auth.tenant.features.includes("create_document");

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy && !scanning) { if (!o) reset(); onOpenChange(o); } }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-fuchsia-600" /> New document analysis
          </DialogTitle>
          <DialogDescription>
            {flow === "create"
              ? "Describe the document — it's drafted in your house structure and template."
              : step === 1
                ? "Upload the document — a rapid scan sizes it up before anything runs."
                : "Here's the scan. Choose what to do — nothing deep runs until you decide."}
          </DialogDescription>
        </DialogHeader>

        {canCreateNew && step === 1 && (
          <div className="flex items-center gap-1 p-1 rounded-xl border bg-muted/30 w-fit">
            {([
              ["improve", "Improve a document", Sparkles],
              ["create", "Create new document", FilePlus2],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFlow(id)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-1.5",
                  flow === id ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        )}

        {flow === "create" && (
          <div className="space-y-3 py-1">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title — e.g. Remote Working Security Policy"
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-fuchsia-500"
            />
            <select
              value={newDocType}
              onChange={(e) => setNewDocType(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-fuchsia-500"
            >
              {["policy", "operations manual", "procedure", "guideline", "circular"].map((t) => (
                <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
            <textarea
              value={newBrief}
              onChange={(e) => setNewBrief(e.target.value)}
              rows={4}
              placeholder="Brief — what must this document cover? Scope, key rules, who it applies to, escalation expectations… (min 20 chars)"
              className="w-full text-xs px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-fuchsia-500 resize-none"
            />
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1.5">
                Template donor — the draft wears this document's logo, headers &amp; styles
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                {donors.isLoading && (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    <Loader2 className="size-4 mx-auto animate-spin" />
                  </div>
                )}
                {!donors.isLoading && (donors.data?.length ?? 0) === 0 && (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    No DOCX documents yet — upload one via "Improve a document" first; it then becomes a template donor.
                  </div>
                )}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {donors.data?.map((d: any) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDonorId(d.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                      donorId === d.id ? "bg-fuchsia-100" : "hover:bg-muted/40",
                    )}
                  >
                    <FileText className={cn("size-4 shrink-0", donorId === d.id ? "text-fuchsia-700" : "text-muted-foreground")} />
                    <span className={cn("truncate flex-1", donorId === d.id && "font-semibold")}>{d.title}</span>
                    {donorId === d.id && <CheckCircle2 className="size-4 text-fuchsia-700 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {flow === "improve" && step === 1 && (
          <div className="py-2">
            <label
              className={cn(
                "relative block border-2 border-dashed rounded-lg px-4 py-10 text-center transition-colors text-sm",
                scanning ? "border-fuchsia-300 bg-fuchsia-50 dark:bg-fuchsia-950/20 cursor-wait" : "cursor-pointer border-muted-foreground/20 hover:border-fuchsia-400 hover:bg-muted/30",
              )}
            >
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                className="hidden"
                disabled={scanning}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
              />
              {scanning ? (
                <span className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-6 animate-spin text-fuchsia-500" />
                  <span className="font-semibold text-foreground">{file?.name}</span>
                  <span className="text-xs">Scanning the document — structure, size, first impressions…</span>
                </span>
              ) : (
                <span className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Upload className="size-6 opacity-60" />
                  <span>Drop a DOCX here (best — full preview &amp; exports) or PDF</span>
                </span>
              )}
            </label>
          </div>
        )}

        {flow === "improve" && step === 2 && scan && (
          <div className="space-y-4 py-1">
            {/* scan card */}
            <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                <Gauge className="size-3.5" /> Document scan · {file?.name}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  { icon: ScrollText, label: "Pages", value: `~${scan.stats.estPages}` },
                  { icon: FileText, label: "Words", value: scan.stats.words.toLocaleString() },
                  { icon: ListTree, label: "Sections", value: String(scan.stats.sections) },
                  { icon: Table2, label: "Tables", value: String(scan.stats.tables) },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg bg-card border px-2 py-2">
                    <s.icon className="size-3.5 mx-auto text-muted-foreground" />
                    <div className="text-sm font-bold mt-1">{s.value}</div>
                    <div className="text-[10px] text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>
              {scan.observations.length > 0 && (
                <ul className="space-y-1">
                  {scan.observations.map((o, i) => (
                    <li key={i} className="text-xs text-foreground/90 flex gap-1.5">
                      <span className="text-fuchsia-500 shrink-0">›</span> {o}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* intent picker */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                What should happen?
              </div>
              <div className="grid grid-cols-2 gap-2">
                {INTENTS.map((it) => {
                  const Icon = it.icon;
                  const active = intent === it.id;
                  const isRecommended = scan.recommended === it.id;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => setIntent(it.id)}
                      className={cn(
                        "relative rounded-xl border p-3 text-left transition-colors space-y-1",
                        active
                          ? "border-fuchsia-500 bg-fuchsia-50 dark:bg-fuchsia-950/20 ring-1 ring-fuchsia-300"
                          : "hover:border-fuchsia-300 hover:bg-muted/30",
                      )}
                    >
                      {isRecommended && (
                        <span className="absolute -top-2 right-2 rounded-full bg-fuchsia-600 text-white text-[9px] font-bold px-2 py-0.5">
                          AI RECOMMENDED
                        </span>
                      )}
                      <div className="flex items-center gap-1.5">
                        <Icon className={cn("size-4", active ? "text-fuchsia-600" : "text-muted-foreground")} />
                        <span className={cn("text-xs font-bold", active && "text-fuchsia-700")}>{it.name}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground leading-snug">{it.blurb}</div>
                    </button>
                  );
                })}
              </div>
              {scan.rationale && (
                <p className="text-[11px] text-muted-foreground italic">Why: {scan.rationale}</p>
              )}
            </div>

            {/* name + instruction */}
            <div className="space-y-2">
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="Name (optional) — e.g. Operations Manual S16"
                className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-fuchsia-500"
              />
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                placeholder={intent === "redraft"
                  ? "Direction for the redraft — e.g. Align with the 2026 outsourcing policy; merge the duplicated escalation sections."
                  : "Specific instruction (optional) — e.g. Pay extra attention to Section 7 escalations."}
                className="w-full text-xs px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-fuchsia-500 resize-none"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {flow === "improve" && step === 2 && (
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Different file
            </Button>
          )}
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }} disabled={busy || scanning}>
            Cancel
          </Button>
          {flow === "create" && (
            <Button
              onClick={submitCreate}
              disabled={!newTitle.trim() || newBrief.trim().length < 20 || !donorId || busy}
              className="gap-2 bg-fuchsia-600 hover:bg-fuchsia-700 text-white"
            >
              {busy ? (<><Loader2 className="size-3.5 animate-spin" /> Starting…</>) : (<><FilePlus2 className="size-3.5" /> Draft document</>)}
            </Button>
          )}
          {flow === "improve" && step === 2 && (
            <Button
              onClick={submit}
              disabled={!intent || busy}
              className="gap-2 bg-fuchsia-600 hover:bg-fuchsia-700 text-white"
            >
              {busy ? (
                <><Loader2 className="size-3.5 animate-spin" /> Starting…</>
              ) : (
                <><Wand2 className="size-3.5" /> Run {INTENTS.find((i) => i.id === intent)?.name}</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
