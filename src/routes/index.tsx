import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Inbox,
  TimerReset,
  Upload,
  UserCircle2,
  Activity,
  Flame,
  ShieldCheck,
  Send,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import {
  mockPriority,
  mockAssignee,
  computeSlaStatus,
  isOpen,
  priorityClasses,
  priorityLabel,
  slaClasses,
  slaLabel,
  generateActivityFeed,
  generateTrend,
  priorityDistribution,
  slaDistribution,
  relativeTime,
  SLA_DAYS,
  type Priority,
} from "@/lib/dashboard-mock";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

export const Route = createFileRoute("/")({ component: Dashboard });

interface ReportRow {
  id: string;
  title: string;
  policy_name: string;
  status: string;
  created_at: string;
}

function Dashboard() {
  // Workspace lives in localStorage — server has no access. Render server-default
  // until mounted, then swap. Same pattern used in app-shell + settings.
  const [workspaceActual] = useWorkspace();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const workspace: WorkspaceId = mounted ? workspaceActual : "rmit";

  // Pull MORE than 10 here so the KPIs reflect the whole pipeline, not a tiny
  // window. Reports table per workspace tends to be < a few hundred.
  const reports = useQuery({
    queryKey: ["reports", "dashboard", workspace],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("analysis_reports")
        .select("id, title, policy_name, status, created_at")
        .eq("workspace_id", workspace)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as ReportRow[];
    },
  });

  const list = reports.data ?? [];

  // Derive every dashboard metric from the same list — keeps everything
  // in sync and avoids a second round-trip to Supabase.
  const metrics = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 86_400_000;
    let openCount = 0;
    let overdueCount = 0;
    let totalDaysOpen = 0;
    let newThisWeek = 0;
    let inReview = 0;
    let approved = 0;
    let rejected = 0;
    let newCount = 0;
    let dueSoon = 0;

    const pending: Array<ReportRow & {
      priority: Priority;
      assignee: string;
      daysOpen: number;
      daysToTarget: number;
      slaStatus: ReturnType<typeof computeSlaStatus>["status"];
    }> = [];

    for (const r of list) {
      const created = new Date(r.created_at).getTime();
      if (created >= weekAgo) newThisWeek++;
      if (r.status === "pending_review" || r.status === "running") inReview++;
      if (r.status === "approved") approved++;
      if (r.status === "rejected") rejected++;
      if (r.status === "new" || r.status === "queued") newCount++;

      if (isOpen(r.status)) {
        openCount++;
        const priority = mockPriority(r.id);
        const sla = computeSlaStatus(r.created_at, priority);
        totalDaysOpen += sla.daysOpen;
        if (sla.status === "overdue") overdueCount++;
        if (sla.status === "due_soon") dueSoon++;
        pending.push({
          ...r,
          priority,
          assignee: mockAssignee(r.id, r.status),
          daysOpen: sla.daysOpen,
          daysToTarget: sla.daysToTarget,
          slaStatus: sla.status,
        });
      }
    }

    // Sort pending: overdue first (most-overdue at top), then due_soon, then by daysToTarget ascending.
    pending.sort((a, b) => {
      const order = { overdue: 0, due_soon: 1, on_track: 2 } as const;
      if (order[a.slaStatus] !== order[b.slaStatus]) return order[a.slaStatus] - order[b.slaStatus];
      return a.daysToTarget - b.daysToTarget;
    });

    return {
      newThisWeek,
      openCount,
      overdueCount,
      dueSoon,
      avgDaysOpen: openCount > 0 ? Math.round(totalDaysOpen / openCount) : 0,
      flow: { newCount, inReview, approved, rejected },
      pending,
    };
  }, [list]);

  const activity = useMemo(() => generateActivityFeed(list), [list]);
  const trend = useMemo(() => generateTrend(list), [list]);
  const priorityData = useMemo(() => priorityDistribution(metrics.pending), [metrics.pending]);
  const slaData = useMemo(() => slaDistribution(metrics.pending), [metrics.pending]);
  const trendTotals = useMemo(() => ({
    received: trend.reduce((a, d) => a + d.received, 0),
    resolved: trend.reduce((a, d) => a + d.resolved, 0),
  }), [trend]);
  const wsMeta = WORKSPACES[workspace];

  return (
    <AppShell>
      <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Compliance Pipeline</h1>
            <p className="text-muted-foreground mt-1">
              Live status of regulatory and policy work in the{" "}
              <span className={cn("font-semibold", wsMeta.color)}>{wsMeta.name}</span>{" "}
              workspace.
            </p>
          </div>
          <Link to="/reports">
            <Button size="lg" className="gap-2">
              <Upload className="size-4" /> New Analysis
            </Button>
          </Link>
        </div>

        {/* Hero KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            icon={Inbox}
            label="New this week"
            value={metrics.newThisWeek}
            tone="blue"
            hint={metrics.newThisWeek > 0 ? "Incoming this period" : "No new arrivals"}
          />
          <KpiCard
            icon={Clock}
            label="Open requests"
            value={metrics.openCount}
            tone="amber"
            hint={metrics.dueSoon > 0 ? `${metrics.dueSoon} due within 3 days` : "All on track"}
          />
          <KpiCard
            icon={Flame}
            label="Overdue"
            value={metrics.overdueCount}
            tone={metrics.overdueCount > 0 ? "rose" : "slate"}
            hint={metrics.overdueCount > 0 ? "Action needed" : "None overdue"}
            urgent={metrics.overdueCount > 0}
          />
          <KpiCard
            icon={TimerReset}
            label="Avg age (open)"
            value={`${metrics.avgDaysOpen}d`}
            tone="slate"
            hint={metrics.openCount === 0 ? "No open requests" : "Across all open"}
          />
        </div>

        {/* Activity trend — 14 days */}
        <Card className="p-5">
          <div className="flex items-end justify-between gap-4 mb-4 flex-wrap">
            <div>
              <h2 className="font-display text-lg font-semibold">14-day activity</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Received vs resolved per day · {trendTotals.received} received, {trendTotals.resolved} resolved in this period
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-blue-500" /> Received
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-emerald-500" /> Resolved
              </span>
            </div>
          </div>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={trend} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#cbd5e1" }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#cbd5e1" }} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                  cursor={{ fill: "rgba(100,116,139,0.08)" }}
                />
                <Bar dataKey="received" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="resolved" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Priority distribution + SLA performance donuts */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <DonutCard
            title="Priority mix"
            subtitle={`${metrics.openCount} open request${metrics.openCount === 1 ? "" : "s"} · demo priorities`}
            data={priorityData}
          />
          <DonutCard
            title="SLA performance"
            subtitle={metrics.overdueCount > 0
              ? `${metrics.overdueCount} overdue · ${metrics.dueSoon} due soon`
              : "All open requests on track"}
            data={slaData}
          />
        </div>

        {/* Two-column: pending requests + activity feed */}
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4">
          {/* Pending Requests Table */}
          <Card className="p-0 overflow-hidden">
            <div className="px-6 py-4 border-b flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-semibold">Pending requests</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sorted by SLA urgency · Priority &amp; assignee shown are demo values
                </p>
              </div>
              <Link to="/reports" className="text-xs text-muted-foreground hover:text-foreground">
                View all →
              </Link>
            </div>

            {reports.isLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-4 animate-pulse">
                    <div className="size-10 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded w-1/3" />
                      <div className="h-3 bg-muted rounded w-1/5" />
                    </div>
                  </div>
                ))}
              </div>
            ) : metrics.pending.length === 0 ? (
              <div className="p-10 text-center">
                <ShieldCheck className="size-8 text-emerald-500 mx-auto" />
                <p className="text-sm font-medium mt-2">No open requests</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The queue is clear in this workspace.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                    <tr>
                      <th className="text-left px-6 py-2">Report</th>
                      <th className="text-left px-3 py-2">Priority</th>
                      <th className="text-left px-3 py-2">Assignee</th>
                      <th className="text-right px-3 py-2">Days open</th>
                      <th className="text-left px-3 py-2">SLA</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {metrics.pending.slice(0, 10).map((r) => (
                      <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-6 py-3">
                          <Link
                            to="/reports/$reportId"
                            params={{ reportId: r.id }}
                            className="font-medium hover:underline"
                          >
                            {r.title}
                          </Link>
                          <div className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[280px]">
                            {r.policy_name} · received {formatDate(r.created_at)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", priorityClasses(r.priority))}>
                            {priorityLabel(r.priority)}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 text-xs">
                            <UserCircle2 className="size-3.5 text-muted-foreground" />
                            <span className="truncate max-w-[120px]">{r.assignee}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {r.daysOpen}d
                          <div className="text-[10px] text-muted-foreground">
                            target {SLA_DAYS[r.priority]}d
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", slaClasses(r.slaStatus))}>
                            {slaLabel(r.slaStatus)}
                            {r.slaStatus === "overdue" && (
                              <span className="ml-1">· {Math.abs(r.daysToTarget)}d late</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Link
                            to="/reports/$reportId"
                            params={{ reportId: r.id }}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ArrowRight className="size-4 inline" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {metrics.pending.length > 10 && (
                  <div className="px-6 py-3 border-t text-xs text-muted-foreground text-center bg-muted/20">
                    Showing top 10 of {metrics.pending.length} open requests. <Link to="/reports" className="text-foreground font-medium hover:underline">View all →</Link>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Activity Feed */}
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-display text-lg font-semibold">Activity</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Recent intake, routing &amp; review events
              </p>
            </div>
            {activity.length === 0 ? (
              <div className="p-10 text-center text-xs text-muted-foreground">
                Nothing yet — events appear as analyses run.
              </div>
            ) : (
              <ul className="divide-y">
                {activity.map((ev) => (
                  <li key={ev.id} className="px-5 py-3 hover:bg-muted/30 transition-colors">
                    <div className="flex items-start gap-3">
                      <ActivityIcon kind={ev.kind} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs leading-snug">{ev.detail}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {relativeTime(ev.timestamp)}
                          {ev.actor && <> · {ev.actor}</>}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Demo data disclosure */}
        <p className="text-[10px] text-muted-foreground italic">
          Priority, assignee and SLA targets shown here are demo values derived deterministically
          from each report's ID (single source of truth: <code>src/lib/dashboard-mock.ts</code>).
          They will be replaced with real workflow fields when assignment + SLA columns land.
        </p>
      </div>
    </AppShell>
  );
}

// ── Components ────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon,
  label,
  value,
  tone,
  hint,
  urgent,
}: {
  icon: any;
  label: string;
  value: number | string;
  tone: "blue" | "amber" | "rose" | "emerald" | "slate";
  hint?: string;
  urgent?: boolean;
}) {
  const toneCls = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    rose: "bg-rose-50 text-rose-800 border-rose-200",
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
    slate: "bg-slate-50 text-slate-700 border-slate-200",
  }[tone];
  return (
    <Card className={cn("p-5 border-l-4", urgent && "ring-1 ring-rose-300/60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">{label}</div>
          <div className="text-4xl font-bold font-display tabular-nums mt-1.5">{value}</div>
          {hint && <div className="text-[11px] text-muted-foreground mt-1.5">{hint}</div>}
        </div>
        <div className={cn("size-10 rounded-lg grid place-items-center shrink-0 border", toneCls)}>
          <Icon className="size-5" />
        </div>
      </div>
    </Card>
  );
}

function DonutCard({
  title,
  subtitle,
  data,
}: {
  title: string;
  subtitle: string;
  data: Array<{ name: string; value: number; fill: string }>;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <Card className="p-5">
      <div className="mb-3">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative" style={{ width: 140, height: 140 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={total > 0 ? data : [{ name: "Empty", value: 1, fill: "#e2e8f0" }]}
                dataKey="value"
                cx="50%"
                cy="50%"
                innerRadius={42}
                outerRadius={62}
                paddingAngle={total > 1 ? 2 : 0}
                stroke="none"
              >
                {(total > 0 ? data : [{ name: "Empty", value: 1, fill: "#e2e8f0" }]).map((d, i) => (
                  <Cell key={i} fill={d.fill} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center">
              <div className="text-2xl font-bold tabular-nums">{total}</div>
              <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">total</div>
            </div>
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          {data.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="size-2.5 rounded-sm shrink-0" style={{ background: d.fill }} />
                <span className="truncate">{d.name}</span>
              </div>
              <div className="tabular-nums font-medium">
                {d.value}
                {total > 0 && (
                  <span className="text-muted-foreground ml-1.5 text-[10px]">
                    {Math.round((d.value / total) * 100)}%
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ActivityIcon({ kind }: { kind: string }) {
  const map: Record<string, { Icon: any; cls: string }> = {
    received: { Icon: Inbox, cls: "bg-blue-100 text-blue-700" },
    assigned: { Icon: UserCircle2, cls: "bg-slate-100 text-slate-700" },
    approved: { Icon: CheckCircle2, cls: "bg-emerald-100 text-emerald-700" },
    legal_review: { Icon: Send, cls: "bg-violet-100 text-violet-700" },
    overdue_breach: { Icon: Flame, cls: "bg-rose-100 text-rose-700" },
  };
  const { Icon, cls } = map[kind] ?? { Icon: Activity, cls: "bg-slate-100 text-slate-600" };
  return (
    <div className={cn("size-7 rounded-md grid place-items-center shrink-0 mt-0.5", cls)}>
      <Icon className="size-3.5" />
    </div>
  );
}
