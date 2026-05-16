import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { updateImpact } from "@/lib/compliance.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MD } from "@/components/md";
import { changeTypeMeta, statusMeta } from "@/lib/format";
import { 
  CheckCircle2, XCircle, UserCheck, AlertTriangle, 
  FileText, MapPin, Sparkles, ArrowRight, Info
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function ImpactsTab({ reportId }: { reportId: string }) {
  const qc = useQueryClient();
  const upd = useServerFn(updateImpact);
  const impacts = useQuery({
    queryKey: ["impacts", reportId],
    queryFn: async () => {
      const { data } = await supabase
        .from("sop_impacts")
        .select("*")
        .eq("report_id", reportId)
        .order("position");
      return data ?? [];
    },
  });
  const sops = useQuery({
    queryKey: ["sop_documents_all"],
    queryFn: async () => {
      const { data } = await supabase.from("sop_documents").select("id,title,doc_type,version,file_url");
      return data ?? [];
    },
  });
  const sopById = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of sops.data ?? []) m.set(s.id, s);
    return m;
  }, [sops.data]);

  async function setStatus(id: string, status: "approved" | "rejected" | "routed") {
    await upd({ data: { id, status } });
    toast.success(`Impact marked as ${status}`);
    qc.invalidateQueries({ queryKey: ["impacts", reportId] });
  }

  const sortedImpacts = useMemo(() => {
    const list = [...(impacts.data ?? [])];
    const order = { pending: 0, routed: 1, approved: 2, rejected: 3 };
    return list.sort((a, b) => {
      const sA = a.status || "pending";
      const sB = b.status || "pending";
      if (order[sA as keyof typeof order] !== order[sB as keyof typeof order]) {
        return order[sA as keyof typeof order] - order[sB as keyof typeof order];
      }
      return (a.position ?? 0) - (b.position ?? 0);
    });
  }, [impacts.data]);

  if (impacts.isLoading)
    return (
      <div className="flex flex-col items-center justify-center p-20 space-y-4">
        <div className="size-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        <div className="text-sm font-medium text-muted-foreground animate-pulse">Calculating specific SOP impacts...</div>
      </div>
    );

  const unmatchedCount = (impacts.data ?? []).filter((i: any) => !i.sop_id).length;
  const showKbHint = unmatchedCount > 0;

  return (
    <div className="max-w-[1200px] mx-auto space-y-8 animate-in-fade">
      {showKbHint && (
        <Card className="p-6 border-amber-500/20 bg-amber-500/[0.03] dark:bg-amber-500/[0.05] relative overflow-hidden group transition-all hover:bg-amber-500/[0.05]">
          <div className="flex items-start gap-4">
            <div className="size-10 rounded-xl bg-amber-500/10 grid place-items-center shrink-0">
              <AlertTriangle className="size-5 text-amber-600" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-amber-900 dark:text-amber-400">Knowledge Base Gap Detected</h4>
              <p className="text-xs text-amber-800/70 dark:text-amber-400/70 leading-relaxed max-w-2xl">
                <span className="font-bold">{unmatchedCount}</span> changes could not be mapped to existing files. 
                Upload missing policies to the <span className="underline font-bold">Knowledge Base</span> to enable automated impact logic for these clauses.
              </p>
            </div>
          </div>
        </Card>
      )}
      
      <div className="grid grid-cols-1 gap-6">
        {sortedImpacts.map((imp, idx) => (
          <ImpactCard
            key={imp.id}
            index={idx}
            impact={imp}
            sopDoc={imp.sop_id ? sopById.get(imp.sop_id) : undefined}
            onStatus={(s) => setStatus(imp.id, s)}
            onEdit={async (text) => {
              await upd({ data: { id: imp.id, edited_text: text } });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ImpactCard({
  impact, sopDoc, index, onStatus, onEdit,
}: {
  impact: any;
  index: number;
  sopDoc?: { title: string; doc_type?: string; version?: string; file_url?: string | null };
  onStatus: (s: "approved" | "rejected" | "routed") => void;
  onEdit: (text: string) => Promise<void>;
}) {
  const meta = changeTypeMeta(impact.change_type);
  const stat = statusMeta(impact.status);
  
  const statusColors = {
    approved: "border-emerald-500/30 bg-emerald-500/[0.02] dark:bg-emerald-500/[0.05]",
    rejected: "opacity-60 grayscale border-slate-200 dark:border-slate-800",
    routed: "border-amber-500/30 bg-amber-500/[0.02] dark:bg-amber-500/[0.05]",
    pending: "glass-card",
  };

  const currentStatus = impact.status || "pending";
  const isInsert = impact.change_type === "insertion" || impact.change_type === "new_section";
  const fileLabel = sopDoc?.title ?? impact.sop_title;

  return (
    <Card className={cn(
      "p-0 overflow-hidden transition-all duration-300", 
      statusColors[currentStatus as keyof typeof statusColors]
    )}>
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="flex-1 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="size-6 rounded bg-primary/10 text-primary grid place-items-center text-[10px] font-black">
                {String(index + 1).padStart(2, '0')}
              </div>
              <Badge variant="outline" className={cn("rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider", meta.classes)}>
                {meta.label}
              </Badge>
              <Badge variant="outline" className={cn("rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider", stat.classes)}>
                {stat.label}
              </Badge>
            </div>
            
            <h3 className="font-display text-2xl font-bold tracking-tight">{impact.sop_title}</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-slate-100 dark:border-slate-800 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="size-3 text-muted-foreground" />
                  <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">Target Document</span>
                </div>
                <div className="font-bold text-sm truncate">
                  {sopDoc?.file_url ? (
                    <a href={sopDoc.file_url} target="_blank" rel="noreferrer" className="text-primary hover:underline underline-offset-4">
                      {fileLabel}
                    </a>
                  ) : fileLabel}
                </div>
                <div className="text-[10px] font-medium opacity-60 mt-1">
                  {[sopDoc?.doc_type, sopDoc?.version ? `v${sopDoc.version}` : null].filter(Boolean).join(" · ") || "External File Reference"}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-slate-100 dark:border-slate-800 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <MapPin className="size-3 text-muted-foreground" />
                  <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">Location Context</span>
                </div>
                <div className="font-bold text-sm">
                  {impact.chapter || "Global Context"}
                  {impact.paragraph ? ` · ${impact.paragraph}` : ""}
                </div>
                <div className="text-[10px] font-medium opacity-60 mt-1">
                  {impact.page ? `Page ${impact.page}` : "Pos. Undefined"}
                  {impact.line_range ? ` · Line ~${impact.line_range}` : ""}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-row md:flex-col gap-2 shrink-0">
            <ActionButton 
              active={currentStatus === "approved"}
              variant="success" 
              icon={CheckCircle2} 
              label="Approve" 
              onClick={() => onStatus("approved")} 
            />
            <ActionButton 
              active={currentStatus === "routed"}
              variant="warning" 
              icon={UserCheck} 
              label="Route" 
              onClick={() => onStatus("routed")} 
            />
            <ActionButton 
              active={currentStatus === "rejected"}
              variant="danger" 
              icon={XCircle} 
              label="Reject" 
              onClick={() => onStatus("rejected")} 
            />
          </div>
        </div>

        {impact.warning && (
          <div className="mt-8 flex items-start gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
            <Info className="size-4 mt-0.5 shrink-0" />
            <div className="text-xs font-medium leading-relaxed">{impact.warning}</div>
          </div>
        )}

        <div className="mt-8 grid grid-cols-1 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-black text-muted-foreground/60">
              <ArrowRight className="size-3 rotate-180" /> Original Text Segment
            </div>
            <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm leading-relaxed opacity-70 italic font-medium">
              <MD>{impact.find_text}</MD>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-black text-primary">
                <Sparkles className="size-3" /> {isInsert ? "Draft Insertion" : "Draft Amendment"}
              </div>
              <div className="text-[9px] font-bold text-muted-foreground/50 italic">(Double-click to refine draft)</div>
            </div>
            <div
              contentEditable
              suppressContentEditableWarning
              onBlur={async (e) => {
                const v = e.currentTarget.innerText;
                if (v && v !== (impact.edited_text ?? impact.replace_text)) {
                  await onEdit(v);
                  toast.success("Draft amendment saved");
                }
              }}
              className="p-6 rounded-2xl bg-primary/[0.03] border border-primary/20 text-sm leading-relaxed font-bold focus:outline-none focus:ring-4 focus:ring-primary/10 transition-all cursor-text min-h-[80px]"
            >
              <MD>{impact.edited_text ?? impact.replace_text}</MD>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActionButton({ 
  label, icon: Icon, onClick, variant, active 
}: { 
  label: string; icon: any; onClick: () => void; variant: "success" | "warning" | "danger"; active: boolean;
}) {
  const themes = {
    success: "hover:bg-emerald-500 hover:text-white border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
    warning: "hover:bg-amber-500 hover:text-white border-amber-500/20 text-amber-600 dark:text-amber-400",
    danger: "hover:bg-red-500 hover:text-white border-red-500/20 text-red-600 dark:text-red-400",
  };

  const activeThemes = {
    success: "bg-emerald-500 text-white border-emerald-500",
    warning: "bg-amber-500 text-white border-amber-500",
    danger: "bg-red-500 text-white border-red-500",
  };

  return (
    <Button 
      variant="outline" 
      size="sm" 
      onClick={onClick}
      className={cn(
        "h-10 px-4 rounded-xl font-bold text-[11px] uppercase tracking-wider transition-all gap-2",
        active ? activeThemes[variant] : themes[variant]
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  );
}
