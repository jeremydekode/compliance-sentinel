import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createRspoReview } from "@/lib/compliance.functions";
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
import { Upload, Loader2, ShieldCheck, FileText, FileSpreadsheet } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CERT_TYPE_LABELS, type RspoCertType } from "@/lib/rspo-checklist";

const CERT_TYPES: RspoCertType[] = ["single_site", "multi_site", "group"];

type SlotKey = "certificate" | "auditReport" | "prisma";

const SLOTS: Array<{ key: SlotKey; label: string; accept: string; hint: string }> = [
  { key: "certificate", label: "Certificate (PDF)", accept: ".pdf", hint: "The RSPO SCC certificate issued by the CB" },
  { key: "auditReport", label: "Audit report (PDF)", accept: ".pdf", hint: "The full audit report — long reports are fine" },
  { key: "prisma", label: "PRISMA / CLM export (XLSX)", accept: ".xlsx,.xls", hint: "The audit + CLM data export from PRISMA" },
];

export function RspoUploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const createFn = useServerFn(createRspoReview);
  const [workspace] = useWorkspace();

  const [certType, setCertType] = useState<RspoCertType>("single_site");
  const [files, setFiles] = useState<Partial<Record<SlotKey, File>>>({});
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFiles({});
    setCompany("");
    setCertType("single_site");
    setBusy(false);
  }

  const canSubmit = !!files.certificate && !!files.auditReport && !!files.prisma && !!company.trim();

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const stamp = Date.now();
      async function put(f: File): Promise<string> {
        const path = `rspo/${stamp}-${f.name}`;
        const up = await supabase.storage.from("policies").upload(path, f, {
          upsert: false,
          contentType: f.type || "application/octet-stream",
        });
        if (up.error) throw up.error;
        return supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
      }
      // Sequential — three parallel uploads on a slow uplink starve each other
      // and the failure story gets murky; these are big files.
      const certificateUrl = await put(files.certificate!);
      const auditReportUrl = await put(files.auditReport!);
      const prismaUrl = await put(files.prisma!);

      const { reportId } = await createFn({
        data: {
          companyName: company.trim(),
          certType,
          workspace,
          certificateUrl,
          certificateName: files.certificate!.name,
          auditReportUrl,
          auditReportName: files.auditReport!.name,
          prismaUrl,
          prismaName: files.prisma!.name,
        },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
    } catch (e: any) {
      toast.error("Could not start the licence review", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-lime-600" /> New Licence Review
          </DialogTitle>
          <DialogDescription>
            Upload the certificate, the audit report and the PRISMA export. The checklist is
            completed automatically with every discrepancy flagged for your review — nothing is
            approved without a reviewer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 1 · Certification type
            </div>
            <div className="grid grid-cols-3 gap-2">
              {CERT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setCertType(t)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors text-center",
                    certType === t
                      ? "border-lime-500 bg-lime-50 dark:bg-lime-950/20 text-lime-900 dark:text-lime-100"
                      : "border-muted-foreground/20 hover:border-lime-400 hover:bg-muted/30",
                  )}
                >
                  {CERT_TYPE_LABELS[t].replace(" Certification", "")}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Drives which checklist items apply — multi-site and group reviews check the site /
              member tables too.
            </p>
          </section>

          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 2 · Documents <span className="text-rose-500">*</span>
            </div>
            {SLOTS.map((slot) => {
              const f = files[slot.key];
              return (
                <label
                  key={slot.key}
                  className={cn(
                    "relative flex items-center gap-3 border-2 border-dashed rounded-lg px-4 py-3 cursor-pointer transition-colors text-sm",
                    f
                      ? "border-lime-300 bg-lime-50 dark:bg-lime-950/20"
                      : "border-muted-foreground/20 hover:border-lime-400 hover:bg-muted/30",
                  )}
                >
                  <input
                    type="file"
                    accept={slot.accept}
                    className="hidden"
                    onChange={(e) => {
                      const picked = e.target.files?.[0] ?? null;
                      setFiles((prev) => {
                        const next = { ...prev };
                        if (picked) next[slot.key] = picked;
                        else delete next[slot.key];
                        return next;
                      });
                    }}
                  />
                  {slot.key === "prisma" ? (
                    <FileSpreadsheet className={cn("size-4 shrink-0", f ? "text-lime-600" : "opacity-50")} />
                  ) : (
                    <FileText className={cn("size-4 shrink-0", f ? "text-lime-600" : "opacity-50")} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold truncate">{f ? f.name : slot.label}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">{slot.hint}</span>
                  </span>
                  {!f && <Upload className="size-4 opacity-50 shrink-0" />}
                </label>
              );
            })}
          </section>

          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 3 · Company / management unit name <span className="text-rose-500">*</span>
            </div>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Alioth"
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-lime-500"
            />
            <p className="text-[11px] text-muted-foreground">
              Used as the review title. The certified company's registered details come from the
              documents themselves.
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
            className="gap-2 bg-lime-600 hover:bg-lime-700 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <ShieldCheck className="size-3.5" /> Start Review
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
