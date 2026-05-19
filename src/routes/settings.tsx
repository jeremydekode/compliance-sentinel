import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, Trash2, CheckCircle2, Loader2, Plug, Unplug } from "lucide-react";
import {
  clearWorkspace,
  getGoogleAuthUrl,
  getGoogleConnectionStatus,
  disconnectGoogle,
  setDriveFolder,
  syncDriveFolder,
} from "@/lib/compliance.functions";
import { Input } from "@/components/ui/input";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useWorkspace, WORKSPACES } from "@/lib/workspace";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · Compliance Sentinel" }] }),
});

function SettingsPage() {
  const qc = useQueryClient();
  const clear = useServerFn(clearWorkspace);
  const getAuthUrl = useServerFn(getGoogleAuthUrl);
  const getStatus = useServerFn(getGoogleConnectionStatus);
  const disconnect = useServerFn(disconnectGoogle);
  const setFolder = useServerFn(setDriveFolder);
  const sync = useServerFn(syncDriveFolder);
  const [busy, setBusy] = useState<string | null>(null);
  const [workspace] = useWorkspace();
  const wsName = WORKSPACES[workspace].name;
  const [folderInput, setFolderInput] = useState("");
  const [syncResult, setSyncResult] = useState<any | null>(null);
  const [forceResync, setForceResync] = useState(false);

  const googleConn = useQuery({
    queryKey: ["google_connection", workspace],
    queryFn: async () => await getStatus({ data: { workspace } }),
  });

  /** Persistent "what's currently indexed from Drive" tally — survives across reloads. */
  const driveIndex = useQuery({
    queryKey: ["drive_indexed", workspace],
    enabled: !!googleConn.data?.connected,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, drive_mime_type, drive_modified_time, last_sync_error, updated_at")
        .eq("workspace_id", workspace)
        .not("drive_file_id", "is", null)
        .order("updated_at", { ascending: false });
      const list = (rows ?? []) as any[];
      const total = list.length;
      const withError = list.filter((r) => !!r.last_sync_error).length;
      const lastSyncedAt = list[0]?.updated_at ?? null;
      return { total, withError, lastSyncedAt, list };
    },
  });

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
    try {
      const r = await sync({ data: { workspace, force: forceResync } });
      setSyncResult(r);
      const parts: string[] = [];
      parts.push(`${r.succeeded} indexed`);
      if (r.unchanged) parts.push(`${r.unchanged} unchanged (skipped)`);
      if (r.failedCount) parts.push(`${r.failedCount} failed`);
      if (r.skippedCount) parts.push(`${r.skippedCount} unsupported`);
      const msg = parts.join(" · ");
      if (r.failedCount > 0) toast.warning(`Sync finished with errors`, { description: msg });
      else toast.success(`Synced from "${r.folderName}"`, { description: msg });
      qc.invalidateQueries({ queryKey: ["counts", workspace] });
      qc.invalidateQueries({ queryKey: ["sops"] });
      qc.invalidateQueries({ queryKey: ["sop_chunk_counts", workspace] });
      qc.invalidateQueries({ queryKey: ["drive_indexed", workspace] });
      setForceResync(false); // reset after every run so it's an explicit opt-in
    } catch (e: any) {
      toast.error("Sync failed", { description: e?.message });
    } finally {
      setBusy(null);
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
                          {busy === "sync" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                          Sync KB from Drive
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
