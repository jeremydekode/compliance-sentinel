/**
 * Dashboard demo mocks — deterministic from report IDs so the same report
 * always shows the same priority + assignee + SLA.
 *
 * ⚠️ MOCK ONLY. When real assignment + SLA fields exist, replace the per-field
 * helpers below — the dashboard renders these without caring whether they
 * came from the DB or a mock.
 */

export type Priority = "critical" | "high" | "medium" | "low";
export type SlaStatus = "on_track" | "due_soon" | "overdue";

const COMPLIANCE_POOL = ["Sarah Tan", "Ahmad Razali", "Priya Krishnan", "Marcus Lim", "Nurul Aiman"];
const LEGAL_POOL = ["David Chen", "Aisha Mohamed", "Yusof Idris"];

/** SLA targets in calendar days, per priority band. */
export const SLA_DAYS: Record<Priority, number> = {
  critical: 5,
  high: 10,
  medium: 15,
  low: 30,
};

/** Stable, fast string hash → non-negative int. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Mock priority from a report ID. Weighted so most reports are medium/low —
 * realistic compliance workload distribution; critical is rare.
 */
export function mockPriority(reportId: string): Priority {
  const buckets: Priority[] = ["critical", "high", "medium", "low"];
  const weights = [1, 2, 4, 3]; // ratio of how often each shows up
  const total = weights.reduce((a, b) => a + b, 0);
  const v = hashId(reportId) % total;
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += weights[i];
    if (v < acc) return buckets[i];
  }
  return "medium";
}

/** Mock assignee. Approved-stage reports get a legal reviewer; others a compliance officer. */
export function mockAssignee(reportId: string, status: string | null): string {
  const pool = status === "approved" || status === "legal_review" ? LEGAL_POOL : COMPLIANCE_POOL;
  return pool[hashId(reportId + status) % pool.length];
}

/** Compute days open + days-to-SLA-target + bucketed SLA status. */
export function computeSlaStatus(
  createdAt: string,
  priority: Priority,
): { daysOpen: number; daysToTarget: number; status: SlaStatus } {
  const target = SLA_DAYS[priority];
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const daysOpen = Math.max(0, Math.floor((now - created) / 86_400_000));
  const daysToTarget = target - daysOpen;
  const status: SlaStatus =
    daysToTarget < 0 ? "overdue" : daysToTarget <= 3 ? "due_soon" : "on_track";
  return { daysOpen, daysToTarget, status };
}

/** Whether a report's lifecycle is still "open" (open = needs action). */
export function isOpen(status: string | null): boolean {
  return !(status === "approved" || status === "rejected" || status === "completed");
}

/** Priority badge styling. */
export function priorityClasses(p: Priority): string {
  switch (p) {
    case "critical":
      return "bg-rose-100 text-rose-800 border-rose-300";
    case "high":
      return "bg-orange-100 text-orange-800 border-orange-300";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "low":
      return "bg-slate-100 text-slate-700 border-slate-300";
  }
}

/** SLA badge styling. */
export function slaClasses(s: SlaStatus): string {
  switch (s) {
    case "overdue":
      return "bg-rose-100 text-rose-800";
    case "due_soon":
      return "bg-amber-100 text-amber-800";
    case "on_track":
      return "bg-emerald-100 text-emerald-800";
  }
}

export function slaLabel(s: SlaStatus): string {
  switch (s) {
    case "overdue":
      return "Overdue";
    case "due_soon":
      return "Due soon";
    case "on_track":
      return "On track";
  }
}

export function priorityLabel(p: Priority): string {
  return p[0].toUpperCase() + p.slice(1);
}

// ── Activity feed ─────────────────────────────────────────────────────

export type ActivityKind = "received" | "assigned" | "approved" | "legal_review" | "overdue_breach";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  kind: ActivityKind;
  reportId: string;
  reportTitle: string;
  detail: string;
  actor?: string;
}

/**
 * Build a feed from real reports + mocked lifecycle events (assignment,
 * SLA breach, hand-off to legal). Returns most recent first.
 */
export function generateActivityFeed(
  reports: Array<{ id: string; title: string | null; policy_name: string | null; status: string | null; created_at: string | null }>,
  limit = 15,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const now = Date.now();
  for (const r of reports) {
    if (!r.created_at) continue;
    const title = r.title ?? r.policy_name ?? "(untitled)";
    const priority = mockPriority(r.id);
    const compliance = mockAssignee(r.id, "pending_review");
    const legal = mockAssignee(r.id, "approved");
    const createdMs = new Date(r.created_at).getTime();

    // 1. Received
    events.push({
      id: `${r.id}_recv`,
      timestamp: r.created_at,
      kind: "received",
      reportId: r.id,
      reportTitle: title,
      detail: `${title} received · flagged ${priority.toUpperCase()}`,
    });
    // 2. Assigned (mocked 1h after intake)
    if (createdMs + 3_600_000 <= now) {
      events.push({
        id: `${r.id}_asgn`,
        timestamp: new Date(createdMs + 3_600_000).toISOString(),
        kind: "assigned",
        reportId: r.id,
        reportTitle: title,
        detail: `Routed to ${compliance} · Compliance Officer`,
        actor: compliance,
      });
    }
    // 3. SLA breach (if past target)
    const sla = computeSlaStatus(r.created_at, priority);
    if (sla.status === "overdue") {
      const breachTs = createdMs + SLA_DAYS[priority] * 86_400_000;
      if (breachTs <= now) {
        events.push({
          id: `${r.id}_brch`,
          timestamp: new Date(breachTs).toISOString(),
          kind: "overdue_breach",
          reportId: r.id,
          reportTitle: title,
          detail: `SLA breached · ${priority} target was ${SLA_DAYS[priority]} days`,
        });
      }
    }
    // 4. Compliance approved → routed to legal (mocked 2 days after intake if approved)
    if (r.status === "approved") {
      const apprTs = createdMs + 2 * 86_400_000;
      if (apprTs <= now) {
        events.push({
          id: `${r.id}_appr`,
          timestamp: new Date(apprTs).toISOString(),
          kind: "approved",
          reportId: r.id,
          reportTitle: title,
          detail: `Approved by ${compliance} · routed to ${legal} for legal sign-off`,
          actor: compliance,
        });
      }
    }
  }
  return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

// ── Chart data ────────────────────────────────────────────────────────

export interface TrendDay {
  date: string;        // ISO date (YYYY-MM-DD)
  label: string;       // "Mon 15"
  received: number;    // mocked baseline + real counts
  resolved: number;    // mocked
}

/**
 * 14-day activity trend. Layers a mocked baseline (week-cycled: weekends low,
 * mid-week high) under real report counts so the chart always looks populated
 * for demo even on sparse workspaces. Resolved is mocked (~65% of received,
 * offset by 2 days for realism).
 */
export function generateTrend(
  reports: Array<{ created_at: string | null; status: string | null }>,
  days = 14,
): TrendDay[] {
  const out: TrendDay[] = [];
  const now = Date.now();

  // Pre-build empty buckets per day
  const byDate = new Map<string, TrendDay>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    // Baseline activity — busier mid-week. Deterministic per date so it
    // doesn't shuffle on every refresh.
    const seed = (d.getDate() * 31 + d.getMonth() + 7) % 7;
    const base = isWeekend ? 1 : 3 + (seed % 3);   // 3-5 weekdays, 1 weekends
    const resolvedBase = Math.max(0, Math.round(base * 0.65) + (seed % 2 === 0 ? 1 : 0));
    const day: TrendDay = {
      date: iso,
      label: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }),
      received: base,
      resolved: resolvedBase,
    };
    byDate.set(iso, day);
    out.push(day);
  }

  // Layer real reports on top of the baseline
  for (const r of reports) {
    if (!r.created_at) continue;
    const createdIso = new Date(r.created_at).toISOString().slice(0, 10);
    const day = byDate.get(createdIso);
    if (day) day.received += 1;
    if (r.status === "approved") {
      const resolvedIso = new Date(new Date(r.created_at).getTime() + 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rDay = byDate.get(resolvedIso);
      if (rDay) rDay.resolved += 1;
    }
  }
  return out;
}

export interface DonutSlice {
  name: string;
  value: number;
  fill: string;
}

/** Priority distribution across open requests. */
export function priorityDistribution(
  openReports: Array<{ id: string }>,
): DonutSlice[] {
  const counts: Record<Priority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of openReports) counts[mockPriority(r.id)]++;
  return [
    { name: "Critical", value: counts.critical, fill: "#e11d48" }, // rose-600
    { name: "High", value: counts.high, fill: "#f97316" },         // orange-500
    { name: "Medium", value: counts.medium, fill: "#eab308" },     // yellow-500
    { name: "Low", value: counts.low, fill: "#64748b" },           // slate-500
  ];
}

/** SLA performance breakdown for open requests. */
export function slaDistribution(
  openReports: Array<{ id: string; created_at: string }>,
): DonutSlice[] {
  const counts: Record<SlaStatus, number> = { on_track: 0, due_soon: 0, overdue: 0 };
  for (const r of openReports) {
    const p = mockPriority(r.id);
    const s = computeSlaStatus(r.created_at, p);
    counts[s.status]++;
  }
  return [
    { name: "On track", value: counts.on_track, fill: "#10b981" }, // emerald-500
    { name: "Due soon", value: counts.due_soon, fill: "#f59e0b" }, // amber-500
    { name: "Overdue", value: counts.overdue, fill: "#e11d48" },   // rose-600
  ];
}

/** "3 hr ago" / "2 days ago" — for the activity feed. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  if (d < 30) return `${Math.floor(d / 7)} wk ago`;
  return new Date(iso).toLocaleDateString();
}
