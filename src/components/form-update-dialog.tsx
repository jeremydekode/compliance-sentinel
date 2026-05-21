import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createFormUpdateReport, analyzeDocForForm, finalizeFormUpdateReport, extractFormMetadata, detectFormChanges } from "@/lib/compliance.functions";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, FileEdit, Loader2, Upload, Sparkles, Wand2, Pencil } from "lucide-react";
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
  const analyzeDocFn = useServerFn(analyzeDocForForm);
  const finalizeFn = useServerFn(finalizeFormUpdateReport);
  const extractFn = useServerFn(extractFormMetadata);
  const detectFn = useServerFn(detectFormChanges);
  const [workspace] = useWorkspace();

  const [formId, setFormId] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  // Auto-detect Stage 5 state: open-ended diff of old (in KB) vs new (uploaded)
  type DetectedChange = {
    label: string;
    oldValue: string | null;
    newValue: string | null;
    category: "header" | "structure" | "instruction";
    propagatable: boolean;
    explanation?: string;
    /** UI: ticked = include in propagation. Defaults to `propagatable`. */
    selected: boolean;
  };
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [detecting, setDetecting] = useState(false);
  const [detectionMsg, setDetectionMsg] = useState<string | null>(null);
  const [oldFormTitle, setOldFormTitle] = useState<string | null>(null);
  const [detectedChanges, setDetectedChanges] = useState<DetectedChange[]>([]);

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
    setDetecting(false);
    setDetectionMsg(null);
    setOldFormTitle(null);
    setDetectedChanges([]);
    setMode("auto");
    setFocusedOldIdx(null);
    setFields([
      { label: "Name", oldValue: "", newValue: "" },
      { label: "Version", oldValue: "", newValue: "" },
      { label: "Date", oldValue: "", newValue: "" },
    ]);
  }

  function updateDetectedChange(idx: number, patch: Partial<DetectedChange>) {
    setDetectedChanges((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
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
    let uploadedUrl: string | null = null;
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
      uploadedUrl = pub.publicUrl;
      setUploadedFileUrl(pub.publicUrl);

      const meta = await extractFn({ data: { fileUrl: pub.publicUrl, fileName: picked.name } });

      // Derive base formId by stripping version suffix: "FGROP 037/2016_v11" → "FGROP 037/2016"
      const baseId = meta.formNumber ? meta.formNumber.replace(/_v\d+$/i, "").trim() : "";
      if (baseId && !formId) setFormId(baseId);
      if (meta.formName && !friendlyName) setFriendlyName(meta.formName);

      // Extracted data = the NEW form values
      setFields((fs) =>
        fs.map((f) => {
          if (f.newValue) return f; // don't overwrite user input
          if (f.label === "Name" && meta.formName) return { ...f, newValue: meta.formName };
          if (f.label === "Version" && meta.formNumber) return { ...f, newValue: meta.formNumber };
          if (f.label === "Date" && meta.updatedDate) return { ...f, newValue: meta.updatedDate };
          return f;
        })
      );

      // Save to cache
      if (meta.formNumber) {
        saveToCache({ formName: meta.formName ?? "", formNumber: meta.formNumber, updatedDate: meta.updatedDate ?? "" });
        setCachedSuggestions(loadCache());
      }

      // Auto-fetch old values from the matching KB original
      if (baseId) {
        try {
          const flat = baseId.replace(/[^A-Za-z0-9]/g, "");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: candidates } = await (supabase as any)
            .from("sop_documents")
            .select("id, title, file_url")
            .eq("workspace_id", "forms")
            .order("created_at", { ascending: false });
          const oldDoc = (candidates ?? []).find((c: any) => {
            const flatTitle = (c.title ?? "").replace(/[^A-Za-z0-9]/g, "");
            return flatTitle.toUpperCase().includes(flat.toUpperCase()) &&
              c.file_url !== pub.publicUrl; // don't match the just-uploaded file
          }) ?? null;

          if (oldDoc?.file_url) {
            const oldMeta = await extractFn({ data: { fileUrl: oldDoc.file_url, fileName: oldDoc.title ?? "" } });
            setFields((fs) =>
              fs.map((f) => {
                if (f.oldValue) return f; // don't overwrite user input
                if (f.label === "Name" && oldMeta.formName) return { ...f, oldValue: oldMeta.formName };
                if (f.label === "Version" && oldMeta.formNumber) return { ...f, oldValue: oldMeta.formNumber };
                if (f.label === "Date" && oldMeta.updatedDate) return { ...f, oldValue: oldMeta.updatedDate };
                return f;
              })
            );
          }
        } catch (e) {
          console.warn("Old form lookup failed:", e); // non-fatal — user can fill in manually
        }
      }
    } catch (e) {
      console.warn("Form metadata extraction failed:", e);
      // Fail silently — user can still fill manually
    } finally {
      setExtracting(false);
    }

    // Stage 5: open-ended diff against the matching old form in KB
    if (mode === "auto" && uploadedUrl) {
      setDetecting(true);
      setDetectionMsg(null);
      try {
        const r = await detectFn({ data: { newFileUrl: uploadedUrl } });
        if (r.oldForm) {
          setOldFormTitle(r.oldForm.title);
          setDetectionMsg(null);
          const changes: DetectedChange[] = (r.detectedChanges ?? []).map((c: any) => ({
            label: c.label ?? "(unlabelled)",
            oldValue: c.oldValue ?? null,
            newValue: c.newValue ?? null,
            category: (c.category === "structure" || c.category === "instruction") ? c.category : "header",
            propagatable: c.propagatable !== false,
            explanation: c.explanation,
            selected: c.propagatable !== false,
          }));
          setDetectedChanges(changes);
        } else {
          // No old form in KB — fall back to manual mode so user can still file a change
          setOldFormTitle(null);
          setDetectedChanges([]);
          setDetectionMsg(r.message ?? "No matching form in KB. Switching to manual entry.");
          setMode("manual");
        }
      } catch (e: any) {
        console.warn("Form diff detection failed:", e);
        setDetectionMsg(`Auto-detect failed: ${e?.message ?? "unknown"}. Switching to manual entry.`);
        setMode("manual");
      } finally {
        setDetecting(false);
      }
    }
  }

  // Auto mode: needs at least one ticked detected change (propagatable + selected).
  // Manual mode: needs the existing fields populated.
  const autoSelected = detectedChanges.filter((c) => c.selected && c.oldValue && c.newValue);
  const canSubmit = mode === "auto"
    ? formId.trim().length > 1 && autoSelected.length > 0
    : formId.trim().length > 1 &&
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
      // Build the field-changes list for createFormUpdateReport — either from the
      // ticked auto-detected changes or from the manually entered fields.
      const validFields = mode === "auto"
        ? autoSelected.map((c) => ({
            label: c.label,
            oldValue: c.oldValue ?? "",
            newValue: c.newValue ?? "",
          }))
        : fields.filter((f) => f.label.trim() && f.oldValue.trim() && f.newValue.trim());

      // Phase 1 — create the report shell + get the list of docs to analyze
      const { reportId, docsToAnalyze } = await createFn({
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

      // Phase 2 — analyze one document per call (each gets its own 60 s budget)
      for (let i = 0; i < docsToAnalyze.length; i++) {
        const d = docsToAnalyze[i];
        toast.message(`Analysing ${i + 1}/${docsToAnalyze.length}: ${d.title}…`, { id: "uc1-progress", duration: 60000 });
        try {
          await analyzeDocFn({ data: { reportId, docId: d.docId } });
        } catch (err: any) {
          console.warn(`Analysis failed for ${d.title}:`, err?.message);
        }
      }

      // Phase 3 — write the final summary
      const fin = await finalizeFn({ data: { reportId } });
      toast.dismiss("uc1-progress");
      toast.success(`Form update analysis complete`, {
        description: `${fin.impactCount} edit${fin.impactCount !== 1 ? "s" : ""} across ${fin.affectedDocs} document${fin.affectedDocs !== 1 ? "s" : ""}`,
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
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
            Upload the new/updated form — the system will extract its details and auto-fill the old values from the matching original in the KB.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 — Upload old form (extraction source) */}
          <section className="space-y-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step 1 · Upload the new/updated form</div>

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
                  {fields.some((f) => f.newValue) && (
                    <span className="text-[10px] text-emerald-600 font-semibold">· fields auto-filled</span>
                  )}
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Upload className="size-4 opacity-60" />
                  <span>Drop the new/updated form PDF here · old values fetched from KB automatically</span>
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

          {/* Step 2 — Field changes (auto-detect or manual) */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Step 2 · What changed? {mode === "auto" ? <span className="text-primary normal-case font-medium tracking-normal">(auto-detected)</span> : null}
              </div>
              <div className="flex items-center gap-1">
                {mode === "manual" && (detectedChanges.length > 0 || oldFormTitle) && (
                  <Button size="sm" variant="ghost" onClick={() => setMode("auto")} className="h-7 text-xs gap-1">
                    <Wand2 className="size-3" /> Use auto-detect
                  </Button>
                )}
                {mode === "auto" && (
                  <Button size="sm" variant="ghost" onClick={() => setMode("manual")} className="h-7 text-xs gap-1">
                    <Pencil className="size-3" /> Enter manually
                  </Button>
                )}
                {mode === "manual" && (
                  <Button size="sm" variant="ghost" onClick={addField} className="h-7 text-xs gap-1">
                    <Plus className="size-3" /> Add field
                  </Button>
                )}
              </div>
            </div>

            {/* ── AUTO MODE: detected-diff preview ─────────────────────────────── */}
            {mode === "auto" && (
              <>
                {detecting && (
                  <div className="flex items-center gap-2 px-3 py-3 rounded-md border bg-muted/30 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Comparing the uploaded form against the matching version in the Internal Forms KB…
                  </div>
                )}
                {!detecting && detectionMsg && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    {detectionMsg}
                  </div>
                )}
                {!detecting && oldFormTitle && (
                  <div className="text-[11px] text-muted-foreground">
                    Comparing against <span className="font-semibold text-foreground">{oldFormTitle}</span> from the Internal Forms KB ·
                    <span className="ml-1">{detectedChanges.length} change{detectedChanges.length === 1 ? "" : "s"} detected</span>
                  </div>
                )}
                {!detecting && detectedChanges.length === 0 && !detectionMsg && !file && (
                  <div className="rounded-md border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                    Drop the new version of the form above. The system will compare it against the matching form in the KB and show every detected change here.
                  </div>
                )}

                {!detecting && detectedChanges.length > 0 && (
                  <div className="space-y-2">
                    {detectedChanges.map((c, i) => {
                      const catColors: Record<string, string> = {
                        header: "bg-blue-100 text-blue-800 border-blue-200",
                        structure: "bg-violet-100 text-violet-800 border-violet-200",
                        instruction: "bg-slate-100 text-slate-700 border-slate-200",
                      };
                      return (
                        <div key={i} className={cn("rounded-lg border p-3 space-y-2", c.selected ? "bg-card" : "bg-muted/30 opacity-60")}>
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={c.selected}
                              onChange={(e) => updateDetectedChange(i, { selected: e.target.checked })}
                              className="mt-1 size-3.5 accent-amber-600"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border", catColors[c.category] ?? catColors.instruction)}>
                                  {c.category}
                                </span>
                                <span className="text-xs font-semibold">{c.label}</span>
                                {!c.propagatable && (
                                  <span className="text-[9px] text-muted-foreground italic">won't cascade to SOPs</span>
                                )}
                              </div>
                              {c.explanation && (
                                <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{c.explanation}</p>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 ml-6">
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-wide text-rose-600 mb-1">Old</div>
                              <textarea
                                value={c.oldValue ?? ""}
                                onChange={(e) => updateDetectedChange(i, { oldValue: e.target.value })}
                                rows={2}
                                placeholder={c.oldValue === null ? "(newly added — no old value)" : ""}
                                className="w-full text-xs font-mono px-2 py-1.5 rounded border bg-rose-50 dark:bg-rose-950/20 border-rose-100 focus:outline-none focus:ring-1 focus:ring-rose-300 resize-none"
                              />
                            </div>
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-wide text-emerald-600 mb-1">New</div>
                              <textarea
                                value={c.newValue ?? ""}
                                onChange={(e) => updateDetectedChange(i, { newValue: e.target.value })}
                                rows={2}
                                placeholder={c.newValue === null ? "(removed — no new value)" : ""}
                                className="w-full text-xs font-mono px-2 py-1.5 rounded border bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 focus:outline-none focus:ring-1 focus:ring-emerald-300 resize-none"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── MANUAL MODE: original field-by-field entry ──────────────────── */}
            {mode === "manual" && (
              <>
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
              </>
            )}
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
