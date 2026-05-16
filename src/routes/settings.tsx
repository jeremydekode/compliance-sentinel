import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, Trash2 } from "lucide-react";
import { clearWorkspace } from "@/lib/compliance.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · Compliance Sentinel" }] }),
});

function SettingsPage() {
  const qc = useQueryClient();
  const clear = useServerFn(clearWorkspace);
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useQuery({
    queryKey: ["counts"],
    queryFn: async () => {
      const [sops, reports] = await Promise.all([
        supabase.from("sop_documents").select("id", { count: "exact", head: true }),
        supabase.from("analysis_reports").select("id", { count: "exact", head: true }),
      ]);
      return { sops: sops.count ?? 0, reports: reports.count ?? 0 };
    },
  });

  async function run(scope: "kb" | "analyses" | "all", label: string) {
    if (!confirm(`This will permanently delete ${label}. Continue?`)) return;
    setBusy(scope);
    try {
      await clear({ data: { scope } });
      toast.success(`${label} cleared`);
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
            Manage your workspace data.
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
