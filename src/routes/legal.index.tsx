import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { listLegalMatters } from "@/lib/legal.functions";
import {
  LegalHeader, StatCard, LifecycleAlerts, statusBadge, routeBadge, priorityDot,
} from "@/components/legal-widgets";
import {
  Plus, FileText, Sparkles, AlertCircle, Clock, CheckCircle2,
  ClipboardList, Library, ChevronRight,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/legal/")({
  component: LegalDashboard,
  head: () => ({ meta: [{ title: "Legal CMS · Dashboard" }] }),
});

function LegalDashboard() {
  const listFn = useServerFn(listLegalMatters);
  const { data: matters = [], isLoading } = useQuery({
    queryKey: ["legal-matters"],
    queryFn: () => listFn({ data: {} }),
    staleTime: 30_000,
  });

  const total     = matters.length;
  const aiResolved= matters.filter((m: any) => m.status === "resolved").length;
  const pending   = matters.filter((m: any) => m.status === "pending_assignment").length;
  const inReview  = matters.filter((m: any) => m.status === "in_review" || m.status === "assigned").length;
  const pendingAp = matters.filter((m: any) => m.status === "pending_approval").length;

  const recent = [...matters]
    .sort((a: any, b: any) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .slice(0, 6);

  return (
    <AppShell>
      <div className="flex flex-col min-h-screen">
        <LegalHeader
          subtitle="Dashboard"
          action={
            <Link to="/legal/new">
              <Button size="sm" className="gap-1.5 h-7 text-xs">
                <Plus className="size-3.5" /> New Request
              </Button>
            </Link>
          }
        />

        <div className="flex-1 p-6 space-y-5">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard icon={FileText}     label="Total Matters"      value={total}     color="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400" />
            <StatCard icon={Sparkles}     label="AI Resolved"        value={aiResolved} sub="no lawyer time" color="bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" />
            <StatCard icon={AlertCircle}  label="Pending Assignment" value={pending}   color="bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400" />
            <StatCard icon={Clock}        label="In Review"          value={inReview}  color="bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400" />
            <StatCard icon={CheckCircle2} label="Pending Approval"   value={pendingAp} color="bg-violet-50 text-violet-600 dark:bg-violet-900/20 dark:text-violet-400" />
          </div>

          {/* Quick links to the two sub-sections */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link to="/legal/requests" className="rounded-xl border bg-card px-4 py-3 flex items-center gap-3 hover:border-indigo-300 hover:bg-muted/20 transition-colors group">
              <div className="size-9 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 grid place-items-center shrink-0">
                <ClipboardList className="size-4.5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Requests</div>
                <div className="text-[11px] text-muted-foreground">Work queue — track, assign &amp; action matters</div>
              </div>
              <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </Link>
            <Link to="/legal/repository" className="rounded-xl border bg-card px-4 py-3 flex items-center gap-3 hover:border-indigo-300 hover:bg-muted/20 transition-colors group">
              <div className="size-9 rounded-lg bg-violet-50 dark:bg-violet-900/20 grid place-items-center shrink-0">
                <Library className="size-4.5 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Repository</div>
                <div className="text-[11px] text-muted-foreground">Vault, knowledge base &amp; self-service templates</div>
              </div>
              <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </Link>
          </div>

          {/* Lifecycle alerts + recent requests */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <LifecycleAlerts />

            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                <Clock className="size-3.5 text-muted-foreground" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Recent Requests</span>
                <Link to="/legal/requests" className="text-[10px] text-indigo-600 dark:text-indigo-400 ml-auto hover:underline">view all →</Link>
              </div>
              <div className="divide-y">
                {isLoading ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground/60">Loading…</p>
                ) : recent.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground/60 italic">No matters yet. Submit your first request.</p>
                ) : recent.map((m: any) => (
                  <Link key={m.id} to="/legal/$matterId" params={{ matterId: m.id }} className="flex items-center gap-2 px-4 py-2 hover:bg-muted/20 transition-colors">
                    {priorityDot(m.priority)}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">{m.reference_number ?? "—"}</span>
                    <span className="text-xs font-medium truncate flex-1">{m.title}</span>
                    {routeBadge(m.route)}
                    {statusBadge(m.status)}
                    <span className="text-[10px] text-muted-foreground shrink-0 hidden sm:inline">
                      {m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : ""}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
