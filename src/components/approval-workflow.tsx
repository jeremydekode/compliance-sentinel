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

  // Phase A — Compliance validation
  if (status === "pending_validation" || status === "draft" || status === "pending_review") {
    return (
      <Card className="p-5 border-blue-300 bg-blue-50/40">
        <div className="flex items-start gap-3">
          <ShieldCheck className="size-5 text-blue-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-display font-semibold text-blue-900">
              Step 7 · Phase A — Compliance Officer Review
            </div>
            <p className="text-sm text-blue-900/80 mt-1">
              Review every draft annotation below. Approve, reject, or route for legal.
              When all {stats.total} items have a decision, submit the Change Notice package to Legal for sign-off.
            </p>
            <div className="flex flex-wrap gap-2 mt-3 text-xs">
              <Badge variant="outline" className="bg-white">Total {stats.total}</Badge>
              <Badge variant="outline" className="bg-emerald-100 text-emerald-900 border-emerald-300">Approved {stats.approved}</Badge>
              <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300">Routed {stats.routed}</Badge>
              <Badge variant="outline" className="bg-muted">Rejected {stats.rejected}</Badge>
              <Badge variant="outline" className="bg-blue-100 text-blue-900 border-blue-300">Pending {stats.pending}</Badge>
            </div>
            <div className="mt-4">
              <Button
                onClick={() => setLegalOpen(true)}
                disabled={!allReviewed || !hasApproved}
                className="gap-2"
              >
                <Scale className="size-4" />
                Submit Change Notice to Legal
              </Button>
              {!allReviewed && (
                <span className="ml-3 text-xs text-blue-900/70">
                  Resolve all {stats.pending} pending items first.
                </span>
              )}
            </div>
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
      </Card>
    );
  }

  // Phase B — Pending Legal
  if (status === "pending_legal") {
    return (
      <Card className="p-5 border-violet-300 bg-violet-50/40">
        <div className="flex items-start gap-3">
          <Scale className="size-5 text-violet-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-display font-semibold text-violet-900">
              Step 7 · Phase B — Awaiting Legal Sign-Off
            </div>
            <p className="text-sm text-violet-900/80 mt-1">
              {stats.approved + stats.routed} consolidated recommendations are queued for Legal.
              Final sign-off unlocks Step 8 · Execution.
            </p>
            <Button
              className="mt-4 gap-2"
              disabled={busy === "fin"}
              onClick={() => run("fin", () => finLegal({ data: { reportId: report.id } }), "Legal sign-off recorded")}
            >
              {busy === "fin" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Record Final Legal Sign-Off
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // Step 8 — Execution
  if (status === "signed_off") {
    return (
      <Card className="p-5 border-emerald-300 bg-emerald-50/40">
        <div className="flex items-start gap-3">
          <Rocket className="size-5 text-emerald-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-display font-semibold text-emerald-900">
              Step 8 · Execution &amp; Publish
            </div>
            <p className="text-sm text-emerald-900/80 mt-1">
              Legal has signed off. Choose how the {stats.approved} approved changes get applied.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => setExecOpen(true)} className="gap-2">
                <Rocket className="size-4" /> Execute…
              </Button>
              <Button
                variant="outline"
                className="gap-2 border-emerald-300 text-emerald-900 hover:bg-emerald-50"
                disabled={busy === "confirm"}
                onClick={() =>
                  run(
                    "confirm",
                    () => confirmManual({ data: { reportId: report.id } }),
                    "Manual execution confirmed · report marked as Published"
                  )
                }
              >
                {busy === "confirm" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                Confirm Manual Completion
              </Button>
            </div>
            <p className="mt-2 text-xs text-emerald-900/70">
              Use Confirm Manual Completion if the instruction memo has already been actioned outside the system.
            </p>
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
      </Card>
    );
  }

  if (status === "published") {
    return (
      <Card className="p-5 border-emerald-400 bg-emerald-100/50">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-5 text-emerald-700" />
          <div>
            <div className="font-display font-semibold text-emerald-900">Published to Knowledge Base</div>
            <p className="text-sm text-emerald-900/80">All approved changes applied. Affected SOPs versioned and timestamped.</p>
          </div>
        </div>
      </Card>
    );
  }

  if (status === "pending_manual") {
    return (
      <Card className="p-5 border-amber-300 bg-amber-50/40">
        <div className="flex items-start gap-3">
          <FileText className="size-5 text-amber-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-display font-semibold text-amber-900">Pending Manual Execution</div>
            <p className="text-sm text-amber-900/80">
              Instruction Memo issued. Awaiting human team to apply changes in source documents.
              Once the edits have been made in the affected SOPs, confirm completion below to close out this report.
            </p>
            <Button
              className="mt-4 gap-2"
              disabled={busy === "confirm"}
              onClick={() =>
                run(
                  "confirm",
                  () => confirmManual({ data: { reportId: report.id } }),
                  "Manual execution confirmed · report marked as Published"
                )
              }
            >
              {busy === "confirm" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Confirm Manual Completion
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return null;
}
