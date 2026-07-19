import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { listLegalMatters, createTemplateRequest, MATTER_TYPES, maskDemoEmail } from "@/lib/legal.functions";
import { LEGAL_TEMPLATES, blankTemplateHtml, downloadDoc, htmlToPlainText, type LegalTemplate } from "@/lib/legal.templates";
import { LegalHeader, VaultAgent, KnowledgeBasePanel, statusBadge, routeBadge } from "@/components/legal-widgets";
import { toast } from "sonner";
import { FileDown, Search, Vault, ChevronRight, Library, Loader2 } from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/legal/repository")({
  component: LegalRepository,
  head: () => ({ meta: [{ title: "Legal CMS · Repository" }] }),
});

// Executed / signed-off matters live in the vault.
const VAULT_STATUSES = new Set(["resolved", "approved", "archived"]);

function LegalRepository() {
  const listFn = useServerFn(listLegalMatters);
  const createTemplateFn = useServerFn(createTemplateRequest);
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [search, setSearch] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Requestor identity for tracked template downloads (mirrors legal.new.tsx).
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

  const { data: matters = [] } = useQuery({
    queryKey: ["legal-matters"],
    queryFn: () => listFn({ data: {} }),
    staleTime: 30_000,
  });

  // Every template download is tracked as a real matter + document — otherwise
  // the file leaves the system with no record, and there'd be nowhere to attach
  // counterparty markup if they send changes back.
  async function downloadAndTrack(t: LegalTemplate) {
    setDownloadingId(t.id);
    const html = blankTemplateHtml(t);
    downloadDoc(html, t.fileName);
    try {
      // Guard the narrow race where a template is clicked before auth.email has
      // resolved into requestorEmail — createTemplateRequest requires a valid email.
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
      toast.success(`${t.fileName} downloaded — tracked as ${matter.reference_number ?? "a new request"}`);
      queryClient.invalidateQueries({ queryKey: ["legal-matters"] });
    } catch (e: any) {
      toast.warning(`${t.fileName} downloaded, but couldn't create a tracked record: ${e?.message ?? "unknown error"}`);
    } finally {
      setDownloadingId(null);
    }
  }

  const q = search.trim().toLowerCase();
  const vault = matters
    .filter((m: any) => VAULT_STATUSES.has(m.status))
    .filter((m: any) => {
      if (!q) return true;
      const hay = `${m.title ?? ""} ${m.reference_number ?? ""} ${m.description ?? ""}`.toLowerCase();
      return hay.includes(q);
    });

  return (
    <AppShell>
      <div className="flex flex-col min-h-screen">
        <LegalHeader subtitle="Repository · library, vault & knowledge base" />

        <div className="flex-1 p-6 space-y-5">
          {/* Knowledge base + vault knowledge agent */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <VaultAgent />
            <KnowledgeBasePanel />
          </div>

          {/* Self-service template library (Route A), grouped by category */}
          <div className="rounded-xl border border-emerald-200/50 dark:border-emerald-900 bg-emerald-50/30 dark:bg-emerald-950/10 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <FileDown className="size-3.5 text-emerald-700 dark:text-emerald-300" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                Self-Service Templates
              </span>
              <span className="text-[10px] text-emerald-700/60 dark:text-emerald-400/60">
                Route A · pre-approved, use directly — no request needed
              </span>
            </div>
            <div className="space-y-1.5">
              {Array.from(new Set(LEGAL_TEMPLATES.map((t) => t.category))).map((cat) => (
                <div key={cat} className="flex items-start gap-2 flex-wrap">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700/70 dark:text-emerald-400/70 w-24 shrink-0 mt-1.5">{cat}</span>
                  <div className="flex items-center gap-1.5 flex-wrap flex-1">
                    {LEGAL_TEMPLATES.filter((t) => t.category === cat).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => downloadAndTrack(t)}
                        disabled={downloadingId === t.id}
                        title={t.description}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300/60 dark:border-emerald-800 bg-card px-2.5 py-1.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 transition-colors disabled:opacity-60"
                      >
                        {downloadingId === t.id ? <Loader2 className="size-3 animate-spin" /> : <FileDown className="size-3" />} {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* The vault — executed / signed-off matters */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b">
              <Vault className="size-3.5 text-indigo-600 dark:text-indigo-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Executed Documents</span>
              <span className="text-[10px] text-muted-foreground/60">word-searchable · access-controlled · {vault.length} record{vault.length !== 1 ? "s" : ""}</span>
              <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1 ml-auto">
                <Search className="size-3 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search the vault…"
                  className="text-[11px] bg-transparent border-0 focus:outline-none w-44 placeholder:text-muted-foreground/60"
                />
              </div>
            </div>
            {vault.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 text-center">
                <div className="size-12 rounded-xl bg-muted grid place-items-center mb-3">
                  <Library className="size-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">{q ? "No matching records" : "The vault is empty"}</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Resolved, approved and archived matters are filed here.</p>
              </div>
            ) : (
              <div className="divide-y">
                {vault.map((m: any) => (
                  <Link key={m.id} to="/legal/$matterId" params={{ matterId: m.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors group">
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">{m.reference_number ?? "—"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{m.title}</div>
                      {m.matter_type && (
                        <div className="text-[10px] text-muted-foreground">
                          {MATTER_TYPES.find((t) => t.value === m.matter_type)?.label ?? m.matter_type}
                        </div>
                      )}
                    </div>
                    {routeBadge(m.route)}
                    {statusBadge(m.status)}
                    <span className="text-[10px] text-muted-foreground shrink-0 hidden sm:inline w-24 text-right">
                      {m.completed_at ? format(new Date(m.completed_at), "d MMM yyyy") : m.approved_at ? format(new Date(m.approved_at), "d MMM yyyy") : ""}
                    </span>
                    <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
