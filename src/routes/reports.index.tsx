import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowRight,
  Trash2,
  Upload,
  CheckCircle2,
  Loader2,
  Sparkles,
  Plus,
  X,
  FileSearch,
  FileEdit,
  HardDrive,
  FileText,
  RefreshCw,
} from "lucide-react";
import { FormUpdateDialog } from "@/components/form-update-dialog";
import { formatDate, statusMeta } from "@/lib/format";
import {
  deleteReport,
  createRegulatoryReport,
  startRegulatoryRerun,
  analyzeRegulatorySop,
  finalizeRegulatoryReport,
  listWorkspaceDriveFiles,
  importDriveFileForAnalysis,
  getGoogleConnectionStatus,
} from "@/lib/compliance.functions";
import { autoDetectDocMeta, DOC_TYPE_LABEL, type DetectedMeta } from "@/lib/auto-detect";
import { useWorkspace, WORKSPACES } from "@/lib/workspace";
import { PIPELINE_STEPS } from "@/lib/mock-pipeline";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/reports/")({
  component: ReportsList,
  head: () => ({ meta: [{ title: "Analyses · Compliance Sentinel" }] }),
});

function ReportsList() {
  const qc = useQueryClient();
  const remove = useServerFn(deleteReport);
  const createReg = useServerFn(createRegulatoryReport);
  const startReg = useServerFn(startRegulatoryRerun);
  const analyzeReg = useServerFn(analyzeRegulatorySop);
  const finalizeReg = useServerFn(finalizeRegulatoryReport);
  const listDrive = useServerFn(listWorkspaceDriveFiles);
  const importDrive = useServerFn(importDriveFileForAnalysis);
  const getGoogleStatus = useServerFn(getGoogleConnectionStatus);
  const nav = useNavigate();

  const [showUpload, setShowUpload] = useState(false);
  const [showFormUpdate, setShowFormUpdate] = useState(false);
  const [source, setSource] = useState<"local" | "drive">("local");
  const [file, setFile] = useState<File | null>(null);
  const [driveFile, setDriveFile] = useState<{ id: string; name: string; mimeType: string } | null>(null);
  const [detected, setDetected] = useState<DetectedMeta | null>(null);
  const [analysisName, setAnalysisName] = useState("");
  const [overrideDocType, setOverrideDocType] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [running, setRunning] = useState(false);
  const [stepIdx, setStepIdx] = useState(-1);
  const [workspace] = useWorkspace();

  // Google connection status — drives whether the "Pick from Drive" tab is usable
  const googleConn = useQuery({
    queryKey: ["google_connection", workspace],
    queryFn: async () => await getGoogleStatus({ data: { workspace } }),
  });

  // Drive file listing — lazy, only fetched when user opens the Drive tab
  const driveFiles = useQuery({
    queryKey: ["drive_files_for_analysis", workspace],
    enabled: showUpload && source === "drive" && !!googleConn.data?.connected && !!googleConn.data?.driveFolderName,
    queryFn: async () => await listDrive({ data: { workspace } }),
  });

  function pickDriveFile(f: { id: string; name: string; mimeType: string }) {
    setDriveFile(f);
    setFile(null); // mutually exclusive
    const meta = autoDetectDocMeta(f.name);
    setDetected(meta);
    setAnalysisName(f.name.replace(/\.[^.]+$/, ""));
    setOverrideDocType(meta?.doc_type ?? "");
    setNotes("");
  }

  const reports = useQuery({
    queryKey: ["reports", "all", workspace],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("analysis_reports")
        .select("id, title, policy_name, status, created_at")
        .eq("workspace_id", workspace)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function startAnalysis() {
    if (!file && !driveFile) return;
    setRunning(true);
    setStepIdx(0);

    let fileUrl: string | null = null;
    let filename: string = "";

    try {
      if (driveFile) {
        // Drive path — server fetches via stored token, uploads to Supabase storage,
        // returns a usable public fileUrl. Same downstream pipeline as a local upload.
        const r = await importDrive({ data: { workspace, driveFileId: driveFile.id } });
        fileUrl = r.fileUrl;
        filename = r.filename;
      } else if (file) {
        // Local path — upload from browser straight to Supabase storage.
        const path = `${Date.now()}-${file.name}`;
        const up = await supabase.storage.from("policies").upload(path, file, {
          upsert: false,
          contentType: file.type,
        });
        if (!up.error) {
          const { data } = supabase.storage.from("policies").getPublicUrl(path);
          fileUrl = data.publicUrl;
        }
        filename = file.name;
      }
    } catch (e: any) {
      console.error("Upload/import failed:", e);
      toast.error("Could not prepare file for analysis", { description: e?.message });
      setRunning(false);
      setStepIdx(-1);
      return;
    }

    // Progress simulation for UI
    for (let i = 0; i < PIPELINE_STEPS.length - 1; i++) {
      setStepIdx(i);
      await new Promise((r) => setTimeout(r, PIPELINE_STEPS[i].duration));
    }

    try {
      setStepIdx(7);
      // Merge user overrides into detected meta
      const detectedWithOverrides = detected ? {
        ...detected,
        doc_type: (overrideDocType || detected.doc_type) as DetectedMeta["doc_type"],
      } : undefined;
      // 1. Create the report row (lightweight — no analysis yet).
      const { reportId } = await createReg({
        data: {
          filename,
          fileUrl,
          workspace,
          detected: detectedWithOverrides,
          customTitle: analysisName.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      });

      // 2. Full-document analysis — one call per internal SOP, run in PARALLEL
      //    (each is an isolated server call), then finalise. A SOP whose call
      //    fails is retried up to 3× and, if still failing, flagged.
      setStepIdx(8);
      const { sops } = await startReg({ data: { reportId } });
      let regDone = 0;
      toast.message(`Analysing ${sops.length} document(s)…`, { id: "reg-analyze", duration: 180000 });
      const coverage = await Promise.all(sops.map(async (sop) => {
        let status = "failed";
        let impactCount = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await analyzeReg({ data: { reportId, sopId: sop.id } });
            status = res?.status ?? "analyzed";
            impactCount = res?.impactCount ?? 0;
            if (status !== "failed") break;
          } catch (err: any) {
            console.warn(`Analysis attempt ${attempt} failed for ${sop.title}:`, err?.message);
            status = "failed";
          }
        }
        regDone++;
        toast.message(`Analysed ${regDone}/${sops.length} document(s)…`, { id: "reg-analyze", duration: 180000 });
        return { title: sop.title, status, impactCount };
      }));
      toast.dismiss("reg-analyze");
      await finalizeReg({ data: { reportId, coverage } });

      const res = { reportId };
      toast.success("Analysis complete");
      qc.invalidateQueries({ queryKey: ["reports"] });

      // Close upload and reset
      setShowUpload(false);
      setFile(null);
      setDriveFile(null);
      setSource("local");
      setDetected(null);
      setAnalysisName("");
      setOverrideDocType("");
      setNotes("");
      setRunning(false);
      setStepIdx(-1);

      nav({ to: "/reports/$reportId", params: { reportId: res.reportId } });
    } catch (e: any) {
      toast.error("Analysis failed", { description: e?.message });
      setRunning(false);
      setStepIdx(-1);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this analysis and all related data?")) return;
    try {
      await remove({ data: { id } });
      toast.success("Analysis deleted");
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["reports", "all"] });
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to delete");
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-[1400px] mx-auto space-y-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {workspace === "forms" ? "Form Updates" : "Regulatory Analyses"}
            </h1>
            <p className="text-muted-foreground mt-1 text-lg">
              {workspace === "forms"
                ? "Propagate form metadata changes across all downstream documents in the Knowledge Base."
                : "Manage intelligence reports and map regulatory impact across your SOPs."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {workspace === "forms" ? (
              <Button
                size="lg"
                onClick={() => setShowFormUpdate(true)}
                className="gap-2 h-12 px-6 rounded-xl font-bold bg-amber-600 hover:bg-amber-700 text-white shadow-lg shadow-amber-500/20 active:scale-95"
              >
                <FileEdit className="size-4" /> New Form Update
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => setShowUpload(!showUpload)}
                variant={showUpload ? "outline" : "default"}
                className="gap-2 h-12 px-6 rounded-xl font-bold shadow-lg shadow-primary/10 transition-all active:scale-95"
              >
                {showUpload ? <X className="size-4" /> : <Plus className="size-4" />}
                {showUpload ? "Cancel" : "New Regulatory Analysis"}
              </Button>
            )}
          </div>
        </div>

        {showUpload && (
          <Card className="p-6 border-primary/20 bg-primary/[0.01] glass-card overflow-hidden animate-in-slide-down">
            {!running ? (
              <div className="space-y-6">
                <div className="flex items-center gap-2 mb-2">
                  <div className="size-8 rounded-lg bg-primary/10 grid place-items-center">
                    <Upload className="size-4 text-primary" />
                  </div>
                  <h2 className="text-xl font-bold italic tracking-tight">Intelligent Data Ingestion</h2>
                </div>
                
                {/* Source tabs — local upload vs pick from Drive */}
                <div className="flex items-center gap-1 p-1 rounded-xl border bg-muted/30 w-fit">
                  <button
                    type="button"
                    onClick={() => { setSource("local"); setDriveFile(null); }}
                    className={cn(
                      "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-2",
                      source === "local" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Upload className="size-3.5" /> Upload local file
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSource("drive"); setFile(null); }}
                    className={cn(
                      "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-2",
                      source === "drive" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <HardDrive className="size-3.5" /> Pick from Drive
                  </button>
                </div>

                {source === "local" && (
                  <label
                    className={cn(
                      "block border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-300",
                      file ? "border-primary bg-primary/5 shadow-inner" : "border-muted-foreground/20 hover:border-primary/50 hover:bg-muted/30"
                    )}
                  >
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setFile(f);
                        setDriveFile(null);
                        const meta = f ? autoDetectDocMeta(f.name) : null;
                        setDetected(meta);
                        setAnalysisName(f ? f.name.replace(/\.[^.]+$/, "") : "");
                        setOverrideDocType(meta?.doc_type ?? "");
                        setNotes("");
                      }}
                    />
                    <div className={cn("size-16 mx-auto rounded-full grid place-items-center mb-4 transition-transform duration-300", file ? "bg-primary text-white scale-110" : "bg-muted text-muted-foreground")}>
                      <Upload className="size-8" />
                    </div>
                    <div className="font-bold text-lg">
                      {file ? file.name : "Drop policy document or click to browse"}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2 font-medium">
                      Supports PDF, DOCX up to 25MB. AI-ready parsing active.
                    </p>
                  </label>
                )}

                {source === "drive" && (
                  <div className="border rounded-2xl bg-muted/20 overflow-hidden">
                    {!googleConn.data?.connected ? (
                      <div className="p-8 text-center">
                        <HardDrive className="size-10 mx-auto mb-3 text-muted-foreground/60" />
                        <div className="font-semibold text-sm">Google Drive isn't connected for this workspace</div>
                        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                          Go to <Link to="/settings" className="text-primary underline">Settings</Link> → Google Drive → Connect, then set a KB folder, then come back here.
                        </p>
                      </div>
                    ) : !googleConn.data?.driveFolderName ? (
                      <div className="p-8 text-center">
                        <HardDrive className="size-10 mx-auto mb-3 text-muted-foreground/60" />
                        <div className="font-semibold text-sm">No KB folder configured</div>
                        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                          Connected as <span className="font-medium">{googleConn.data.email}</span>. Open <Link to="/settings" className="text-primary underline">Settings</Link> to set a Drive folder, then come back.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="px-4 py-3 border-b bg-card flex items-center justify-between">
                          <div className="text-xs">
                            <span className="text-muted-foreground">Folder:</span>{" "}
                            <span className="font-semibold">{googleConn.data.driveFolderName}</span>
                            {driveFiles.data && (
                              <span className="text-muted-foreground ml-2">· {driveFiles.data.files.length} file{driveFiles.data.files.length === 1 ? "" : "s"}</span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => qc.invalidateQueries({ queryKey: ["drive_files_for_analysis", workspace] })}
                            disabled={driveFiles.isFetching}
                            className="gap-1.5 h-7 text-xs"
                          >
                            {driveFiles.isFetching ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                            Refresh
                          </Button>
                        </div>

                        {driveFiles.isLoading ? (
                          <div className="p-8 text-center text-muted-foreground">
                            <Loader2 className="size-5 mx-auto animate-spin mb-2" />
                            <div className="text-xs">Listing folder contents…</div>
                          </div>
                        ) : driveFiles.isError ? (
                          <div className="p-6 text-center text-sm text-rose-700">
                            Could not list folder: {(driveFiles.error as any)?.message ?? "unknown error"}
                          </div>
                        ) : driveFiles.data?.files?.length === 0 ? (
                          <div className="p-8 text-center text-sm text-muted-foreground">
                            Folder is empty.
                          </div>
                        ) : (
                          <div className="max-h-72 overflow-y-auto divide-y">
                            {driveFiles.data?.files.map((f) => {
                              const isPicked = driveFile?.id === f.id;
                              return (
                                <button
                                  key={f.id}
                                  type="button"
                                  disabled={!f.indexable}
                                  onClick={() => f.indexable && pickDriveFile(f)}
                                  className={cn(
                                    "w-full text-left px-4 py-2.5 transition-colors flex items-center gap-3",
                                    !f.indexable && "opacity-50 cursor-not-allowed",
                                    isPicked ? "bg-primary/10" : "hover:bg-muted/40"
                                  )}
                                >
                                  <FileText className={cn("size-4 shrink-0", isPicked ? "text-primary" : "text-muted-foreground")} />
                                  <div className="min-w-0 flex-1">
                                    <div className={cn("text-sm truncate", isPicked && "font-semibold")}>{f.name}</div>
                                    <div className="text-[10px] text-muted-foreground truncate">
                                      {f.mimeType.replace("application/vnd.google-apps.", "Google ").replace("application/", "")}
                                      {f.modifiedTime && <> · modified {new Date(f.modifiedTime).toLocaleDateString()}</>}
                                      {!f.indexable && <> · unsupported</>}
                                    </div>
                                  </div>
                                  {isPicked && <CheckCircle2 className="size-4 text-primary shrink-0" />}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {detected && (
                  <div className="rounded-2xl border border-primary/10 bg-white/50 dark:bg-slate-900/50 p-6 shadow-sm space-y-5">
                    <div className="flex items-center gap-1.5 text-[10px] font-black text-primary uppercase tracking-[0.2em]">
                      <Sparkles className="size-3.5" /> Submission Details
                      <span className="ml-2 text-muted-foreground/70 font-medium normal-case tracking-normal text-[10px]">— review &amp; adjust before running</span>
                    </div>

                    {/* Editable analysis name */}
                    <div>
                      <label className="block text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">
                        Analysis Name <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={analysisName}
                        onChange={(e) => setAnalysisName(e.target.value)}
                        placeholder="e.g. RMiT Nov 2025 — Q2 review"
                        className="w-full text-sm font-medium px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Doc type override */}
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">
                          Document Type <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">(detected: {DOC_TYPE_LABEL[detected.doc_type]})</span>
                        </label>
                        <select
                          value={overrideDocType}
                          onChange={(e) => setOverrideDocType(e.target.value)}
                          className="w-full text-sm font-medium px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <optgroup label="External regulations (compared against old version)">
                            <option value="rmit_reg">RMiT / Tech Regulation (BNM)</option>
                            <option value="fatf">FATF / AML</option>
                            <option value="circular">Regulator Circular</option>
                          </optgroup>
                          <optgroup label="Internal documents (amended to comply)">
                            <option value="sop">Internal SOP</option>
                            <option value="it_policy">IT Policy</option>
                            <option value="policy">Policy</option>
                          </optgroup>
                        </select>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {(["rmit_reg", "fatf", "circular"].includes(overrideDocType))
                            ? "→ This is a regulation. The system will look for an older version in KB and map changes to your internal SOPs."
                            : "→ This is an internal document. It will be indexed in KB as an amendment target."}
                        </p>
                      </div>

                      {/* Version (read-only auto-detected) */}
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">Detected Version</label>
                        <div className="px-3 py-2 rounded-lg border bg-muted/40 text-sm font-mono">{detected.version || "v1.0.0"}</div>
                      </div>
                    </div>

                    {/* Notes / context */}
                    <div>
                      <label className="block text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">
                        Notes for the analyst <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">(optional)</span>
                      </label>
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="e.g. Focus on operational resilience clauses; benchmark against legacy 2023 baseline."
                        rows={2}
                        className="w-full text-xs px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>

                    {/* Tags display */}
                    {detected.tags.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">Semantic Tags (auto)</div>
                        <div className="flex flex-wrap gap-1.5">
                          {detected.tags.map((t) => (
                            <Badge key={t} variant="outline" className="text-[9px] bg-primary/5 border-primary/10 font-bold uppercase py-0">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end pt-4 border-t border-primary/5">
                  <Button
                    size="lg"
                    disabled={!file && !driveFile}
                    onClick={startAnalysis}
                    className="gap-2 h-12 px-10 rounded-xl font-black uppercase tracking-widest text-[10px] shadow-xl shadow-primary/20 active:scale-95"
                  >
                    Run Intelligent Analysis
                  </Button>
                </div>
              </div>
            ) : (
              <div className="py-8">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-2xl font-black italic tracking-tighter text-primary">Intelligence Pipeline</h2>
                    <p className="text-sm text-muted-foreground font-medium uppercase tracking-widest mt-1">Executing multi-stage analysis...</p>
                  </div>
                  <Loader2 className="size-8 text-primary animate-spin" />
                </div>
                
              <div className="flex flex-col items-center justify-center py-12 space-y-12">
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl animate-pulse" />
                  <div className="relative size-32 rounded-full border-4 border-primary/10 grid place-items-center bg-white dark:bg-slate-950 shadow-2xl">
                    <Loader2 className="size-16 text-primary animate-spin" strokeWidth={1.5} />
                  </div>
                </div>

                <div className="text-center max-w-md mx-auto space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-2xl font-black italic tracking-tighter text-primary animate-in fade-in slide-in-from-bottom-4 duration-500">
                      {PIPELINE_STEPS[stepIdx]?.label || "Intelligence Pipeline"}
                    </h3>
                    <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.3em]">
                      Executing Autonomous Analysis Stage {stepIdx + 1} of {PIPELINE_STEPS.length}
                    </p>
                  </div>

                  <div className="w-full bg-muted/30 h-1.5 rounded-full overflow-hidden border border-primary/5">
                    <div 
                      className="bg-primary h-full transition-all duration-700 ease-out shadow-[0_0_15px_rgba(var(--primary),0.5)]" 
                      style={{ width: `${((stepIdx + 1) / PIPELINE_STEPS.length) * 100}%` }}
                    />
                  </div>
                  
                  <div className="flex items-center justify-center gap-3 pt-2">
                    {PIPELINE_STEPS.map((_, i) => (
                      <div 
                        key={i}
                        className={cn(
                          "size-2 rounded-full transition-all duration-500",
                          i === stepIdx ? "bg-primary w-6" : i < stepIdx ? "bg-primary/40" : "bg-muted-foreground/20"
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>
              </div>
            )}
          </Card>
        )}

        <Card className="p-0 overflow-hidden border-border/50 shadow-sm glass-card">
          <div className="px-6 py-4 border-b border-border/50 bg-muted/30 flex items-center justify-between">
            <h2 className="font-bold text-sm uppercase tracking-[0.2em] text-muted-foreground">Recent Analyses</h2>
            <Badge variant="secondary" className="font-black text-[10px]">{reports.data?.length ?? 0} TOTAL</Badge>
          </div>
          
          {reports.isLoading && (
            <div className="p-12 text-center text-muted-foreground font-medium italic animate-pulse">
              Syncing regulatory data...
            </div>
          )}
          
          {!reports.isLoading && (reports.data?.length ?? 0) === 0 && !showUpload && (
            <div className="p-20 text-center">
              <div className="size-16 bg-muted rounded-full grid place-items-center mx-auto mb-4">
                <FileSearch className="size-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-bold">No analyses yet</h3>
              <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                Upload your first regulatory document to start extracting intelligence and mapping SOP impacts.
              </p>
              <Button onClick={() => setShowUpload(true)} className="mt-6 gap-2 h-11 px-8 rounded-lg font-bold">
                <Plus className="size-4" /> Start First Analysis
              </Button>
            </div>
          )}

          <div className="divide-y divide-border/50">
            {reports.data?.map((r: any) => {
              const s = statusMeta(r.status);
              return (
                <Link
                  key={r.id}
                  to="/reports/$reportId"
                  params={{ reportId: r.id }}
                  className="flex items-center justify-between px-6 py-5 hover:bg-primary/[0.02] transition-colors group relative overflow-hidden"
                >
                  <div className="min-w-0 flex items-center gap-4">
                    <div className={cn("size-10 rounded-xl grid place-items-center shrink-0 transition-transform group-hover:scale-110", s.bg)}>
                      <FileSearch className={cn("size-5", s.text)} />
                    </div>
                    <div>
                      <div className="font-bold text-base truncate group-hover:text-primary transition-colors">{r.title}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 font-medium">
                        <span className="uppercase tracking-widest font-black text-[10px] opacity-70">{r.policy_name}</span>
                        <span>•</span>
                        <span>{formatDate(r.created_at)}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4 shrink-0">
                    <Badge variant="outline" className={cn("font-black text-[10px] uppercase tracking-widest px-2", s.classes)}>
                      {s.label}
                    </Badge>
                    
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        onClick={(e) => handleDelete(e, r.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                      <div className="size-9 rounded-lg bg-muted grid place-items-center group-hover:bg-primary group-hover:text-white transition-all">
                        <ArrowRight className="size-4" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <FormUpdateDialog
        open={showFormUpdate}
        onOpenChange={setShowFormUpdate}
        onCreated={(reportId) => {
          qc.invalidateQueries({ queryKey: ["reports"] });
          nav({ to: "/reports/$reportId", params: { reportId } });
        }}
      />
    </AppShell>
  );
}
