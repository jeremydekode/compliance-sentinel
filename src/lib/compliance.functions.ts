import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { analyzePolicy, chunkDocument } from "./gemini";
import { generateEmbedding, generateQueryEmbedding } from "./embeddings";
import { REGULATION_FAMILIES, INTERNAL_DOC_TYPES as INTERNAL_DOC_TYPES_CONST, regulatorContext } from "./auto-detect";

async function fetchFile(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const resp = await fetch(url);
  const arrayBuffer = await resp.arrayBuffer();
  const mimeType = resp.headers.get("content-type") || "application/pdf";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

export const createReport = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      customTitle: z.string().optional(),
      notes: z.string().optional(),
      detected: z
        .object({
          doc_type: z.string(),
          tags: z.array(z.string()).default([]),
          title: z.string().optional(),
          version: z.string().optional(),
          summary: z.string().optional(),
        })
        .optional(),
    })
  )
  .handler(async ({ data }) => {
    const detected = data.detected;
    
    // 1. Fetch the newly uploaded policy
    if (!data.fileUrl) throw new Error("No file URL provided for analysis");
    const newPolicy = await fetchFile(data.fileUrl);

    // 2. Try to find the old version of this policy in the KB.
    // Use REGULATION_FAMILIES so e.g. uploading new RMiT (rmit_reg) finds legacy "rmit"
    // tagged docs, FATF finds FATF, etc.
    const oldDocTypes = detected?.doc_type
      ? (REGULATION_FAMILIES[detected.doc_type] ?? [detected.doc_type])
      : ["__none__"];
    const { data: oldDocs } = await supabase
      .from("sop_documents")
      .select("*")
      .in("doc_type", oldDocTypes)
      .neq("version", detected?.version ?? "")
      .order("created_at", { ascending: false })
      .limit(1);
    const oldDoc = oldDocs?.[0];
    let oldPolicy = undefined;
    if (oldDoc?.file_url) {
      try {
        oldPolicy = await fetchFile(oldDoc.file_url);
      } catch (e) {
        console.error("Failed to fetch old policy:", e);
      }
    }

    let aiResult: any;
    let relevantSops: any[] = [];
    let kbAll: any[] = [];

    try {
      // 3. Vector search for relevant SOP chunks using the uploaded policy as the query
      const queryText = `${data.filename} ${detected?.summary || ""} ${detected?.tags?.join(" ") || ""}`;
      const embedding = await generateQueryEmbedding(queryText);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: matchedChunks, error: matchErr } = await (supabase as any).rpc("match_sop_chunks", {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: 50,
      });

      // If the RPC fails (e.g. table not yet created), fall through to the document-level fallback
      if (matchErr) {
        console.warn("match_sop_chunks RPC failed (table may not exist yet):", matchErr.message);
      }

      const chunks: any[] = matchedChunks ?? [];
      const sopIds = Array.from(new Set(chunks.map((c: any) => c.sop_id as string)));

      // Internal-only doc types — sourced from shared constant
      const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];

      if (sopIds.length > 0) {
        const { data: sopDocs } = await supabase
          .from("sop_documents")
          .select("*")
          .in("id", sopIds)
          .in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (sopDocs ?? []) as any[];
      }

      // Fall back to ALL internal SOPs if chunk search returned nothing
      if (relevantSops.length === 0) {
        console.log("Chunk search returned nothing — fetching all internal SOPs as fallback.");
        const { data: allSops } = await supabase
          .from("sop_documents")
          .select("*")
          .in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (allSops ?? []) as any[];
      }
      kbAll = relevantSops;

      // Build SOP context: fetch full PDF files where available
      const sopsForAi = await Promise.all(relevantSops.map(async s => {
        if (s.file_url) {
          try {
            const file = await fetchFile(s.file_url);
            return { title: s.title, buffer: file.buffer, mimeType: file.mimeType };
          } catch (e) {
            console.error(`Failed to fetch SOP ${s.title}:`, e);
          }
        }
        // Fall back to indexed chunk text
        const chunksForThisSop = chunks.filter((c: any) => c.sop_id === s.id);
        const chunkContext = chunksForThisSop.map((c: any) =>
          `[${c.chapter_ref || "§?"}, p.${c.page_number || "?"}]\n${c.content}`
        ).join("\n\n---\n\n");
        return { title: s.title, text: chunkContext || `[No content indexed for ${s.title}]` };
      }));

      // 4. Run AI Analysis: extract regulatory changes then map each to SOPs
      console.log(`Starting analysis for ${data.filename} against ${sopsForAi.length} internal SOPs...`);
      aiResult = await analyzePolicy(
        { name: data.filename, buffer: newPolicy.buffer, mimeType: newPolicy.mimeType },
        oldPolicy ? { name: oldDoc!.title, buffer: oldPolicy.buffer, mimeType: oldPolicy.mimeType } : undefined,
        sopsForAi,
        regulatorContext(detected?.doc_type)
      );
      console.log(`Analysis complete. ${aiResult.changes.length} changes, ${aiResult.impacts.length} SOP impacts.`);
    } catch (e: any) {
      console.error("Intelligence engine encountered an issue during analysis:", e);
      throw new Error(`AI Analysis failed: ${e.message}`);
    }

    const fallbackName = data.filename.replace(/\.[^.]+$/, "").trim() || data.filename;
    const displayName = (data.customTitle ?? "").trim() || fallbackName;

    const { data: report, error } = await supabase
      .from("analysis_reports")
      .insert({
        title: displayName,
        policy_name: displayName,
        status: "pending_validation",
        source_file_url: data.fileUrl,
        summary_json: {
          ...aiResult.summary,
          kb_size: kbAll.length,
          detected: detected ?? null,
          old_policy_name: oldDoc?.title ?? null,
          analyst_notes: data.notes ?? null,
        },
      })
      .select()
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create report");

    const { error: changesErr } = await supabase.from("regulatory_changes").insert(
      aiResult.changes.map((c: any, i: number) => ({
        chapter_ref: c.chapter_ref,
        old_requirement: c.old_requirement,
        new_requirement: c.new_requirement,
        change_summary: c.change_summary,
        impact: c.impact,
        tone_shift: c.tone_shift,
        pages: c.pages,
        legal_refs: c.legal_refs,
        related_instruments: c.related_instruments,
        report_id: report.id,
        position: i,
      }))
    );
    if (changesErr) throw new Error(`changes insert: ${changesErr.message}`);

    const matchedImpacts = aiResult.impacts.map((m: any) => {
      const aiTitle = (m.sop_title ?? "").toLowerCase().trim();
      const sop = relevantSops.find(s => {
        const stored = (s.title ?? "").toLowerCase().trim();
        return stored === aiTitle || stored.includes(aiTitle) || aiTitle.includes(stored);
      });
      return {
        ...m,
        sop_id: sop?.id ?? null,
        sop_title: sop ? sop.title : m.sop_title,
      };
    });

    if (matchedImpacts.length > 0) {
      await supabase.from("sop_impacts").insert(
        matchedImpacts.map((m: any, i: number) => ({ 
          ...m, 
          report_id: report.id, 
          position: i 
        }))
      );
    }

    return {
      reportId: report.id as string,
      impactCount: matchedImpacts.length,
      matchedToKbCount: matchedImpacts.filter((m: any) => m.sop_id).length,
      kbSize: kbAll.length,
      candidateKbSize: relevantSops.length,
    };
  });

export const rerunReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    // 1. Load existing report
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    if (!report.source_file_url) throw new Error("Report has no source file URL — cannot rerun");

    const detected = (report.summary_json as any)?.detected ?? null;

    // 2. Re-fetch the new policy
    const newPolicy = await fetchFile(report.source_file_url);

    // 3. Find the old policy in KB (same logic as createReport)
    const oldDocTypes = detected?.doc_type
      ? (REGULATION_FAMILIES[detected.doc_type] ?? [detected.doc_type])
      : ["__none__"];
    const { data: oldDocs } = await supabase
      .from("sop_documents").select("*")
      .in("doc_type", oldDocTypes)
      .neq("version", detected?.version ?? "")
      .order("created_at", { ascending: false }).limit(1);
    const oldDoc = oldDocs?.[0];
    let oldPolicy: { buffer: Buffer; mimeType: string } | undefined = undefined;
    if (oldDoc?.file_url) {
      try { oldPolicy = await fetchFile(oldDoc.file_url); }
      catch (e) { console.error("Rerun: failed to fetch old policy:", e); }
    }

    // 4. Find relevant internal SOPs (same logic as createReport)
    const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];
    let relevantSops: any[] = [];
    try {
      const queryText = `${report.policy_name} ${detected?.summary || ""} ${detected?.tags?.join(" ") || ""}`;
      const embedding = await generateQueryEmbedding(queryText);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: matchedChunks } = await (supabase as any).rpc("match_sop_chunks", {
        query_embedding: embedding, match_threshold: 0.2, match_count: 50,
      });
      const chunks: any[] = matchedChunks ?? [];
      const sopIds = Array.from(new Set(chunks.map((c: any) => c.sop_id as string)));
      if (sopIds.length > 0) {
        const { data: sopDocs } = await supabase
          .from("sop_documents").select("*").in("id", sopIds).in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (sopDocs ?? []) as any[];
      }
      if (relevantSops.length === 0) {
        const { data: allSops } = await supabase
          .from("sop_documents").select("*").in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (allSops ?? []) as any[];
      }
    } catch (e: any) {
      console.error("Rerun: SOP lookup failed:", e);
    }

    const sopsForAi = await Promise.all(relevantSops.map(async s => {
      if (s.file_url) {
        try {
          const f = await fetchFile(s.file_url);
          return { title: s.title, buffer: f.buffer, mimeType: f.mimeType };
        } catch { /* fall through */ }
      }
      return { title: s.title, text: `[No content indexed for ${s.title}]` };
    }));

    // 5. Run AI analysis
    const aiResult = await analyzePolicy(
      { name: report.policy_name ?? "policy", buffer: newPolicy.buffer, mimeType: newPolicy.mimeType },
      oldPolicy ? { name: oldDoc!.title, buffer: oldPolicy.buffer, mimeType: oldPolicy.mimeType } : undefined,
      sopsForAi,
      regulatorContext(detected?.doc_type)
    );

    // 6. Wipe old changes/impacts for this report and re-insert
    await supabase.from("sop_impacts").delete().eq("report_id", report.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", report.id);

    await supabase.from("analysis_reports").update({
      summary_json: {
        ...aiResult.summary,
        kb_size: relevantSops.length,
        detected: detected ?? null,
        old_policy_name: oldDoc?.title ?? null,
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    if (aiResult.changes.length > 0) {
      await supabase.from("regulatory_changes").insert(
        aiResult.changes.map((c: any, i: number) => ({
          chapter_ref: c.chapter_ref,
          old_requirement: c.old_requirement,
          new_requirement: c.new_requirement,
          change_summary: c.change_summary,
          impact: c.impact,
          tone_shift: c.tone_shift,
          pages: c.pages,
          legal_refs: c.legal_refs,
          related_instruments: c.related_instruments,
          report_id: report.id,
          position: i,
        }))
      );
    }

    const matchedImpacts = aiResult.impacts.map((m: any) => {
      const aiTitle = (m.sop_title ?? "").toLowerCase().trim();
      const sop = relevantSops.find(s => {
        const stored = (s.title ?? "").toLowerCase().trim();
        return stored === aiTitle || stored.includes(aiTitle) || aiTitle.includes(stored);
      });
      return { ...m, sop_id: sop?.id ?? null, sop_title: sop ? sop.title : m.sop_title };
    });

    if (matchedImpacts.length > 0) {
      await supabase.from("sop_impacts").insert(
        matchedImpacts.map((m: any, i: number) => ({ ...m, report_id: report.id, position: i }))
      );
    }

    return {
      reportId: report.id as string,
      changesCount: aiResult.changes.length,
      impactCount: matchedImpacts.length,
      matchedToKbCount: matchedImpacts.filter((m: any) => m.sop_id).length,
    };
  });

export const requestLegalSignOff = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "pending_legal" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const finalizeLegalSignOff = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { data: row } = await supabase
      .from("analysis_reports")
      .select("summary_json")
      .eq("id", data.reportId)
      .single();
    const summary = (row?.summary_json ?? {}) as Record<string, unknown>;
    const { error } = await supabase
      .from("analysis_reports")
      .update({
        status: "signed_off",
        summary_json: { ...summary, signed_off_at: new Date().toISOString() },
      })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

function bumpVersion(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return `${v}.1`;
  const major = Number(m[1]);
  const minor = Number(m[2]) + 1;
  return `${major}.${minor}`;
}

export const publishToKB = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { data: impacts } = await supabase
      .from("sop_impacts")
      .select("sop_id, sop_title, edited_text, replace_text, chapter")
      .eq("report_id", data.reportId)
      .eq("status", "approved");

    const list = (impacts ?? []) as Array<{
      sop_id: string | null;
      sop_title: string;
      edited_text: string | null;
      replace_text: string | null;
      chapter: string | null;
    }>;

    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const seen = new Set<string>();

    for (const imp of list) {
      if (!imp.sop_id || seen.has(imp.sop_id)) continue;
      seen.add(imp.sop_id);
      const { data: sop } = await supabase
        .from("sop_documents")
        .select("version, summary")
        .eq("id", imp.sop_id)
        .single();
      if (!sop) continue;
      const newVersion = bumpVersion(String(sop.version ?? "1.0"));
      const note = `\n\n[${today}] v${newVersion}: applied changes from report (${imp.chapter ?? "—"}).`;
      const { error } = await supabase
        .from("sop_documents")
        .update({
          version: newVersion,
          summary: ((sop.summary as string | null) ?? "") + note,
        })
        .eq("id", imp.sop_id);
      if (!error) updated += 1;
    }

    await supabase
      .from("analysis_reports")
      .update({ status: "published" })
      .eq("id", data.reportId);

    return { ok: true, updatedSops: updated };
  });

export const markPendingManual = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "pending_manual" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const confirmManualCompletion = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "published" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateImpact = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      id: z.string(),
      status: z.enum(["pending", "approved", "rejected", "routed"]).optional(),
      edited_text: z.string().optional(),
    })
  )
  .handler(async ({ data }) => {
    const { id, ...rest } = data;
    const { error } = await supabase.from("sop_impacts").update(rest).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const chatWithReport = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      reportId: z.string(),
      message: z.string().min(1).max(4000),
    })
  )
  .handler(async function* ({ data }) {
    const { data: report } = await supabase
      .from("analysis_reports")
      .select("title, policy_name, summary_json")
      .eq("id", data.reportId)
      .single();
    const { data: changes } = await supabase
      .from("regulatory_changes")
      .select("chapter_ref, change_summary, impact, new_requirement")
      .eq("report_id", data.reportId);
    const { data: impacts } = await supabase
      .from("sop_impacts")
      .select("sop_title, change_type, chapter, paragraph, status")
      .eq("report_id", data.reportId);
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("report_id", data.reportId)
      .order("created_at", { ascending: true })
      .limit(40);

    const system = `You are a compliance analyst assistant for the report "${report?.title}" (${report?.policy_name}).
You have full context on the regulatory changes and the impacted internal SOPs below. Answer concisely with markdown, cite chapter refs, and stay grounded in this data.

REGULATORY CHANGES (JSON):
${JSON.stringify(changes ?? [], null, 2)}

SOP IMPACTS (JSON):
${JSON.stringify(impacts ?? [], null, 2)}

EXECUTIVE SUMMARY (JSON):
${JSON.stringify(report?.summary_json ?? {}, null, 2)}`;

    await supabase
      .from("chat_messages")
      .insert({ report_id: data.reportId, role: "user", content: data.message });

    const CHAT_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];

    let buffer = "";
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

      const contents = [
        ...(history ?? []).map((m: any) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        { role: "user", parts: [{ text: data.message }] },
      ];

      let stream: any;
      for (const model of CHAT_MODELS) {
        try {
          stream = await ai.models.generateContentStream({ model, contents, config: { systemInstruction: system } });
          break;
        } catch (e: any) {
          const msg: string = e?.message ?? "";
          if (msg.includes("high demand") || msg.includes("overloaded") || msg.includes("503") || msg.includes("NOT_FOUND") || msg.includes("not found")) {
            console.warn(`Chat model ${model} unavailable, trying next...`);
            continue;
          }
          throw e;
        }
      }
      if (!stream) throw new Error("All chat models are currently unavailable. Please try again shortly.");

      for await (const chunk of stream) {
        const text = chunk.text ?? "";
        if (text) {
          buffer += text;
          yield { delta: text };
        }
      }
    } finally {
      if (buffer) {
        await supabase
          .from("chat_messages")
          .insert({ report_id: data.reportId, role: "assistant", content: buffer });
      }
    }
  });

export const deleteReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    await supabase.from("chat_messages").delete().eq("report_id", data.id);
    await supabase.from("sop_impacts").delete().eq("report_id", data.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", data.id);
    const { error } = await supabase.from("analysis_reports").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteSop = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const { error } = await supabase.from("sop_documents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createSop = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      title: z.string().min(2).max(200),
      doc_type: z.enum(["sop", "rmit", "rmit_reg", "fatf", "circular", "it_policy", "policy"]),
      version: z.string().min(1).max(20),
      summary: z.string().max(2000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      file_url: z.string().nullable().optional(),
    })
  )
  .handler(async ({ data }) => {
    const embedding = await generateEmbedding(`${data.title} ${data.summary || ""}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (supabase as any)
      .from("sop_documents")
      .insert({
        title: data.title,
        doc_type: data.doc_type,
        version: data.version,
        summary: data.summary ?? null,
        tags: data.tags ?? [],
        file_url: data.file_url ?? null,
        embedding,
      })
      .select()
      .single();
    if (error || !row) throw new Error(error?.message || "Failed to create document");

    // FULL-TEXT INDEXING: Extract and store chunks
    if (data.file_url) {
      try {
        console.log(`Starting full-text indexing for ${data.title}...`);
        const file = await fetchFile(data.file_url);
        const chunks = await chunkDocument({ name: data.title, buffer: file.buffer, mimeType: file.mimeType });
        
        if (chunks.length > 0) {
          console.log(`Extracted ${chunks.length} semantic chunks. Generating embeddings...`);
          const chunksWithEmbeddings = await Promise.all(chunks.map(async c => ({
            sop_id: row.id,
            content: c.content,
            chapter_ref: c.chapter_ref || null,
            page_number: c.page_number || null,
            embedding: await generateEmbedding(c.content)
          })));

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: chunkErr } = await (supabase as any).from("sop_chunks").insert(chunksWithEmbeddings);
          if (chunkErr) console.error("Failed to store chunks:", chunkErr);
          else console.log(`Successfully indexed ${chunks.length} chunks for ${data.title}`);
        }
      } catch (e) {
        console.error("Full-text indexing failed:", e);
        // We don't throw here to ensure the main document record remains
      }
    }

    return { id: row.id as string };
  });

export const updateSop = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      id: z.string(),
      title: z.string().min(2).max(200),
      doc_type: z.enum(["sop", "rmit", "rmit_reg", "fatf", "circular", "it_policy", "policy"]),
      summary: z.string().max(4000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      file_url: z.string().nullable().optional(),
    })
  )
  .handler(async ({ data }) => {
    const { data: current, error: readError } = await supabase
      .from("sop_documents")
      .select("version")
      .eq("id", data.id)
      .single();
    if (readError || !current) throw new Error(readError?.message || "SOP not found");

    const nextVersion = bumpVersion(String(current.version ?? "1.0"));
    const embedding = await generateEmbedding(`${data.title} ${data.summary || ""}`);

    const updatePayload = {
      title: data.title,
      doc_type: data.doc_type,
      version: nextVersion,
      summary: data.summary ?? null,
      tags: data.tags ?? [],
      embedding,
      ...(data.file_url !== undefined ? { file_url: data.file_url } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("sop_documents").update(updatePayload).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true, version: nextVersion };
  });

export const clearWorkspace = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      scope: z.enum(["analyses", "kb", "all"]),
    })
  )
  .handler(async ({ data }) => {
    if (data.scope === "analyses" || data.scope === "all") {
      await supabase.from("chat_messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("sop_impacts").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("regulatory_changes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("analysis_reports").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }
    if (data.scope === "kb" || data.scope === "all") {
      await supabase.from("sop_documents").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }
    return { ok: true };
  });
