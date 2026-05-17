import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getAmendableDocuments,
  generateDocumentPreview,
  finalizeDocumentAmendment,
} from "@/lib/compliance.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { FileEdit, Loader2, CheckCircle2, FileText, Sparkles, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function AmendmentPanel({ reportId }: { reportId: string }) {
  const qc = useQueryClient();
  const getDocs = useServerFn(getAmendableDocuments);
  const preview = useServerFn(generateDocumentPreview);
  const finalize = useServerFn(finalizeDocumentAmendment);

  const [previewing, setPreviewing] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [previewData, setPreviewData] = useState<{
    sopId: string;
    sopTitle: string;
    currentVersion: string;
    nextVersion: string;
    editsApplied: number;
    amendedHtml: string;
  } | null>(null);

  const docs = useQuery({
    queryKey: ["amendable", reportId],
    queryFn: async () => {
      const r = await getDocs({ data: { reportId } });
      return r.documents;
    },
  });

  const remaining = (docs.data ?? []).filter((d: any) => d.is_active);
  if (!docs.isLoading && remaining.length === 0) return null;

  async function handlePreview(sopId: string) {
    setPreviewing(sopId);
    try {
      const r = await preview({ data: { reportId, sopId } });
      setPreviewData({ sopId, ...r });
    } catch (e: any) {
      toast.error("Preview failed", { description: e?.message });
    } finally {
      setPreviewing(null);
    }
  }

  async function handleFinalize() {
    if (!previewData) return;
    setFinalizing(true);
    try {
      const r = await finalize({
        data: {
          reportId,
          sopId: previewData.sopId,
          amendedHtml: previewData.amendedHtml,
        },
      });
      toast.success(`Saved as v${r.newVersion}`, { description: "Amended document published to KB" });
      setPreviewData(null);
      qc.invalidateQueries({ queryKey: ["amendable", reportId] });
      qc.invalidateQueries({ queryKey: ["impacts", reportId] });
      qc.invalidateQueries({ queryKey: ["sops"] });
      qc.invalidateQueries({ queryKey: ["sop_documents_all"] });
    } catch (e: any) {
      toast.error("Finalize failed", { description: e?.message });
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div className="border-b border-indigo-200 bg-indigo-50/50 dark:bg-indigo-950/20">
      <div className="px-4 py-2.5 flex items-start gap-3 flex-wrap">
        <FileEdit className="size-4 text-indigo-700 shrink-0 mt-0.5" />
        <div className="text-xs font-bold text-indigo-900 dark:text-indigo-300 whitespace-nowrap mt-0.5">
          Step 9 · Apply Amendments
        </div>
        <div className="h-4 w-px bg-indigo-300/50 mt-1" />
        <div className="text-[11px] text-indigo-900/80 dark:text-indigo-300/80 mt-0.5">
          {remaining.length} {remaining.length === 1 ? "document" : "documents"} ready · click preview to amend
        </div>

        <div className="basis-full flex flex-wrap gap-2 mt-2">
          {docs.isLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {remaining.map((d: any) => (
            <div key={d.sop_id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900/60 border text-xs">
              <FileText className="size-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium truncate max-w-[200px]" title={d.title}>{d.title}</span>
              <span className="text-muted-foreground font-mono">v{d.version}</span>
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-indigo-100 text-indigo-700 border-indigo-200">
                {d.edits_count} {d.edits_count === 1 ? "edit" : "edits"}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={previewing === d.sop_id}
                onClick={() => handlePreview(d.sop_id)}
                className="h-6 px-2 text-[10px] gap-1"
              >
                {previewing === d.sop_id
                  ? <><Loader2 className="size-3 animate-spin" /> Generating…</>
                  : <><Sparkles className="size-3" /> Generate Preview</>}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={!!previewData} onOpenChange={(o) => !o && setPreviewData(null)}>
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0">
          {previewData && (
            <>
              <DialogHeader className="px-6 py-4 border-b shrink-0">
                <DialogTitle className="flex items-center gap-3 flex-wrap">
                  <FileEdit className="size-4 text-indigo-600" />
                  <span className="truncate">{previewData.sopTitle}</span>
                  <Badge variant="outline" className="font-mono">
                    v{previewData.currentVersion} → v{previewData.nextVersion}
                  </Badge>
                  <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200">
                    {previewData.editsApplied} edits applied
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Review the amended document below. Highlighted text shows the inserted/replaced sections.
                  Click <strong>Finalize</strong> to publish as v{previewData.nextVersion} in the Knowledge Base.
                </DialogDescription>
              </DialogHeader>

              <div className="flex-1 overflow-hidden bg-slate-50 dark:bg-slate-900/40">
                <iframe
                  title="Amended preview"
                  srcDoc={`<!doctype html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:Georgia,serif;color:#111;max-width:780px;margin:32px auto;padding:0 28px;line-height:1.55;font-size:13px}
  h1{font-size:20px;margin:0 0 8px} h2{font-size:15px;margin:20px 0 6px}
  h3{font-size:13px;margin:14px 0 6px} p{margin:0 0 8px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
  th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:#f5f5f5;font-weight:700}
  ul,ol{margin:6px 0 8px 22px} li{margin-bottom:2px}
  mark.amended{background:#fffacc;padding:1px 3px;border-radius:2px;border-bottom:2px solid #e0b800}
</style></head><body>${previewData.amendedHtml}</body></html>`}
                  className="w-full h-full bg-white"
                />
              </div>

              <DialogFooter className="px-6 py-3 border-t bg-card shrink-0 sm:justify-between gap-2">
                <div className="flex items-center gap-2 text-[10px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  <span>For PDF sources, formatting is re-rendered cleanly — original layout may not be pixel-perfect.</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => setPreviewData(null)} disabled={finalizing}>
                    Discard
                  </Button>
                  <Button
                    onClick={handleFinalize}
                    disabled={finalizing}
                    className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {finalizing
                      ? <><Loader2 className="size-3.5 animate-spin" /> Publishing…</>
                      : <><CheckCircle2 className="size-3.5" /> Finalize &amp; Publish v{previewData.nextVersion}</>}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
