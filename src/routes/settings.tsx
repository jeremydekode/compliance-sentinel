import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { AlertTriangle, Trash2, CheckCircle2, Loader2, Plug, Unplug, Eye, EyeOff, Briefcase, RotateCcw, Users, UserPlus, Palette, Pencil, CopyPlus } from "lucide-react";
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
  listAppUsers,
  setUserAccess,
  listTenants,
  createTenant,
  updateTenant,
  getModelSettings,
  setModelSettings,
  listSeedableContent,
  seedTenantDemo,
  type AppUserRow,
  type AccessLevel,
  type TenantRow,
} from "@/lib/compliance.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { DEFAULT_SIMPLIFY_GUIDANCE } from "@/lib/simplify";
import { ALL_FEATURES } from "@/lib/tenant";
import { DEFAULT_RECOMMEND_GUIDANCE } from "@/lib/recommend";
import { DEFAULT_FRAME_EXTRACTION_PROMPT } from "@/lib/layout/prompt";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · AI Document Workflow" }] }),
});

function SettingsPage() {
  const qc = useQueryClient();
  const auth = useAuth();
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
  const [workspaceActual] = useWorkspace();
  // Workspace lives in localStorage — server has no access, so it defaults
  // to "rmit". Render with the server-default until after hydration, then
  // swap to the real workspace. Prevents a React 19 hydration crash when
  // the page is hard-refreshed on a non-rmit workspace.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const workspace: WorkspaceId = mounted ? workspaceActual : "rmit";
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
    queryKey: ["drive_indexed", workspace, auth.tenantId],
    enabled: !!googleConn.data?.connected && !auth.loading,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows, error } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, drive_mime_type, drive_modified_time, last_sync_error, created_at")
        .eq("workspace_id", workspace)
        .eq("tenant_id", auth.tenantId)
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
        (workspace === "simplify" || workspace === "simplify_v2"
          ? DEFAULT_SIMPLIFY_GUIDANCE
          : workspace === "layout"
            ? DEFAULT_FRAME_EXTRACTION_PROMPT
            : ""),
    );
  }, [guidanceQuery.data, workspace]);

  function resetGuidanceToDefault() {
    if (workspace === "simplify" || workspace === "simplify_v2") setGuidanceText(DEFAULT_SIMPLIFY_GUIDANCE);
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
    queryKey: ["counts", workspace, auth.tenantId],
    enabled: !auth.loading,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [sops, reports] = await Promise.all([
        (supabase as any).from("sop_documents").select("id", { count: "exact", head: true }).eq("workspace_id", workspace).eq("tenant_id", auth.tenantId),
        (supabase as any).from("analysis_reports").select("id", { count: "exact", head: true }).eq("workspace_id", workspace).eq("tenant_id", auth.tenantId),
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

        {/* Super-admin only — renders nothing for everyone else. */}
        <TeamCard />
        <TenantsCard />

        <ModelSettingsCard />

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
            {(workspace === "layout" || workspace === "simplify" || workspace === "simplify_v2") && (
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

        {workspace === "simplify_v2" && <RecommendGuidanceCard />}

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

const LEVEL_LABEL: Record<AccessLevel, string> = {
  none: "No access",
  viewer: "Viewer",
  member: "Member",
  super_admin: "Super admin",
};

/**
 * Team & Access — super-admin-only control panel. Renders NOTHING for any other
 * role (defence-in-depth: the server functions also re-check super_admin, and
 * RLS is the real boundary; hiding the UI is purely cosmetic). Lets the admin
 * invite emails, change access levels, and see last-sign-in per person.
 */
function TeamCard() {
  const auth = useAuth();
  const qc = useQueryClient();
  const listUsers = useServerFn(listAppUsers);
  const setAccess = useServerFn(setUserAccess);
  const listTenantsFn = useServerFn(listTenants);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const isSuper = mounted && !auth.loading && auth.role === "super_admin";

  const usersQuery = useQuery({
    queryKey: ["app_users"],
    queryFn: () => listUsers(),
    enabled: isSuper,
  });
  const tenantsQuery = useQuery({
    queryKey: ["tenants"],
    queryFn: () => listTenantsFn(),
    enabled: isSuper,
  });
  const tenants = tenantsQuery.data?.tenants ?? [];

  // Hidden for non-super-admins and until auth resolves (avoids SSR/hydration flash).
  if (!isSuper) return null;

  async function invite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setBusyKey("invite");
    try {
      await setAccess({ data: { email, level: "viewer" } });
      toast.success(`Invited ${email}`, { description: "Read-only access on first sign-in." });
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["app_users"] });
    } catch (e: any) {
      toast.error("Could not invite", { description: e?.message });
    } finally {
      setBusyKey(null);
    }
  }

  async function changeLevel(u: AppUserRow, level: AccessLevel) {
    setBusyKey(u.email);
    try {
      await setAccess({ data: { userId: u.id ?? undefined, email: u.email, level } });
      toast.success(`${u.email} → ${LEVEL_LABEL[level]}`);
      qc.invalidateQueries({ queryKey: ["app_users"] });
    } catch (e: any) {
      toast.error("Could not update access", { description: e?.message });
    } finally {
      setBusyKey(null);
    }
  }

  async function changeTenant(u: AppUserRow, tenantId: string) {
    setBusyKey(u.email);
    try {
      await setAccess({ data: { userId: u.id ?? undefined, email: u.email, level: u.level, tenantId } });
      toast.success(`${u.email} branding → ${tenantId}`);
      qc.invalidateQueries({ queryKey: ["app_users"] });
    } catch (e: any) {
      toast.error("Could not update branding", { description: e?.message });
    } finally {
      setBusyKey(null);
    }
  }

  const users = usersQuery.data?.users ?? [];

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-lg bg-primary/10 grid place-items-center shrink-0">
          <Users className="size-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold">Team &amp; Access</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Who can sign in and what they can do — applies across all workspaces.{" "}
            <span className="font-medium text-foreground">Viewer</span> reads only,{" "}
            <span className="font-medium text-foreground">Member</span> can edit &amp; run analyses,{" "}
            <span className="font-medium text-foreground">No access</span> blocks sign-in entirely.
          </p>
        </div>
      </div>

      {/* Invite by email */}
      <div className="mt-5">
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Invite by email
        </label>
        <div className="mt-1 flex gap-2 max-w-md">
          <Input
            type="email"
            placeholder="name@company.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
            disabled={busyKey === "invite"}
            className="text-sm"
          />
          <Button onClick={invite} disabled={busyKey === "invite" || !inviteEmail.trim()} className="gap-1.5 shrink-0">
            {busyKey === "invite" ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
            Invite
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          They sign in with Google; first login lands them as a read-only Viewer.
        </p>
      </div>

      {/* People */}
      <div className="mt-6">
        {usersQuery.isLoading ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" /> Loading team…
          </div>
        ) : usersQuery.error ? (
          <div className="text-xs text-destructive">
            Couldn&apos;t load users. {(usersQuery.error as any)?.message}
          </div>
        ) : users.length === 0 ? (
          <div className="text-xs text-muted-foreground">No one has signed in yet.</div>
        ) : (
          <div className="rounded-lg border divide-y">
            {users.map((u) => {
              const isSelf = !!u.id && u.id === auth.userId;
              const rowBusy = busyKey === u.email;
              return (
                <div key={u.email} className="flex items-center gap-3 px-4 py-3">
                  <div className="size-8 rounded-full bg-muted grid place-items-center text-xs font-bold shrink-0 uppercase">
                    {u.email.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate flex items-center gap-2">
                      {u.email}
                      {isSelf && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-primary bg-primary/10 rounded px-1.5 py-0.5">
                          You
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {u.signedIn
                        ? u.lastSignInAt
                          ? `Last seen ${timeAgo(u.lastSignInAt)}`
                          : "Signed in"
                        : "Invited · never signed in"}
                    </div>
                  </div>
                  {rowBusy && <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />}
                  <select
                    value={u.tenantId}
                    disabled={rowBusy}
                    onChange={(e) => changeTenant(u, e.target.value)}
                    title="Branding tenant"
                    className="text-xs rounded-md border bg-card px-2 py-1.5 font-medium shrink-0 disabled:opacity-60"
                  >
                    {tenants.length === 0 ? (
                      <option value={u.tenantId}>{u.tenantId}</option>
                    ) : (
                      tenants.map((t) => (
                        <option key={t.slug} value={t.slug}>{t.name}</option>
                      ))
                    )}
                  </select>
                  <select
                    value={u.level}
                    disabled={rowBusy || isSelf}
                    onChange={(e) => changeLevel(u, e.target.value as AccessLevel)}
                    title={isSelf ? "You can't change your own access" : undefined}
                    className="text-xs rounded-md border bg-card px-2 py-1.5 font-medium shrink-0 disabled:opacity-60"
                  >
                    <option value="none">No access</option>
                    <option value="viewer">Viewer</option>
                    <option value="member">Member</option>
                    <option value="super_admin">Super admin</option>
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

type TenantFormState = {
  slug: string;
  name: string;
  tagline: string;
  logoUrl: string;
  colorPrimary: string;
  colorSidebar: string;
  colorSidebarPrimary: string;
  colorSidebarAccent: string;
  features: string[];
};

// Human labels for the per-tenant capability toggles. Workspace keys reuse the
// WORKSPACES names; the extra capability keys are labelled here.
const FEATURE_LABELS: Record<string, string> = {
  legal_cms: "Legal CMS",
  rudy: "Rudy.ai assistant",
  create_document: "Create documents",
};

const BLANK_TENANT_FORM: TenantFormState = {
  slug: "",
  name: "",
  tagline: "",
  logoUrl: "",
  colorPrimary: "",
  colorSidebar: "",
  colorSidebarPrimary: "",
  colorSidebarAccent: "",
  features: [...ALL_FEATURES],
};

function tenantToForm(t: TenantRow): TenantFormState {
  const hex = (v: string | null) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : "");
  return {
    slug: t.slug,
    name: t.name,
    tagline: t.tagline ?? "",
    logoUrl: t.logoUrl ?? "",
    colorPrimary: hex(t.colorPrimary),
    colorSidebar: hex(t.colorSidebar),
    colorSidebarPrimary: hex(t.colorSidebarPrimary),
    colorSidebarAccent: hex(t.colorSidebarAccent),
    features: Array.isArray(t.features) ? t.features : [...ALL_FEATURES],
  };
}

/**
 * Tenants — super-admin-only branding admin. Lets you create a re-skinned
 * "tenant" for an external prospect (name/tagline/logo/colors) and assign
 * users/invites to it from the Team panel above. Purely cosmetic — every
 * tenant's users still see every workspace, same as today.
 */
function TenantsCard() {
  const auth = useAuth();
  const qc = useQueryClient();
  const listTenantsFn = useServerFn(listTenants);
  const createTenantFn = useServerFn(createTenant);
  const updateTenantFn = useServerFn(updateTenant);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [editing, setEditing] = useState<{ form: TenantFormState; isNew: boolean } | null>(null);
  const [seeding, setSeeding] = useState<TenantRow | null>(null);
  const [saving, setSaving] = useState(false);

  const isSuper = mounted && !auth.loading && auth.role === "super_admin";

  const tenantsQuery = useQuery({
    queryKey: ["tenants"],
    queryFn: () => listTenantsFn(),
    enabled: isSuper,
  });

  if (!isSuper) return null;

  const tenants = tenantsQuery.data?.tenants ?? [];

  async function save() {
    if (!editing) return;
    const f = editing.form;
    if (!f.slug.trim() || !f.name.trim()) {
      toast.error("Slug and name are required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        slug: f.slug.trim().toLowerCase(),
        name: f.name.trim(),
        tagline: f.tagline.trim() || undefined,
        logoUrl: f.logoUrl.trim() || undefined,
        colorPrimary: f.colorPrimary || undefined,
        colorSidebar: f.colorSidebar || undefined,
        colorSidebarPrimary: f.colorSidebarPrimary || undefined,
        colorSidebarAccent: f.colorSidebarAccent || undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        features: f.features as any,
      };
      if (editing.isNew) await createTenantFn({ data: payload });
      else await updateTenantFn({ data: payload });
      toast.success(`Saved ${payload.name}`);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["app_users"] });
    } catch (e: any) {
      toast.error("Could not save tenant", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-lg bg-primary/10 grid place-items-center shrink-0">
          <Palette className="size-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold">Tenants</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Branded environments for external prospects: name, tagline, logo, colors,
            plus which demos &amp; capabilities the tenant gets. Documents are always
            tenant-scoped — one tenant can never see another's files. Assign people via
            the tenant picker in Team &amp; Access above.
          </p>
        </div>
        {!editing && (
          <Button
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setEditing({ form: BLANK_TENANT_FORM, isNew: true })}
          >
            <UserPlus className="size-4" />
            New tenant
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-5 rounded-lg border p-4 space-y-3 max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Slug</label>
              <Input
                value={editing.form.slug}
                disabled={!editing.isNew}
                placeholder="rhb"
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, slug: e.target.value } })}
                className="text-sm mt-1"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Name</label>
              <Input
                value={editing.form.name}
                placeholder="RHB Bank"
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })}
                className="text-sm mt-1"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Tagline</label>
            <Input
              value={editing.form.tagline}
              placeholder="Compliance & Risk Intelligence"
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, tagline: e.target.value } })}
              className="text-sm mt-1"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Logo URL (optional)</label>
            <Input
              value={editing.form.logoUrl}
              placeholder="https://…"
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, logoUrl: e.target.value } })}
              className="text-sm mt-1"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Colors (optional — blank inherits the default)
            </label>
            <div className="mt-1 flex gap-4">
              {([
                ["colorPrimary", "Primary"],
                ["colorSidebar", "Sidebar"],
                ["colorSidebarPrimary", "Sidebar accent"],
                ["colorSidebarAccent", "Sidebar hover"],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex flex-col items-center gap-1">
                  <input
                    type="color"
                    value={editing.form[key] || "#ffffff"}
                    onChange={(e) => setEditing({ ...editing, form: { ...editing.form, [key]: e.target.value } })}
                    className="size-8 rounded border cursor-pointer"
                  />
                  <span className="text-[9px] text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Enabled demos &amp; capabilities
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              This tenant's users only see the workspaces and features ticked here — their
              document lists are always limited to the tenant's own files.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {ALL_FEATURES.map((key) => {
                const label =
                  FEATURE_LABELS[key] ?? WORKSPACES[key as WorkspaceId]?.name ?? key;
                const on = editing.form.features.includes(key);
                return (
                  <label key={key} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          form: {
                            ...editing.form,
                            features: e.target.checked
                              ? [...editing.form.features, key]
                              : editing.form.features.filter((f) => f !== key),
                          },
                        })
                      }
                      className="accent-[var(--primary)]"
                    />
                    <span className={cn(!on && "text-muted-foreground")}>{label}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button onClick={save} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Save
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5">
        {tenantsQuery.isLoading ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" /> Loading tenants…
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {tenants.map((t) => (
              <div key={t.slug} className="flex items-center gap-3 px-4 py-3">
                <div className="flex gap-1 shrink-0">
                  {[t.colorPrimary, t.colorSidebar, t.colorSidebarPrimary].map((c, i) => (
                    <div
                      key={i}
                      className="size-4 rounded-full border"
                      style={{ background: c ?? "var(--muted)" }}
                    />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{t.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t.slug} {t.tagline ? `· ${t.tagline}` : ""}
                  </div>
                </div>
                {t.slug !== "rhb" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 shrink-0 text-muted-foreground"
                    onClick={() => setSeeding(t)}
                  >
                    <CopyPlus className="size-3.5" />
                    Seed demos
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 shrink-0"
                  onClick={() => setEditing({ form: tenantToForm(t), isNew: false })}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {seeding && <SeedTenantDialog tenant={seeding} onClose={() => setSeeding(null)} />}
    </Card>
  );
}

/**
 * Seed demo content — pops up over the Tenants card. Lists RHB's reports and
 * KB documents; ticked items are cloned (rows + embedding chunks, inside
 * Postgres) into the target tenant. Files are shared by URL — nothing is
 * re-uploaded or re-embedded, so cloning is near-instant.
 */
function SeedTenantDialog({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const listFn = useServerFn(listSeedableContent);
  const seedFn = useServerFn(seedTenantDemo);
  const [picked, setPicked] = useState<{ reports: Set<string>; sops: Set<string> }>({
    reports: new Set(),
    sops: new Set(),
  });
  const [running, setRunning] = useState(false);

  const content = useQuery({
    queryKey: ["seedable_content", "rhb"],
    queryFn: () => listFn({ data: { sourceTenant: "rhb" } }),
  });

  function toggle(kind: "reports" | "sops", id: string) {
    setPicked((prev) => {
      const next = new Set(prev[kind]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [kind]: next };
    });
  }

  function toggleAll(kind: "reports" | "sops", ids: string[]) {
    setPicked((prev) => {
      const allOn = ids.every((id) => prev[kind].has(id));
      return { ...prev, [kind]: allOn ? new Set() : new Set(ids) };
    });
  }

  async function run() {
    setRunning(true);
    try {
      const r = await seedFn({
        data: {
          targetTenant: tenant.slug,
          reportIds: [...picked.reports],
          sopIds: [...picked.sops],
        },
      });
      toast.success(`Seeded ${tenant.name}`, {
        description: `${r.reports} report(s), ${r.sops} KB doc(s) (${r.chunks} embedding chunks) cloned.`,
      });
      onClose();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Seeding failed", { description: e?.message });
    } finally {
      setRunning(false);
    }
  }

  const total = picked.reports.size + picked.sops.size;

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <CopyPlus className="size-4 text-primary" /> Seed "{tenant.name}" with demo content
          </DialogTitle>
          <DialogDescription>
            Clones independent copies from the RHB demo library — results, findings and knowledge-base
            embeddings included. Actions in one tenant never affect the other's copy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {content.isLoading && (
            <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4">
              <Loader2 className="size-3 animate-spin" /> Loading library…
            </div>
          )}
          {content.isError && (
            <p className="text-xs text-destructive">Could not load the demo library.</p>
          )}

          {content.data && (
            <div className="grid md:grid-cols-2 gap-4">
              {([
                ["sops", "Knowledge base documents", content.data.sops, "doc_type"],
                ["reports", "Analyses & reports", content.data.reports, "workflow_type"],
              ] as const).map(([kind, label, rows, subKey]) => (
                <div key={kind}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      {label} ({rows.length})
                    </div>
                    {rows.length > 0 && (
                      <button
                        className="text-[10px] text-primary hover:underline"
                        onClick={() => toggleAll(kind, rows.map((r: { id: string }) => r.id))}
                      >
                        {rows.every((r: { id: string }) => picked[kind].has(r.id)) ? "Deselect all" : "Select all"}
                      </button>
                    )}
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded-lg border divide-y">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {rows.map((row: any) => (
                      <label key={row.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                        <input
                          type="checkbox"
                          checked={picked[kind].has(row.id)}
                          onChange={() => toggle(kind, row.id)}
                          className="accent-[var(--primary)] shrink-0"
                        />
                        <span className="truncate flex-1" title={row.title}>{row.title}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {row.workspace_id}{row[subKey] ? ` · ${row[subKey]}` : ""}
                        </span>
                      </label>
                    ))}
                    {rows.length === 0 && (
                      <div className="p-3 text-center text-xs text-muted-foreground">Nothing available.</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-5 py-4 border-t shrink-0">
          <Button onClick={run} disabled={total === 0 || running} className="gap-1.5">
            {running ? <Loader2 className="size-4 animate-spin" /> : <CopyPlus className="size-4" />}
            Clone {total > 0 ? `${total} item${total === 1 ? "" : "s"}` : ""} into {tenant.name}
          </Button>
          <span className="text-[11px] text-muted-foreground flex-1">
            Instant — rows + embeddings copy inside the database; files are shared.
          </span>
          <Button variant="outline" onClick={onClose} disabled={running}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
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

/**
 * Simplify v2 — second guidance editor for the RECOMMENDATION (quality-audit)
 * prompt, stored under the synthetic guidance key "simplify_v2_recommend".
 * The main editor above owns the simplification style rules; this one owns the
 * defect taxonomy, severity calibration and evidence rules the audit follows.
 */
function RecommendGuidanceCard() {
  const qc = useQueryClient();
  const getGuidance = useServerFn(getAnalysisGuidance);
  const saveGuidance = useServerFn(saveAnalysisGuidance);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["analysis_guidance", "simplify_v2_recommend"],
    queryFn: async () => await getGuidance({ data: { workspace: "simplify_v2_recommend" } }),
  });
  useEffect(() => {
    if (!query.data) return;
    setText((query.data.guidance ?? "").trim() || DEFAULT_RECOMMEND_GUIDANCE);
  }, [query.data]);

  async function save() {
    setSaving(true);
    try {
      await saveGuidance({ data: { workspace: "simplify_v2_recommend", guidance: text } });
      qc.invalidateQueries({ queryKey: ["analysis_guidance", "simplify_v2_recommend"] });
      toast.success("Audit guidance saved", { description: "It applies to the next Recommendation run." });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Could not save guidance", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-semibold">Audit Guidance (Recommendation modes)</h2>
      <p className="text-sm text-muted-foreground mt-1">
        The instruction the <span className="font-semibold text-foreground">document quality audit</span> follows
        in Recommendation and Recommend &amp; Edit runs — defect categories, severity calibration and evidence
        rules. The JSON output contract stays fixed.
      </p>
      <textarea
        className="mt-4 w-full min-h-[280px] text-xs font-mono p-3 rounded-lg border bg-muted/30 leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={query.isLoading}
      />
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <Button onClick={save} disabled={saving || query.isLoading}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          Save audit guidance
        </Button>
        <Button
          variant="outline"
          onClick={() => setText(DEFAULT_RECOMMEND_GUIDANCE)}
          disabled={saving || query.isLoading}
          className="gap-1.5"
        >
          <RotateCcw className="size-3.5" />
          Reset to default
        </Button>
        <span className="text-xs text-muted-foreground">Applies to the next audit run.</span>
      </div>
    </Card>
  );
}


/**
 * AI Model — super-admin picker for the app's DEFAULT model. The chosen model
 * is always called FIRST for the main analysis passes; the standard fallback
 * chain still applies automatically if it errors or is overloaded. High-volume
 * mechanical batch calls stay on the fast/cheap model regardless.
 */
function ModelSettingsCard() {
  const auth = useAuth();
  const qc = useQueryClient();
  const getModel = useServerFn(getModelSettings);
  const setModel = useServerFn(setModelSettings);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [saving, setSaving] = useState(false);

  const isSuper = mounted && !auth.loading && auth.role === "super_admin";
  const query = useQuery({
    queryKey: ["model_settings"],
    queryFn: () => getModel(),
    enabled: isSuper,
  });

  if (!isSuper) return null;

  const MODEL_BLURB: Record<string, string> = {
    "gemini-2.5-pro": "Strongest reasoning — best audit accuracy, slower & pricier",
    "gemini-3.5-flash": "Balanced default — fast, strong, economical",
    "gemini-2.5-flash": "Previous-gen balanced model",
    "gemini-3.1-flash-lite": "Cheapest & fastest — light tasks only",
  };

  async function pick(model: string) {
    setSaving(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setModel({ data: { model } as any });
      await qc.invalidateQueries({ queryKey: ["model_settings"] });
      toast.success(`Default model set to ${model}`, {
        description: "It leads every analysis from the next run; fallbacks still apply automatically.",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Could not save model setting", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-semibold">AI Model</h2>
      <p className="text-sm text-muted-foreground mt-1">
        The default model leads every analysis call. If it fails or is overloaded, the
        standard fallback chain takes over automatically — a run never dies because one
        model is busy. Bulk mechanical passes always use the fast tier for cost.
      </p>
      <div className="mt-4 space-y-2 max-w-lg">
        {(query.data?.available ?? []).map((m) => {
          const active = query.data?.model === m;
          return (
            <button
              key={m}
              disabled={saving || query.isLoading}
              onClick={() => !active && pick(m)}
              className={cn(
                "w-full flex items-center justify-between rounded-lg border px-4 py-2.5 text-left transition-colors",
                active ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:border-primary/40",
              )}
            >
              <div>
                <div className={cn("text-sm font-semibold font-mono", active && "text-primary")}>{m}</div>
                <div className="text-[11px] text-muted-foreground">{MODEL_BLURB[m] ?? ""}</div>
              </div>
              {active && <CheckCircle2 className="size-4 text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
