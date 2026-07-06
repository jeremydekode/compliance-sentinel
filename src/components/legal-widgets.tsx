import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  listLifecycleAlerts,
  vaultKnowledgeSearch,
  listKnowledgeBase,
  seedKnowledgeBase,
  STATUS_META,
  ROUTE_META,
} from "@/lib/legal.functions";
import { toast } from "sonner";
import { differenceInCalendarDays } from "date-fns";
import { Scale, Loader2, Send, Bot, CalendarClock, Trash2, Sparkles, BookOpen } from "lucide-react";

// ---------------------------------------------------------------------------
// Shared building blocks for the Legal CMS routes (Dashboard / Requests /
// Repository), so the split pages stay consistent.
// ---------------------------------------------------------------------------

export const STATUS_FILTER_TABS = [
  { key: "all",              label: "All Matters" },
  { key: "resolved",         label: "AI Resolved" },
  { key: "pending_assignment", label: "Pending Assignment" },
  { key: "in_review",        label: "In Review" },
  { key: "pending_approval", label: "Pending Approval" },
  { key: "approved",         label: "Approved" },
  { key: "archived",         label: "Archived" },
] as const;

// One source of truth for "does this matter belong under this tab", used by the
// tab counts and the table filter so they never disagree. The In Review tab
// intentionally includes "assigned" (work is with a lawyer).
export function statusMatchesTab(status: string, tab: string): boolean {
  if (tab === "all") return true;
  if (tab === "in_review") return status === "in_review" || status === "assigned";
  return status === tab;
}

export function routeBadge(route: string | null) {
  if (!route) return null;
  const meta = ROUTE_META[route];
  const cls: Record<string, string> = {
    A: "bg-emerald-50 text-emerald-700 ring-emerald-200/60 dark:bg-emerald-900/20 dark:text-emerald-300",
    B: "bg-blue-50 text-blue-700 ring-blue-200/60 dark:bg-blue-900/20 dark:text-blue-300",
    C: "bg-violet-50 text-violet-700 ring-violet-200/60 dark:bg-violet-900/20 dark:text-violet-300",
    D: "bg-rose-50 text-rose-700 ring-rose-200/60 dark:bg-rose-900/20 dark:text-rose-300",
  };
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1",
      cls[route] ?? "bg-muted text-muted-foreground ring-border"
    )}>
      {route} · {meta?.description}
    </span>
  );
}

export function statusBadge(status: string) {
  const meta = STATUS_META[status] ?? { label: status, color: "gray" };
  const colorCls: Record<string, string> = {
    gray:   "bg-muted text-muted-foreground",
    violet: "bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300",
    amber:  "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300",
    blue:   "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300",
    emerald:"bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300",
    red:    "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300",
  };
  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
      colorCls[meta.color] ?? colorCls.gray
    )}>
      {meta.label}
    </span>
  );
}

export function priorityDot(priority: string) {
  const cls: Record<string, string> = {
    urgent: "bg-red-500",
    high:   "bg-amber-500",
    normal: "bg-blue-400",
    low:    "bg-gray-300",
  };
  return (
    <span
      title={`${priority} priority`}
      className={cn("inline-block size-1.5 rounded-full shrink-0 mt-0.5", cls[priority] ?? cls.normal)}
    />
  );
}

export function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: number; sub?: string; color: string;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 flex items-center gap-3">
      <div className={cn("size-8 rounded-lg grid place-items-center shrink-0", color)}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold tabular-nums leading-tight">{value}</div>
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground/60">{sub}</div>}
      </div>
    </div>
  );
}

// Sticky page header shared by every Legal CMS route.
export function LegalHeader({ subtitle, action }: { subtitle: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b bg-background/95 px-6 py-3 sticky top-0 z-10 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 grid place-items-center ring-1 ring-indigo-500/20">
          <Scale className="size-3.5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-sm font-bold leading-tight">Legal CMS</h1>
          <p className="text-[10px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

// Post-execution AI knowledge agent — reasons over the vault + published KB.
export function VaultAgent() {
  const searchFn = useServerFn(vaultKnowledgeSearch);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; citations: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setAnswer(null);
    try {
      const res: any = await searchFn({ data: { query: query.trim() } });
      setAnswer(res);
    } catch (e: any) {
      toast.error(e?.message ?? "Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <Bot className="size-3.5 text-indigo-600 dark:text-indigo-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Repository Knowledge Agent</span>
        <span className="text-[10px] text-muted-foreground/60 ml-auto">reasons over executed matters + KB</span>
      </div>
      <div className="p-3 space-y-2 flex-1">
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
            placeholder="e.g. What's our position on unlimited liability caps?"
            className="flex-1 rounded-lg border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          <Button size="sm" className="h-7 text-[11px] gap-1.5" disabled={!query.trim() || loading} onClick={ask}>
            {loading ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Ask
          </Button>
        </div>
        {answer && (
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
            {answer.answer}
            {answer.citations?.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {answer.citations.map((c) => (
                  <span key={c} className="rounded bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 text-[10px] font-mono text-indigo-700 dark:text-indigo-300">{c}</span>
                ))}
              </div>
            )}
          </div>
        )}
        {!answer && !loading && (
          <p className="text-[10px] text-muted-foreground/60">Post-execution advisory — answers recurring practical queries from the repository, citing prior matters.</p>
        )}
      </div>
    </div>
  );
}

// Expiry / renewal tracker + destruction prompts (Step 6).
export function LifecycleAlerts() {
  const alertsFn = useServerFn(listLifecycleAlerts);
  const { data: rows = [] } = useQuery({
    queryKey: ["legal-lifecycle"],
    queryFn: () => alertsFn(),
    staleTime: 60_000,
  });

  const now = new Date();
  const expiring = rows
    .filter((r: any) => r.expiry_date)
    .map((r: any) => ({ ...r, days: differenceInCalendarDays(new Date(r.expiry_date), now) }))
    .filter((r: any) => r.days <= 90)
    .sort((a: any, b: any) => a.days - b.days);
  const destroying = rows
    .filter((r: any) => r.destroy_after)
    .map((r: any) => ({ ...r, days: differenceInCalendarDays(new Date(r.destroy_after), now) }))
    .filter((r: any) => r.days <= 30);

  return (
    <div className="rounded-xl border bg-card overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <CalendarClock className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Lifecycle Alerts</span>
        <span className="text-[10px] text-muted-foreground/60 ml-auto">expiry · renewal · destruction</span>
      </div>
      <div className="p-3 space-y-1.5 flex-1">
        {expiring.length === 0 && destroying.length === 0 && (
          <p className="text-[10px] text-muted-foreground/60">No contracts within 90 days of expiry, and none due for destruction. Set lifecycle dates on approved matters.</p>
        )}
        {expiring.map((r: any) => (
          <Link key={`e-${r.id}`} to="/legal/$matterId" params={{ matterId: r.id }} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] hover:bg-muted/30 transition-colors">
            <CalendarClock className={cn("size-3 shrink-0", r.days < 0 ? "text-red-500" : r.days <= 30 ? "text-amber-500" : "text-blue-500")} />
            <span className="font-medium truncate flex-1">{r.title}</span>
            <span className={cn("text-[10px] shrink-0", r.days < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
              {r.days < 0 ? `expired ${-r.days}d ago` : `renews in ${r.days}d`}
            </span>
          </Link>
        ))}
        {destroying.map((r: any) => (
          <Link key={`d-${r.id}`} to="/legal/$matterId" params={{ matterId: r.id }} className="flex items-center gap-2 rounded-lg border border-red-200/50 dark:border-red-900 bg-red-50/30 dark:bg-red-950/10 px-2.5 py-1.5 text-[11px] hover:bg-red-50/60 transition-colors">
            <Trash2 className="size-3 shrink-0 text-red-500" />
            <span className="font-medium truncate flex-1">{r.title}</span>
            <span className="text-[10px] text-red-600 dark:text-red-400 shrink-0">retention ending — review for destruction</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// Knowledge base browser + seed — the source Route C answers from.
export function KnowledgeBasePanel() {
  const listKb = useServerFn(listKnowledgeBase);
  const seedKb = useServerFn(seedKnowledgeBase);
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const { data: entries = [] } = useQuery({
    queryKey: ["legal-kb"],
    queryFn: () => listKb(),
    staleTime: 60_000,
  });

  async function seed() {
    setSeeding(true);
    try {
      const r: any = await seedKb({});
      toast.success(r.inserted > 0 ? `Seeded ${r.inserted} knowledge base entries` : "Knowledge base already up to date");
      queryClient.invalidateQueries({ queryKey: ["legal-kb"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Seed failed");
    } finally {
      setSeeding(false);
    }
  }

  const shown = expanded ? entries : entries.slice(0, 6);

  return (
    <div className="rounded-xl border border-violet-200/50 dark:border-violet-900 bg-violet-50/30 dark:bg-violet-950/10 px-4 py-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <BookOpen className="size-3.5 text-violet-700 dark:text-violet-300" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">Legal Knowledge Base</span>
        <span className="text-[10px] text-violet-700/60 dark:text-violet-400/60">
          Route C answers from these positions · {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
        <Button
          size="sm" variant="outline"
          className="ml-auto h-7 text-[11px] gap-1.5 border-violet-300 text-violet-700 dark:text-violet-300 hover:bg-violet-100/50"
          disabled={seeding}
          onClick={seed}
        >
          {seeding ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          Seed starter KB
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Empty. Click <span className="font-medium">Seed starter KB</span> to load common Malaysian banking &amp; cross-industry legal positions, or publish takeaways from a completed Route D advisory.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((e: any) => (
            <span key={e.id} title={e.takeaways} className="inline-flex items-center rounded-lg border bg-card px-2.5 py-1 text-[11px] text-foreground/80 max-w-[280px] truncate">
              {e.title}
            </span>
          ))}
          {entries.length > 6 && (
            <button onClick={() => setExpanded((v) => !v)} className="text-[11px] text-violet-700 dark:text-violet-300 hover:underline px-1">
              {expanded ? "show less" : `+${entries.length - 6} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
