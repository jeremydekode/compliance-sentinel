import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createMbrsFiling } from "@/lib/compliance.functions";
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
import { Upload, Loader2, FileSpreadsheet, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Best-effort company name from an AFS filename, e.g.
 *  "IOT Foresight 2025 - Audited report.pdf" → "IOT Foresight". Editable. */
function guessCompany(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/\b(audited|audit)\b\s*(report|accounts|financial statements)?/gi, "")
    .replace(/\bfinancial statements?\b/gi, "")
    .replace(/\bFY\s*\d{2,4}\b/gi, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/[-–—_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function MbrsUploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const createFn = useServerFn(createMbrsFiling);
  const [workspace] = useWorkspace();

  const [file, setFile] = useState<File | null>(null);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setCompany("");
    setBusy(false);
  }

  function pickFile(f: File | null) {
    setFile(f);
    if (f && !company.trim()) setCompany(guessCompany(f.name));
  }

  const canSubmit = !!file && !!company.trim();

  async function submit() {
    if (!canSubmit || busy || !file) return;
    setBusy(true);
    try {
      const path = `mbrs/${Date.now()}-${file.name}`;
      const up = await supabase.storage.from("policies").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) throw up.error;
      const fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

      const { reportId } = await createFn({
        data: { filename: file.name, fileUrl, workspace, companyName: company.trim() },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
    } catch (e: any) {
      toast.error("Could not start the MBRS conversion", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-4 text-teal-600" /> New MBRS Filing
          </DialogTitle>
          <DialogDescription>
            Upload a set of audited financial statements. Figures and disclosures are extracted,
            checked against the statement arithmetic, and converted to an SSM-format XBRL file.
            Scanned reports are read with OCR.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 1 · Audited financial statements
            </div>
            <label
              className={cn(
                "relative block border-2 border-dashed rounded-lg px-4 py-6 text-center cursor-pointer transition-colors text-sm",
                file
                  ? "border-teal-300 bg-teal-50 dark:bg-teal-950/20"
                  : "border-muted-foreground/20 hover:border-teal-400 hover:bg-muted/30",
              )}
            >
              <input
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className="flex items-center justify-center gap-2">
                  <FileText className="size-4 text-teal-500" />
                  <span className="font-semibold">{file.name}</span>
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Upload className="size-4 opacity-60" />
                  <span>Drop the audited report PDF here</span>
                </span>
              )}
            </label>
          </section>

          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 2 · Company name <span className="text-rose-500">*</span>
            </div>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. IOT FORESIGHT SDN BHD"
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <p className="text-[11px] text-muted-foreground">
              Auto-filled from the filename. Used as the filing title — the registered name is taken
              from the report itself.
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
            className="gap-2 bg-teal-600 hover:bg-teal-700 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <FileSpreadsheet className="size-3.5" /> Extract & Convert
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
