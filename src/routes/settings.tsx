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
} from "@/lib/compliance.functions";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [workspace] = useWorkspace();
  const wsName = WORKSPACES[workspace].name;

  const googleConn = useQuery({
    queryKey: ["google_connection", workspace],
    queryFn: async () => await getStatus({ data: { workspace } }),
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
    } catch (e: any) {
      toast.error("Disconnect failed", { description: e?.message });
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
                <div className="mt-3 rounded-md border bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 px-3 py-2 text-xs">
                  <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                    {googleConn.data.email}
                  </div>
                  <div className="text-emerald-800/70 dark:text-emerald-300/70 mt-0.5">
                    {googleConn.data.driveFolderName
                      ? <>KB folder: <span className="font-medium">{googleConn.data.driveFolderName}</span></>
                      : <>No KB folder configured yet — coming in the next stage.</>}
                  </div>
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
