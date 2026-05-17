import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  requestLegalSignOff,
  finalizeLegalSignOff,
  publishToKB,
  markPendingManual,
  confirmManualCompletion,
} from "@/lib/compliance.functions";
import { exportInstructionMemo } from "@/lib/exports";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  ShieldCheck, Scale, Rocket, FileText, Database, Loader2, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export function ApprovalWorkflow({ report }: { report: any }) {
  const qc = useQueryClient();
  const reqLegal = useServerFn(requestLegalSignOff);
  const finLegal = useServerFn(finalizeLegalSignOff);
  const publish = useServerFn(publishToKB);
  const markManual = useServerFn(markPendingManual);
  const confirmManual = useServerFn(confirmManualCompletion);

  const [legalOpen, setLegalOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const impacts = useQuery({
    queryKey: ["impacts", report.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("sop_impacts")
        .select("*")
        .eq("report_id", report.id)
        .order("position");
      return data ?? [];
    },
  });

  const stats = useMemo(() => {
    const list = impacts.data ?? [];
    return {
      total: list.length,
      approved: list.filter((i: any) => i.status === "approved").length,
      rejected: list.filter((i: any) => i.status === "rejected").length,
      routed: list.filter((i: any) => i.status === "routed").length,
      pending: list.filter((i: any) => !i.status || i.status === "pending").length,
    };
  }, [impacts.data]);

  const status = report.status as string;
  const allReviewed = stats.total > 0 && stats.pending === 0;
  const hasApproved = stats.approved + stats.routed > 0;

  async function run<T>(key: string, fn: () => Promise<T>, msg: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      qc.invalidateQueries({ queryKey: ["report", report.id] });
      qc.invalidateQueries({ queryKey: ["impacts", report.id] });
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed");
    } finally {
      setBusy(null);
    }
  }

  // Phase A — Compliance validation (compact horizontal strip)
  if (status === "pending_validation" || status === "draft" || status === "pending_review") {
    return (
      <div className="border-b border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
        <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
          <ShieldCheck className="size-4 text-blue-700 shrink-0" />
          <div className="text-xs font-bold text-blue-900 dark:text-blue-300 whitespace-nowrap">
            Compliance Review
          </div>
          <div className="h-4 w-px bg-blue-300/50" />
          <div className="flex items-center gap-1.5 text-[11px] flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-white border text-foreground/80"><span className="font-bold">{stats.total}</span> total</span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200"><span className="font-bold">{stats.approved}</span> approved</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200"><span className="font-bold">{stats.routed}</span> routed</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200"><span className="font-bold">{stats.rejected}</span> rejected</span>
            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200"><span className="font-bold">{stats.pending}</span> pending</span>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!allReviewed && (
              <span className="text-[10px] text-blue-900/70 italic hidden lg:inline">
                Resolve {stats.pending} pending first
              </span>
            )}
            <Button
              size="sm"
              onClick={() => setLegalOpen(true)}
              disabled={!allReviewed || !hasApproved}
              className="h-7 text-xs gap-1.5"
            >
              <Scale className="size-3" />
              Submit to Legal
            </Button>
          </div>
        </div>

        <Dialog open={legalOpen} onOpenChange={setLegalOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Submit Change Notice to Legal</DialogTitle>
              <DialogDescription>
                This will package all approved and routed amendments and send them to Legal for final sign-off.
                After Legal confirms, you will be able to export the formal Instruction Memo.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2 max-h-72 overflow-auto">
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                <div><span className="text-muted-foreground">Regulation:</span> <strong>{report.policy_name}</strong></div>
                <div><span className="text-muted-foreground">Total items:</span> <strong>{stats.total}</strong></div>
                <div><span className="text-muted-foreground text-emerald-700">Approved by Compliance:</span> <strong className="text-emerald-700">{stats.approved}</strong></div>
                <div><span className="text-muted-foreground text-amber-700">Routed for Legal review:</span> <strong className="text-amber-700">{stats.routed}</strong></div>
                <div><span className="text-muted-foreground">Excluded (rejected):</span> <strong>{stats.rejected}</strong></div>
              </div>
              <div className="border-t pt-2 mt-2">
                <div className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Items included in this submission</div>
                <ul className="space-y-1">
                  {(impacts.data ?? [])
                    .filter((i: any) => i.status === "approved" || i.status === "routed")
                    .map((i: any, idx: number) => (
                      <li key={i.id} className="text-xs flex items-start gap-2">
                        <span className="text-muted-foreground font-mono w-5 shrink-0">{idx + 1}.</span>
                        <span>
                          <span className="font-medium">{i.sop_title?.replace(/\s*\(no matching internal doc(?:\s+found)?\)/gi, "")}</span>
                          <span className="text-muted-foreground"> — {i.chapter}{i.page ? ` · p.${i.page}` : ""}</span>
                          {i.status === "routed" && <span className="ml-1 text-amber-600 font-semibold text-[10px]">[Legal review required]</span>}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setLegalOpen(false)}>Cancel</Button>
              <Button
                disabled={busy === "req"}
                onClick={async () => {
                  await run("req", () => reqLegal({ data: { reportId: report.id } }), "Change Notice submitted to Legal");
                  setLegalOpen(false);
                }}
                className="gap-2"
              >
                {busy === "req" ? <Loader2 className="size-4 animate-spin" /> : <Scale className="size-4" />}
                Confirm &amp; Submit to Legal
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Phase B — Pending Legal (compact)
  if (status === "pending_legal") {
    return (
      <div className="border-b border-violet-200 bg-violet-50/50 dark:bg-violet-950/20">
        <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
          <Scale className="size-4 text-violet-700 shrink-0" />
          <div className="text-xs font-bold text-violet-900 dark:text-violet-300 whitespace-nowrap">
            Awaiting Legal Sign-Off
          </div>
          <div className="h-4 w-px bg-violet-300/50" />
          <div className="text-[11px] text-violet-900/80 dark:text-violet-300/80">
            <span className="font-bold">{stats.approved + stats.routed}</span> items queued · Switch to <span className="font-semibold">Head of Legal</span> role to sign off
          </div>
          <div className="ml-auto shrink-0">
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5"
              disabled={busy === "fin"}
              onClick={() => run("fin", () => finLegal({ data: { reportId: report.id } }), "Legal sign-off recorded")}
            >
              {busy === "fin" ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              Record Sign-Off
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Step 8 — Execution (compact)
  if (status === "signed_off") {
    return (
      <div className="border-b border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20">
        <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
          <Rocket className="size-4 text-emerald-700 shrink-0" />
          <div className="text-xs font-bold text-emerald-900 dark:text-emerald-300 whitespace-nowrap">
            Execute &amp; Publish
          </div>
          <div className="h-4 w-px bg-emerald-300/50" />
          <div className="text-[11px] text-emerald-900/80 dark:text-emerald-300/80">
            Legal signed off · <span className="font-bold">{stats.approved}</span> changes ready to apply
          </div>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <Button size="sm" onClick={() => setExecOpen(true)} className="h-7 text-xs gap-1.5">
              <Rocket className="size-3" /> Execute…
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 border-emerald-300 text-emerald-900 hover:bg-emerald-50"
              disabled={busy === "confirm"}
              onClick={() =>
                run("confirm", () => confirmManual({ data: { reportId: report.id } }),
                  "Manual execution confirmed · report marked as Published")
              }
            >
              {busy === "confirm" ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              Confirm Manual
            </Button>
          </div>
        </div>

        <Dialog open={execOpen} onOpenChange={setExecOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Execute Approved Changes</DialogTitle>
              <DialogDescription>Pick one execution path.</DialogDescription>
            </DialogHeader>
            <div className="grid md:grid-cols-2 gap-3">
              <button
                disabled={!!busy}
                onClick={async () => {
                  await run(
                    "pub",
                    async () => {
                      const r = await publish({ data: { reportId: report.id } });
                      toast.message(`Updated ${r.updatedSops} SOP(s) in the Knowledge Base.`);
                    },
                    "Published to Knowledge Base"
                  );
                  setExecOpen(false);
                }}
                className="text-left rounded-md border-2 border-emerald-300 bg-white p-4 hover:bg-emerald-50 disabled:opacity-50"
              >
                <Database className="size-5 text-emerald-700" />
                <div className="font-display font-semibold mt-2">Direct KB Integration</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Bumps the SOP version and records the approved Find/Replace blocks in the changelog.
                  The original uploaded file is <span className="font-semibold">not</span> rewritten — re-upload the revised file from Knowledge Base if needed.
                </p>
                {busy === "pub" && <Loader2 className="size-4 animate-spin mt-2" />}
              </button>
              <button
                disabled={!!busy}
                onClick={async () => {
                  exportInstructionMemo(report, impacts.data ?? []);
                  await run(
                    "memo",
                    () => markManual({ data: { reportId: report.id } }),
                    "Memo generated · marked Pending Manual Execution"
                  );
                  setExecOpen(false);
                }}
                className="text-left rounded-md border-2 border-amber-300 bg-white p-4 hover:bg-amber-50 disabled:opacity-50"
              >
                <FileText className="size-5 text-amber-700" />
                <div className="font-display font-semibold mt-2">Export Instruction Memo</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Generate a printable memo with exact locations &amp; Find/Replace blocks for human execution.
                </p>
                {busy === "memo" && <Loader2 className="size-4 animate-spin mt-2" />}
              </button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExecOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (status === "published") {
    return (
      <div className="border-b border-emerald-300 bg-emerald-100/50 dark:bg-emerald-950/30">
        <div className="px-4 py-2 flex items-center gap-3">
          <CheckCircle2 className="size-4 text-emerald-700" />
          <div className="text-xs font-bold text-emerald-900 dark:text-emerald-300">Published to Knowledge Base</div>
          <div className="h-4 w-px bg-emerald-400/50" />
          <div className="text-[11px] text-emerald-900/80 dark:text-emerald-300/80">All approved changes applied · SOPs versioned</div>
        </div>
      </div>
    );
  }

  if (status === "pending_manual") {
    return (
      <div className="border-b border-amber-200 bg-amber-50/50 dark:bg-amber-950/20">
        <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
          <FileText className="size-4 text-amber-700 shrink-0" />
          <div className="text-xs font-bold text-amber-900 dark:text-amber-300 whitespace-nowrap">Pending Manual Execution</div>
          <div className="h-4 w-px bg-amber-300/50" />
          <div className="text-[11px] text-amber-900/80 dark:text-amber-300/80">
            Instruction Memo issued · awaiting team to apply changes in source documents
          </div>
          <div className="ml-auto shrink-0">
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5"
              disabled={busy === "confirm"}
              onClick={() =>
                run("confirm", () => confirmManual({ data: { reportId: report.id } }),
                  "Manual execution confirmed · report marked as Published")
              }
            >
              {busy === "confirm" ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              Confirm Completion
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
