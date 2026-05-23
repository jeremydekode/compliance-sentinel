import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { generateWithFallback } from "@/lib/gemini";
import { placeFixtures } from "@/lib/layout/rules";
import { DEFAULT_FRAME_EXTRACTION_PROMPT } from "@/lib/layout/prompt";
import type {
  FrameGeometry,
  LayoutFrameRow,
  LayoutJob,
  LayoutPlacementRow,
  LayoutStatus,
  StoreType,
} from "@/lib/layout/types";

/**
 * Retail Layout Planner — server functions.
 *
 * Pipeline:
 *   createLayoutJob → uploadLayoutSketch → digitizeLayoutSketch
 *     → (frame approval gate) approveLayoutFrame
 *     → placeLayoutFixtures (deterministic, no LLM)
 *     → (placement approval gate) approveAllLayoutPlacements
 *
 * All functions scoped to workspace_id = "layout". They do not read or
 * write any table used by the compliance pipeline.
 */

const storeTypeSchema = z.enum(["standard", "small", "kiosk", "cafe"]);

// ── Create + list ─────────────────────────────────────────────────────

export const createLayoutJob = createServerFn({ method: "POST" })
  .inputValidator(z.object({ title: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { data: row, error } = await (supabase as any)
      .from("layout_jobs")
      .insert({ title: data.title, status: "uploaded" })
      .select("*")
      .single();
    if (error) throw new Error(`Could not create layout job: ${error.message}`);
    return row as LayoutJob;
  });

export const listLayoutJobs = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await (supabase as any)
    .from("layout_jobs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not list layout jobs: ${error.message}`);
  return (data ?? []) as LayoutJob[];
});

export const getLayoutJob = createServerFn({ method: "GET" })
  .inputValidator(z.object({ jobId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const [job, frame, placements] = await Promise.all([
      (supabase as any).from("layout_jobs").select("*").eq("id", data.jobId).single(),
      (supabase as any)
        .from("layout_frames")
        .select("*")
        .eq("job_id", data.jobId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      (supabase as any)
        .from("layout_placements")
        .select("*")
        .eq("job_id", data.jobId)
        .order("created_at"),
    ]);
    if (job.error) throw new Error(`Job not found: ${job.error.message}`);
    return {
      job: job.data as LayoutJob,
      frame: (frame.data ?? null) as LayoutFrameRow | null,
      placements: (placements.data ?? []) as LayoutPlacementRow[],
    };
  });

export const deleteLayoutJob = createServerFn({ method: "POST" })
  .inputValidator(z.object({ jobId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { error } = await (supabase as any).from("layout_jobs").delete().eq("id", data.jobId);
    if (error) throw new Error(`Could not delete job: ${error.message}`);
    return { ok: true };
  });

// ── Upload sketch (client uploads to Supabase storage, hands us the URL) ──

export const uploadLayoutSketch = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      jobId: z.string().uuid(),
      fileUrl: z.string().url(),
      mimeType: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const { error } = await (supabase as any)
      .from("layout_jobs")
      .update({
        sketch_drive_url: data.fileUrl,
        sketch_mime_type: data.mimeType,
        status: "uploaded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.jobId);
    if (error) throw new Error(`Could not attach sketch: ${error.message}`);
    return { ok: true };
  });

// ── AI: digitize the sketch into geometry ─────────────────────────────
// The system prompt now lives in src/lib/layout/prompt.ts as
// DEFAULT_FRAME_EXTRACTION_PROMPT — exposed to the Settings UI so users can
// view and amend it without code changes.

export const digitizeLayoutSketch = createServerFn({ method: "POST" })
  .inputValidator(z.object({ jobId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { data: job, error: jobErr } = await (supabase as any)
      .from("layout_jobs")
      .select("*")
      .eq("id", data.jobId)
      .single();
    if (jobErr || !job) throw new Error(`Job not found: ${jobErr?.message}`);
    if (!job.sketch_drive_url) throw new Error("No sketch uploaded for this job yet.");

    await (supabase as any)
      .from("layout_jobs")
      .update({ status: "digitizing", updated_at: new Date().toISOString() })
      .eq("id", data.jobId);

    // The system prompt for layout extraction is editable from Settings →
    // Analysis Guidance. If the user has saved a custom prompt for the layout
    // workspace, it REPLACES the default (full-replacement semantics — unlike
    // compliance, where guidance is supplementary). This lets prompt engineering
    // happen in the UI without a code change.
    const { data: guidanceRow } = await (supabase as any)
      .from("analysis_guidance")
      .select("guidance")
      .eq("workspace_id", "layout")
      .maybeSingle();
    const savedPrompt = (guidanceRow?.guidance ?? "").trim();
    const promptText = savedPrompt || DEFAULT_FRAME_EXTRACTION_PROMPT;

    // Fetch the sketch image as base64.
    const fileResp = await fetch(job.sketch_drive_url);
    if (!fileResp.ok) {
      throw new Error(`Could not fetch sketch image: HTTP ${fileResp.status}`);
    }
    const arrayBuffer = await fileResp.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const mimeType: string = job.sketch_mime_type || "image/png";

    const resp = await generateWithFallback(
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: promptText },
              { inlineData: { data: buf.toString("base64"), mimeType } },
            ],
          },
        ],
        config: { responseMimeType: "application/json" },
      },
      { tier: "quality" },
    );

    const raw = (resp as any).text ?? "";
    const parsed = safeParseGeometry(raw);
    if (!parsed) {
      throw new Error(
        `AI returned malformed geometry. First 300 chars:\n${String(raw).slice(0, 300)}`,
      );
    }

    const { confidence, reasoning, ...geometry } = parsed;

    // Exact token counts from Gemini's usageMetadata (not estimates).
    const m = ((resp as any).usageMetadata ?? {}) as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };

    const { data: frameRow, error: frameErr } = await (supabase as any)
      .from("layout_frames")
      .insert({
        job_id: data.jobId,
        geometry,
        ai_confidence: confidence ?? null,
        ai_reasoning: reasoning ?? null,
        ai_input_tokens: m.promptTokenCount ?? null,
        ai_output_tokens: m.candidatesTokenCount ?? null,
        ai_thinking_tokens: m.thoughtsTokenCount ?? null,
      })
      .select("*")
      .single();
    if (frameErr) throw new Error(`Could not save frame: ${frameErr.message}`);

    await (supabase as any)
      .from("layout_jobs")
      .update({ status: "pending_frame_approval", updated_at: new Date().toISOString() })
      .eq("id", data.jobId);

    return { frame: frameRow as LayoutFrameRow };
  });

// ── Frame approval gate ──────────────────────────────────────────────

export const approveLayoutFrame = createServerFn({ method: "POST" })
  .inputValidator(z.object({ jobId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const now = new Date().toISOString();
    await (supabase as any)
      .from("layout_frames")
      .update({ approved_at: now })
      .eq("job_id", data.jobId);
    const { error } = await (supabase as any)
      .from("layout_jobs")
      .update({ status: "frame_approved", updated_at: now })
      .eq("id", data.jobId);
    if (error) throw new Error(`Could not approve frame: ${error.message}`);
    return { ok: true };
  });

// ── Rules-based fixture placement ─────────────────────────────────────

export const placeLayoutFixtures = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      jobId: z.string().uuid(),
      storeType: storeTypeSchema,
    }),
  )
  .handler(async ({ data }) => {
    const { data: frame, error: frameErr } = await (supabase as any)
      .from("layout_frames")
      .select("*")
      .eq("job_id", data.jobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (frameErr || !frame) throw new Error(`No frame for this job: ${frameErr?.message}`);

    await (supabase as any)
      .from("layout_jobs")
      .update({
        status: "placing_fixtures",
        store_type: data.storeType,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.jobId);

    // Clear any previous placements (re-run safe).
    await (supabase as any).from("layout_placements").delete().eq("job_id", data.jobId);

    const placements = placeFixtures(frame.geometry as FrameGeometry, data.storeType);

    if (placements.length > 0) {
      const rows = placements.map((p) => ({
        job_id: data.jobId,
        fixture_code: p.fixtureCode,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        width: p.width,
        height: p.height,
        zone: p.zone ?? null,
        reason: p.reason ?? null,
        status: p.status,
      }));
      const { error: insErr } = await (supabase as any).from("layout_placements").insert(rows);
      if (insErr) throw new Error(`Could not save placements: ${insErr.message}`);
    }

    await (supabase as any)
      .from("layout_jobs")
      .update({ status: "pending_placement_review", updated_at: new Date().toISOString() })
      .eq("id", data.jobId);

    const { data: saved } = await (supabase as any)
      .from("layout_placements")
      .select("*")
      .eq("job_id", data.jobId)
      .order("created_at");
    return { placements: (saved ?? []) as LayoutPlacementRow[] };
  });

// ── Placement review ─────────────────────────────────────────────────

export const setLayoutPlacementStatus = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      placementId: z.string().uuid(),
      status: z.enum(["pending", "approved", "rejected"]),
    }),
  )
  .handler(async ({ data }) => {
    const { error } = await (supabase as any)
      .from("layout_placements")
      .update({ status: data.status })
      .eq("id", data.placementId);
    if (error) throw new Error(`Could not update placement: ${error.message}`);
    return { ok: true };
  });

export const approveAllLayoutPlacements = createServerFn({ method: "POST" })
  .inputValidator(z.object({ jobId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await (supabase as any)
      .from("layout_placements")
      .update({ status: "approved" })
      .eq("job_id", data.jobId)
      .eq("status", "pending");
    const { error } = await (supabase as any)
      .from("layout_jobs")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("id", data.jobId);
    if (error) throw new Error(`Could not finalize job: ${error.message}`);
    return { ok: true };
  });

// ── Helpers ──────────────────────────────────────────────────────────

function safeParseGeometry(
  raw: unknown,
): (FrameGeometry & { confidence?: number; reasoning?: string }) | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  // Strip ```json fences if Gemini adds them despite the prompt.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.walls) || parsed.walls.length === 0) return null;
    if (!parsed.bbox || typeof parsed.bbox.width !== "number") return null;
    if (!Array.isArray(parsed.zones)) parsed.zones = [];
    if (!Array.isArray(parsed.openings)) parsed.openings = [];
    if (!Array.isArray(parsed.dimensions)) parsed.dimensions = [];
    parsed.units = "mm";
    if (typeof parsed.totalAreaSqm !== "number") {
      parsed.totalAreaSqm = (parsed.bbox.width * parsed.bbox.height) / 1_000_000;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Re-export status type for client convenience.
export type { LayoutStatus, StoreType };
