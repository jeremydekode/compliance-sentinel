import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createFormUpdateReport, extractFormMetadata } from "@/lib/compliance.functions";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, FileEdit, Loader2, Upload, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type FieldChange = { label: string; oldValue: string; newValue: string };

// ── localStorage cache for previously extracted form metadata ─────────────────
const CACHE_KEY = "uc1_form_meta_cache";

type CachedFormMeta = {
  formName: string;
  formNumber: string;
  updatedDate: string;
};

function loadCache(): CachedFormMeta[] {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]"); } catch { return []; }
}

function saveToCache(entry: CachedFormMeta) {
  const existing = loadCache().filter((e) => e.formNumber !== entry.formNumber);
  localStorage.setItem(CACHE_KEY, JSON.stringify([entry, ...existing].slice(0, 20)));
}

// Maps the standard field labels to the cache property
const LABEL_TO_CACHE: Record<string, keyof CachedFormMeta> = {
  Name: "formName",
  Version: "formNumber",
  Date: "updatedDate",
};

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = reject;
  });
}

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
  const extractFn = useServerFn(extractFormMetadata);
  const [workspace] = useWorkspace();

  const [formId, setFormId] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  const [fields, setFields] = useState<FieldChange[]>([
    { label: "Name", oldValue: "", newValue: "" },
    { label: "Version", oldValue: "", newValue: "" },
    { label: "Date", oldValue: "", newValue: "" },
  ]);

  const [busy, setBusy] = useState(false);
  const [cachedSuggestions, setCachedSuggestions] = useState<CachedFormMeta[]>([]);
  const [focusedOldIdx, setFocusedOldIdx] = useState<number | null>(null);

  // Load cache on open
  useEffect(() => {
    if (open) setCachedSuggestions(loadCache());
  }, [open]);

  function reset() {
    setFormId("");
    setFriendlyName("");
    setCustomTitle("");
    setNotes("");
    setFile(null);
    setUploadedFileUrl(null);
    setExtracting(false);
    setFocusedOldIdx(null);
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

  async function handleFileChange(picked: File | null) {
    setFile(picked);
    setUploadedFileUrl(null);
    if (!picked) return;

    const lower = picked.name.toLowerCase();
    const isPdf = picked.type === "application/pdf" || lower.endsWith(".pdf");
    const isDocx = lower.endsWith(".docx") || lower.endsWith(".doc") ||
      picked.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!isPdf && !isDocx) return; // Only PDF / DOCX supported

    setExtracting(true);
    try {
      // Upload to Supabase storage first so we pass a URL to the server function
      // (Vercel serverless functions cap POST bodies at ~4.5 MB — base64 PDFs blow past that).
      const path = `forms/${Date.now()}-${picked.name}`;
      const up = await supabase.storage.from("policies").upload(path, picked, {
        upsert: false,
        contentType: picked.type || (isPdf ? "application/pdf" : "application/octet-stream"),
      });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from("policies").getPublicUrl(path);
      setUploadedFileUrl(pub.publicUrl);

      const meta = await extractFn({ data: { fileUrl: pub.publicUrl, fileName: picked.name } });

      // Derive base formId by stripping version suffix: "FGROP 037/2016_v10" → "FGROP 037/2016"
      if (meta.formNumber && !formId) {
        const baseId = meta.formNumber.replace(/_v\d+$/i, "").trim();
        setFormId(baseId);
      }
      if (meta.formName && !friendlyName) {
        setFriendlyName(meta.formName);
      }

      // Populate the standard oldValue fields only if they're still empty
      setFields((fs) =>
        fs.map((f) => {
          if (f.oldValue) return f; // don't overwrite user input
          if (f.label === "Name" && meta.formName) return { ...f, oldValue: meta.formName };
          if (f.label === "Version" && meta.formNumber) return { ...f, oldValue: meta.formNumber };
          if (f.label === "Date" && meta.updatedDate) return { ...f, oldValue: meta.updatedDate };
          return f;
        })
      );

      // Save extracted metadata to cache
      if (meta.formNumber) {
        const entry: CachedFormMeta = {
          formName: meta.formName ?? "",
          formNumber: meta.formNumber,
          updatedDate: meta.updatedDate ?? "",
        };
        saveToCache(entry);
        setCachedSuggestions(loadCache());
      }
    } catch (e) {
      console.warn("Form metadata extraction failed:", e);
      // Fail silently — user can still fill manually
    } finally {
      setExtracting(false);
    }
  }

  const canSubmit =
    formId.trim().length > 1 &&
    fields.filter((f) => f.label.trim() && f.oldValue.trim() && f.newValue.trim()).length > 0;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      // The file was already uploaded during extraction (handleFileChange).
      // Only upload here if extraction didn't happen (unsupported type, or extraction failed before storing the URL).
      let newFileUrl: string | null = uploadedFileUrl;
      if (file && !newFileUrl) {
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
            Upload the old form to auto-extract its details, or fill in manually. Then specify what changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 — Upload old form (extraction source) */}
          <section className="space-y-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 1 · Upload the old form (auto-fills fields below)</div>

            <label className={cn(
              "relative block border-2 border-dashed rounded-lg px-4 py-3 text-center cursor-pointer transition-colors text-sm",
              file ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20" : "border-muted-foreground/20 hover:border-amber-400 hover:bg-muted/30"
            )}>
              <input type="file" accept=".pdf,.doc,.docx" className="hidden"
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)} />
              {extracting ? (
                <span className="flex items-center justify-center gap-2 text-amber-700 dark:text-amber-400">
                  <Loader2 className="size-4 animate-spin" />
                  <span className="font-semibold">Extracting form details…</span>
                </span>
              ) : file ? (
                <span className="flex items-center justify-center gap-2">
                  <Sparkles className="size-4 text-amber-500" />
                  <span className="font-semibold">{file.name}</span>
                  {fields.some((f) => f.oldValue) && (
                    <span className="text-[10px] text-emerald-600 font-semibold">· fields auto-filled</span>
                  )}
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Upload className="size-4 opacity-60" />
                  <span>Drop the old form PDF here to auto-fill · or skip and enter manually</span>
                </span>
              )}
            </label>

            {/* Form identity fields (auto-filled from PDF or entered manually) */}
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
          </section>

          {/* Step 2 — Field changes */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 2 · What changed?</div>
              <Button size="sm" variant="ghost" onClick={addField} className="h-7 text-xs gap-1">
                <Plus className="size-3" /> Add field
              </Button>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[100px_1fr_1fr_auto] gap-2 px-0.5">
              <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Field</div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-rose-600">Old value</div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">New value</div>
              <div className="w-7" />
            </div>

            <div className="space-y-2">
              {fields.map((f, i) => {
                const cacheKey = LABEL_TO_CACHE[f.label];
                const suggestions = cacheKey
                  ? cachedSuggestions.map((c) => c[cacheKey]).filter(Boolean)
                  : [];
                const showSuggestions = focusedOldIdx === i && suggestions.length > 0;

                return (
                  <div key={i} className="space-y-0.5">
                    <div className="grid grid-cols-[100px_1fr_1fr_auto] gap-2 items-start">
                      <input
                        type="text" value={f.label}
                        onChange={(e) => updateField(i, { label: e.target.value })}
                        placeholder="Field"
                        className="text-xs font-semibold px-2 py-1.5 rounded border bg-card focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <div className="relative">
                        <textarea
                          value={f.oldValue}
                          onChange={(e) => updateField(i, { oldValue: e.target.value })}
                          onFocus={() => setFocusedOldIdx(i)}
                          onBlur={() => setTimeout(() => setFocusedOldIdx(null), 150)}
                          placeholder="Old value (verbatim)"
                          rows={2}
                          className="w-full text-xs font-mono px-2 py-1.5 rounded border bg-rose-50 dark:bg-rose-950/20 border-rose-100 focus:outline-none focus:ring-1 focus:ring-rose-300 resize-none"
                        />
                        {showSuggestions && (
                          <div className="absolute top-full left-0 right-0 z-10 mt-0.5 rounded-md border bg-popover shadow-md p-1.5 space-y-0.5">
                            <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground px-1 pb-0.5">Recent values</div>
                            {(suggestions as string[]).slice(0, 5).map((s, si) => (
                              <button
                                key={si}
                                type="button"
                                onMouseDown={() => updateField(i, { oldValue: s })}
                                className="w-full text-left text-[11px] font-mono px-2 py-1 rounded hover:bg-accent truncate"
                                title={s}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
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
                  </div>
                );
              })}
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
            disabled={!canSubmit || busy || extracting}
            className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
          >
            {busy ? <><Loader2 className="size-3.5 animate-spin" /> Analysing…</> : <><FileEdit className="size-3.5" /> Run Form Update Analysis</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
