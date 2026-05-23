import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, Trash2, CheckCircle2, Loader2, Plug, Unplug, Eye, EyeOff, Briefcase, RotateCcw } from "lucide-react";
import {
  clearWorkspace,
  getGoogleAuthUrl,
  getGoogleConnectionStatus,
  disconnectGoogle,
  setDriveFolder,
  listDriveFilesToSync,
  mirrorDriveFile,
  reindexSop,
  getAnalysisGuidance,
  saveAnalysisGuidance,
  getWorkspaceVisibility,
  setWorkspaceVisibility,
} from "@/lib/compliance.functions";
import { Input } from "@/components/ui/input";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { DEFAULT_SIMPLIFY_GUIDANCE } from "@/lib/simplify";
import { DEFAULT_FRAME_EXTRACTION_PROMPT } from "@/lib/layout/prompt";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · AI Document Workflow" }] }),
});

function SettingsPage() {
  const qc = useQueryClient();
  const clear = useServerFn(clearWorkspace);
  const getAuthUrl = useServerFn(getGoogleAuthUrl);
  const getStatus = useServerFn(getGoogleConnectionStatus);
  const disconnect = useServerFn(disconnectGoogle);
  const setFolder = useServerFn(setDriveFolder);
  const listFiles = useServerFn(listDriveFilesToSync);
  const mirrorFile = useServerFn(mirrorDriveFile);
  const reindex = useServerFn(reindexSop);
  const getGuidance = useServerFn(getAnalysisGuidance);
  const saveGuidance = useServerFn(saveAnalysisGuidance);
  const getVis = useServerFn(getWorkspaceVisibility);
  const setVis = useServerFn(setWorkspaceVisibility);
  const [visBusy, setVisBusy] = useState<WorkspaceId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{ done: number; total: number } | null>(null);
  const [syncPhase, setSyncPhase] = useState<"mirror" | "index" | null>(null);
  const [workspace] = useWorkspace();
  const wsName = WORKSPACES[workspace].name;
  const [folderInput, setFolderInput] = useState("");
  const [syncResult, setSyncResult] = useState<any | null>(null);
  const [forceResync, setForceResync] = useState(false);

  const googleConn = useQuery({
    queryKey: ["google_connection", workspace],
    queryFn: async () => await getStatus({ data: { workspace } }),
  });

  // Master visibility — which workspaces appear in the AppShell switcher.
  // Missing rows default to visible, so an empty table behaves like "all on".
  const visibilityQuery = useQuery({
    queryKey: ["workspace_visibility"],
    queryFn: () => getVis(),
    staleTime: 60_000,
  });
  const visibility = visibilityQuery.data?.visibility ?? {};

  async function toggleVisibility(ws: WorkspaceId, next: boolean) {
    setVisBusy(ws);
    try {
      await setVis({ data: { workspace: ws, visible: next } });
      await qc.invalidateQueries({ queryKey: ["workspace_visibility"] });
      toast.success(
        next
          ? `${WORKSPACES[ws].name} is now visible`
          : `${WORKSPACES[ws].name} hidden from switcher`,
      );
    } catch (e: any) {
      toast.error("Could not update visibility", { description: e?.message });
    } finally {
      setVisBusy(null);
    }
  }

  /** Persistent "what's currently indexed from Drive" tally — survives across reloads. */
  const driveIndex = useQuery({
    queryKey: ["drive_indexed", workspace],
    enabled: !!googleConn.data?.connected,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows, error } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, drive_mime_type, drive_modified_time, last_sync_error, created_at")
        .eq("workspace_id", workspace)
        .not("drive_file_id", "is", null)
        .order("created_at", { ascending: false });
      if (error) console.warn("driveIndex query failed:", error.message);
      const list = (rows ?? []) as any[];
      const total = list.length;
      const withError = list.filter((r) => !!r.last_sync_error).length;
      // Use the freshest signal we have — drive_modified_time falls back to created_at
      const lastSyncedAt =
        list.map((r) => r.drive_modified_time || r.created_at).filter(Boolean).sort().pop() ?? null;
      return { total, withError, lastSyncedAt, list };
    },
  });

  // Analysis guidance — the editable instruction injected into the AI prompts.
  const guidanceQuery = useQuery({
    queryKey: ["analysis_guidance", workspace],
    queryFn: async () => await getGuidance({ data: { workspace } }),
  });
  useEffect(() => {
    if (!guidanceQuery.data) return;
    const saved = (guidanceQuery.data.guidance ?? "").trim();
    // Some workspaces pre-fill with their starter system prompt so users can
    // see the full instructions and amend them without code changes:
    //   - simplify: editable DEFAULT_SIMPLIFY_GUIDANCE
    //   - layout:   editable DEFAULT_FRAME_EXTRACTION_PROMPT (full replacement)
    // Other workspaces (rmit/fatf/forms) treat guidance as a supplemental
    // prefix and stay blank by default.
    setGuidanceText(
      saved ||
        (workspace === "simplify"
          ? DEFAULT_SIMPLIFY_GUIDANCE
          : workspace === "layout"
            ? DEFAULT_FRAME_EXTRACTION_PROMPT
            : ""),
    );
  }, [guidanceQuery.data, workspace]);

  function resetGuidanceToDefault() {
    if (workspace === "simplify") setGuidanceText(DEFAULT_SIMPLIFY_GUIDANCE);
    else if (workspace === "layout") setGuidanceText(DEFAULT_FRAME_EXTRACTION_PROMPT);
    else setGuidanceText("");
  }

  async function saveGuidanceNow() {
    setGuidanceSaving(true);
    try {
      await saveGuidance({ data: { workspace, guidance: guidanceText } });
      qc.invalidateQueries({ queryKey: ["analysis_guidance", workspace] });
      toast.success("Analysis guidance saved", { description: "It applies to the next analysis run." });
    } catch (e: any) {
      toast.error("Could not save guidance", { description: e?.message });
    } finally {
      setGuidanceSaving(false);
    }
  }

  async function connectGoogle() {
    setBusy("connect");
    try {
      const { url } = await getAuthUrl({ data: { workspace, origin: window.location.origin } });
      window.location.href = url;
    } catch (e: any) {
      toast.error("Could not start Google connection", { description: e?.message });
      setBusy(null);
    }
  }
  async function disconnectGoogleNow() {
    if (!confirm(`Disconnect Google Drive from the ${wsName} workspace?`)) return;
    setBusy("disconnect");
    try {
      await disconnect({ data: { workspace } });
      toast.success(`Disconnected Google Drive from ${wsName}`);
      qc.invalidateQueries({ queryKey: ["google_connection", workspace] });
      setSyncResult(null);
    } catch (e: any) {
      toast.error("Disconnect failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function saveDriveFolder() {
    if (!folderInput.trim()) return;
    setBusy("folder");
    try {
      const r = await setFolder({ data: { workspace, folderUrlOrId: folderInput.trim() } });
      toast.success(`KB folder set: ${r.folderName}`);
      setFolderInput("");
      qc.invalidateQueries({ queryKey: ["google_connection", workspace] });
    } catch (e: any) {
      toast.error("Could not set folder", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy("sync");
    setSyncResult(null);
    setIndexProgress(null);
    setSyncPhase(null);
    try {
      // Phase 1: fast list — no downloads, just Drive API metadata
      const list = await listFiles({ data: { workspace, force: forceResync } });
      setForceResync(false);

      if (list.toSync.length === 0) {
        toast.success(`All files up to date`, { description: `${list.unchangedCount} unchanged · ${list.skippedCount} unsupported` });
        qc.invalidateQueries({ queryKey: ["drive_indexed", workspace] });
        return;
      }

      // Phase 2: mirror each file one at a time — each call has its own 60 s budget
      setSyncPhase("mirror");
      setIndexProgress({ done: 0, total: list.toSync.length });
      const syncedDocs: { id: string; title: string }[] = [];
      let mirrorFailed = 0;
      for (let i = 0; i < list.toSync.length; i++) {
        const f = list.toSync[i];
        setIndexProgress({ done: i, total: list.toSync.length });
        try {
          const r = await mirrorFile({ data: { workspace, fileId: f.id, fileName: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, existingSopId: f.existingSopId } });
          syncedDocs.push({ id: r.sopId, title: r.title });
        } catch (e: any) {
          console.warn(`Mirror failed for ${f.name}:`, e?.message);
          mirrorFailed++;
        }
      }
      setIndexProgress(null);

      const mirrorMsg = `${syncedDocs.length} mirrored${mirrorFailed ? ` · ${mirrorFailed} failed` : ""}${list.unchangedCount ? ` · ${list.unchangedCount} unchanged` : ""}`;
      if (mirrorFailed) toast.warning(`Sync finished with errors`, { description: mirrorMsg });
      else toast.success(`Synced from "${list.folderName}"`, { description: mirrorMsg });
      qc.invalidateQueries({ queryKey: ["drive_indexed", workspace] });

      // Phase 3: index each mirrored doc one at a time (skip forms workspace)
      if (syncedDocs.length > 0 && workspace !== "forms") {
        setSyncPhase("index");
        setIndexProgress({ done: 0, total: syncedDocs.length });
        let indexed = 0;
        for (const doc of syncedDocs) {
          try { await reindex({ data: { id: doc.id } }); } catch (e) {
            console.warn(`Re-index failed for ${doc.title}:`, e);
          }
          indexed++;
          setIndexProgress({ done: indexed, total: syncedDocs.length });
        }
        toast.success(`Indexed ${indexed} of ${syncedDocs.length} documents`);
        setIndexProgress(null);
      }

      qc.invalidateQueries({ queryKey: ["counts", workspace] });
      qc.invalidateQueries({ queryKey: ["sops"] });
      qc.invalidateQueries({ queryKey: ["sop_chunk_counts", workspace] });
      qc.invalidateQueries({ queryKey: ["drive_indexed", workspace] });
    } catch (e: any) {
      toast.error("Sync failed", { description: e?.message });
    } finally {
      setBusy(null);
      setIndexProgress(null);
      setSyncPhase(null);
    }
  }

  const counts = useQuery({
    queryKey: ["counts", workspace],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [sops, reports] = await Promise.all([
        (supabase as any).from("sop_documents").select("id", { count: "exact", head: true }).eq("workspace_id", workspace),
        (supabase as any).from("analysis_reports").select("id", { count: "exact", head: true }).eq("workspace_id", workspace),
      ]);
      return { sops: sops.count ?? 0, reports: reports.count ?? 0 };
    },
  });

  async function run(scope: "kb" | "analyses" | "all", label: string) {
    if (!confirm(`This will permanently delete ${label} in the "${wsName}" workspace only.\n\nOther workspaces will be unaffected. Continue?`)) return;
    setBusy(scope);
    try {
      await clear({ data: { scope, workspace } });
      toast.success(`${label} cleared in ${wsName}`);
      qc.invalidateQueries();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-[1400px] mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Manage data in the <span className="font-semibold text-foreground">{wsName}</span> workspace.
            Other workspaces are unaffected.
          </p>
        </div>

        <Card className="p-6">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-lg bg-primary/10 grid place-items-center shrink-0">
              <Briefcase className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold">Workspace Visibility</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Master switch for which demos appear in the workspace switcher.
                Hidden workspaces stay intact — toggle back on any time. The
                current workspace can't be hidden from itself to avoid trapping you.
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {(Object.keys(WORKSPACES) as WorkspaceId[]).map((id) => {
              const meta = WORKSPACES[id];
              const isVisible = visibility[id] !== false; // default true
              const isCurrent = id === workspace;
              const isBusy = visBusy === id;
              return (
                <div
                  key={id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md border p-3 transition-colors",
                    isVisible ? "bg-card" : "bg-muted/40 opacity-75",
                  )}
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <div
                      className={cn(
                        "size-8 rounded-md grid place-items-center shrink-0 text-[11px] font-bold",
                        meta.bgColor,
                        meta.color,
                      )}
                    >
                      {meta.short.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {meta.name}
                        {isCurrent && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-primary bg-primary/10 rounded px-1.5 py-0.5">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {meta.tagline}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isVisible ? "outline" : "default"}
                    onClick={() => toggleVisibility(id, !isVisible)}
                    disabled={isBusy || isCurrent || visibilityQuery.isLoading}
                    className="gap-1.5 shrink-0"
                    title={isCurrent ? "Switch to another workspace first" : undefined}
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isVisible ? (
                      <Eye className="size-3.5" />
                    ) : (
                      <EyeOff className="size-3.5" />
                    )}
                    {isVisible ? "Visible" : "Hidden"}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Tip: Hide non-bank demos before screen-sharing with the bank, then
            toggle them back on for internal use.
          </p>
        </Card>

        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Workspace</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-md bg-muted/40 p-4">
              <div className="text-2xl font-display font-semibold">
                {counts.data?.sops ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground">SOPs in Knowledge Base</div>
            </div>
            <div className="rounded-md bg-muted/40 p-4">
              <div className="text-2xl font-display font-semibold">
                {counts.data?.reports ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground">Analysis reports</div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">
            {workspace === "layout" ? "System Prompt" : "Analysis Guidance"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {workspace === "layout" ? (
              <>
                The complete AI system prompt for the{" "}
                <span className="font-semibold text-foreground">{wsName}</span> workspace.
                Whatever you save here REPLACES the built-in default on the next digitization run.
                Use <span className="font-semibold">Reset to default</span> to restore the
                shipped prompt if your edits break extraction.
              </>
            ) : (
              <>
                Extra instruction added to the AI&apos;s regulatory analysis for the{" "}
                <span className="font-semibold text-foreground">{wsName}</span> workspace.
                It refines focus and emphasis — the output format and verification rules stay fixed.
              </>
            )}
          </p>
          <textarea
            className="mt-4 w-full min-h-[220px] text-xs font-mono p-3 rounded-lg border bg-muted/30 leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Focus on virtual-asset / VASP scope changes. Always flag stale date references. Treat tone-hardening (should → shall) as high impact."
            value={guidanceText}
            onChange={(e) => setGuidanceText(e.target.value)}
            disabled={guidanceQuery.isLoading}
            style={workspace === "layout" ? { minHeight: 480 } : undefined}
          />
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <Button onClick={saveGuidanceNow} disabled={guidanceSaving || guidanceQuery.isLoading}>
              {guidanceSaving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              {workspace === "layout" ? "Save system prompt" : "Save guidance"}
            </Button>
            {(workspace === "layout" || workspace === "simplify") && (
              <Button
                variant="outline"
                onClick={resetGuidanceToDefault}
                disabled={guidanceSaving || guidanceQuery.isLoading}
                className="gap-1.5"
              >
                <RotateCcw className="size-3.5" />
                Reset to default
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {workspace === "layout"
                ? "Applies to the next Re-digitize run. Keep the JSON output schema intact."
                : "Applies to the next analysis run."}
            </span>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold inline-flex items-center gap-2">
                Google Drive
                {googleConn.data?.connected && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                    <CheckCircle2 className="size-3" /> Connected
                  </span>
                )}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Connect a Google account to use a Drive folder as the {wsName} Knowledge Base, pick policy docs from Drive for analysis, and write comments back into source Docs.
              </p>
              {googleConn.isLoading && (
                <div className="mt-3 text-xs text-muted-foreground inline-flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" /> Checking connection…
                </div>
              )}
              {googleConn.data?.connected && (
                <div className="mt-3 rounded-md border bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 px-3 py-2 text-xs space-y-1">
                  <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                    {googleConn.data.email}
                  </div>
                  <div className="text-emerald-800/70 dark:text-emerald-300/70">
                    {googleConn.data.driveFolderName
                      ? <>KB folder: <span className="font-medium">{googleConn.data.driveFolderName}</span></>
                      : <>No KB folder configured yet. Paste a Drive folder URL below.</>}
                  </div>
                  {googleConn.data.driveFolderName && driveIndex.data && (
                    <div className="pt-1.5 mt-1.5 border-t border-emerald-200/60 dark:border-emerald-800/60 text-emerald-800/80 dark:text-emerald-300/80 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span><span className="font-semibold">{driveIndex.data.total}</span> doc{driveIndex.data.total === 1 ? "" : "s"} indexed from Drive</span>
                      {driveIndex.data.withError > 0 && (
                        <span className="text-amber-700 dark:text-amber-400">{driveIndex.data.withError} with sync error{driveIndex.data.withError === 1 ? "" : "s"}</span>
                      )}
                      {driveIndex.data.lastSyncedAt && (
                        <span className="opacity-80">Last sync: {timeAgo(driveIndex.data.lastSyncedAt)}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Folder configuration + Sync — only visible when connected */}
              {googleConn.data?.connected && (
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {googleConn.data.driveFolderName ? "Change KB folder" : "Set KB folder"}
                    </label>
                    <div className="mt-1 flex gap-2">
                      <Input
                        placeholder="Paste Drive folder URL or ID"
                        value={folderInput}
                        onChange={(e) => setFolderInput(e.target.value)}
                        disabled={busy === "folder"}
                        className="text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={saveDriveFolder}
                        disabled={busy === "folder" || !folderInput.trim()}
                        className="gap-1.5"
                      >
                        {busy === "folder" ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
                        {googleConn.data.driveFolderName ? "Change" : "Save"}
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Example: <code>https://drive.google.com/drive/folders/1AbC...</code> — folder must be shared with the connected Google account.
                    </p>
                  </div>

                  {googleConn.data.driveFolderName && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={syncNow}
                          disabled={busy === "sync"}
                          className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          <Loader2 className={`size-3.5 ${busy === "sync" ? "animate-spin" : "hidden"}`} />
                          {!busy && <RefreshCw className="size-3.5" />}
                          {busy === "sync"
                            ? indexProgress
                              ? syncPhase === "index"
                                ? `Indexing ${indexProgress.done}/${indexProgress.total}…`
                                : `Mirroring ${indexProgress.done + 1}/${indexProgress.total}…`
                              : "Checking files…"
                            : "Sync KB from Drive"}
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          Skips files unchanged since last successful sync · retries previously failed files automatically.
                        </span>
                      </div>
                      <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={forceResync}
                          onChange={(e) => setForceResync(e.target.checked)}
                          disabled={busy === "sync"}
                          className="size-3.5 accent-emerald-600"
                        />
                        Force full re-sync (re-process every file, ignore last-sync state)
                      </label>
                    </div>
                  )}

                  {syncResult && (
                    <div className="rounded-md border bg-card p-3 text-[11px] space-y-1.5">
                      <div className="font-semibold">
                        Sync from "<span className="text-primary">{syncResult.folderName}</span>" complete
                      </div>
                      <ul className="text-muted-foreground space-y-0.5">
                        <li>
                          {syncResult.indexable} indexable file{syncResult.indexable === 1 ? "" : "s"} found
                          · <span className="text-emerald-700 font-medium">{syncResult.succeeded} succeeded</span>
                          {syncResult.unchanged ? <> · <span className="text-slate-700">{syncResult.unchanged} unchanged (skipped)</span></> : null}
                          {syncResult.failedCount ? <> · <span className="text-amber-700">{syncResult.failedCount} failed</span></> : null}
                          {syncResult.skippedCount ? <> · {syncResult.skippedCount} unsupported</> : null}
                        </li>
                      </ul>
                      {syncResult.failures?.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[10px] font-semibold uppercase text-amber-700">Failures</div>
                          <ul className="text-[11px] mt-0.5">
                            {syncResult.failures.map((f: any, i: number) => (
                              <li key={i} className="text-amber-800/90">• <span className="font-medium">{f.name}</span> — {f.reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {syncResult.skipped?.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Skipped (unsupported file types)</div>
                          <ul className="text-[11px] mt-0.5">
                            {syncResult.skipped.map((f: any, i: number) => (
                              <li key={i} className="text-muted-foreground">• {f.name} <span className="opacity-60">({f.mimeType})</span></li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {googleConn.data && !googleConn.data.connected && (
                <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Not connected. Click Connect to start the Google consent flow.
                </div>
              )}
            </div>
            <div className="shrink-0">
              {googleConn.data?.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={disconnectGoogleNow}
                  disabled={busy === "disconnect"}
                  className="gap-2"
                >
                  {busy === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={connectGoogle}
                  disabled={busy === "connect" || googleConn.isLoading}
                  className="gap-2"
                >
                  {busy === "connect" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                  Connect Google Drive
                </Button>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-6 border-destructive/30">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-lg bg-destructive/10 grid place-items-center shrink-0">
              <AlertTriangle className="size-5 text-destructive" />
            </div>
            <div>
              <h2 className="font-display text-lg font-semibold text-destructive">Danger Zone</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Irreversible operations. These actions delete data permanently.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <DangerRow
              title="Clear all analyses"
              desc="Delete every analysis report, regulatory change, SOP impact, and chat history."
              busy={busy === "analyses"}
              onClick={() => run("analyses", "all analyses")}
            />
            <DangerRow
              title="Clear Knowledge Base"
              desc="Remove every SOP and policy document you've added."
              busy={busy === "kb"}
              onClick={() => run("kb", "the Knowledge Base")}
            />
            <DangerRow
              title="Reset workspace"
              desc="Wipe both the Knowledge Base and all analyses. Returns the workspace to a fresh state."
              busy={busy === "all"}
              onClick={() => run("all", "the entire workspace")}
              destructive
            />
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function DangerRow({
  title,
  desc,
  busy,
  onClick,
  destructive,
}: {
  title: string;
  desc: string;
  busy: boolean;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-md border">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
      </div>
      <Button
        variant={destructive ? "destructive" : "outline"}
        size="sm"
        disabled={busy}
        onClick={onClick}
        className="gap-2 shrink-0"
      >
        <Trash2 className="size-4" />
        {busy ? "Clearing..." : "Clear"}
      </Button>
    </div>
  );
}

/** Human-friendly relative time for the "Last sync: 3min ago" display. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}
