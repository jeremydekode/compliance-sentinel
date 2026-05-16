import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { chatWithReport } from "@/lib/compliance.functions";
import { MD } from "@/components/md";
import { cn } from "@/lib/utils";

export function AIAssistant({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useServerFn(chatWithReport);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useQuery({
    queryKey: ["chat", reportId],
    queryFn: async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("report_id", reportId)
        .order("created_at");
      return data ?? [];
    },
    enabled: open,
    refetchInterval: streaming ? false : 5000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.data, streaming]);

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setStreaming("");
    try {
      const stream = await send({ data: { reportId, message: text } });
      let acc = "";
      for await (const chunk of stream as AsyncIterable<{ delta: string }>) {
        acc += chunk.delta;
        setStreaming(acc);
      }
    } catch (e: any) {
      setStreaming(`_Error: ${e?.message ?? "Unknown error"}_`);
    } finally {
      setBusy(false);
      setStreaming("");
      messages.refetch();
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="lg"
        className="fixed bottom-6 right-6 rounded-full shadow-lg gap-2 z-40 no-print"
      >
        <Sparkles className="size-4" /> Ask AI
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
          <SheetHeader className="px-5 py-4 border-b">
            <SheetTitle className="flex items-center gap-2 font-display">
              <Sparkles className="size-4 text-primary" /> Compliance AI Assistant
            </SheetTitle>
          </SheetHeader>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
            {(messages.data?.length ?? 0) === 0 && !streaming && (
              <div className="text-sm text-muted-foreground">
                Ask anything about this report. Try:
                <ul className="mt-2 space-y-1.5">
                  {["Which SOPs are most affected?", "What's the highest-risk change?", "Summarise Chapter 10A in 2 sentences."].map((s) => (
                    <li key={s}>
                      <button
                        onClick={() => setInput(s)}
                        className="text-left text-foreground hover:underline"
                      >• {s}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {messages.data?.map((m) => (
              <Bubble key={m.id} role={m.role} content={m.content} />
            ))}
            {streaming && <Bubble role="assistant" content={streaming} />}
          </div>

          <div className="p-4 border-t flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Ask about this report..."
              disabled={busy}
            />
            <Button onClick={submit} disabled={busy || !input.trim()} size="icon">
              <Send className="size-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Bubble({ role, content }: { role: string; content: string }) {
  const user = role === "user";
  return (
    <div className={cn("flex", user ? "justify-end" : "justify-start")}>
      <div className={cn(
        "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
        user ? "bg-primary text-primary-foreground" : "bg-muted"
      )}>
        {user ? content : <MD>{content}</MD>}
      </div>
    </div>
  );
}
