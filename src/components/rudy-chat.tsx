// ============================================================================
// RUDY CHAT — floating assistant panel (modeled on credit-chat.tsx).
// Rudy interviews the user, answers research questions on uploaded documents
// against the tenant's policy KB, and proposes workflows as confirmation
// cards. Confirm calls the matching create serverFn CLIENT-side and navigates
// — Rudy itself never triggers anything.
// ============================================================================

import { useRef, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { rudyChat, type RudyAction, type RudyReply } from "@/lib/rudy.functions";
import { createSimplifyV2Report } from "@/lib/compliance.functions";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  X, Send, Loader2, Paperclip, Sparkles, FileText,
  ArrowRight, Bot,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
  action?: RudyAction | null;
  resolvedDoc?: RudyReply["resolvedDoc"];
  actionDone?: boolean;
}

interface Attachment {
  filename: string;
  fileUrl: string;
}

const GREETING =
  "Hi, I'm **Rudy** — your document assistant.\n\nTell me what you're working on: a document that's hard to follow, one you suspect has gaps or contradictions, a new regulation to assess, or something new to draft. You can also attach a document and ask how it impacts your policies.";

export function RudyChat() {
  const auth = useAuth();
  const nav = useNavigate();
  const ask = useServerFn(rudyChat);
  const createV2 = useServerFn(createSimplifyV2Report);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // Feature-gated + only for signed-in users.
  const enabled = mounted && !auth.loading && !!auth.userId && auth.tenant.features.includes("rudy");
  if (!enabled) return null;

  async function attachFile(file: File) {
    setUploading(true);
    try {
      const path = `rudy/${Date.now()}-${file.name}`;
      const up = await supabase.storage.from("policies").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) throw up.error;
      setAttachment({
        filename: file.name,
        fileUrl: supabase.storage.from("policies").getPublicUrl(path).data.publicUrl,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't attach the file", { description: e?.message });
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const outgoing: Msg = {
      role: "user",
      content: attachment ? `${text}\n\n📎 ${attachment.filename}` : text,
    };
    setMessages((m) => [...m, outgoing]);
    setBusy(true);
    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content })).slice(-10);
      const r = await ask({
        data: {
          message: text,
          history,
          ...(attachment ? { fileUrl: attachment.fileUrl, filename: attachment.filename } : {}),
        },
      });
      setMessages((m) => [...m, { role: "assistant", content: r.reply, action: r.action, resolvedDoc: r.resolvedDoc }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: `Sorry — that failed: ${e?.message?.slice(0, 140) ?? "unknown error"}. Try again.` }]);
    } finally {
      setBusy(false);
    }
  }

  /** Confirm an action card → create the report → navigate. */
  async function runAction(msgIndex: number, action: RudyAction, resolvedDoc: RudyReply["resolvedDoc"]) {
    if (confirming) return;
    setConfirming(true);
    try {
      // The chat attachment may ONLY stand in when the action explicitly
      // targets it ("uploaded") — silently substituting it for an indexed
      // document with no stored file would run the analysis on the wrong doc.
      const isUploadedTarget = action.params.docRef === "uploaded" || (!action.params.docRef && !resolvedDoc);
      const fileUrl = resolvedDoc?.fileUrl ?? (isUploadedTarget ? attachment?.fileUrl ?? null : null);
      const filename = resolvedDoc?.fileUrl
        ? resolvedDoc.title
        : (isUploadedTarget ? attachment?.filename ?? resolvedDoc?.title ?? "document" : resolvedDoc?.title ?? "document");

      if (action.kind === "simplify_v2" || action.kind === "redraft") {
        if (!fileUrl) throw new Error("No source file resolved — attach or pick a document first.");
        const isRedraft = action.kind === "redraft";
        const { reportId } = await createV2({
          data: {
            filename,
            fileUrl,
            customTitle: resolvedDoc?.title,
            instruction: action.params.brief,
            workflowMode: isRedraft ? "recommend_edit" : (action.params.workflowMode ?? "recommend"),
            ...(isRedraft ? { redraftAuto: true } : {}),
            ...(action.params.profile === "max" ? { simplifyProfile: "max" as const } : {}),
          },
        });
        markDone(msgIndex);
        setOpen(false);
        nav({ to: "/simplify2/$reportId", params: { reportId } });
      } else if (action.kind === "regulatory") {
        markDone(msgIndex);
        setOpen(false);
        toast.info("Opening the regulatory analysis workspace", {
          description: "Upload the regulation there — the analysis maps it against your document library.",
        });
        nav({ to: "/reports" });
      } else if (action.kind === "create_document") {
        markDone(msgIndex);
        setOpen(false);
        toast.info("Opening the document workspace", {
          description: "Use New Analysis → New Document with the brief Rudy prepared.",
        });
        nav({ to: "/reports" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error("Couldn't start the workflow", { description: e?.message });
    } finally {
      setConfirming(false);
    }
  }

  function markDone(msgIndex: number) {
    setMessages((m) => m.map((msg, i) => (i === msgIndex ? { ...msg, actionDone: true } : msg)));
    setAttachment(null);
  }

  const display: Msg[] = messages.length === 0 ? [{ role: "assistant", content: GREETING }] : messages;

  return (
    <>
      {/* floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title={`Rudy · ${auth.tenant.name}`}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 pl-3 pr-4 py-2.5 text-sm font-semibold transition-transform hover:scale-105 active:scale-95"
        >
          <Bot className="size-5" />
          Ask Rudy
        </button>
      )}

      {/* slide-over panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[600px] max-h-[80vh] w-[400px] max-w-[calc(100vw-2.5rem)] flex-col rounded-2xl border bg-card shadow-2xl overflow-hidden">
          {/* header */}
          <div className="flex items-center gap-2.5 border-b bg-sidebar px-4 py-3 text-sidebar-foreground">
            <div className="size-8 rounded-lg bg-sidebar-primary/20 grid place-items-center ring-1 ring-sidebar-primary/30">
              <Bot className="size-4 text-sidebar-primary" />
            </div>
            <div className="flex-1 min-w-0 leading-tight">
              <div className="text-sm font-bold">Rudy</div>
              <div className="text-[10px] text-sidebar-foreground/60 truncate">{auth.tenant.name} · document assistant</div>
            </div>
            <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-sidebar-accent/50 transition-colors">
              <X className="size-4" />
            </button>
          </div>

          {/* messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-muted/20">
            {display.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-card border rounded-bl-sm",
                )}>
                  {m.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0 text-sm">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  )}

                  {/* action confirmation card */}
                  {m.action && (
                    <div className={cn(
                      "mt-2.5 rounded-xl border p-3 space-y-1.5",
                      m.actionDone ? "bg-emerald-50 border-emerald-200" : "bg-primary/5 border-primary/20",
                    )}>
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                        <Sparkles className="size-3" /> Proposed workflow
                      </div>
                      <div className="text-sm font-semibold">{m.action.label}</div>
                      {m.action.description && (
                        <div className="text-xs text-muted-foreground">{m.action.description}</div>
                      )}
                      {m.resolvedDoc && (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <FileText className="size-3" /> {m.resolvedDoc.title}
                        </div>
                      )}
                      {m.actionDone ? (
                        <div className="text-[11px] font-medium text-emerald-700">Started ✓</div>
                      ) : (
                        <Button
                          size="sm"
                          className="w-full h-7 text-xs mt-1"
                          disabled={confirming}
                          onClick={() => runAction(i, m.action!, m.resolvedDoc)}
                        >
                          {confirming
                            ? (<><Loader2 className="size-3 mr-1 animate-spin" /> Starting…</>)
                            : (<>Confirm & run <ArrowRight className="size-3 ml-1" /></>)}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-card border px-3.5 py-2.5">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* attachment chip */}
          {attachment && (
            <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-1.5 text-xs">
              <FileText className="size-3.5 text-primary shrink-0" />
              <span className="truncate flex-1">{attachment.filename}</span>
              <button onClick={() => setAttachment(null)} className="p-0.5 rounded hover:bg-muted">
                <X className="size-3" />
              </button>
            </div>
          )}

          {/* input */}
          <div className="flex items-end gap-1.5 border-t bg-card p-2.5">
            <label className={cn("p-2 rounded-lg cursor-pointer transition-colors shrink-0", uploading ? "opacity-50" : "hover:bg-muted")}>
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                className="hidden"
                disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) attachFile(f); e.target.value = ""; }}
              />
              {uploading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Paperclip className="size-4 text-muted-foreground" />}
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder="Describe what you need…"
              className="flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary max-h-28"
            />
            <Button size="icon" className="size-9 rounded-xl shrink-0" disabled={!input.trim() || busy} onClick={send}>
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
