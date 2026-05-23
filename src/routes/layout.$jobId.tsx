import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { LayoutSvg } from "@/components/layout-svg";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  XCircle,
  Wand2,
  FileImage,
  Info,
  Coins,
  Download,
  FileCode,
} from "lucide-react";
import { computeCost, formatTokens, formatUsd, GEMINI_PRICE, type RunCost } from "@/lib/pricing";
import { dxfFromLayout, downloadDxf, downloadPdfFromElement } from "@/lib/layout/export";
import {
  getLayoutJob,
  uploadLayoutSketch,
  digitizeLayoutSketch,
  approveLayoutFrame,
  placeLayoutFixtures,
  setLayoutPlacementStatus,
  approveAllLayoutPlacements,
} from "@/lib/layout.functions";
import { cn } from "@/lib/utils";
import {
  STORE_RECIPES,
  STORE_TYPE_META,
  fixtureByCode,
} from "@/lib/layout/fixtures";
import type { StoreType } from "@/lib/layout/types";
import { toast } from "sonner";

export const Route = createFileRoute("/layout/$jobId")({
  component: LayoutJobPage,
  head: () => ({ meta: [{ title: "Layout · AI Document Workflow" }] }),
});

function LayoutJobPage() {
  const { jobId } = Route.useParams();
  const qc = useQueryClient();
  const fetchJob = useServerFn(getLayoutJob);
  const upload = useServerFn(uploadLayoutSketch);
  const digitize = useServerFn(digitizeLayoutSketch);
  const approveFrame = useServerFn(approveLayoutFrame);
  const place = useServerFn(placeLayoutFixtures);
  const setPlacement = useServerFn(setLayoutPlacementStatus);
  const approveAll = useServerFn(approveAllLayoutPlacements);

  const [busy, setBusy] = useState<string | null>(null);
  const [storeType, setStoreType] = useState<StoreType>("standard");
  const fileRef = useRef<HTMLInputElement>(null);

  const q = useQuery({
    queryKey: ["layout_job", jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      // Light polling only while AI is mid-extraction.
      return status === "digitizing" ? 2000 : false;
    },
  });

  useEffect(() => {
    if (q.data?.job.store_type) setStoreType(q.data.job.store_type as StoreType);
  }, [q.data?.job.store_type]);

  if (q.isLoading) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-muted-foreground inline-flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading layout…
        </div>
      </AppShell>
    );
  }
  if (q.error || !q.data) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-rose-600">Could not load layout: {(q.error as any)?.message}</div>
      </AppShell>
    );
  }

  const { job, frame, placements } = q.data;
  const status = job.status;
  const approvedPlacements = placements.filter((p) => p.status === "approved");
  const pendingPlacements = placements.filter((p) => p.status === "pending");
  const rejectedPlacements = placements.filter((p) => p.status === "rejected");

  // ── Handlers ──────────────────────────────────────────────────────

  async function onPickFile(file: File) {
    setBusy("upload");
    try {
      const path = `layout/${jobId}/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, "_")}`;
      const up = await supabase.storage.from("policies").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      });
      if (up.error) throw new Error(up.error.message);
      const publicUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
      await upload({ data: { jobId, fileUrl: publicUrl, mimeType: file.type || "image/png" } });
      toast.success("Sketch uploaded — ready to digitize");
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Upload failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function onDigitize() {
    setBusy("digitize");
    try {
      await digitize({ data: { jobId } });
      toast.success("Frame extracted — review and approve");
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Digitization failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function onApproveFrame() {
    setBusy("approve_frame");
    try {
      await approveFrame({ data: { jobId } });
      toast.success("Frame approved");
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Could not approve", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function onPlaceFixtures() {
    setBusy("place");
    try {
      await place({ data: { jobId, storeType } });
      toast.success(`Fixtures placed for ${STORE_TYPE_META[storeType].name}`);
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Placement failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  async function togglePlacement(id: string, next: "approved" | "rejected" | "pending") {
    try {
      await setPlacement({ data: { placementId: id, status: next } });
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Could not update", { description: e?.message });
    }
  }

  async function onApproveAll() {
    setBusy("approve_all");
    try {
      await approveAll({ data: { jobId } });
      toast.success("Layout finalized");
      qc.invalidateQueries({ queryKey: ["layout_job", jobId] });
    } catch (e: any) {
      toast.error("Could not finalize", { description: e?.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-[1600px] mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link to="/layout" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold truncate">{job.title}</h1>
            <div className="text-xs text-muted-foreground mt-0.5">Status: <StatusBadge status={status} /></div>
          </div>
        </div>

        {/* Stage 1: Upload */}
        {status === "uploaded" && (
          <UploadStage
            sketchUrl={job.sketch_drive_url}
            busy={busy}
            onPick={() => fileRef.current?.click()}
            onDigitize={onDigitize}
          />
        )}

        {status === "digitizing" && (
          <Card className="p-12 text-center">
            <Loader2 className="size-8 text-blue-600 animate-spin mx-auto" />
            <div className="mt-4 font-semibold">Extracting frame from sketch…</div>
            <div className="text-sm text-muted-foreground mt-1">
              Gemini Vision is identifying walls, openings, and dimensions. Usually 15-30 seconds.
            </div>
          </Card>
        )}

        {/* Stage 2: Frame approval */}
        {status === "pending_frame_approval" && frame && (
          <FrameApprovalStage
            sketchUrl={job.sketch_drive_url}
            frame={frame}
            jobTitle={job.title}
            busy={busy}
            onApprove={onApproveFrame}
            onRedigitize={onDigitize}
          />
        )}

        {/* Stage 3: Pick store type + place fixtures */}
        {(status === "frame_approved" || status === "placing_fixtures") && frame && (
          <PickStoreTypeStage
            frame={frame}
            storeType={storeType}
            setStoreType={setStoreType}
            busy={busy}
            placing={status === "placing_fixtures"}
            onPlace={onPlaceFixtures}
          />
        )}

        {/* Stage 4: Placement review */}
        {status === "pending_placement_review" && frame && (
          <PlacementReviewStage
            frame={frame}
            placements={placements}
            approved={approvedPlacements}
            pending={pendingPlacements}
            rejected={rejectedPlacements}
            busy={busy}
            jobTitle={job.title}
            onToggle={togglePlacement}
            onRePlace={onPlaceFixtures}
            onApproveAll={onApproveAll}
            storeType={storeType}
          />
        )}

        {/* Stage 5: Approved */}
        {status === "approved" && frame && (
          <ApprovedStage
            frame={frame}
            placements={placements}
            storeType={(job.store_type ?? "standard") as StoreType}
            jobTitle={job.title}
            onRePlace={() => {
              setBusy("reset");
              place({ data: { jobId, storeType: (job.store_type ?? "standard") as StoreType } })
                .then(() => qc.invalidateQueries({ queryKey: ["layout_job", jobId] }))
                .finally(() => setBusy(null));
            }}
          />
        )}

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickFile(f);
            e.target.value = "";
          }}
        />
      </div>
    </AppShell>
  );
}

// ── Stage components ───────────────────────────────────────────────

function UploadStage({
  sketchUrl,
  busy,
  onPick,
  onDigitize,
}: {
  sketchUrl: string | null;
  busy: string | null;
  onPick: () => void;
  onDigitize: () => void;
}) {
  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-semibold inline-flex items-center gap-2">
        <FileImage className="size-5 text-orange-600" /> Upload the sketch
      </h2>
      <p className="text-sm text-muted-foreground mt-1">
        A phone photo, PDF scan, or PNG of the hand-drawn floor plan. The AI extracts walls, openings and dimensions.
      </p>

      {sketchUrl ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-md border bg-muted/20 p-3">
            <img src={sketchUrl} alt="Uploaded sketch" className="max-h-[480px] mx-auto" />
          </div>
          <div className="flex gap-2">
            <Button onClick={onDigitize} disabled={busy === "digitize"} className="gap-2 bg-orange-600 hover:bg-orange-700">
              {busy === "digitize" ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              Digitize sketch with AI
            </Button>
            <Button variant="outline" onClick={onPick} disabled={busy === "upload"} className="gap-2">
              <Upload className="size-4" /> Replace sketch
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={onPick}
          disabled={busy === "upload"}
          className="mt-4 w-full rounded-md border-2 border-dashed border-orange-300 bg-orange-50/50 px-6 py-12 text-center hover:border-orange-500 hover:bg-orange-100/50 transition-colors disabled:opacity-50"
        >
          {busy === "upload" ? (
            <Loader2 className="size-8 mx-auto animate-spin text-orange-600" />
          ) : (
            <Upload className="size-8 mx-auto text-orange-600" />
          )}
          <div className="mt-3 font-medium text-orange-900">
            {busy === "upload" ? "Uploading…" : "Click to upload sketch"}
          </div>
          <div className="text-xs text-orange-700/70 mt-1">PNG, JPEG, WebP or PDF · up to 10 MB</div>
        </button>
      )}
    </Card>
  );
}

function FrameApprovalStage({
  sketchUrl,
  frame,
  jobTitle,
  busy,
  onApprove,
  onRedigitize,
}: {
  sketchUrl: string | null;
  frame: NonNullable<ReturnType<typeof useQuery<any, any>>["data"]>;
  jobTitle: string;
  busy: string | null;
  onApprove: () => void;
  onRedigitize: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<null | "pdf" | "dxf">(null);

  async function exportFramePdf() {
    if (!frameRef.current) return;
    setExporting("pdf");
    try {
      await downloadPdfFromElement(
        frameRef.current,
        jobTitle,
        `AI-extracted frame · ${Math.round(frame.ai_confidence ?? 0)}% confidence · ${(frame.geometry?.totalAreaSqm ?? 0).toFixed(1)} m²`,
        `${jobTitle}_frame`,
      );
    } catch (e: any) {
      toast.error("PDF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  function exportFrameDxf() {
    setExporting("dxf");
    try {
      const dxf = dxfFromLayout(frame.geometry, []);
      downloadDxf(dxf, `${jobTitle}_frame`);
      toast.success("DXF exported", { description: "Open in AutoCAD, LibreCAD or FreeCAD" });
    } catch (e: any) {
      toast.error("DXF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-4">
        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
          Original sketch
        </div>
        {sketchUrl ? (
          <img src={sketchUrl} alt="Original sketch" className="w-full max-h-[640px] object-contain" />
        ) : (
          <div className="text-sm text-muted-foreground">No sketch attached.</div>
        )}
      </Card>
      <Card className="p-4">
        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            AI-extracted frame
            {(frame.ai_input_tokens ?? 0) > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground/60 hover:text-foreground transition-colors"
                    aria-label="Token usage and cost"
                  >
                    <Info className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 text-xs">
                  <FrameCostBreakdown frame={frame} />
                </PopoverContent>
              </Popover>
            )}
          </span>
          {frame.ai_confidence !== null && (
            <span className={cn(
              "text-[10px] font-bold uppercase rounded-full px-2 py-0.5",
              (frame.ai_confidence ?? 0) >= 80
                ? "bg-emerald-100 text-emerald-800"
                : (frame.ai_confidence ?? 0) >= 60
                  ? "bg-amber-100 text-amber-800"
                  : "bg-rose-100 text-rose-800",
            )}>
              {Math.round(frame.ai_confidence ?? 0)}% confidence
            </span>
          )}
        </div>
        <div ref={frameRef} className="rounded-md border bg-slate-50 p-2 max-h-[640px] overflow-hidden">
          <LayoutSvg frame={frame.geometry} />
        </div>
        {frame.ai_reasoning && (
          <div className="mt-3 text-xs text-muted-foreground italic border-l-2 border-orange-300 pl-2">
            {frame.ai_reasoning}
          </div>
        )}
        <div className="mt-4 flex gap-2 flex-wrap">
          <Button
            onClick={onApprove}
            disabled={busy === "approve_frame"}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700"
          >
            {busy === "approve_frame" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Approve frame
          </Button>
          <Button
            variant="outline"
            onClick={onRedigitize}
            disabled={busy === "digitize"}
            className="gap-2"
          >
            {busy === "digitize" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Re-digitize
          </Button>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={exportFramePdf}
              disabled={exporting !== null}
              className="gap-1.5"
              title="Export the extracted frame as a PDF"
            >
              {exporting === "pdf" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              PDF
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={exportFrameDxf}
              disabled={exporting !== null}
              className="gap-1.5"
              title="Export as DXF — open in AutoCAD / LibreCAD / FreeCAD"
            >
              {exporting === "dxf" ? <Loader2 className="size-3.5 animate-spin" /> : <FileCode className="size-3.5" />}
              DXF
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function PickStoreTypeStage({
  frame,
  storeType,
  setStoreType,
  busy,
  placing,
  onPlace,
}: {
  frame: any;
  storeType: StoreType;
  setStoreType: (s: StoreType) => void;
  busy: string | null;
  placing: boolean;
  onPlace: () => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
      <Card className="p-4">
        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
          Approved frame
        </div>
        <div className="rounded-md border bg-slate-50 p-2">
          <LayoutSvg frame={frame.geometry} />
        </div>
      </Card>
      <Card className="p-4">
        <h2 className="font-display text-lg font-semibold">Pick store type</h2>
        <p className="text-sm text-muted-foreground mt-1">
          The rules engine uses this to decide which fixtures appear and how
          space is allocated.
        </p>
        <div className="mt-4 space-y-2">
          {(Object.keys(STORE_TYPE_META) as StoreType[]).map((t) => {
            const meta = STORE_TYPE_META[t];
            const active = t === storeType;
            const fixtures = STORE_RECIPES[t];
            return (
              <button
                key={t}
                onClick={() => setStoreType(t)}
                disabled={placing}
                className={cn(
                  "w-full text-left rounded-md border p-3 transition-all",
                  active
                    ? "border-orange-500 bg-orange-50 ring-1 ring-orange-500"
                    : "hover:border-orange-300 hover:bg-orange-50/30",
                )}
              >
                <div className="font-medium text-sm">{meta.name}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{meta.description}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Fixtures: {fixtures.map((f) => `${f.count}× ${fixtureByCode(f.code)?.name ?? f.code}`).join(" · ")}
                </div>
              </button>
            );
          })}
        </div>
        <Button
          onClick={onPlace}
          disabled={busy === "place" || placing}
          className="mt-4 w-full gap-2 bg-orange-600 hover:bg-orange-700"
        >
          {busy === "place" || placing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          Place fixtures
        </Button>
      </Card>
    </div>
  );
}

function PlacementReviewStage({
  frame,
  placements,
  approved,
  pending,
  rejected,
  busy,
  jobTitle,
  onToggle,
  onRePlace,
  onApproveAll,
  storeType,
}: {
  frame: any;
  placements: any[];
  approved: any[];
  pending: any[];
  rejected: any[];
  busy: string | null;
  jobTitle: string;
  onToggle: (id: string, status: "approved" | "rejected" | "pending") => void;
  onRePlace: () => void;
  onApproveAll: () => void;
  storeType: StoreType;
}) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<null | "pdf" | "dxf">(null);

  async function exportPdf() {
    if (!exportRef.current) return;
    setExporting("pdf");
    try {
      await downloadPdfFromElement(
        exportRef.current,
        jobTitle,
        `${STORE_TYPE_META[storeType].name} · ${placements.length} fixtures · DRAFT (under review)`,
        `${jobTitle}_draft`,
      );
    } catch (e: any) {
      toast.error("PDF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  function exportDxf() {
    setExporting("dxf");
    try {
      const dxf = dxfFromLayout(frame.geometry, placements);
      downloadDxf(dxf, `${jobTitle}_draft`);
      toast.success("DXF exported");
    } catch (e: any) {
      toast.error("DXF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
      <Card className="p-4">
        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center justify-between gap-2 flex-wrap">
          <span>Layout — {STORE_TYPE_META[storeType].name}</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={exportPdf} disabled={exporting !== null} className="gap-1.5 h-7" title="Export draft as PDF">
              {exporting === "pdf" ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} PDF
            </Button>
            <Button size="sm" variant="ghost" onClick={exportDxf} disabled={exporting !== null} className="gap-1.5 h-7" title="Export as DXF — open in any CAD tool">
              {exporting === "dxf" ? <Loader2 className="size-3 animate-spin" /> : <FileCode className="size-3" />} DXF
            </Button>
            <Button size="sm" variant="outline" onClick={onRePlace} disabled={busy === "place"} className="gap-1.5 h-7">
              {busy === "place" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Re-place
            </Button>
          </div>
        </div>
        <div ref={exportRef} className="rounded-md border bg-slate-50 p-2">
          <LayoutSvg
            frame={frame.geometry}
            placements={placements}
            highlightPlacementId={highlight}
            onPlacementClick={setHighlight}
          />
        </div>
        <div className="mt-3 text-[11px] text-muted-foreground flex gap-3">
          <span><span className="inline-block size-2.5 rounded bg-blue-200 mr-1" /> Storefront</span>
          <span><span className="inline-block size-2.5 rounded bg-amber-200 mr-1" /> Backroom</span>
          <span><span className="inline-block size-2.5 rounded bg-pink-200 mr-1" /> Service</span>
        </div>
      </Card>
      <Card className="p-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Placements</h2>
          <span className="text-[11px] text-muted-foreground">
            {approved.length} ✓ · {pending.length} pending · {rejected.length} ✗
          </span>
        </div>
        {pending.length > 0 && (
          <Button
            onClick={onApproveAll}
            disabled={busy === "approve_all"}
            className="mt-3 w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
            size="sm"
          >
            {busy === "approve_all" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
            Approve all remaining ({pending.length})
          </Button>
        )}
        <div className="mt-3 space-y-1.5">
          {placements.map((p) => {
            const def = fixtureByCode(p.fixture_code);
            return (
              <div
                key={p.id}
                onMouseEnter={() => setHighlight(p.id)}
                onMouseLeave={() => setHighlight(null)}
                className={cn(
                  "rounded-md border p-2.5 transition-all",
                  p.status === "approved" && "bg-emerald-50/50 border-emerald-200",
                  p.status === "rejected" && "bg-rose-50/50 border-rose-200 opacity-70",
                  highlight === p.id && "ring-2 ring-orange-400",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      <span className="inline-block size-3 rounded" style={{ background: def?.fillColor, border: `1px solid ${def?.strokeColor}` }} />
                      {def?.name ?? p.fixture_code}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {p.width}×{p.height}mm · {p.zone ?? "—"}
                    </div>
                    {p.reason && <div className="text-[10px] text-muted-foreground mt-0.5 italic">{p.reason}</div>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => onToggle(p.id, p.status === "approved" ? "pending" : "approved")}
                      title="Approve"
                      className={cn(
                        "p-1 rounded transition-colors",
                        p.status === "approved" ? "bg-emerald-600 text-white" : "hover:bg-emerald-100 text-emerald-700",
                      )}
                    >
                      <CheckCircle2 className="size-3.5" />
                    </button>
                    <button
                      onClick={() => onToggle(p.id, p.status === "rejected" ? "pending" : "rejected")}
                      title="Reject"
                      className={cn(
                        "p-1 rounded transition-colors",
                        p.status === "rejected" ? "bg-rose-600 text-white" : "hover:bg-rose-100 text-rose-700",
                      )}
                    >
                      <XCircle className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function ApprovedStage({
  frame,
  placements,
  storeType,
  jobTitle,
  onRePlace,
}: {
  frame: any;
  placements: any[];
  storeType: StoreType;
  jobTitle: string;
  onRePlace: () => void;
}) {
  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<null | "pdf" | "dxf">(null);
  const approved = placements.filter((p) => p.status === "approved");
  const subtitle = `${STORE_TYPE_META[storeType].name} · ${approved.length} fixtures · Generated ${new Date().toLocaleDateString()}`;

  async function exportPdf() {
    if (!exportRef.current) return;
    setExporting("pdf");
    try {
      await downloadPdfFromElement(exportRef.current, jobTitle, subtitle, `${jobTitle}_layout`);
    } catch (e: any) {
      toast.error("PDF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  function exportDxf() {
    setExporting("dxf");
    try {
      const dxf = dxfFromLayout(frame.geometry, approved);
      downloadDxf(dxf, `${jobTitle}_layout`);
      toast.success("DXF exported", { description: "Open in AutoCAD, LibreCAD or FreeCAD" });
    } catch (e: any) {
      toast.error("DXF export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-600" />
            <span className="font-semibold">Layout finalized</span>
            <span className="text-xs text-muted-foreground">· {STORE_TYPE_META[storeType].name} · {approved.length} fixtures</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={exportPdf} disabled={exporting !== null} className="gap-1.5 bg-orange-600 hover:bg-orange-700">
              {exporting === "pdf" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Export PDF
            </Button>
            <Button size="sm" onClick={exportDxf} disabled={exporting !== null} variant="outline" className="gap-1.5">
              {exporting === "dxf" ? <Loader2 className="size-3.5 animate-spin" /> : <FileCode className="size-3.5" />}
              Export DXF
            </Button>
            <Button size="sm" variant="outline" onClick={onRePlace} className="gap-1.5">
              <RefreshCw className="size-3.5" /> Reopen for editing
            </Button>
          </div>
        </div>
        <div ref={exportRef} className="rounded-md border bg-slate-50 p-2">
          <LayoutSvg frame={frame.geometry} placements={approved} />
        </div>
      </Card>
    </div>
  );
}

/** Popover content: exact token usage from the digitization call. */
function FrameCostBreakdown({ frame }: { frame: any }) {
  const cost: RunCost = computeCost({
    inputTokens: frame.ai_input_tokens ?? 0,
    outputTokens: frame.ai_output_tokens ?? 0,
    thinkingTokens: frame.ai_thinking_tokens ?? 0,
    calls: 1,
  });
  return (
    <div className="space-y-2">
      <div className="font-bold text-sm flex items-center gap-1.5">
        <Coins className="size-3.5 text-orange-600" /> Digitization cost
      </div>
      <div className="space-y-1 text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">Model</span>
          <span className="font-medium text-foreground tabular-nums shrink-0">{cost.model}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">Input · {formatTokens(cost.inputTokens)} tokens</span>
          <span className="font-medium text-foreground tabular-nums shrink-0">{formatUsd(cost.inputUsd)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">Output · {formatTokens(cost.outputTokens + cost.thinkingTokens)} tokens</span>
          <span className="font-medium text-foreground tabular-nums shrink-0">{formatUsd(cost.outputUsd)}</span>
        </div>
      </div>
      <div className="border-t pt-1.5 flex items-center justify-between font-bold">
        <span>Total</span>
        <span className="tabular-nums">{formatUsd(cost.usd)}</span>
      </div>
      <p className="text-[10px] text-muted-foreground/80 leading-snug pt-1">
        Token counts are exact (from the API). Price assumes {GEMINI_PRICE.model} at $
        {GEMINI_PRICE.inputUsdPer1M}/1M input and ${GEMINI_PRICE.outputUsdPer1M}/1M output.
        Fixture placement uses zero AI tokens.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    uploaded: { label: "Uploaded", cls: "bg-slate-100 text-slate-700" },
    digitizing: { label: "Digitizing", cls: "bg-blue-100 text-blue-800" },
    pending_frame_approval: { label: "Frame needs approval", cls: "bg-amber-100 text-amber-800" },
    frame_approved: { label: "Frame approved", cls: "bg-blue-100 text-blue-800" },
    placing_fixtures: { label: "Placing", cls: "bg-blue-100 text-blue-800" },
    pending_placement_review: { label: "Placements need review", cls: "bg-amber-100 text-amber-800" },
    approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800" },
  };
  const m = map[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ml-1", m.cls)}>
      {m.label}
    </span>
  );
}
