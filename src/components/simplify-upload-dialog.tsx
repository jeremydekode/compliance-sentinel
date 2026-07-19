import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import {
  createSimplificationReport,
  importDriveFileForAnalysis,
  listWorkspaceDriveFiles,
  getGoogleConnectionStatus,
} from "@/lib/compliance.functions";
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
import {
  Upload,
  Loader2,
  Sparkles,
  Wand2,
  HardDrive,
  FileText,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type DriveFile = { id: string; name: string; mimeType: string; indexable?: boolean };

/**
 * UC4 — create a Document Simplification report from a local upload OR a Google
 * Drive file. A Drive source records its file ID, so the apply step can copy
 * and amend the original document straight in Drive.
 */
export function SimplifyUploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (reportId: string) => void;
}) {
  const qc = useQueryClient();
  const createFn = useServerFn(createSimplificationReport);
  const importDrive = useServerFn(importDriveFileForAnalysis);
  const listDrive = useServerFn(listWorkspaceDriveFiles);
  const getGoogleStatus = useServerFn(getGoogleConnectionStatus);
  const [workspace] = useWorkspace();

  const [source, setSource] = useState<"local" | "drive">("local");
  const [file, setFile] = useState<File | null>(null);
  const [driveFile, setDriveFile] = useState<DriveFile | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"thorough" | "quick">("thorough");

  const googleConn = useQuery({
    queryKey: ["google_connection", workspace],
    enabled: open && source === "drive",
    queryFn: async () => await getGoogleStatus({ data: { workspace } }),
  });
  const driveFiles = useQuery({
    queryKey: ["drive_files_for_simplify", workspace],
    enabled:
      open &&
      source === "drive" &&
      !!googleConn.data?.connected &&
      !!googleConn.data?.driveFolderName,
    queryFn: async () => await listDrive({ data: { workspace } }),
  });

  function reset() {
    setSource("local");
    setFile(null);
    setDriveFile(null);
    setCustomTitle("");
    setInstruction("");
    setBusy(false);
  }

  function pickDrive(f: DriveFile) {
    setDriveFile(f);
    setFile(null);
    if (!customTitle.trim()) setCustomTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  const canSubmit = source === "local" ? !!file : !!driveFile;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      let fileUrl: string | null = null;
      let filename = "";
      let driveFileId: string | undefined;
      let driveMimeType: string | undefined;

      if (source === "drive" && driveFile) {
        // Mirror the Drive file into storage (the run reads text from there);
        // the Drive file ID is recorded so apply can copy the original.
        const r = await importDrive({ data: { workspace, driveFileId: driveFile.id } });
        fileUrl = r.fileUrl;
        filename = r.filename;
        driveFileId = driveFile.id;
        driveMimeType = driveFile.mimeType;
      } else if (file) {
        const path = `simplify/${Date.now()}-${file.name}`;
        const up = await supabase.storage.from("policies").upload(path, file, {
          upsert: false,
          contentType: file.type || "application/octet-stream",
        });
        if (up.error) throw up.error;
        fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
        filename = file.name;
      }

      const { reportId } = await createFn({
        data: {
          filename,
          fileUrl,
          customTitle: customTitle.trim() || undefined,
          instruction: instruction.trim() || undefined,
          driveFileId,
          driveMimeType,
          mode,
        },
      });
      reset();
      onOpenChange(false);
      onCreated(reportId);
    } catch (e: any) {
      toast.error("Could not start simplification", { description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-violet-600" /> New Document Simplification
          </DialogTitle>
          <DialogDescription>
            Upload a document or pick one from Drive. Every proposed edit is anchored back to the
            source — invented clauses are caught and quarantined automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 — source */}
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 1 · Choose the document
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl border bg-muted/30 w-fit">
              <button
                type="button"
                onClick={() => {
                  setSource("local");
                  setDriveFile(null);
                }}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-1.5",
                  source === "local"
                    ? "bg-card shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Upload className="size-3.5" /> Upload file
              </button>
              <button
                type="button"
                onClick={() => {
                  setSource("drive");
                  setFile(null);
                }}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-1.5",
                  source === "drive"
                    ? "bg-card shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <HardDrive className="size-3.5" /> Pick from Drive
              </button>
            </div>

            {source === "local" && (
              <label
                className={cn(
                  "relative block border-2 border-dashed rounded-lg px-4 py-6 text-center cursor-pointer transition-colors text-sm",
                  file
                    ? "border-violet-300 bg-violet-50 dark:bg-violet-950/20"
                    : "border-muted-foreground/20 hover:border-violet-400 hover:bg-muted/30",
                )}
              >
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <span className="flex items-center justify-center gap-2">
                    <Sparkles className="size-4 text-violet-500" />
                    <span className="font-semibold">{file.name}</span>
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2 text-muted-foreground">
                    <Upload className="size-4 opacity-60" />
                    <span>Drop a DOCX (best — tables preserved) or PDF here</span>
                  </span>
                )}
              </label>
            )}

            {source === "drive" && (
              <div className="border rounded-lg bg-muted/20 overflow-hidden">
                {!googleConn.data?.connected ? (
                  <div className="p-6 text-center">
                    <HardDrive className="size-8 mx-auto mb-2 text-muted-foreground/60" />
                    <div className="font-semibold text-sm">Google Drive isn't connected</div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Open{" "}
                      <Link to="/settings" className="text-violet-600 underline">
                        Settings
                      </Link>{" "}
                      → Google Drive → Connect for this workspace, set a folder, then come back.
                    </p>
                  </div>
                ) : !googleConn.data?.driveFolderName ? (
                  <div className="p-6 text-center">
                    <HardDrive className="size-8 mx-auto mb-2 text-muted-foreground/60" />
                    <div className="font-semibold text-sm">No Drive folder configured</div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Connected as {googleConn.data.email}. Set a folder in{" "}
                      <Link to="/settings" className="text-violet-600 underline">
                        Settings
                      </Link>
                      .
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="px-3 py-2 border-b bg-card flex items-center justify-between">
                      <div className="text-xs text-muted-foreground truncate">
                        Folder:{" "}
                        <span className="font-semibold text-foreground">
                          {googleConn.data.driveFolderName}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          qc.invalidateQueries({
                            queryKey: ["drive_files_for_simplify", workspace],
                          })
                        }
                        disabled={driveFiles.isFetching}
                        className="gap-1.5 h-6 text-[11px]"
                      >
                        {driveFiles.isFetching ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        Refresh
                      </Button>
                    </div>
                    {driveFiles.isLoading ? (
                      <div className="p-6 text-center text-xs text-muted-foreground">
                        <Loader2 className="size-4 mx-auto animate-spin mb-1" />
                        Listing folder…
                      </div>
                    ) : driveFiles.isError ? (
                      <div className="p-5 text-center text-xs text-rose-700">
                        Could not list folder: {(driveFiles.error as any)?.message ?? "error"}
                      </div>
                    ) : (driveFiles.data?.files?.length ?? 0) === 0 ? (
                      <div className="p-6 text-center text-xs text-muted-foreground">
                        Folder is empty.
                      </div>
                    ) : (
                      <div className="max-h-56 overflow-y-auto divide-y">
                        {driveFiles.data?.files.map((f) => {
                          const picked = driveFile?.id === f.id;
                          return (
                            <button
                              key={f.id}
                              type="button"
                              disabled={f.indexable === false}
                              onClick={() => pickDrive(f)}
                              className={cn(
                                "w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5",
                                f.indexable === false && "opacity-50 cursor-not-allowed",
                                picked ? "bg-violet-100" : "hover:bg-muted/40",
                              )}
                            >
                              <FileText
                                className={cn(
                                  "size-4 shrink-0",
                                  picked ? "text-violet-700" : "text-muted-foreground",
                                )}
                              />
                              <span
                                className={cn("text-sm truncate flex-1", picked && "font-semibold")}
                              >
                                {f.name}
                              </span>
                              {picked && (
                                <CheckCircle2 className="size-4 text-violet-700 shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          {/* Step 2 — name */}
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Step 2 · Name (optional)
            </div>
            <input
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="e.g. Document Management Manual — plain-English pass"
              className="w-full text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </section>

          {/* Step 3 — optional instruction */}
          <section className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Wand2 className="size-3" /> Step 3 · Specific instruction (optional)
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder="e.g. Focus on Section C; keep all defined terms exactly as written."
              className="w-full text-xs px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
            />
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <div className="text-xs">
            <div className="font-medium">Analysis depth</div>
            <div className="text-muted-foreground text-[11px]">
              {mode === "thorough"
                ? "Evaluate every paragraph & table cell — comprehensive, slower, more API calls."
                : "Fast pass — a curated set of high-confidence edits."}
            </div>
          </div>
          <div className="flex rounded-lg border overflow-hidden text-xs font-medium shrink-0">
            <button
              type="button"
              onClick={() => setMode("thorough")}
              className={`px-3 py-1.5 transition-colors ${mode === "thorough" ? "bg-violet-600 text-white" : "bg-card hover:bg-muted/50"}`}
            >
              Thorough
            </button>
            <button
              type="button"
              onClick={() => setMode("quick")}
              className={`px-3 py-1.5 border-l transition-colors ${mode === "quick" ? "bg-violet-600 text-white" : "bg-card hover:bg-muted/50"}`}
            >
              Quick
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" /> Run Simplification
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
