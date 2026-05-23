import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Layers, Plus, Loader2, Trash2, ArrowRight } from "lucide-react";
import {
  createLayoutJob,
  listLayoutJobs,
  deleteLayoutJob,
} from "@/lib/layout.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/layout/")({
  component: LayoutIndex,
  head: () => ({ meta: [{ title: "Layouts · AI Document Workflow" }] }),
});

const STATUS_META: Record<
  string,
  { label: string; tone: "slate" | "blue" | "amber" | "emerald" | "rose" }
> = {
  uploaded: { label: "Uploaded — needs digitizing", tone: "slate" },
  digitizing: { label: "Digitizing…", tone: "blue" },
  pending_frame_approval: { label: "Frame awaiting approval", tone: "amber" },
  frame_approved: { label: "Frame approved — ready for fixtures", tone: "blue" },
  placing_fixtures: { label: "Placing fixtures…", tone: "blue" },
  pending_placement_review: { label: "Placements awaiting review", tone: "amber" },
  approved: { label: "Approved", tone: "emerald" },
};

function LayoutIndex() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useServerFn(listLayoutJobs);
  const create = useServerFn(createLayoutJob);
  const del = useServerFn(deleteLayoutJob);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const jobs = useQuery({
    queryKey: ["layout_jobs"],
    queryFn: () => list(),
  });

  async function startJob() {
    const title = newTitle.trim();
    if (!title) {
      toast.error("Give the layout a title first");
      return;
    }
    setCreating(true);
    try {
      const job = await create({ data: { title } });
      setNewTitle("");
      qc.invalidateQueries({ queryKey: ["layout_jobs"] });
      navigate({ to: "/layout/$jobId", params: { jobId: job.id } });
    } catch (e: any) {
      toast.error("Could not create job", { description: e?.message });
    } finally {
      setCreating(false);
    }
  }

  async function removeJob(id: string, title: string) {
    if (!confirm(`Delete layout "${title}"? This removes its sketch, frame and placements.`)) return;
    try {
      await del({ data: { jobId: id } });
      toast.success(`Deleted "${title}"`);
      qc.invalidateQueries({ queryKey: ["layout_jobs"] });
    } catch (e: any) {
      toast.error("Could not delete", { description: e?.message });
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-[1400px] mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold flex items-center gap-3">
              <Layers className="size-7 text-orange-600" />
              Retail Layout Planner
            </h1>
            <p className="text-muted-foreground mt-1">
              Digitize a hand-drawn sketch, approve the frame, and let the rules
              engine place fixtures.
            </p>
          </div>
        </div>

        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">New layout</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Start with a name. You'll upload the sketch on the next screen.
          </p>
          <div className="mt-4 flex gap-2">
            <Input
              placeholder='e.g. "Petronas KL Sentral — refit Jul 2026"'
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startJob(); }}
              disabled={creating}
              className="flex-1"
            />
            <Button onClick={startJob} disabled={creating || !newTitle.trim()} className="gap-2">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create
            </Button>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Existing layouts</h2>
          {jobs.isLoading ? (
            <div className="mt-6 text-sm text-muted-foreground inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : !jobs.data?.length ? (
            <div className="mt-6 rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No layouts yet. Create one above to begin.
            </div>
          ) : (
            <div className="mt-4 divide-y rounded-md border">
              {jobs.data.map((j) => {
                const meta = STATUS_META[j.status] ?? { label: j.status, tone: "slate" as const };
                return (
                  <Link
                    key={j.id}
                    to="/layout/$jobId"
                    params={{ jobId: j.id }}
                    className="flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{j.title}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                        <span className={badgeClass(meta.tone)}>{meta.label}</span>
                        {j.store_type && <span>· {j.store_type}</span>}
                        <span>· {new Date(j.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeJob(j.id, j.title); }}
                      className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete layout"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                    <ArrowRight className="size-4 text-muted-foreground opacity-60" />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

function badgeClass(tone: "slate" | "blue" | "amber" | "emerald" | "rose"): string {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide";
  switch (tone) {
    case "blue":
      return `${base} bg-blue-100 text-blue-800`;
    case "amber":
      return `${base} bg-amber-100 text-amber-800`;
    case "emerald":
      return `${base} bg-emerald-100 text-emerald-800`;
    case "rose":
      return `${base} bg-rose-100 text-rose-800`;
    default:
      return `${base} bg-slate-100 text-slate-700`;
  }
}
