import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  createLegalMatter,
  createTemplateRequest,
  legalIntakeChat,
  attachLegalDocument,
  reviewLegalDocument,
  MATTER_TYPES,
} from "@/lib/legal.functions";
import { LEGAL_TEMPLATES, fillTemplate, htmlToPlainText, downloadDoc, type LegalTemplate } from "@/lib/legal.templates";
import { RoleSwitcher } from "@/components/legal-widgets";
import { maskDemoEmail } from "@/lib/legal.functions";
import {
  ArrowLeft,
  Scale,
  Sparkles,
  Loader2,
  CalendarDays,
  AlertTriangle,
  Bot,
  Send,
  Paperclip,
  X,
  FileDown,
  FileText,
  MessageSquareText,
  ClipboardList,
} from "lucide-react";

export const Route = createFileRoute("/legal/new")({
  component: NewLegalMatter,
  head: () => ({ meta: [{ title: "New Request · Legal CMS" }] }),
});

// ---------------------------------------------------------------------------
// Shared: open a request (+ upload docs + trigger AI review), used by both
// the chat intake and the classic form.
// ---------------------------------------------------------------------------

interface DraftPayload {
  title: string;
  description: string;
  matter_type: string;
  priority: "low" | "normal" | "high" | "urgent";
  requestor_name: string;
  requestor_email: string;
  due_date?: string;
  is_material?: boolean;
  contract_value?: number;
}

const PRIORITIES = [
  { value: "low",    label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high",   label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

function NewLegalMatter() {
  const [mode, setMode] = useState<"chat" | "form">("chat");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();

  const createFn = useServerFn(createLegalMatter);
  const attachFn = useServerFn(attachLegalDocument);
  const reviewFn = useServerFn(reviewLegalDocument);
  const createTemplateFn = useServerFn(createTemplateRequest);

  const [phase, setPhase] = useState<string | null>(null);

  // Requestor identity, shared by both modes
  const [requestorName, setRequestorName] = useState("");
  const [requestorEmail, setRequestorEmail] = useState("");
  useEffect(() => {
    if (auth.email && !requestorEmail) {
      setRequestorEmail(maskDemoEmail(auth.email));
      if (!requestorName) {
        const prefix = auth.email.split("@")[0];
        setRequestorName(prefix.split(/[._-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "));
      }
    }
  }, [auth.email]);

  // Every self-service template download is tracked as a real matter + document —
  // otherwise the file leaves the system with zero record, and there'd be nowhere
  // to attach the counterparty's markup if they send changes back.
  async function trackTemplate(t: LegalTemplate, html: string): Promise<any> {
    // Guard the narrow race where a template is clicked before auth.email has
    // resolved into requestorEmail — createTemplateRequest requires a valid
    // email, so fail with a clear message rather than a raw validation error.
    if (!requestorEmail.trim()) throw new Error("Still loading your profile — try again in a moment.");
    const blob = new Blob([html], { type: "application/msword" });
    const path = `legal/${Date.now()}-${t.fileName}`;
    const up = await supabase.storage.from("policies").upload(path, blob, {
      upsert: false,
      contentType: "application/msword",
    });
    if (up.error) throw new Error(up.error.message);
    const fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
    const matter: any = await createTemplateFn({
      data: {
        template_id:     t.id,
        template_name:   t.name,
        matter_type:     t.matter_type,
        file_name:       t.fileName,
        file_url:        fileUrl,
        mime_type:       "application/msword",
        size_bytes:      blob.size,
        plain_text:      htmlToPlainText(html),
        requestor_name:  requestorName,
        requestor_email: requestorEmail,
      },
    });
    // Land the user on the matter that was just created — the download already
    // fired, and staying on the chat page leaves them with no obvious next step.
    queryClient.invalidateQueries({ queryKey: ["legal-matters"] });
    navigate({ to: "/legal/$matterId", params: { matterId: matter.id } });
    return matter;
  }

  async function openRequest(payload: DraftPayload, files: File[]) {
    setPhase("Opening request — AI screening, routing & triage…");

    // Create the matter first. If THIS fails, nothing was persisted, so it's safe
    // to bounce back to the form and let the user retry.
    let matter: any;
    try {
      matter = await createFn({ data: { ...payload, has_attachments: files.length > 0 } });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to open the request");
      setPhase(null);
      return;
    }

    // The matter now EXISTS. From here we never send the user back to the form —
    // doing so would leave this matter orphaned and create a DUPLICATE on retry.
    // A failed upload/attach is collected and reported; the user still lands on
    // the matter and can re-add the file there.
    const uploaded: any[] = [];
    const failedFiles: string[] = [];
    for (const file of files) {
      try {
        setPhase(`Uploading ${file.name}…`);
        const path = `legal/${Date.now()}-${file.name}`;
        const up = await supabase.storage.from("policies").upload(path, file, {
          upsert: false,
          contentType: file.type || "application/octet-stream",
        });
        if (up.error) throw new Error(up.error.message);
        const fileUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
        const doc = await attachFn({
          data: {
            matter_id: matter.id,
            file_name: file.name,
            file_url: fileUrl,
            mime_type: file.type || undefined,
            size_bytes: file.size,
            doc_role: "submitted",
          },
        });
        uploaded.push(doc);
      } catch {
        failedFiles.push(file.name);
      }
    }

    // Clause-by-clause first cut on each successfully-attached document
    for (const doc of uploaded) {
      setPhase(`AI reviewing ${doc.file_name} clause-by-clause…`);
      try {
        await reviewFn({ data: { document_id: doc.id } });
      } catch {
        toast.warning(`AI review of ${doc.file_name} failed — you can re-run it from the matter page.`);
      }
    }

    queryClient.invalidateQueries({ queryKey: ["legal-matters"] });
    if (failedFiles.length > 0) {
      toast.warning(
        `Matter ${matter.reference_number ?? ""} opened, but ${failedFiles.length} attachment${failedFiles.length === 1 ? "" : "s"} failed to upload (${failedFiles.join(", ")}). Re-add ${failedFiles.length === 1 ? "it" : "them"} from the matter page.`,
      );
    } else {
      toast.success(`Matter ${matter.reference_number ?? ""} opened — Route ${matter.route}`);
    }
    navigate({ to: "/legal/$matterId", params: { matterId: matter.id } });
  }

  return (
    <AppShell>
      <div className="flex flex-col h-screen">
        {/* Header */}
        <div className="flex items-center gap-3 border-b bg-background/95 px-6 py-3 sticky top-0 z-10 backdrop-blur shrink-0">
          <Link
            to="/legal"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3" /> Legal CMS
          </Link>
          <span className="text-muted-foreground/30">/</span>
          <div className="flex items-center gap-2">
            <Scale className="size-3.5 text-indigo-600 dark:text-indigo-400" />
            <h1 className="text-sm font-bold">New Legal Request</h1>
          </div>
          {/* Mode toggle */}
          <div className="ml-auto flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5">
            <button
              onClick={() => setMode("chat")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                mode === "chat" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <MessageSquareText className="size-3" /> AI Assistant
            </button>
            <button
              onClick={() => setMode("form")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                mode === "form" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ClipboardList className="size-3" /> Form
            </button>
          </div>
          <RoleSwitcher />
        </div>

        {/* Busy overlay while opening request */}
        {phase && (
          <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm grid place-items-center">
            <div className="rounded-xl border bg-card px-6 py-5 shadow-lg flex items-center gap-3 max-w-md">
              <Loader2 className="size-4 animate-spin text-indigo-600 shrink-0" />
              <span className="text-sm font-medium">{phase}</span>
            </div>
          </div>
        )}

        {mode === "chat" ? (
          <ChatIntake
            requestorName={requestorName}
            requestorEmail={requestorEmail}
            onOpenRequest={openRequest}
            onTrackTemplate={trackTemplate}
            onSwitchToForm={() => setMode("form")}
          />
        ) : (
          <FormIntake
            requestorName={requestorName} setRequestorName={setRequestorName}
            requestorEmail={requestorEmail} setRequestorEmail={setRequestorEmail}
            onOpenRequest={openRequest}
          />
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Chat-first intake — the conversational gatekeeper (Step 1 in the deck)
// ---------------------------------------------------------------------------

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  action?: any;
}

const STARTERS = [
  "I need an NDA for a partner discussion",
  "Review a vendor contract for me",
  "Can we share customer data with a third-party vendor?",
  "I need a bespoke agreement drafted",
];

const GREETING: ChatMsg = {
  role: "assistant",
  text: "Hi — I'm the Legal Intake Assistant. Tell me in plain English what you need from Legal and I'll work out the right track: instant templates for standard documents, an AI-triaged review for contracts, quick answers for routine questions, or full counsel review for complex matters. What can I help with?",
};

function ChatIntake({
  requestorName,
  requestorEmail,
  onOpenRequest,
  onTrackTemplate,
  onSwitchToForm,
}: {
  requestorName: string;
  requestorEmail: string;
  onOpenRequest: (payload: DraftPayload, files: File[]) => Promise<void>;
  onTrackTemplate: (t: LegalTemplate, html: string) => Promise<any>;
  onSwitchToForm: () => void;
}) {
  const chatFn = useServerFn(legalIntakeChat);
  const [messages, setMessages] = useState<ChatMsg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const next: ChatMsg[] = [...messages, { role: "user", text: trimmed }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const res: any = await chatFn({
        data: {
          messages: next
            .filter((m) => m !== GREETING) // greeting is client-side flavor, not model context
            .map((m) => ({ role: m.role, text: m.text })),
        },
      });
      setMessages((cur) => [...cur, { role: "assistant", text: res.reply, action: res.action }]);
    } catch (e: any) {
      toast.error(e?.message ?? "The assistant is unavailable — try the Form mode.");
      setMessages((cur) => [...cur, { role: "assistant", text: "Sorry, I hit a snag. You can retry, or switch to Form mode at the top right." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-4">
          {messages.map((m, i) => (
            <div key={i}>
              <div className={cn("flex gap-2.5", m.role === "user" && "justify-end")}>
                {m.role === "assistant" && (
                  <div className="size-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 grid place-items-center shrink-0 mt-0.5">
                    <Bot className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                )}
                <div
                  className={cn(
                    "rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed max-w-[85%] whitespace-pre-wrap",
                    m.role === "assistant"
                      ? "bg-muted/60 text-foreground rounded-tl-sm"
                      : "bg-indigo-600 text-white rounded-tr-sm"
                  )}
                >
                  {m.text}
                </div>
              </div>
              {/* Action cards */}
              {m.action?.type === "offer_template" && (
                <TemplateCard templateId={m.action.template_id} onTrackTemplate={onTrackTemplate} />
              )}
              {m.action?.type === "propose_request" && (
                <DraftCard
                  draft={m.action.draft}
                  requestorName={requestorName}
                  requestorEmail={requestorEmail}
                  onOpenRequest={onOpenRequest}
                />
              )}
            </div>
          ))}

          {sending && (
            <div className="flex gap-2.5">
              <div className="size-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 grid place-items-center shrink-0">
                <Bot className="size-3.5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5">
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}

          {/* Starter suggestions on fresh chat */}
          {messages.length === 1 && !sending && (
            <>
              <div className="flex flex-wrap gap-1.5 pl-9">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-indigo-300 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="pl-9 text-[11px] text-muted-foreground/70">
                Prefer clicking through fields instead of chatting?{" "}
                <button onClick={onSwitchToForm} className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
                  Switch to Form
                </button>
              </p>
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t bg-background shrink-0">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder="Describe what you need from Legal…"
            className="flex-1 rounded-xl border bg-background px-3.5 py-2.5 text-xs leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          <Button
            size="sm"
            className="h-9 gap-1.5 text-xs"
            disabled={!input.trim() || sending}
            onClick={() => send(input)}
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Self-service drafting wizard (Route A) rendered inline in the chat — the
    chatbot-as-drafting-wizard: collect customized answers, generate the contract. */
function TemplateCard({ templateId, onTrackTemplate }: {
  templateId: string;
  onTrackTemplate: (t: LegalTemplate, html: string) => Promise<any>;
}) {
  const t = LEGAL_TEMPLATES.find((x) => x.id === templateId);
  const [wizard, setWizard] = useState(false);
  const [downloading, setDownloading] = useState(false);
  if (!t) return null;

  async function downloadBlank() {
    if (!t) return;
    setDownloading(true);
    const html = fillTemplate(t, {});
    downloadDoc(html, t.fileName);
    try {
      const matter = await onTrackTemplate(t, html);
      toast.success(`${t.fileName} downloaded — tracked as ${matter.reference_number ?? "a new request"}`);
    } catch (e: any) {
      toast.warning(`${t.fileName} downloaded, but couldn't create a tracked record: ${e?.message ?? "unknown error"}`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="ml-9 mt-2 rounded-xl border border-emerald-200/60 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 p-3.5 max-w-[92%]">
      <div className="flex items-start gap-3">
        <div className="size-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 grid place-items-center shrink-0">
          <FileText className="size-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold">{t.name}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{t.description}</p>
          {!wizard ? (
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                size="sm"
                className="h-7 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => setWizard(true)}
              >
                <Sparkles className="size-3" /> Draft with AI wizard
              </Button>
              <Button
                size="sm" variant="ghost"
                className="h-7 text-[11px] gap-1.5 text-emerald-700 dark:text-emerald-300"
                disabled={downloading}
                onClick={downloadBlank}
              >
                {downloading ? <Loader2 className="size-3 animate-spin" /> : <FileDown className="size-3" />} Blank template
              </Button>
            </div>
          ) : (
            <TemplateWizard t={t} onClose={() => setWizard(false)} onTrackTemplate={onTrackTemplate} />
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateWizard({ t, onClose, onTrackTemplate }: {
  t: LegalTemplate;
  onClose: () => void;
  onTrackTemplate: (t: LegalTemplate, html: string) => Promise<any>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [step, setStep] = useState(0);
  const [generating, setGenerating] = useState(false);
  const fields = t.fields;
  const done = step >= fields.length;
  const f = fields[step];

  return (
    <div className="mt-2.5 rounded-lg border bg-card p-3 space-y-2.5">
      {!done ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              Question {step + 1} of {fields.length}
            </span>
            <span className="text-[10px] text-muted-foreground">{t.name}</span>
          </div>
          <label className="block text-xs font-medium">{f.label}{f.optional && <span className="text-muted-foreground font-normal"> (optional)</span>}</label>
          {f.type === "textarea" ? (
            <textarea
              autoFocus
              value={answers[f.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: e.target.value }))}
              rows={2}
              placeholder={f.placeholder}
              className="w-full rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          ) : (
            <input
              autoFocus
              type={f.type === "date" ? "date" : "text"}
              value={answers[f.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") setStep((s) => s + 1); }}
              placeholder={f.placeholder}
              className="w-full rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          )}
          {f.help && <p className="text-[10px] text-amber-600 dark:text-amber-400">{f.help}</p>}
          <div className="flex items-center justify-between">
            <button onClick={step === 0 ? onClose : () => setStep((s) => s - 1)} className="text-[11px] text-muted-foreground hover:text-foreground">
              {step === 0 ? "Cancel" : "Back"}
            </button>
            <Button size="sm" className="h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => setStep((s) => s + 1)}>
              {step === fields.length - 1 ? "Review" : "Next"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Ready to generate</div>
          <div className="space-y-1">
            {fields.map((fld) => {
              const missing = !fld.optional && !answers[fld.id]?.trim();
              return (
                <div key={fld.id} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground shrink-0">{fld.label}</span>
                  <span className="font-medium text-right">
                    {answers[fld.id]?.trim() || (
                      <button onClick={() => setStep(fields.indexOf(fld))} className={cn("italic underline underline-offset-2", missing ? "text-red-500" : "text-muted-foreground/50")}>
                        {fld.optional ? "—" : "required — add"}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground">Any special instructions? <span className="opacity-60">(AI adds a clause)</span></label>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={2}
              placeholder="e.g. add a 6-month exclusivity period…"
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setStep(fields.length - 1)} className="text-[11px] text-muted-foreground hover:text-foreground">Back</button>
            <Button
              size="sm"
              className="h-7 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              disabled={generating || fields.some((fld) => !fld.optional && !answers[fld.id]?.trim())}
              onClick={async () => {
                setGenerating(true);
                const html = fillTemplate(t, answers, extra);
                downloadDoc(html, t.fileName);
                try {
                  const matter = await onTrackTemplate(t, html);
                  toast.success(`${t.fileName} generated — tracked as ${matter.reference_number ?? "a new request"}`);
                } catch (e: any) {
                  toast.warning(`${t.fileName} generated, but couldn't create a tracked record: ${e?.message ?? "unknown error"}`);
                } finally {
                  setGenerating(false);
                  onClose();
                }
              }}
            >
              {generating ? <Loader2 className="size-3 animate-spin" /> : <FileDown className="size-3" />} Generate contract
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Editable request draft proposed by the assistant — confirm to open. */
function DraftCard({
  draft,
  requestorName,
  requestorEmail,
  onOpenRequest,
}: {
  draft: any;
  requestorName: string;
  requestorEmail: string;
  onOpenRequest: (payload: DraftPayload, files: File[]) => Promise<void>;
}) {
  const [title, setTitle] = useState(draft?.title ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [matterType, setMatterType] = useState(draft?.matter_type ?? "");
  const [priority, setPriority] = useState<"low"|"normal"|"high"|"urgent">(draft?.priority ?? "normal");
  const [isMaterial, setIsMaterial] = useState(!!draft?.is_material);
  const [contractValue, setContractValue] = useState(
    draft?.contract_value != null ? String(draft.contract_value) : ""
  );
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState(requestorName);
  const [email, setEmail] = useState(requestorEmail);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (requestorName && !name) setName(requestorName); }, [requestorName]);
  useEffect(() => { if (requestorEmail && !email) setEmail(requestorEmail); }, [requestorEmail]);

  const valid = title.trim().length >= 3 && description.trim().length >= 10 && matterType && name.trim() && /\S+@\S+\.\S+/.test(email);

  return (
    <div className="ml-9 mt-2 rounded-xl border-2 border-indigo-200/70 dark:border-indigo-900 bg-card p-4 max-w-[92%] space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-indigo-600 dark:text-indigo-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">
          Request draft — confirm to open
        </span>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Matter title"
        className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      />

      <div className="grid grid-cols-2 gap-2">
        <select
          value={matterType}
          onChange={(e) => setMatterType(e.target.value)}
          className="rounded-lg border bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        >
          <option value="">Matter type…</option>
          {MATTER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as any)}
          className="rounded-lg border bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label} priority</option>
          ))}
        </select>
      </div>

      <input
        type="number"
        min="0"
        value={contractValue}
        onChange={(e) => setContractValue(e.target.value)}
        placeholder="Contract value — drives the approval threshold (optional)"
        className="w-full rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      />

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        className="w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      />

      {/* Attachments */}
      <div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt"
          className="hidden"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length) setFiles((cur) => [...cur, ...picked]);
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-indigo-300 transition-colors"
          >
            <Paperclip className="size-3" /> Attach contract / documents
          </button>
          {files.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-[10px] font-medium">
              <FileText className="size-3 opacity-60" />
              <span className="max-w-[140px] truncate">{f.name}</span>
              <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                <X className="size-3 opacity-60 hover:opacity-100" />
              </button>
            </span>
          ))}
        </div>
        {files.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
            <Bot className="size-3" /> Each document gets an instant AI clause-by-clause first cut on submission.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Requestor name"
          className="rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Requestor email"
          className="rounded-lg border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isMaterial}
          onChange={(e) => setIsMaterial(e.target.checked)}
          className="size-3.5 rounded accent-indigo-600"
        />
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <AlertTriangle className="size-3 text-amber-500" /> Material contract (executive-level approval on sign-off)
        </span>
      </label>

      <Button
        size="sm"
        className="w-full h-8 text-xs gap-1.5"
        disabled={!valid || submitting}
        onClick={async () => {
          setSubmitting(true);
          try {
            await onOpenRequest(
              {
                title: title.trim(),
                description: description.trim(),
                matter_type: matterType,
                priority,
                requestor_name: name.trim(),
                requestor_email: email.trim(),
                is_material: isMaterial,
                contract_value: contractValue ? Number(contractValue) : undefined,
              },
              files
            );
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        Open Request{files.length > 0 ? ` + AI review ${files.length} doc${files.length > 1 ? "s" : ""}` : ""}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Classic form intake (fallback mode)
// ---------------------------------------------------------------------------

function FormIntake({
  requestorName, setRequestorName,
  requestorEmail, setRequestorEmail,
  onOpenRequest,
}: {
  requestorName: string; setRequestorName: (v: string) => void;
  requestorEmail: string; setRequestorEmail: (v: string) => void;
  onOpenRequest: (payload: DraftPayload, files: File[]) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [matterType, setMatterType] = useState("");
  const [priority, setPriority] = useState<"low"|"normal"|"high"|"urgent">("normal");
  const [dueDate, setDueDate] = useState("");
  const [isMaterial, setIsMaterial] = useState(false);
  const [contractValue, setContractValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const valid =
    title.trim().length >= 3 &&
    description.trim().length >= 10 &&
    matterType &&
    requestorName.trim() &&
    /\S+@\S+\.\S+/.test(requestorEmail);

  const selectedType = MATTER_TYPES.find((t) => t.value === matterType);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="rounded-xl border bg-card divide-y">
          <div className="p-5 space-y-4">
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Matter title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Vendor SaaS agreement review — Acme Corp"
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
              />
            </div>

            <div>
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Matter type
                </label>
                <select
                  value={matterType}
                  onChange={(e) => {
                    setMatterType(e.target.value);
                    if (e.target.value === "material_contract") setIsMaterial(true);
                  }}
                  className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                >
                  <option value="">Select type…</option>
                  <optgroup label="Self-Service (Route A)">
                    {MATTER_TYPES.filter((t) => t.route_hint === "A").map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Bespoke Contract (Route B)">
                    {MATTER_TYPES.filter((t) => t.route_hint === "B").map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Simple Advisory (Route C)">
                    {MATTER_TYPES.filter((t) => t.route_hint === "C").map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Complex Advisory (Route D)">
                    {MATTER_TYPES.filter((t) => t.route_hint === "D").map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </optgroup>
                </select>
                {selectedType && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Typically routed to <span className="font-semibold">Route {selectedType.route_hint}</span> — final routing decided by AI.
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Describe your request <span className="normal-case font-normal opacity-60">(at least a full sentence — ~5 words)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="What do you need from Legal? Include counterparty names, deadlines, commercial context…"
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
              />
              {description.trim().length > 0 && description.trim().length < 10 && (
                <p className="text-[10px] text-amber-600 mt-1">A bit more detail needed before you can submit.</p>
              )}
            </div>

            {/* Attachments */}
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Documents <span className="normal-case font-normal opacity-60">(contract to review, reference docs)</span>
              </label>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt"
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length) setFiles((cur) => [...cur, ...picked]);
                  e.target.value = "";
                }}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-indigo-300 transition-colors"
                >
                  <Paperclip className="size-3.5" /> Attach files
                </button>
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1.5 text-[11px] font-medium">
                    <FileText className="size-3 opacity-60" />
                    <span className="max-w-[160px] truncate">{f.name}</span>
                    <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                      <X className="size-3 opacity-60 hover:opacity-100" />
                    </button>
                  </span>
                ))}
              </div>
              {files.length > 0 && (
                <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                  <Bot className="size-3" /> Each document gets an instant AI clause-by-clause first cut on submission.
                </p>
              )}
            </div>
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Priority
                </label>
                <div className="mt-1.5 flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPriority(p.value)}
                      className={cn(
                        "flex-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
                        priority === p.value
                          ? p.value === "urgent"
                            ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 shadow-sm"
                            : "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <CalendarDays className="size-3" /> Needed by <span className="normal-case font-normal opacity-60">(optional)</span>
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Contract value <span className="normal-case font-normal opacity-60">(optional — drives approval threshold)</span>
              </label>
              <input
                type="number"
                min="0"
                value={contractValue}
                onChange={(e) => setContractValue(e.target.value)}
                placeholder="e.g. 120000"
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={isMaterial}
                onChange={(e) => setIsMaterial(e.target.checked)}
                className="mt-0.5 size-3.5 rounded border-input accent-indigo-600"
              />
              <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                <span className="font-semibold flex items-center gap-1">
                  <AlertTriangle className="size-3 text-amber-500" /> Material contract
                </span>
                Exceeds materiality thresholds — routes to executive-level approval on sign-off.
              </span>
            </label>
          </div>

          <div className="p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Requestor name
                </label>
                <input
                  value={requestorName}
                  onChange={(e) => setRequestorName(e.target.value)}
                  placeholder="Your name"
                  className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Requestor email
                </label>
                <input
                  type="email"
                  value={requestorEmail}
                  onChange={(e) => setRequestorEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pb-8">
          <Link to="/legal">
            <Button variant="ghost" size="sm" className="text-xs h-8" disabled={submitting}>
              Cancel
            </Button>
          </Link>
          <Button
            size="sm"
            className="gap-2 h-8 text-xs min-w-[200px]"
            disabled={!valid || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onOpenRequest(
                  {
                    title: title.trim(),
                    description: description.trim(),
                    matter_type: matterType,
                    priority,
                    requestor_name: requestorName.trim(),
                    requestor_email: requestorEmail.trim(),
                    due_date: dueDate ? new Date(dueDate).toISOString() : undefined,
                    is_material: isMaterial,
                    contract_value: contractValue ? Number(contractValue) : undefined,
                  },
                  files
                );
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            Submit — AI routes it instantly
          </Button>
        </div>
      </div>
    </div>
  );
}
