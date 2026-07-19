import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listLegalMatters, MATTER_TYPES } from "@/lib/legal.functions";
import {
  LegalHeader, STATUS_FILTER_TABS, statusMatchesTab, statusBadge, routeBadge, priorityDot,
} from "@/components/legal-widgets";
import { Plus, Filter, Search, ChevronRight, Loader2, Scale } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/legal/requests")({
  component: LegalRequests,
  head: () => ({ meta: [{ title: "Legal CMS · Requests" }] }),
});

function LegalRequests() {
  const listFn = useServerFn(listLegalMatters);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [routeFilter, setRouteFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: matters = [], isLoading } = useQuery({
    queryKey: ["legal-matters"],
    queryFn: () => listFn({ data: {} }),
    staleTime: 30_000,
  });

  const q = search.trim().toLowerCase();
  const filtered = matters.filter((m: any) => {
    if (!statusMatchesTab(m.status, statusFilter)) return false;
    if (routeFilter !== "all" && m.route !== routeFilter) return false;
    if (q) {
      const hay = `${m.title ?? ""} ${m.reference_number ?? ""} ${m.description ?? ""} ${m.requestor_name ?? ""} ${m.assigned_to_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <AppShell>
      <div className="flex flex-col min-h-screen">
        <LegalHeader
          subtitle="Requests · work queue"
          action={
            <Link to="/legal/new">
              <Button size="sm" className="gap-1.5 h-7 text-xs">
                <Plus className="size-3.5" /> New Request
              </Button>
            </Link>
          }
        />

        <div className="flex-1 p-6 space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5 flex-wrap">
              {STATUS_FILTER_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setStatusFilter(t.key)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                    statusFilter === t.key
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t.label}
                  {t.key !== "all" && (
                    <span className="ml-1 text-[10px] opacity-60">
                      {matters.filter((m: any) => statusMatchesTab(m.status, t.key)).length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1">
                <Search className="size-3 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search requests…"
                  className="text-[11px] bg-transparent border-0 focus:outline-none w-40 placeholder:text-muted-foreground/60"
                />
              </div>
              <div className="flex items-center gap-1">
                <Filter className="size-3 text-muted-foreground" />
                <select
                  value={routeFilter}
                  onChange={(e) => setRouteFilter(e.target.value)}
                  className="text-[11px] border-0 bg-transparent text-muted-foreground focus:outline-none cursor-pointer"
                >
                  <option value="all">All Routes</option>
                  <option value="A">Route A · Self-Service</option>
                  <option value="B">Route B · Bespoke</option>
                  <option value="C">Route C · Simple Advisory</option>
                  <option value="D">Route D · Complex Advisory</option>
                </select>
              </div>
            </div>
          </div>

          {/* Matter list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="size-12 rounded-xl bg-muted grid place-items-center mb-3">
                <Scale className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No requests found</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                {statusFilter === "all" ? "Submit your first request to get started." : "Try a different filter."}
              </p>
              {statusFilter === "all" && (
                <Link to="/legal/new" className="mt-4">
                  <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs">
                    <Plus className="size-3.5" /> New Request
                  </Button>
                </Link>
              )}
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Reference</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Matter</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Route</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Assigned To</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Submitted</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((m: any) => (
                    <tr key={m.id} className="hover:bg-muted/20 transition-colors group">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-[10px] text-muted-foreground">{m.reference_number ?? "—"}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-start gap-1.5">
                          {priorityDot(m.priority)}
                          <span className="font-medium text-foreground truncate max-w-[220px]">{m.title}</span>
                        </div>
                        {m.matter_type && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {MATTER_TYPES.find((t) => t.value === m.matter_type)?.label ?? m.matter_type}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{routeBadge(m.route)}</td>
                      <td className="px-4 py-2.5">{statusBadge(m.status)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {m.assigned_to_name ?? <span className="text-muted-foreground/50 italic">Unassigned</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link to="/legal/$matterId" params={{ matterId: m.id }}>
                          <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
