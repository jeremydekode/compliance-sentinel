import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, FileText, AlertTriangle, CheckCircle2, Upload } from "lucide-react";
import { formatDate, statusMeta } from "@/lib/format";

export const Route = createFileRoute("/")({ component: Dashboard });

function Dashboard() {
  const reports = useQuery({
    queryKey: ["reports"],
    queryFn: async () => {
      const { data } = await supabase
        .from("analysis_reports")
        .select("id, title, policy_name, status, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });

  const totals = {
    reports: reports.data?.length ?? 0,
    pending: reports.data?.filter((r) => r.status === "pending_review").length ?? 0,
    approved: reports.data?.filter((r) => r.status === "approved").length ?? 0,
  };

  return (
    <AppShell>
      <div className="p-8 space-y-8 max-w-[1400px] mx-auto">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-1">
              Monitor regulatory updates and SOP gap analysis across your organisation.
            </p>
          </div>
          <Link to="/reports">
            <Button size="lg" className="gap-2">
              <Upload className="size-4" /> New Analysis
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard icon={FileText} label="Active Reports" value={totals.reports} tone="primary" />
          <StatCard icon={AlertTriangle} label="Pending Review" value={totals.pending} tone="amber" />
          <StatCard icon={CheckCircle2} label="Approved" value={totals.approved} tone="emerald" />
        </div>

        <Card className="p-0 overflow-hidden">
          <div className="px-6 py-4 border-b flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Recent Analyses</h2>
            <Link to="/reports" className="text-xs text-muted-foreground hover:text-foreground">
              + View all
            </Link>
          </div>
          <div className="divide-y">
            {reports.isLoading && (
              <div className="p-6 space-y-3">
                {[1,2,3].map(i => (
                  <div key={i} className="flex items-center gap-4 animate-pulse">
                    <div className="size-10 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded w-1/3" />
                      <div className="h-3 bg-muted rounded w-1/5" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!reports.isLoading && (reports.data?.length ?? 0) === 0 && (
              <div className="p-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No analyses yet. Upload a regulatory document to get started.
                </p>
                <Link to="/reports">
                  <Button className="mt-4 gap-2"><Upload className="size-4" /> Upload policy</Button>
                </Link>
              </div>
            )}
            {reports.data?.map((r) => {
              const s = statusMeta(r.status);
              return (
                <Link
                  key={r.id}
                  to="/reports/$reportId"
                  params={{ reportId: r.id }}
                  className="flex items-center justify-between px-6 py-4 hover:bg-muted/40 transition-colors group"
                >
                  <div>
                    <div className="font-medium">{r.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {r.policy_name} · {formatDate(r.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={s.classes}>{s.label}</Badge>
                    <ArrowRight className="size-4 text-muted-foreground group-hover:text-foreground transition" />
                  </div>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function StatCard({
  icon: Icon, label, value, tone,
}: { icon: any; label: string; value: number; tone: "primary" | "amber" | "emerald" }) {
  const toneCls =
    tone === "amber" ? "bg-amber-100 text-amber-700"
    : tone === "emerald" ? "bg-emerald-100 text-emerald-700"
    : "bg-accent text-accent-foreground";
  return (
    <Card className="p-5 flex items-center gap-4">
      <div className={`size-11 rounded-lg grid place-items-center ${toneCls}`}>
        <Icon className="size-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold font-display">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}
