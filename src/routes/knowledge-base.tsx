import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { ExternalLink, Eye, FileText, LayoutGrid, List, Loader2, Pencil, Plus, Trash2, Upload, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createSop, deleteSop, updateSop, reindexSop, getChunkCounts } from "@/lib/compliance.functions";
import { useWorkspace, WORKSPACES } from "@/lib/workspace";
import { autoDetectDocMeta, DOC_TYPE_LABEL, type DetectedDocType, type DetectedMeta } from "@/lib/auto-detect";
import { toast } from "sonner";

const DOC_TYPE_META: Record<string, { label: string; classes: string }> = {
  sop:       { label: "Internal SOP",        classes: "bg-blue-100 text-blue-900 border-blue-300" },
  rmit:      { label: "Old RMiT (legacy)",   classes: "bg-slate-200 text-slate-800 border-slate-300" },
  rmit_reg:  { label: "RMiT / Tech Reg",     classes: "bg-indigo-100 text-indigo-900 border-indigo-300" },
  fatf:      { label: "FATF / AML",          classes: "bg-rose-100 text-rose-900 border-rose-300" },
  circular:  { label: "Regulator Circular",  classes: "bg-amber-100 text-amber-900 border-amber-300" },
  it_policy: { label: "IT Policy",           classes: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  policy:    { label: "Policy",              classes: "bg-violet-100 text-violet-900 border-violet-300" },
};
function typeMeta(t: string) {
  return DOC_TYPE_META[t] ?? { label: t, classes: "bg-muted text-muted-foreground border-border" };
}

export const Route = createFileRoute("/knowledge-base")({
  component: KB,
  head: () => ({ meta: [{ title: "Knowledge Base · Compliance Sentinel" }] }),
});

function KB() {
  const qc = useQueryClient();
  const create = useServerFn(createSop);
  const remove = useServerFn(deleteSop);
  const update = useServerFn(updateSop);
  const reindex = useServerFn(reindexSop);
  const chunkCountsFn = useServerFn(getChunkCounts);
  const [open, setOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<any | null>(null);
  const [editDoc, setEditDoc] = useState<any | null>(null);
  const [view, setView] = useState<"cards" | "table">("table");
  const [reindexing, setReindexing] = useState<string | null>(null);
  const [bulkReindex, setBulkReindex] = useState<{ done: number; total: number } | null>(null);

  const [workspace] = useWorkspace();

  const sops = useQuery({
    queryKey: ["sops", workspace],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("sop_documents")
        .select("*")
        .eq("workspace_id", workspace)
        .order("is_active", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const chunkCounts = useQuery({
    queryKey: ["sop_chunk_counts", workspace],
    queryFn: async () => {
      const r = await chunkCountsFn({ data: { workspace } });
      return r.counts;
    },
  });

  async function handleReindex(id: string, title: string) {
    setReindexing(id);
    try {
      const r = await reindex({ data: { id } });
      if (r.chunkCount === 0) {
        toast.warning(`No content extracted from ${title}`, {
          description: "The source file may be image-based or use unsupported formatting. Check the source file directly.",
        });
      } else {
        toast.success(`${title} re-indexed`, { description: r.message });
      }
      // Force-refetch (invalidate alone doesn't always trigger immediate refetch in some TQ states)
      await qc.refetchQueries({ queryKey: ["sop_chunk_counts", workspace] });
    } catch (e: any) {
      toast.error("Re-index failed", { description: e?.message });
    } finally {
      setReindexing(null);
    }
  }

  async function handleReindexAllPdfs() {
    const docs = (sops.data ?? []).filter((s: any) => !!s.file_url);
    if (docs.length === 0) {
      toast.info("No documents with source files to re-index in this workspace");
      return;
    }
    if (!confirm(`Re-index ${docs.length} document${docs.length > 1 ? "s" : ""} with the latest chunker? This may take a few minutes.`)) return;

    setBulkReindex({ done: 0, total: docs.length });
    let success = 0;
    let failed = 0;
    for (let i = 0; i < docs.length; i++) {
      const s = docs[i];
      try {
        await reindex({ data: { id: s.id } });
        success++;
      } catch (e: any) {
        failed++;
        console.warn(`Re-index failed for ${s.title}:`, e?.message);
      }
      setBulkReindex({ done: i + 1, total: docs.length });
    }
    setBulkReindex(null);
    await qc.refetchQueries({ queryKey: ["sop_chunk_counts", workspace] });
    if (failed === 0) {
      toast.success(`Re-indexed ${success} document${success > 1 ? "s" : ""}`);
    } else {
      toast.warning(`Re-indexed ${success} of ${docs.length} documents · ${failed} failed (see console)`);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this SOP from the Knowledge Base?")) return;
    try {
      await remove({ data: { id } });
      toast.success("Removed from Knowledge Base");
      qc.invalidateQueries({ queryKey: ["sops"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to delete");
    }
  }

  return (
    <AppShell>
      <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-semibold">Knowledge Base</h1>
            <p className="text-muted-foreground mt-1">
              Internal SOPs and policies indexed for AI-driven gap analysis.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border p-1 bg-card">
              <button
                className={`px-2.5 py-1 text-xs rounded inline-flex items-center gap-1 ${view === "cards" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                onClick={() => setView("cards")}
              >
                <LayoutGrid className="size-3.5" /> Cards
              </button>
              <button
                className={`px-2.5 py-1 text-xs rounded inline-flex items-center gap-1 ${view === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                onClick={() => setView("table")}
              >
                <List className="size-3.5" /> Table
              </button>
            </div>
            <Button
              size="lg"
              variant="outline"
              className="gap-2"
              onClick={handleReindexAllPdfs}
              disabled={!!bulkReindex || !!reindexing}
              title="Re-chunk every document in this workspace (PDFs use the page-aware extractor; DOCX uses the deterministic text splitter)"
            >
              {bulkReindex ? (
                <><Loader2 className="size-4 animate-spin" /> Re-indexing {bulkReindex.done}/{bulkReindex.total}…</>
              ) : (
                <><RefreshCw className="size-4" /> Re-index all</>
              )}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="lg" className="gap-2">
                  <Plus className="size-4" /> Add Knowledge Base
                </Button>
              </DialogTrigger>
              <UploadDialog
                onCreated={() => {
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["sops"] });
                }}
                create={create}
              />
            </Dialog>
          </div>
        </div>

        {!sops.isLoading && (sops.data?.length ?? 0) === 0 && (
          <Card className="p-12 text-center border-dashed">
            <FileText className="size-10 mx-auto text-muted-foreground" />
            <h3 className="mt-4 font-semibold">Your Knowledge Base is empty</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Add your internal SOPs and policies. The AI will compare incoming
              regulations against everything you upload here.
            </p>
            <Button className="mt-4 gap-2" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> Add your first Document
            </Button>
          </Card>
        )}

        {view === "cards" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sops.data?.map((s: any) => (
              <Card key={s.id} className="p-5 hover:shadow-md transition-shadow group relative">
                <div className="flex items-start gap-3">
                  <div className="size-10 rounded-lg bg-accent grid place-items-center shrink-0">
                    <FileText className="size-5 text-accent-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`text-[10px] ${typeMeta(s.doc_type).classes}`}>
                        {typeMeta(s.doc_type).label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">v{s.version}</span>
                      {s.drive_file_id && (
                        <span
                          title={s.last_sync_error ? `Drive sync error: ${s.last_sync_error}` : "Synced from Google Drive"}
                          className={`inline-flex items-center text-[9px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border ${
                            s.last_sync_error
                              ? "bg-amber-100 text-amber-800 border-amber-200"
                              : "bg-blue-100 text-blue-800 border-blue-200"
                          }`}
                        >
                          {s.last_sync_error ? "Drive · error" : "Drive"}
                        </span>
                      )}
                    </div>
                    <h3 className="font-semibold mt-1.5 leading-snug">{s.title}</h3>
                    {s.summary && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-3">{s.summary}</p>
                    )}
                    <div className="flex flex-wrap gap-1 mt-3">
                      {(s.tags as string[])?.map((t) => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-4">
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={!s.file_url} onClick={() => setPreviewDoc(s)}>
                        <Eye className="size-3.5" /> Preview
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={!s.file_url} asChild={!!s.file_url}>
                        {s.file_url ? (
                          <a href={s.file_url} target="_blank" rel="noreferrer">
                            <ExternalLink className="size-3.5" /> Open
                          </a>
                        ) : (
                          <span><ExternalLink className="size-3.5" /> Open</span>
                        )}
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditDoc(s)}>
                        <Pencil className="size-3.5" /> Edit
                      </Button>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => handleDelete(s.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-[160px]">Type</TableHead>
                  <TableHead className="w-[70px]">Version</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead className="w-[110px]">Index</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="w-[160px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sops.data?.map((s: any) => (
                  <TableRow key={s.id} className="align-middle">
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        {s.title}
                        {s.drive_file_id && (
                          <span
                            title={s.last_sync_error ? `Drive sync error: ${s.last_sync_error}` : "Synced from Google Drive"}
                            className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border ${
                              s.last_sync_error
                                ? "bg-amber-100 text-amber-800 border-amber-200"
                                : "bg-blue-100 text-blue-800 border-blue-200"
                            }`}
                          >
                            {s.last_sync_error ? "Drive · error" : "Drive"}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${typeMeta(s.doc_type).classes}`}>
                        {typeMeta(s.doc_type).label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">v{s.version}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(s.tags as string[])?.map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const count = chunkCounts.data?.[s.id] ?? 0;
                        if (chunkCounts.isLoading) return <Loader2 className="size-3 animate-spin text-muted-foreground" />;
                        if (count === 0) {
                          return (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
                              <AlertTriangle className="size-2.5" /> Not indexed
                            </span>
                          );
                        }
                        return (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                            <CheckCircle2 className="size-2.5" /> {count} chunks
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                      {s.summary ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          title="Re-index (re-chunk + re-embed)"
                          disabled={!s.file_url || reindexing === s.id}
                          onClick={() => handleReindex(s.id, s.title)}
                        >
                          {reindexing === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8" disabled={!s.file_url} onClick={() => setPreviewDoc(s)}>
                          <Eye className="size-3.5" />
                        </Button>
                        {s.file_url ? (
                          <Button size="icon" variant="ghost" className="size-8" asChild>
                            <a href={s.file_url} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        ) : (
                          <Button size="icon" variant="ghost" className="size-8" disabled>
                            <ExternalLink className="size-3.5" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditDoc(s)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(s.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        <DocumentPreview doc={previewDoc} onOpenChange={(v: boolean) => !v && setPreviewDoc(null)} />
        <EditSopDialog
          doc={editDoc}
          update={update}
          onOpenChange={(v: boolean) => !v && setEditDoc(null)}
          onSaved={() => {
            setEditDoc(null);
            qc.invalidateQueries({ queryKey: ["sops"] });
          }}
        />
      </div>
    </AppShell>
  );
}

function getFileExtension(url?: string | null) {
  const clean = (url ?? "").split("?")[0].toLowerCase();
  return clean.includes(".") ? clean.split(".").pop() ?? "" : "";
}

function canPreviewInline(url?: string | null) {
  return ["pdf", "png", "jpg", "jpeg", "webp", "gif", "txt"].includes(getFileExtension(url));
}

function DocumentPreview({ doc, onOpenChange }: { doc: any | null; onOpenChange: (open: boolean) => void }) {
  const fileUrl = doc?.file_url as string | undefined;
  const previewable = canPreviewInline(fileUrl);

  return (
    <Dialog open={!!doc} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{doc?.title ?? "Document preview"}</DialogTitle>
          <DialogDescription>
            Review the uploaded Knowledge Base document. Office files may need to be opened in a new tab.
          </DialogDescription>
        </DialogHeader>
        {fileUrl && previewable ? (
          <iframe title={doc?.title ?? "Document preview"} src={fileUrl} className="h-[75vh] w-full rounded-md border bg-background" />
        ) : (
          <div className="rounded-md border bg-muted/30 p-6 text-sm text-muted-foreground">
            Inline preview is not available for this file type.
            {fileUrl && (
              <Button variant="outline" className="mt-4 gap-2" asChild>
                <a href={fileUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Open in new tab
                </a>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditSopDialog({
  doc,
  update,
  onOpenChange,
  onSaved,
}: {
  doc: any | null;
  update: ReturnType<typeof useServerFn<typeof updateSop>>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState<DetectedDocType | "sop" | "rmit">("sop");
  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title ?? "");
    setDocType((doc.doc_type ?? "sop") as DetectedDocType | "sop" | "rmit");
    setSummary(doc.summary ?? "");
    setTags(((doc.tags as string[]) ?? []).join(", "));
    setFile(null);
  }, [doc]);

  async function submit() {
    if (!doc || !title.trim()) return;
    setBusy(true);
    try {
      let fileUrl: string | null | undefined = undefined;
      if (file) {
        const path = `kb/${Date.now()}-${file.name}`;
        const up = await supabase.storage.from("policies").upload(path, file, {
          upsert: false,
          contentType: file.type,
        });
        if (up.error) throw up.error;
        const { data } = supabase.storage.from("policies").getPublicUrl(path);
        fileUrl = data.publicUrl;
      }
      const result = await update({
        data: {
          id: doc.id,
          title: title.trim(),
          doc_type: docType,
          summary: summary.trim() || undefined,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          file_url: fileUrl,
        },
      });
      toast.success(`Document updated · version bumped to v${result.version}`);
      setTitle("");
      setSummary("");
      setTags("");
      setFile(null);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update document");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!doc} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Document</DialogTitle>
          <DialogDescription>Every saved edit automatically bumps the version number.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Title *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Document type</Label>
              <Select value={docType} onValueChange={(v) => setDocType(v as DetectedDocType | "sop" | "rmit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sop">Internal SOP</SelectItem>
                  <SelectItem value="rmit_reg">{DOC_TYPE_LABEL.rmit_reg}</SelectItem>
                  <SelectItem value="fatf">{DOC_TYPE_LABEL.fatf}</SelectItem>
                  <SelectItem value="circular">{DOC_TYPE_LABEL.circular}</SelectItem>
                  <SelectItem value="it_policy">{DOC_TYPE_LABEL.it_policy}</SelectItem>
                  <SelectItem value="policy">{DOC_TYPE_LABEL.policy}</SelectItem>
                  <SelectItem value="rmit">Old RMiT (legacy)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Replacement file</Label>
              <Input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.txt,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <div>
            <Label>Manual edit notes / summary</Label>
            <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div>
            <Label>Tags</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="cyber, incident, policy" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="gap-2">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save &amp; Bump Version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({
  create,
  onCreated,
}: {
  create: ReturnType<typeof useServerFn<typeof createSop>>;
  onCreated: () => void;
}) {
  const [files, setFiles] = useState<Array<{ file: File; meta: DetectedMeta }>>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [workspace] = useWorkspace();

  function handleFiles(selectedFiles: FileList | null) {
    if (!selectedFiles) return;
    const newFiles = Array.from(selectedFiles).map((f) => ({
      file: f,
      meta: autoDetectDocMeta(f.name),
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    if (files.length === 0) {
      toast.error("Please select at least one file");
      return;
    }
    setBusy(true);
    setProgress({ current: 0, total: files.length });

    try {
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        setProgress({ current: i + 1, total: files.length });

        let fileUrl: string | null = null;
        const path = `kb/${Date.now()}-${item.file.name}`;
        
        const up = await supabase.storage.from("policies").upload(path, item.file, {
          upsert: false,
          contentType: item.file.type,
        });

        if (!up.error) {
          const { data } = supabase.storage.from("policies").getPublicUrl(path);
          fileUrl = data.publicUrl;
        }

        await create({
          data: {
            title: item.meta.title,
            doc_type: item.meta.doc_type,
            version: item.meta.version,
            workspace,
            summary: item.meta.summary,
            tags: item.meta.tags,
            file_url: fileUrl,
          },
        });
      }

      toast.success(`Successfully added ${files.length} documents to Knowledge Base`);
      setFiles([]);
      onCreated();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to add one or more documents");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
      <DialogHeader>
        <DialogTitle>Add to Knowledge Base</DialogTitle>
        <DialogDescription>
          Upload multiple internal policies, SOPs, or legacy regulations. Metadata will be auto-detected.
        </DialogDescription>
      </DialogHeader>

      <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-1">
        <div
          className="border-2 border-dashed rounded-xl p-10 text-center hover:bg-muted/50 transition-colors cursor-pointer group"
          onClick={() => document.getElementById("batch-upload")?.click()}
        >
          <Upload className="size-10 mx-auto text-muted-foreground group-hover:text-primary transition-colors" />
          <p className="mt-3 text-sm font-semibold">Click to select multiple files</p>
          <p className="text-xs text-muted-foreground mt-1">PDF or DOCX supported</p>
          <input
            id="batch-upload"
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.xlsx,.xls"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold px-1">
              Files to upload ({files.length})
            </Label>
            <div className="grid gap-2">
              {files.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-4 rounded-xl border bg-card/50 hover:bg-card transition-colors text-sm group"
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <FileText className="size-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate pr-4" title={item.meta.title}>
                        {item.meta.title}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-[10px] py-0 px-2 h-5 font-normal">
                          {DOC_TYPE_LABEL[item.meta.doc_type]}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">v{item.meta.version}</span>
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => removeFile(idx)}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="pt-4 border-t mt-auto">
        {progress && (
          <div className="space-y-2 mb-4 px-1">
            <div className="flex justify-between text-xs font-semibold">
              <span className="text-primary">Uploading documents...</span>
              <span>
                {progress.current} of {progress.total}
              </span>
            </div>
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onCreated()} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || files.length === 0} className="gap-2 min-w-[120px]">
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Upload className="size-4" />
                Upload All
              </>
            )}
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  );
}
