export function impactClasses(impact: string) {
  switch (impact) {
    case "high":
      return "bg-[oklch(0.95_0.06_25)] text-[oklch(0.4_0.18_25)] border-[oklch(0.85_0.12_25)]";
    case "medium":
      return "bg-[oklch(0.96_0.06_75)] text-[oklch(0.4_0.15_75)] border-[oklch(0.85_0.12_75)]";
    case "low":
      return "bg-[oklch(0.95_0.06_150)] text-[oklch(0.35_0.14_150)] border-[oklch(0.85_0.12_150)]";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function changeTypeMeta(type: string) {
  switch (type) {
    case "find_replace":
      return { label: "Find & Replace", classes: "bg-amber-100 text-amber-900 border-amber-300" };
    case "insertion":
      return { label: "Insertion", classes: "bg-blue-100 text-blue-900 border-blue-300" };
    case "full_rewrite":
      return { label: "Full Rewrite", classes: "bg-rose-100 text-rose-900 border-rose-300" };
    case "new_section":
      return { label: "New Section", classes: "bg-emerald-100 text-emerald-900 border-emerald-300" };
    case "contextual":
      return { label: "Contextual Update", classes: "bg-violet-100 text-violet-900 border-violet-300" };
    default:
      return { label: type, classes: "bg-muted text-muted-foreground border-border" };
  }
}

export function statusMeta(status: string) {
  switch (status) {
    case "approved":
      return { label: "Approved", classes: "bg-emerald-100 text-emerald-900 border-emerald-300", bg: "bg-emerald-100", text: "text-emerald-700" };
    case "rejected":
      return { label: "Rejected", classes: "bg-muted text-muted-foreground border-border", bg: "bg-muted", text: "text-muted-foreground" };
    case "routed":
      return { label: "Flagged for Legal", classes: "bg-amber-100 text-amber-900 border-amber-300", bg: "bg-amber-100", text: "text-amber-700" };
    case "pending_validation":
      return { label: "Pending Compliance Validation", classes: "bg-blue-100 text-blue-900 border-blue-300", bg: "bg-blue-100", text: "text-blue-700" };
    case "pending_legal":
      return { label: "Pending Legal Sign-Off", classes: "bg-violet-100 text-violet-900 border-violet-300", bg: "bg-violet-100", text: "text-violet-700" };
    case "signed_off":
      return { label: "Legal Signed-Off", classes: "bg-emerald-100 text-emerald-900 border-emerald-300", bg: "bg-emerald-100", text: "text-emerald-700" };
    case "published":
      return { label: "Published to KB", classes: "bg-emerald-200 text-emerald-900 border-emerald-400", bg: "bg-emerald-200", text: "text-emerald-800" };
    case "pending_manual":
      return { label: "Pending Manual Execution", classes: "bg-amber-100 text-amber-900 border-amber-300", bg: "bg-amber-100", text: "text-amber-700" };
    case "pending_review":
      return { label: "Pending Compliance Validation", classes: "bg-blue-100 text-blue-900 border-blue-300", bg: "bg-blue-100", text: "text-blue-700" };
    default:
      return { label: status || "Pending", classes: "bg-secondary text-secondary-foreground border-border", bg: "bg-secondary", text: "text-secondary-foreground" };
  }
}

export function formatDate(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
