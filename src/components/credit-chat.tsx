import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import Markdown from "react-markdown";
import { askCreditRisk } from "@/lib/compliance.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Sparkles, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Why is this an overall high risk?",
  "What's the single biggest concern, and what should I probe first?",
  "Explain the related-party exposure to W Services.",
  "What does Case 48 warn about, and how does it apply here?",
  "What are the mitigants, and are they enough?",
];

/* Compact markdown styling for assistant bubbles (bold, bullets, numbered lists). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MD: any = {
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="leading-snug">{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  h1: ({ children }: any) => <p className="font-semibold mb-1">{children}</p>,
  h2: ({ children }: any) => <p className="font-semibold mb-1">{children}</p>,
  h3: ({ children }: any) => <p className="font-semibold mb-1">{children}</p>,
  code: ({ children }: any) => (
    <code className="text-[12px] bg-black/5 dark:bg-white/10 rounded px-1 py-0.5">{children}</code>
  ),
};

/**
 * Conversational Q&A over one credit risk report. Answers are grounded in the
 * stored analysis + KB excerpts retrieved server-side for each question.
 */
export function CreditChat({
  open,
  onOpenChange,
  reportId,
  borrower,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  reportId: string;
  borrower: string;
}) {
  const ask = useServerFn(askCreditRisk);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const { answer } = await ask({ data: { reportId, question, history } });
      setMessages((m) => [...m, { role: "assistant", content: answer || "(no answer returned)" }]);
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Sorry — ${e?.message ?? "something went wrong"}.` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 flex flex-col h-[80vh]">
        <DialogHeader className="px-5 py-3.5 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-red-600" /> Ask about {borrower}'s risk
          </DialogTitle>
          <DialogDescription className="text-xs">
            Answers draw only from this report's analysis and the case knowledge base.
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-6">
              <MessageSquare className="size-8 mx-auto mb-2 opacity-40" />
              <p className="max-w-sm mx-auto">
                Ask anything about this report — the findings, the figures, or the cases it mirrors.
              </p>
              <div className="flex flex-col items-stretch gap-2 mt-4 max-w-md mx-auto">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-xs border rounded-lg px-3 py-2 hover:bg-muted/50 hover:border-red-200 text-foreground transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-red-600 text-white">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed bg-muted/60 text-foreground">
                  <Markdown components={MD}>{m.content}</Markdown>
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex justify-start">
              <div className="bg-muted/60 rounded-2xl px-3.5 py-2.5 text-sm text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          )}
        </div>

        <div className="border-t p-3 flex items-center gap-2 shrink-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask about the risk or a case…"
            disabled={busy}
            className="flex-1 text-sm px-3 py-2 rounded-lg border bg-card focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-60"
          />
          <Button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="bg-red-600 hover:bg-red-700 text-white gap-1.5 shrink-0"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
