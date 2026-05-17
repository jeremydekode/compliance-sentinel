import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createFormUpdateReport } from "@/lib/compliance.functions";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, FileEdit, Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type FieldChange = { label: string; oldValue: string; newValue: string };

export function FormUpdateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const createFn = useServerFn(createFormUpdateReport);
  const [workspace] = useWorkspace();

  const [formId, setFormId] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [fields, setFields] = useState<FieldChange[]>([
    { label: "Name", oldValue: "", newValue: "" },
    { label: "Version", oldValue: "", newValue: "" },
    { label: "Date", oldValue: "", newValue: "" },
  ]);

  const [busy, setBusy] = useState(false);

  function reset() {
    setFormId("");
    setFriendlyName("");
    setCustomTitle("");
    setNotes("");
    setFile(null);
    setFields([
      { label: "Name", oldValue: "", newValue: "" },
      { label: "Version", oldValue: "", newValue: "" },
      { label: "Date", oldValue: "", newValue: "" },
    ]);
  }

  function updateField(idx: number, patch: Partial<FieldChange>) {
    setFields((fs) => fs.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((fs) => [...fs, { label: "", oldValue: "", newValue: "" }]);
  }
  function removeField(idx: number) {
    setFields((fs) => fs.filter((_, i) => i !== idx));
  }

  const canSubmit =
    formId.trim().length > 1 &&
    fields.filter((f) => f.label.trim() && f.oldValue.trim() && f.newValue.trim()).length > 0;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      let newFileUrl: string | null = null;
      if (file) {
        const path = `forms/${Date.now()}-${file.name}`;
        const up = await supabase.storage.from("policies").upload(path, file, {
          upsert: false,
          contentType: file.type,
        });
        if (!up.error) {
          const { data } = supabase.storage.from("policies").getPublicUrl(path);
          newFileUrl = data.publicUrl;
        }
      }
      const validFields = fields.filter((f) => f.label.trim() && f.oldValue.trim() && f.newValue.trim());

      toast.message("Analysing form references across the KB…", { duration: 4000 });
      const res = await createFn({
        data: {
          workspace,
          formId: formId.trim(),
          friendlyName: friendlyName.trim() || undefined,
          customTitle: customTitle.trim() || undefined,
          notes: notes.trim() || undefined,
          newFileUrl,
          fieldChanges: validFields,
        },
      });
      toast.success(`Form update analysis complete`, {
        description: `${res.impactCount} edit${res.impactCount !== 1 ? "s" : ""} across ${res.affectedDocs} document${res.affectedDocs !== 1 ? "s" : ""}`,
      });
      reset();
      onOpenChange(false);
      onCreated(res.reportId);
    } catch (e: any) {
      toast.error("Form update failed", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileEdit className="size-4 text-amber-600" /> New Form / Template Update
          </DialogTitle>
          <DialogDescription>
            Specify what changed in the form. The system will find all references across downstream docs and generate find/replace edits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 — Identify */}
          <section className="space-y-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 1 · Identify the form</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold mb-1.5">Form ID / Number <span className="text-rose-500">*</span></label>
                <input
                  type="text" value={formId} onChange={(e) => setFormId(e.target.value)}
                  placeholder="e.g. FGROP 037/2016"
                  className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5">Friendly name (optional)</label>
                <input
                  type="text" value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)}
                  placeholder="e.g. Account Opening Application Form"
                  className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5">New form file (optional)</label>
              <label className={cn(
                "block border-2 border-dashed rounded-lg px-4 py-3 text-center cursor-pointer transition-colors text-sm",
                file ? "border-amber-300 bg-amber-50" : "border-muted-foreground/20 hover:border-amber-400 hover:bg-muted/30"
              )}>
                <input type="file" accept=".pdf,.doc,.docx" className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <Upload className="size-4 inline-block mr-2 opacity-60" />
                {file ? <span className="font-semibold">{file.name}</span> : <span className="text-muted-foreground">Drop the new form PDF/DOCX (or skip)</span>}
              </label>
            </div>
          </section>

          {/* Step 2 — Field changes */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 2 · What changed?</div>
              <Button size="sm" variant="ghost" onClick={addField} className="h-7 text-xs gap-1">
                <Plus className="size-3" /> Add field
              </Button>
            </div>
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={i} className="grid grid-cols-[100px_1fr_1fr_auto] gap-2 items-start">
                  <input
                    type="text" value={f.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                    placeholder="Field"
                    className="text-xs font-semibold px-2 py-1.5 rounded border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <textarea
                    value={f.oldValue}
                    onChange={(e) => updateField(i, { oldValue: e.target.value })}
                    placeholder="Old value (verbatim)"
                    rows={2}
                    className="text-xs font-mono px-2 py-1.5 rounded border bg-rose-50 dark:bg-rose-950/20 border-rose-100 focus:outline-none focus:ring-1 focus:ring-rose-300 resize-none"
                  />
                  <textarea
                    value={f.newValue}
                    onChange={(e) => updateField(i, { newValue: e.target.value })}
                    placeholder="New value (verbatim)"
                    rows={2}
                    className="text-xs font-mono px-2 py-1.5 rounded border bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 focus:outline-none focus:ring-1 focus:ring-emerald-300 resize-none"
                  />
                  <button
                    onClick={() => removeField(i)}
                    disabled={fields.length <= 1}
                    className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 transition-colors"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Step 3 — Submit details */}
          <section className="space-y-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 3 · Submission details</div>
            <div>
              <label className="block text-xs font-semibold mb-1.5">Analysis name</label>
              <input
                type="text" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)}
                placeholder={formId ? `${formId} update` : "e.g. FGROP 037 v10 → v11"}
                className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Will be saved in <span className="font-semibold">{WORKSPACES[workspace].name}</span> workspace.
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5">Notes for the analyst (optional)</label>
              <textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full text-xs px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
                placeholder="Any context for reviewers"
              />
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
          >
            {busy ? <><Loader2 className="size-3.5 animate-spin" /> Analysing…</> : <><FileEdit className="size-3.5" /> Run Form Update Analysis</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
