import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createCreditRiskReport } from "@/lib/compliance.functions";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Upload, Loader2, ShieldAlert, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Derive a likely borrower name from a credit-application filename, e.g.
 * "Credit Application (SB SDN BHD- Rejection).pdf" → "SB SDN BHD".
 * Best-effort only — the field is editable.
 */
function guessBorrower(filename: string): string {
  let base = filename.replace(/\.[^.]+$/, "");
  const paren = base.match(/\(([^)]+)\)/);
  if (paren) base = paren[1];
  base = base
    .replace(/credit\s*application/gi, "")
    .replace(/\b(rejection|rejected|approval|approved|declined|decline|application|appl?n)\b/gi, "")
    .replace(/[-–—_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return base;
}

/**
 * Credit Risk Alert — create a report from an uploaded credit application.
 * Lazy like the regulatory/simplify flows: uploads the file, records the
 * borrower, marks pending_analysis, then the report page runs the analysis.
 */
export function CreditUploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const createFn = useServerFn(createCreditRiskReport);
  const [workspace] = useWorkspace();

  const [file, setFile] = useState<File | null>(null);
  const [borrower, setBorrower] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setBorrower("");
    setBusy(false);
  }

  function pickFile(f: File | null) {
    setFile(f);
    if (f && !borrower.trim()) setBorrower(guessBorrower(f.name));
  }

  const canSubmit = !!file && !!borrower.trim();

  async function submit() {
    if (!canSubmit || busy || !file) return;
    setBusy(true);
    try {
      const path = `credit_risk/${Date.now()}-${file.name}`;
      const up = await supabase.storage.from("policies").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) throw up.error;
      const fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

      const { reportId } = await createFn({
        data: { filename: file.name, fileUrl, workspace, borrowerName: borrower.trim() },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
    } catch (e: any) {
      toast.error("Could not start the credit risk analysis", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-red-600" /> New Credit Risk Analysis
          </DialogTitle>
          <DialogDescription>
            Upload a credit application. It's screened across 8 risk dimensions against the internal
            case knowledge base — every flag traced back to a historical post-mortem case.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 — the application file */}
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 1 · Credit application
            </div>
            <label
              className={cn(
                "relative block border-2 border-dashed rounded-lg px-4 py-6 text-center cursor-pointer transition-colors text-sm",
                file
                  ? "border-red-300 bg-red-50 dark:bg-red-950/20"
                  : "border-muted-foreground/20 hover:border-red-400 hover:bg-muted/30",
              )}
            >
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className="flex items-center justify-center gap-2">
                  <FileText className="size-4 text-red-500" />
                  <span className="font-semibold">{file.name}</span>
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Upload className="size-4 opacity-60" />
                  <span>Drop a PDF or DOCX credit application here</span>
                </span>
              )}
            </label>
          </section>

          {/* Step 2 — borrower */}
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 2 · Borrower / applicant name <span className="text-rose-500">*</span>
            </div>
            <input
              type="text"
              value={borrower}
              onChange={(e) => setBorrower(e.target.value)}
              placeholder="e.g. SB SDN BHD"
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-red-500"
            />
            <p className="text-[11px] text-muted-foreground">
              Auto-filled from the filename — adjust if needed. Used as the report title.
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="gap-2 bg-red-600 hover:bg-red-700 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <ShieldAlert className="size-3.5" /> Run Risk Analysis
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
