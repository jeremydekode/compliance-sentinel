import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useRef } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import {
  getLegalMatter,
  assignLegalMatter,
  advanceLegalMatterStatus,
  addLegalComment,
  archiveLegalMatter,
  escalateLegalMatter,
  attachLegalDocument,
  reviewLegalDocument,
  setDocumentAccess,
  deleteLegalDocument,
  generateProposedResponse,
  referToGeneralCounsel,
  tagFunctions,
  publishToKnowledgeBase,
  setMatterLifecycle,
  updateExecSummary,
  approvalTierFor,
  MATTER_TYPES,
  ROUTE_META,
  STATUS_META,
} from "@/lib/legal.functions";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft,
  Scale,
  Sparkles,
  Bot,
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  Archive,
  UserCheck,
  Clock,
  Send,
  MessageSquare,
  FileText,
  Loader2,
  RotateCcw,
  Vault,
  ClipboardCheck,
  Landmark,
  Paperclip,
  Download,
  ChevronDown,
  FileSearch,
  Lock,
  Unlock,
  Trash2,
  BookOpen,
  Users,
  ArrowUpCircle,
  Share2,
  CalendarClock,
  Pencil,
  Check,
  ShieldQuestion,
} from "lucide-react";

export const Route = createFileRoute("/legal/$matterId")({
  component: LegalMatterDetail,
  head: () => ({ meta: [{ title: "Matter · Legal CMS" }] }),
});

// 6-step lifecycle from the workflow deck:
// 1 Intake → 2 AI Triage → 3 Assignment → 4 Review → 5 Approval → 6 Vault
const STEPS = [
  { n: 1, label: "Intake" },
  { n: 2, label: "AI Triage" },
  { n: 3, label: "Assignment" },
  { n: 4, label: "Review" },
  { n: 5, label: "Approval" },
  { n: 6, label: "Repository" },
];

// Which step is currently ACTIVE for each status (7 = all complete).
const CURRENT_STEP: Record<string, number> = {
  draft: 1,
  triage: 2,
  pending_assignment: 3,
  assigned: 3,
  in_review: 4,
  pending_approval: 5,
  rejected: 5,
  approved: 6,
  archived: 7,
};

function Stepper({ status, route }: { status: string; route: string | null }) {
  const cur = CURRENT_STEP[status] ?? 1;
  const rejected = status === "rejected";
  // Routes A & C skip human assignment — the AI handles it, so step 3 shows as auto.
  const skipsAssignment = route === "A" || route === "C";

  return (
    <div className="flex items-center gap-0">
      {STEPS.map((s, i) => {
        const complete = s.n < cur;
        const active = s.n === cur;
        const isRejectedStep = rejected && active;
        const auto = skipsAssignment && s.n === 3;
        return (
          <div key={s.n} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1 shrink-0">
              <div
                className={cn(
                  "size-6 rounded-full grid place-items-center text-[10px] font-bold transition-colors ring-1",
                  isRejectedStep
                    ? "bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-300"
                    : complete
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : active
                    ? "bg-indigo-50 text-indigo-700 ring-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-300"
                    : "bg-muted text-muted-foreground/60 ring-border"
                )}
              >
                {isRejectedStep ? (
                  <XCircle className="size-3.5" />
                ) : complete ? (
                  <CheckCircle2 className="size-3.5" />
                ) : (
                  s.n
                )}
              </div>
              <span
                className={cn(
                  "text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap",
                  isRejectedStep ? "text-red-600 dark:text-red-400"
                    : complete || active ? "text-foreground" : "text-muted-foreground/50"
                )}
              >
                {s.label}
                {auto && <span className="ml-0.5 text-indigo-500 normal-case font-normal">· AI</span>}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 mx-1.5 mb-4",
                  s.n < cur ? "bg-indigo-400" : "bg-border"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function severityMeta(sev: string) {
  if (sev === "high")   return { icon: ShieldAlert,    cls: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 ring-red-200/60 dark:ring-red-900" };
  if (sev === "medium") return { icon: AlertTriangle,  cls: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 ring-amber-200/60 dark:ring-amber-900" };
  return { icon: Info, cls: "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 ring-blue-200/60 dark:ring-blue-900" };
}

function LegalMatterDetail() {
  const { matterId } = Route.useParams();
  const queryClient = useQueryClient();
  const getFn = useServerFn(getLegalMatter);
  const assignFn = useServerFn(assignLegalMatter);
  const advanceFn = useServerFn(advanceLegalMatterStatus);
  const commentFn = useServerFn(addLegalComment);
  const archiveFn = useServerFn(archiveLegalMatter);
  const escalateFn = useServerFn(escalateLegalMatter);
  const attachFn = useServerFn(attachLegalDocument);
  const reviewFn = useServerFn(reviewLegalDocument);

  const { data, isLoading } = useQuery({
    queryKey: ["legal-matter", matterId],
    queryFn: () => getFn({ data: { id: matterId } }),
  });

  const [assignName, setAssignName] = useState("");
  const [assignEmail, setAssignEmail] = useState("");
  const [actionNotes, setActionNotes] = useState("");
  const [newComment, setNewComment] = useState("");

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["legal-matter", matterId] });
    queryClient.invalidateQueries({ queryKey: ["legal-matters"] });
  }

  const assign = useMutation({
    mutationFn: () => assignFn({ data: {
      matter_id: matterId,
      assigned_to_name: assignName.trim(),
      assigned_to_email: assignEmail.trim() || undefined,
      notes: actionNotes.trim() || undefined,
    }}),
    onSuccess: () => { toast.success(`Assigned to ${assignName}`); setAssignName(""); setAssignEmail(""); setActionNotes(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Assignment failed"),
  });

  const advance = useMutation({
    mutationFn: (p: { status: string; notes?: string }) =>
      advanceFn({ data: { matter_id: matterId, new_status: p.status as any, notes: p.notes } }),
    onSuccess: (_r, p) => {
      const labels: Record<string, string> = {
        in_review: "Review started",
        pending_approval: "Sent for approval — AI executive summary generated",
        approved: "Matter approved",
        rejected: "Matter rejected",
      };
      toast.success(labels[p.status] ?? "Status updated");
      setActionNotes("");
      refresh();
    },
    onError: (e: any) => toast.error(e?.message ?? "Update failed"),
  });

  const archive = useMutation({
    mutationFn: () => archiveFn({ data: { matter_id: matterId } }),
    onSuccess: () => { toast.success("Archived to the vault"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Archive failed"),
  });

  const escalate = useMutation({
    mutationFn: (reason?: string) => escalateFn({ data: { matter_id: matterId, reason } }),
    onSuccess: () => { toast.success("Escalated to counsel — now in the assignment queue"); setActionNotes(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Escalation failed"),
  });

  const comment = useMutation({
    mutationFn: (fnTag?: string) => commentFn({ data: { matter_id: matterId, content: newComment.trim(), comment_type: "comment", function_tag: fnTag } }),
    onSuccess: () => { setNewComment(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Comment failed"),
  });

  // Cluster 2/3/4 server fns
  const proposeFn = useServerFn(generateProposedResponse);
  const referFn = useServerFn(referToGeneralCounsel);
  const tagFn = useServerFn(tagFunctions);
  const publishFn = useServerFn(publishToKnowledgeBase);
  const lifecycleFn = useServerFn(setMatterLifecycle);
  const execFn = useServerFn(updateExecSummary);
  const docAccessFn = useServerFn(setDocumentAccess);

  const propose = useMutation({
    mutationFn: () => proposeFn({ data: { matter_id: matterId } }),
    onSuccess: () => { toast.success("AI proposed response drafted"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Draft failed"),
  });
  const refer = useMutation({
    mutationFn: (note?: string) => referFn({ data: { matter_id: matterId, note } }),
    onSuccess: () => { toast.success("Referred to General Counsel"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Referral failed"),
  });
  const tag = useMutation({
    mutationFn: (fns: string[]) => tagFn({ data: { matter_id: matterId, functions: fns } }),
    onSuccess: () => { toast.success("Function looped in"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Tag failed"),
  });
  const publish = useMutation({
    mutationFn: (p: { title: string; takeaways: string }) => publishFn({ data: { matter_id: matterId, ...p } }),
    onSuccess: () => { toast.success("Published to the legal knowledge base"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Publish failed"),
  });
  const lifecycle = useMutation({
    mutationFn: (p: { expiry_date?: string; retention_years?: number }) => lifecycleFn({ data: { matter_id: matterId, ...p } }),
    onSuccess: () => { toast.success("Lifecycle updated"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Update failed"),
  });
  const saveExec = useMutation({
    mutationFn: (summary: string) => execFn({ data: { matter_id: matterId, summary } }),
    onSuccess: () => { toast.success("Executive summary saved"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });
  const setDocAccess = useMutation({
    mutationFn: (p: { document_id: string; access_level: "standard" | "restricted" }) => docAccessFn({ data: p }),
    onSuccess: () => { toast.success("Document access updated"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const deleteDocFn = useServerFn(deleteLegalDocument);
  const deleteDoc = useMutation({
    mutationFn: (document_id: string) => deleteDocFn({ data: { document_id } }),
    onSuccess: () => { toast.success("Document deleted"); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });

  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [reviewingDocId, setReviewingDocId] = useState<string | null>(null);

  async function uploadDocument(file: File) {
    setUploadingDoc(true);
    try {
      const path = `legal/${Date.now()}-${file.name}`;
      const up = await supabase.storage.from("policies").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) throw new Error(up.error.message);
      const fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
      const doc: any = await attachFn({
        data: {
          matter_id: matterId,
          file_name: file.name,
          file_url: fileUrl,
          mime_type: file.type || undefined,
          size_bytes: file.size,
          doc_role: "submitted",
        },
      });
      refresh();
      // Kick off the AI first cut immediately
      setReviewingDocId(doc.id);
      try {
        await reviewFn({ data: { document_id: doc.id } });
        toast.success(`AI first-cut review of ${file.name} complete`);
      } catch (e: any) {
        toast.warning(`AI review failed — you can re-run it: ${e?.message ?? ""}`);
      } finally {
        setReviewingDocId(null);
        refresh();
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed");
    } finally {
      setUploadingDoc(false);
    }
  }

  async function rerunReview(docId: string) {
    setReviewingDocId(docId);
    try {
      await reviewFn({ data: { document_id: docId } });
      toast.success("AI review complete");
    } catch (e: any) {
      toast.error(e?.message ?? "AI review failed");
    } finally {
      setReviewingDocId(null);
      refresh();
    }
  }

  if (isLoading || !data) {
    return (
      <AppShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  const m: any = data.matter;
  const events: any[] = data.events ?? [];
  const comments: any[] = data.comments ?? [];
  const documents: any[] = (data as any).documents ?? [];
  const riskFlags: any[] = Array.isArray(m.ai_risk_flags) ? m.ai_risk_flags : [];
  const screening = m.ai_screening && m.ai_screening.status === "flags" ? m.ai_screening.flags ?? [] : [];
  const taggedFunctions: string[] = Array.isArray(m.tagged_functions) ? m.tagged_functions : [];
  const routeMeta = m.route ? ROUTE_META[m.route] : null;
  const typeLabel = MATTER_TYPES.find((t) => t.value === m.matter_type)?.label ?? m.matter_type;
  const busy = assign.isPending || advance.isPending || archive.isPending;
  const isRouteD = m.route === "D";
  const terminal = m.status === "approved" || m.status === "archived";

  return (
    <AppShell>
      <div className="flex flex-col min-h-screen">
        {/* Compact header */}
        <div className="border-b bg-background/95 px-6 py-2.5 sticky top-0 z-10 backdrop-blur">
          <div className="flex items-center gap-2.5 flex-wrap">
            <Link
              to="/legal"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft className="size-3" /> Legal CMS
            </Link>
            <span className="text-muted-foreground/30">/</span>
            <span className="font-mono text-[10px] text-muted-foreground">{m.reference_number}</span>
            <h1 className="text-sm font-bold truncate">{m.title}</h1>
            <div className="flex items-center gap-1.5 ml-auto shrink-0">
              {m.is_material && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 ring-1 ring-amber-200/60">
                  <Landmark className="size-2.5" /> Material
                </span>
              )}
              {routeMeta && (
                <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-foreground/70 ring-1 ring-border" title={m.ai_route_reasoning ?? ""}>
                  Route {m.route} · {routeMeta.description}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stepper strip — full 6-step path for B/D; A/C bypass it, so show a
            compact "resolved at intake" banner instead of a misleading stepper. */}
        <div className="border-b bg-muted/20 px-6 py-3">
          {(m.route === "A" || m.route === "C") && (m.status === "resolved") ? (
            <div className="max-w-3xl flex items-center gap-2.5 text-xs">
              <div className="size-6 rounded-full bg-emerald-100 dark:bg-emerald-900/40 grid place-items-center ring-1 ring-emerald-300 shrink-0">
                <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                {m.route === "A" ? "Self-served at intake" : "Resolved autonomously by AI at intake"}
              </span>
              <span className="text-muted-foreground">
                · bypassed triage, assignment, review &amp; approval{m.route === "C" ? " — escalate below if this needs a lawyer" : ""}
              </span>
            </div>
          ) : (
            <div className="max-w-3xl">
              <Stepper status={m.status} route={m.route} />
            </div>
          )}
        </div>

        <div className="flex-1 p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
            {/* ============ MAIN COLUMN ============ */}
            <div className="lg:col-span-2 space-y-4">
              {/* Intake AI screening discrepancies */}
              {screening.length > 0 && (
                <div className="rounded-xl border border-amber-300/60 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-200/40 dark:border-amber-900/60">
                    <ShieldQuestion className="size-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                      Intake Screening — {screening.length} discrepancy{screening.length !== 1 ? " flags" : " flag"}
                    </span>
                  </div>
                  <div className="p-4 space-y-1.5">
                    {screening.map((f: any, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <AlertTriangle className="size-3 text-amber-500 shrink-0 mt-0.5" />
                        <span className="text-foreground/85">{f.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI triage */}
              {(m.ai_triage_summary || riskFlags.length > 0) && (
                <div className="rounded-xl border border-violet-200/60 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-violet-200/40 dark:border-violet-900/60">
                    <Bot className="size-3.5 text-violet-600 dark:text-violet-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">
                      AI Triage — First Cut
                    </span>
                    <span className="text-[10px] text-violet-600/60 dark:text-violet-400/60 ml-auto">
                      generated before a lawyer opened the file
                    </span>
                  </div>
                  <div className="p-4 space-y-3">
                    {m.ai_triage_summary && (
                      <p className="text-xs leading-relaxed text-foreground/90">{m.ai_triage_summary}</p>
                    )}
                    {riskFlags.length > 0 && (
                      <div className="space-y-1.5">
                        {riskFlags.map((f: any, i: number) => {
                          const sev = severityMeta(f.severity);
                          return (
                            <div key={i} className={cn("rounded-lg px-3 py-2 ring-1 flex items-start gap-2.5", sev.cls)}>
                              <sev.icon className="size-3.5 shrink-0 mt-0.5" />
                              <div className="min-w-0 text-xs">
                                <div className="font-semibold">{f.flag}</div>
                                {f.recommendation && (
                                  <div className="text-[11px] opacity-80 mt-0.5">{f.recommendation}</div>
                                )}
                              </div>
                              <span className="ml-auto text-[9px] font-bold uppercase tracking-wider opacity-60 shrink-0">{f.severity}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Documents + AI clause review */}
              <DocumentsCard
                documents={documents}
                uploading={uploadingDoc}
                reviewingDocId={reviewingDocId}
                onUpload={uploadDocument}
                onRerun={rerunReview}
                onSetAccess={(document_id, access_level) => setDocAccess.mutate({ document_id, access_level })}
                onDelete={(document_id) => deleteDoc.mutate(document_id)}
                deletingDocId={deleteDoc.isPending ? (deleteDoc.variables as string) : null}
              />

              {/* AI advisory response (Route C answer, or Route D proposed response) */}
              {(m.ai_response || (isRouteD && (m.status === "in_review" || m.status === "assigned"))) && (
                <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-emerald-200/40 dark:border-emerald-900/60">
                    <Sparkles className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                      {isRouteD ? "AI Proposed Response — for Legal Manager" : "AI Advisory Response"}
                    </span>
                    <span className="text-[10px] text-emerald-600/60 dark:text-emerald-400/60 ml-auto">
                      {isRouteD ? "drawn from policies, playbooks & precedents" : "Route C · answered from playbooks"}
                    </span>
                  </div>
                  {m.ai_response ? (
                    <div className="p-4 space-y-2">
                      <div className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">{m.ai_response}</div>
                      {isRouteD && (
                        <button
                          onClick={() => propose.mutate()}
                          disabled={propose.isPending}
                          className="text-[11px] text-emerald-700 dark:text-emerald-300 hover:underline inline-flex items-center gap-1"
                        >
                          {propose.isPending ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Regenerate
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="p-4">
                      <p className="text-[11px] text-muted-foreground mb-2">
                        Draft an AI-proposed advisory response from the policy library, published KB, and historical precedents for your review.
                      </p>
                      <Button size="sm" className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700" disabled={propose.isPending} onClick={() => propose.mutate()}>
                        {propose.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Generate proposed response
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Editable executive summary for approvers */}
              {m.ai_executive_summary && (
                <ExecSummaryPanel
                  summary={m.ai_executive_summary}
                  editable={m.status === "pending_approval" || m.status === "in_review"}
                  saving={saveExec.isPending}
                  onSave={(s) => saveExec.mutate(s)}
                />
              )}

              {/* Route D advisory tools */}
              {isRouteD && (m.status === "in_review" || m.status === "assigned" || m.status === "pending_approval") && (
                <RouteDToolbar
                  m={m}
                  taggedFunctions={taggedFunctions}
                  onRefer={(note) => refer.mutate(note)}
                  onTag={(fns) => tag.mutate(fns)}
                  referBusy={refer.isPending}
                  tagBusy={tag.isPending}
                />
              )}

              {/* Publish to Knowledge Base — only after GC sign-off (approved) */}
              {isRouteD && m.ai_response && m.status === "approved" && (
                <PublishKbPanel saving={publish.isPending} onPublish={(p) => publish.mutate(p)} />
              )}

              {/* Request description */}
              <div className="rounded-xl border bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                  <FileText className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Request</span>
                  <span className="text-[10px] text-muted-foreground/60 ml-auto">{typeLabel}</span>
                </div>
                <div className="p-4 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {m.description}
                </div>
              </div>

              {/* In-matter chat — isolated to this matter, supports @-tagging */}
              <MatterChat
                comments={comments}
                value={newComment}
                setValue={setNewComment}
                posting={comment.isPending}
                onPost={(fnTag) => comment.mutate(fnTag)}
              />
            </div>

            {/* ============ SIDEBAR ============ */}
            <div className="space-y-4">
              {/* Action panel */}
              <ActionPanel
                m={m}
                busy={busy}
                assignName={assignName} setAssignName={setAssignName}
                assignEmail={assignEmail} setAssignEmail={setAssignEmail}
                actionNotes={actionNotes} setActionNotes={setActionNotes}
                onAssign={() => assign.mutate()}
                onAdvance={(status, notes) => advance.mutate({ status, notes })}
                onArchive={() => archive.mutate()}
                onEscalate={(reason) => escalate.mutate(reason)}
              />

              {/* Details */}
              <div className="rounded-xl border bg-card p-4 space-y-2.5 text-xs">
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Details</div>
                <DetailRow label="Status" value={STATUS_META[m.status]?.label ?? m.status} />
                <DetailRow label="Type" value={typeLabel} />
                <DetailRow label="Priority" value={m.priority} cap />
                <DetailRow label="Requestor" value={m.requestor_name ?? "—"} sub={m.requestor_email} />
                <DetailRow label="Assigned to" value={m.assigned_to_name ?? "Unassigned"} sub={m.assigned_to_email} />
                {m.due_date && <DetailRow label="Needed by" value={format(new Date(m.due_date), "d MMM yyyy")} />}
                <DetailRow label="Submitted" value={m.created_at ? format(new Date(m.created_at), "d MMM yyyy, HH:mm") : "—"} />
                {m.contract_value != null && <DetailRow label="Contract value" value={Number(m.contract_value).toLocaleString()} />}
                {m.approved_at && <DetailRow label="Approved" value={format(new Date(m.approved_at), "d MMM yyyy, HH:mm")} sub={m.approved_by_name} />}
                {m.referred_to_gc && <DetailRow label="Referred" value="To General Counsel" />}
                {taggedFunctions.length > 0 && <DetailRow label="Looped in" value={taggedFunctions.join(", ")} />}
                {m.ai_route_reasoning && (
                  <div className="pt-1.5 border-t">
                    <div className="text-[10px] text-muted-foreground/70 flex items-start gap-1.5 leading-relaxed">
                      <Bot className="size-3 shrink-0 mt-0.5" />
                      <span><span className="font-semibold">AI routing:</span> {m.ai_route_reasoning}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Lifecycle — expiry / renewal / retention (Step 6) */}
              {terminal && (
                <LifecyclePanel m={m} saving={lifecycle.isPending} onSave={(p) => lifecycle.mutate(p)} />
              )}

              {/* Audit trail */}
              <div className="rounded-xl border bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                  <Clock className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Audit Trail</span>
                  <span className="text-[10px] text-muted-foreground/50 ml-auto">unalterable</span>
                </div>
                <div className="p-4">
                  <div className="space-y-0 relative">
                    <div className="absolute left-[5px] top-1 bottom-1 w-px bg-border" />
                    {events.map((ev: any) => (
                      <div key={ev.id} className="relative pl-5 pb-3 last:pb-0">
                        <div className="absolute left-0 top-1 size-2.5 rounded-full bg-indigo-100 dark:bg-indigo-900 ring-2 ring-background border border-indigo-400" />
                        <div className="text-[11px] font-medium leading-tight">
                          {eventLabel(ev)}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {ev.actor_name ?? "System"} · {ev.created_at ? format(new Date(ev.created_at), "d MMM, HH:mm") : ""}
                        </div>
                      </div>
                    ))}
                    {events.length === 0 && (
                      <p className="text-xs text-muted-foreground/60 italic">No events recorded.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function eventLabel(ev: any): string {
  switch (ev.event_type) {
    case "created":          return `Matter submitted${ev.payload?.route ? ` — AI routed to Route ${ev.payload.route}` : ""}`;
    case "triage_completed": return `AI triage completed${typeof ev.payload?.riskCount === "number" ? ` — ${ev.payload.riskCount} risk flag${ev.payload.riskCount !== 1 ? "s" : ""}` : ""}`;
    case "assigned":         return `Assigned to ${ev.payload?.assigned_to ?? "counsel"}`;
    case "escalated":        return `Escalated to human review — re-routed to Route ${ev.payload?.route ?? "D"}`;
    case "document_uploaded":return `Document uploaded: ${ev.payload?.file_name ?? "file"}`;
    case "ai_review_completed": return `AI first-cut review — ${ev.payload?.verdict === "red_flag" ? "red flags found" : ev.payload?.verdict === "caution" ? "cautions raised" : "compliant"}`;
    case "suggestion_accepted": return `AI suggested edit applied — ${ev.payload?.ref ?? "clause"}`;
    case "version_created":     return `Amended version v${ev.payload?.version ?? "?"} created — ${ev.payload?.applied ?? 0} change${ev.payload?.applied === 1 ? "" : "s"} applied`;
    case "document_deleted":    return `Document deleted${ev.payload?.file_name ? ` — ${ev.payload.file_name}` : ""}`;
    case "ai_response_generated": return "AI proposed response drafted";
    case "referred_to_gc":   return "Referred to General Counsel for validation";
    case "functions_tagged": return `Looped in: ${(ev.payload?.functions ?? []).join(", ")}`;
    case "kb_published":     return `Published to knowledge base: ${ev.payload?.title ?? ""}`;
    case "shared_external":  return `Sent to counterparty (${ev.payload?.recipient ?? ""})`;
    case "share_downloaded": return "Counterparty opened the shared package";
    case "status_changed":   return `${STATUS_META[ev.from_status]?.label ?? ev.from_status ?? ""} → ${STATUS_META[ev.to_status]?.label ?? ev.to_status}`;
    case "archived":         return "Archived to the vault";
    default:                 return ev.event_type;
  }
}

function DetailRow({ label, value, sub, cap }: { label: string; value: string; sub?: string | null; cap?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground/70 shrink-0">{label}</span>
      <span className="text-right min-w-0">
        <span className={cn("font-medium block truncate", cap && "capitalize")}>{value}</span>
        {sub && <span className="text-[10px] text-muted-foreground/60 block truncate">{sub}</span>}
      </span>
    </div>
  );
}

function ActionPanel(props: {
  m: any;
  busy: boolean;
  assignName: string; setAssignName: (v: string) => void;
  assignEmail: string; setAssignEmail: (v: string) => void;
  actionNotes: string; setActionNotes: (v: string) => void;
  onAssign: () => void;
  onAdvance: (status: string, notes?: string) => void;
  onArchive: () => void;
  onEscalate: (reason?: string) => void;
}) {
  const { m, busy, assignName, setAssignName, assignEmail, setAssignEmail, actionNotes, setActionNotes } = props;

  const notesBox = (placeholder: string) => (
    <textarea
      value={actionNotes}
      onChange={(e) => setActionNotes(e.target.value)}
      rows={2}
      placeholder={placeholder}
      className="w-full rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
    />
  );

  const spinner = busy && <Loader2 className="size-3 animate-spin" />;

  let body: React.ReactNode = null;
  let title = "Next Action";

  switch (m.status) {
    case "resolved":
      title = m.route === "A" ? "Self-Served" : "Resolved by AI";
      body = (
        <>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {m.route === "A"
              ? "This standard request was self-served at intake. If the standard form needs a deviation, send it for bespoke legal review."
              : "The AI answered this simple advisory from the playbooks. If the answer isn't sufficient, escalate it to human counsel."}
          </p>
          {notesBox(m.route === "A" ? "What needs changing from the standard form? (optional)" : "Why does this need a lawyer? (optional)")}
          <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={() => props.onEscalate(actionNotes.trim() || undefined)}>
            {spinner || <UserCheck className="size-3.5" />} {m.route === "A" ? "Send for Legal Review" : "Escalate to Counsel"}
          </Button>
          <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={props.onArchive}>
            {spinner || <Archive className="size-3.5" />} File to Repository
          </Button>
        </>
      );
      break;

    case "pending_assignment":
      title = "Step 3 · Assignment";
      body = (
        <>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Chain-of-command: only the General Counsel / Legal Head assigns matters to the team.
          </p>
          <input
            value={assignName}
            onChange={(e) => setAssignName(e.target.value)}
            placeholder="Counsel name — e.g. Sarah Lim"
            className="w-full rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          <input
            value={assignEmail}
            onChange={(e) => setAssignEmail(e.target.value)}
            placeholder="Counsel email (optional)"
            className="w-full rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          {notesBox("Assignment notes (optional)…")}
          <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={!assignName.trim() || busy} onClick={props.onAssign}>
            {spinner || <UserCheck className="size-3.5" />} Assign Matter
          </Button>
        </>
      );
      break;

    case "assigned":
      title = "Step 4 · Review";
      body = (
        <>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Assigned to <span className="font-semibold text-foreground">{m.assigned_to_name}</span>. Start the enhanced review when ready.
          </p>
          <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={() => props.onAdvance("in_review")}>
            {spinner || <FileText className="size-3.5" />} Start Review
          </Button>
        </>
      );
      break;

    case "in_review":
      title = "Step 4 · In Review";
      body = (
        <>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            When the review is complete, send it up for e-approval — the AI drafts an executive summary for the approver automatically.
          </p>
          {notesBox("Review notes (optional)…")}
          <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={() => props.onAdvance("pending_approval", actionNotes.trim() || undefined)}>
            {spinner || <Send className="size-3.5" />} Submit for Approval
          </Button>
          <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 text-red-600 hover:text-red-700" disabled={busy} onClick={() => props.onAdvance("rejected", actionNotes.trim() || undefined)}>
            <XCircle className="size-3.5" /> Reject / Return
          </Button>
        </>
      );
      break;

    case "pending_approval": {
      title = "Step 5 · e-Approval";
      const tier = approvalTierFor(m.contract_value, m.is_material);
      body = (
        <>
          <div className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] flex items-center gap-2">
            <UserCheck className="size-3.5 shrink-0 text-muted-foreground" />
            <span>
              Threshold requires: <span className="font-semibold">{tier.label}</span>
              {m.contract_value != null && <span className="text-muted-foreground"> · value {Number(m.contract_value).toLocaleString()}</span>}
            </span>
          </div>
          {tier.material && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-900 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <Landmark className="size-3.5 shrink-0 mt-0.5" />
              <span><span className="font-bold">Material contract exception</span> — on approval this matter routes to executive / group-level approval.</span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Review the AI executive summary, then approve or reject with mandatory rationale.
          </p>
          {notesBox("Approval note / rejection rationale…")}
          <Button size="sm" className="w-full h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => props.onAdvance("approved", actionNotes.trim() || undefined)}>
            {spinner || <CheckCircle2 className="size-3.5" />} Approve
          </Button>
          <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 text-red-600 hover:text-red-700" disabled={busy || !actionNotes.trim()} onClick={() => props.onAdvance("rejected", actionNotes.trim())}>
            <XCircle className="size-3.5" /> Reject (rationale required)
          </Button>
        </>
      );
      break;
    }

    case "approved":
      title = "Step 6 · Vault";
      body = (
        <>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Approved{m.approved_by_name ? <> by <span className="font-semibold text-foreground">{m.approved_by_name}</span></> : null}. Archive the executed matter into the access-controlled repository.
          </p>
          <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={props.onArchive}>
            {spinner || <Archive className="size-3.5" />} Archive to Repository
          </Button>
        </>
      );
      break;

    case "rejected":
      title = "Rejected";
      body = (
        <>
          {m.rejection_reason && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200/60 dark:ring-red-900 px-3 py-2 text-[11px] text-red-800 dark:text-red-300">
              <span className="font-bold">Rationale:</span> {m.rejection_reason}
            </div>
          )}
          <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5" disabled={busy} onClick={() => props.onAdvance("in_review")}>
            {spinner || <RotateCcw className="size-3.5" />} Reopen for Review
          </Button>
        </>
      );
      break;

    case "archived":
      title = "Step 6 · In the Repository";
      body = (
        <div className="flex items-start gap-2.5 text-[11px] text-muted-foreground leading-relaxed">
          <Vault className="size-4 shrink-0 text-indigo-500 mt-0.5" />
          <span>
            This matter is archived in the central repository — word-searchable,
            access-controlled, with the full audit trail preserved.
          </span>
        </div>
      );
      break;

    default:
      body = <p className="text-xs text-muted-foreground italic">No action required.</p>;
  }

  return (
    <div className="rounded-xl border-2 border-indigo-200/60 dark:border-indigo-900 bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-indigo-50/50 dark:bg-indigo-950/30">
        <Scale className="size-3.5 text-indigo-600 dark:text-indigo-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">{title}</span>
      </div>
      <div className="p-4 space-y-2.5">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents + AI clause-by-clause review (the co-pilot sidebar from the deck)
// ---------------------------------------------------------------------------

function formatBytes(n?: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const CLAUSE_SEVERITY: Record<string, { label: string; icon: React.ElementType; cls: string; chip: string }> = {
  red_flag: {
    label: "Red flag",
    icon: ShieldAlert,
    cls: "border-red-200/70 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20",
    chip: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
  caution: {
    label: "Caution",
    icon: AlertTriangle,
    cls: "border-amber-200/70 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20",
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  compliant: {
    label: "Compliant",
    icon: CheckCircle2,
    cls: "border-emerald-200/70 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
};

function reviewCounts(review: any): { red_flag: number; caution: number; compliant: number } {
  const counts = { red_flag: 0, caution: 0, compliant: 0 };
  for (const c of review?.clauses ?? []) {
    if (c.severity in counts) counts[c.severity as keyof typeof counts]++;
  }
  return counts;
}

function DocumentsCard({
  documents,
  uploading,
  reviewingDocId,
  onUpload,
  onRerun,
  onSetAccess,
  onDelete,
  deletingDocId,
}: {
  documents: any[];
  uploading: boolean;
  reviewingDocId: string | null;
  onUpload: (f: File) => void;
  onRerun: (docId: string) => void;
  onSetAccess: (documentId: string, level: "standard" | "restricted") => void;
  onDelete: (documentId: string) => void;
  deletingDocId: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Highest version per version-group (root = parent_document_id ?? id), to badge "Latest".
  const latestByGroup = new Map<string, number>();
  for (const d of documents) {
    const root = d.parent_document_id ?? d.id;
    latestByGroup.set(root, Math.max(latestByGroup.get(root) ?? 1, Number(d.version) || 1));
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <FileSearch className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Documents</span>
        <span className="text-[10px] text-muted-foreground/60">· AI first cut on every upload</span>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 text-[11px] gap-1.5 px-2"
          disabled={uploading || !!reviewingDocId}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
          Upload
        </Button>
      </div>

      {documents.length === 0 && !uploading ? (
        <p className="px-4 py-4 text-xs text-muted-foreground/60 italic">
          No documents yet — attach the contract or supporting files to get the AI clause-by-clause first cut.
        </p>
      ) : (
        <div className="divide-y">
          {documents.map((d: any) => {
            const review = d.ai_review;
            const counts = review ? reviewCounts(review) : null;
            const reviewing = reviewingDocId === d.id;
            const open = openDocId === d.id;
            const verdict = review?.verdict && CLAUSE_SEVERITY[review.verdict];
            return (
              <div key={d.id}>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <FileText className="size-3.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{d.file_name}</span>
                      {/* Version tag: Original (v1) vs amended versions; Latest badge on the newest */}
                      {(d.parent_document_id == null && (Number(d.version) || 1) === 1) ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Original</span>
                      ) : (
                        <span className="shrink-0 rounded bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">v{d.version}</span>
                      )}
                      {(Number(d.version) || 1) === latestByGroup.get(d.parent_document_id ?? d.id) && latestByGroup.get(d.parent_document_id ?? d.id)! > 1 && (
                        <span className="shrink-0 rounded bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Latest</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatBytes(d.size_bytes)}{d.size_bytes ? " · " : ""}{d.doc_role}
                      {d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ""}
                      {d.version_note ? ` · ${d.version_note}` : ""}
                    </div>
                  </div>

                  {/* Review status */}
                  {reviewing || d.ai_review_status === "running" ? (
                    <span className="inline-flex items-center gap-1.5 text-[10px] text-violet-600 dark:text-violet-400 font-medium shrink-0">
                      <Loader2 className="size-3 animate-spin" /> AI reviewing…
                    </span>
                  ) : review && counts ? (
                    <button
                      onClick={() => setOpenDocId(open ? null : d.id)}
                      className="inline-flex items-center gap-1.5 shrink-0 group"
                      title="View AI clause review"
                    >
                      {counts.red_flag > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">
                          <ShieldAlert className="size-2.5" /> {counts.red_flag}
                        </span>
                      )}
                      {counts.caution > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="size-2.5" /> {counts.caution}
                        </span>
                      )}
                      {counts.compliant > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="size-2.5" /> {counts.compliant}
                        </span>
                      )}
                      <ChevronDown className={cn("size-3.5 text-muted-foreground group-hover:text-foreground transition-transform", open && "rotate-180")} />
                    </button>
                  ) : d.ai_review_status === "failed" ? (
                    <button
                      onClick={() => onRerun(d.id)}
                      className="text-[10px] text-red-600 dark:text-red-400 font-medium hover:underline shrink-0"
                    >
                      Review failed — retry
                    </button>
                  ) : (
                    <button
                      onClick={() => onRerun(d.id)}
                      disabled={!!reviewingDocId}
                      className="inline-flex items-center gap-1 text-[10px] text-violet-600 dark:text-violet-400 font-medium hover:underline shrink-0"
                    >
                      <Bot className="size-3" /> Run AI review
                    </button>
                  )}

                  {/* Open the document viewer (read + comment; run AI analysis inside) */}
                  {d.access_level !== "restricted" && (
                    <Link
                      to="/legal/review/$documentId"
                      params={{ documentId: d.id }}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 shrink-0 transition-colors"
                      title="Open document review — read, comment, and run AI analysis"
                    >
                      <Bot className="size-3" /> Review
                    </Link>
                  )}

                  {/* Access control — restricted (e.g. NDAs): view-only, no download */}
                  <button
                    onClick={() => onSetAccess(d.id, d.access_level === "restricted" ? "standard" : "restricted")}
                    className={cn("shrink-0", d.access_level === "restricted" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground hover:text-foreground")}
                    title={d.access_level === "restricted" ? "Restricted — view-only, no download. Click to unlock." : "Standard access. Click to restrict (view-only)."}
                  >
                    {d.access_level === "restricted" ? <Lock className="size-3.5" /> : <Unlock className="size-3.5 opacity-50" />}
                  </button>

                  {d.access_level === "restricted" ? (
                    <span className="text-muted-foreground/40 shrink-0" title="Download disabled for restricted documents">
                      <Download className="size-3.5" />
                    </span>
                  ) : (
                    <a
                      href={d.file_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      title="Download"
                    >
                      <Download className="size-3.5" />
                    </a>
                  )}

                  {/* Delete (with inline confirm) */}
                  {confirmDeleteId === d.id ? (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { onDelete(d.id); setConfirmDeleteId(null); }}
                        disabled={deletingDocId === d.id}
                        className="text-[10px] font-semibold text-red-600 dark:text-red-400 hover:underline"
                      >
                        {deletingDocId === d.id ? "…" : "Delete"}
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)} className="text-[10px] text-muted-foreground hover:text-foreground">Cancel</button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(d.id)}
                      className="text-muted-foreground/60 hover:text-red-500 shrink-0"
                      title="Delete this document / version"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>

                {/* Expanded AI review panel */}
                {open && review && (
                  <div className="px-4 pb-4 space-y-2">
                    {verdict && (
                      <div className={cn("rounded-lg border px-3 py-2 flex items-start gap-2.5", verdict.cls)}>
                        <verdict.icon className="size-3.5 shrink-0 mt-0.5" />
                        <div className="text-xs leading-relaxed">
                          <span className={cn("inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider mr-1.5", verdict.chip)}>
                            {verdict.label}
                          </span>
                          {review.summary}
                        </div>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {(review.clauses ?? []).map((c: any, i: number) => {
                        const sev = CLAUSE_SEVERITY[c.severity] ?? CLAUSE_SEVERITY.caution;
                        return (
                          <div key={i} className={cn("rounded-lg border px-3 py-2.5", sev.cls)}>
                            <div className="flex items-center gap-2 mb-1">
                              <sev.icon className="size-3 shrink-0" />
                              <span className="text-[11px] font-bold">{c.ref}</span>
                              <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider shrink-0", sev.chip)}>
                                {sev.label}
                              </span>
                            </div>
                            {c.excerpt && (
                              <p className="text-[11px] italic text-muted-foreground border-l-2 border-current/20 pl-2 my-1.5">
                                "{c.excerpt}"
                              </p>
                            )}
                            <p className="text-[11px] leading-relaxed">{c.comment}</p>
                            {c.suggestion && (
                              <p className="text-[11px] leading-relaxed mt-1 font-medium">
                                <span className="opacity-60">Suggested position:</span> {c.suggestion}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable AI executive summary (Cluster 4)
// ---------------------------------------------------------------------------
function ExecSummaryPanel({ summary, editable, saving, onSave }: {
  summary: string; editable: boolean; saving: boolean; onSave: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary);
  return (
    <div className="rounded-xl border border-blue-200/60 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-blue-200/40 dark:border-blue-900/60">
        <ClipboardCheck className="size-3.5 text-blue-600 dark:text-blue-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-blue-800 dark:text-blue-300">
          e-Approval · Executive Summary
        </span>
        {editable && !editing && (
          <button onClick={() => { setDraft(summary); setEditing(true); }} className="ml-auto text-[11px] text-blue-700 dark:text-blue-300 inline-flex items-center gap-1 hover:underline">
            <Pencil className="size-3" /> Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="p-4 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
          <div className="flex items-center gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
            <Button size="sm" className="h-7 text-[11px] gap-1.5" disabled={saving} onClick={() => { onSave(draft); setEditing(false); }}>
              {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-4 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">{summary}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route D advisory toolbar — refer to GC + cross-functional tagging (Cluster 2)
// ---------------------------------------------------------------------------
const FUNCTIONS = ["Tax", "Compliance", "Risk", "Finance"];
function RouteDToolbar({ m, taggedFunctions, onRefer, onTag, referBusy, tagBusy }: {
  m: any; taggedFunctions: string[];
  onRefer: (note?: string) => void; onTag: (fns: string[]) => void;
  referBusy: boolean; tagBusy: boolean;
}) {
  const [referOpen, setReferOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <Users className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Advisory Collaboration</span>
      </div>
      <div className="p-4 space-y-3">
        {/* Cross-functional tagging */}
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Loop in a specialist function (isolated to this matter file):</p>
          <div className="flex flex-wrap gap-1.5">
            {FUNCTIONS.map((f) => {
              const on = taggedFunctions.includes(f);
              return (
                <button
                  key={f}
                  disabled={on || tagBusy}
                  onClick={() => onTag([f])}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    on ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 cursor-default"
                       : "text-muted-foreground hover:border-indigo-300 hover:text-foreground"
                  )}
                >
                  {on ? <Check className="size-3 inline mr-1" /> : null}{f}
                </button>
              );
            })}
          </div>
        </div>
        {/* Refer to GC */}
        <div className="pt-2 border-t">
          {m.referred_to_gc ? (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
              <ArrowUpCircle className="size-3.5" /> Referred to General Counsel for validation
            </div>
          ) : !referOpen ? (
            <button onClick={() => setReferOpen(true)} className="text-[11px] text-indigo-700 dark:text-indigo-300 inline-flex items-center gap-1 hover:underline">
              <ArrowUpCircle className="size-3.5" /> Refer to General Counsel
            </button>
          ) : (
            <div className="space-y-2">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What needs GC validation?" className="w-full rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <div className="flex items-center gap-2 justify-end">
                <button onClick={() => setReferOpen(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
                <Button size="sm" className="h-7 text-[11px] gap-1.5" disabled={referBusy} onClick={() => { onRefer(note.trim() || undefined); setReferOpen(false); setNote(""); }}>
                  {referBusy ? <Loader2 className="size-3 animate-spin" /> : <ArrowUpCircle className="size-3" />} Refer
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish to Route C knowledge base (Cluster 2)
// ---------------------------------------------------------------------------
function PublishKbPanel({ saving, onPublish }: {
  saving: boolean; onPublish: (p: { title: string; takeaways: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [takeaways, setTakeaways] = useState("");
  return (
    <div className="rounded-xl border border-violet-200/60 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-violet-200/40 dark:border-violet-900/60">
        <BookOpen className="size-3.5 text-violet-600 dark:text-violet-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">Legal Knowledge Base</span>
      </div>
      <div className="p-4">
        {!open ? (
          <>
            <p className="text-[11px] text-muted-foreground mb-2">
              Publish the key takeaways from this advice into the Route C self-service chatbot so future queries answer autonomously.
            </p>
            <Button size="sm" className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700" onClick={() => setOpen(true)}>
              <BookOpen className="size-3.5" /> Publish takeaways
            </Button>
          </>
        ) : (
          <div className="space-y-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Topic title (e.g. Vendor data-sharing position)" className="w-full rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500/30" />
            <textarea value={takeaways} onChange={(e) => setTakeaways(e.target.value)} rows={4} placeholder="Key takeaways / position the chatbot should cite…" className="w-full rounded-lg border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/30" />
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => setOpen(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
              <Button size="sm" className="h-7 text-[11px] gap-1.5 bg-violet-600 hover:bg-violet-700" disabled={saving || title.trim().length < 3 || takeaways.trim().length < 10} onClick={() => { onPublish({ title: title.trim(), takeaways: takeaways.trim() }); setOpen(false); setTitle(""); setTakeaways(""); }}>
                {saving ? <Loader2 className="size-3 animate-spin" /> : <BookOpen className="size-3" />} Publish
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-matter chat (Cluster 4) — isolated per matter, @-mentions, function tags
// ---------------------------------------------------------------------------
function renderChatContent(text: string) {
  // Highlight @mentions inline
  const parts = text.split(/(@[\w.\-]+)/g);
  return parts.map((p, i) =>
    p.startsWith("@")
      ? <span key={i} className="font-semibold text-indigo-600 dark:text-indigo-400">{p}</span>
      : <span key={i}>{p}</span>
  );
}
function MatterChat({ comments, value, setValue, posting, onPost }: {
  comments: any[]; value: string; setValue: (v: string) => void; posting: boolean; onPost: (fnTag?: string) => void;
}) {
  const [fnTag, setFnTag] = useState<string>("");
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Matter Chat</span>
        <span className="text-[10px] text-muted-foreground/60">· scoped to this matter · @-tag to highlight</span>
        <span className="text-[10px] text-muted-foreground/60 ml-auto">{comments.length}</span>
      </div>
      <div className="divide-y max-h-[380px] overflow-y-auto">
        {comments.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground/60 italic">No messages yet.</p>}
        {comments.map((c: any) => {
          const isAi = c.author_name === "AI Triage Scanner" || c.author_name === "AI Advisory Engine";
          return (
            <div key={c.id} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={cn("text-[11px] font-semibold", isAi && "text-violet-700 dark:text-violet-300")}>{c.author_name ?? "User"}</span>
                {c.function_tag && (
                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">{c.function_tag}</span>
                )}
                {c.comment_type && c.comment_type !== "comment" && (
                  <span className={cn(
                    "text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded",
                    c.comment_type === "rejection_reason" ? "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400" : "bg-muted text-muted-foreground"
                  )}>
                    {c.comment_type.replace("_", " ")}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/60 ml-auto">
                  {c.created_at ? formatDistanceToNow(new Date(c.created_at), { addSuffix: true }) : ""}
                </span>
              </div>
              <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/85">{renderChatContent(c.content)}</p>
            </div>
          );
        })}
      </div>
      <div className="border-t p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">Post as:</span>
          {["", ...FUNCTIONS].map((f) => (
            <button
              key={f || "none"}
              onClick={() => setFnTag(f)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                fnTag === f ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f || "Legal"}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            placeholder="Message… use @name to tag"
            className="flex-1 rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={!value.trim() || posting} onClick={() => onPost(fnTag || undefined)}>
            {posting ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle panel — expiry / renewal / retention (Cluster 3, Step 6)
// ---------------------------------------------------------------------------
function LifecyclePanel({ m, saving, onSave }: {
  m: any; saving: boolean; onSave: (p: { expiry_date?: string; retention_years?: number }) => void;
}) {
  const [expiry, setExpiry] = useState(m.expiry_date ? String(m.expiry_date).slice(0, 10) : "");
  const [retention, setRetention] = useState<string>(m.retention_until ? "" : "7");
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <CalendarClock className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Lifecycle</span>
      </div>
      <div className="p-4 space-y-3 text-xs">
        {m.expiry_date && (
          <DetailRow label="Expiry / renewal" value={format(new Date(m.expiry_date), "d MMM yyyy")} />
        )}
        {m.retention_until && (
          <DetailRow label="Retain until" value={format(new Date(m.retention_until), "d MMM yyyy")} />
        )}
        {m.destroy_after && (
          <DetailRow label="Destroy after" value={format(new Date(m.destroy_after), "d MMM yyyy")} />
        )}
        <div className="pt-1 space-y-2 border-t">
          <div>
            <label className="text-[10px] text-muted-foreground">Contract expiry / renewal date</label>
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="mt-1 w-full rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Retention period (years from now)</label>
            <input type="number" min="1" max="30" value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="e.g. 7" className="mt-1 w-full rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          </div>
          <Button
            size="sm" className="w-full h-7 text-[11px] gap-1.5"
            disabled={saving || (!expiry && !retention)}
            onClick={() => onSave({ expiry_date: expiry ? new Date(expiry).toISOString() : undefined, retention_years: retention ? Number(retention) : undefined })}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Set lifecycle
          </Button>
        </div>
      </div>
    </div>
  );
}
