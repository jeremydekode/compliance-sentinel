import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { analyzePolicy, chunkDocument, generateAmendedDocument, extractRegulatoryChanges, mapChangeToSops, generateAnalysisSummary } from "./gemini";
import { applyEditsToDocx, looksLikeDocx, docxToText } from "./docx-editor";

/**
 * Wrap a fetched file as a PolicySource for Gemini.
 * Gemini's inline data API doesn't accept DOCX — for DOCX we extract paragraph text
 * and send as text content instead.
 */
function policySourceFromFile(
  name: string,
  file: { buffer: Buffer; mimeType: string },
  hintUrl?: string | null
): { name: string; buffer: Buffer; mimeType: string } | { name: string; text: string } {
  if (looksLikeDocx(file.mimeType, hintUrl ?? null)) {
    const text = docxToText(file.buffer);
    return { name, text };
  }
  return { name, buffer: file.buffer, mimeType: file.mimeType };
}
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
      workspace: z.enum(["rmit", "fatf"]).default("rmit"),
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
    const workspace = data.workspace;
    
    // 1. Fetch the newly uploaded policy
    if (!data.fileUrl) throw new Error("No file URL provided for analysis");
    const newPolicy = await fetchFile(data.fileUrl);

    // 2. Try to find the old version of this policy in the KB.
    // Use REGULATION_FAMILIES so e.g. uploading new RMiT (rmit_reg) finds legacy "rmit"
    // tagged docs, FATF finds FATF, etc.
    const oldDocTypes = detected?.doc_type
      ? (REGULATION_FAMILIES[detected.doc_type] ?? [detected.doc_type])
      : ["__none__"];
    const { data: oldDocs } = await (supabase as any)
      .from("sop_documents")
      .select("*")
      .eq("workspace_id", workspace)
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
        const { data: sopDocs } = await (supabase as any)
          .from("sop_documents")
          .select("*")
          .eq("workspace_id", workspace)
          .in("id", sopIds)
          .in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (sopDocs ?? []) as any[];
      }

      // Fall back to ALL internal SOPs if chunk search returned nothing
      if (relevantSops.length === 0) {
        console.log("Chunk search returned nothing — fetching all internal SOPs as fallback.");
        const { data: allSops } = await (supabase as any)
          .from("sop_documents")
          .select("*")
          .eq("workspace_id", workspace)
          .in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (allSops ?? []) as any[];
      }
      kbAll = relevantSops;

      // 4. Two-stage analysis with per-change chunk RAG
      //    Stage A: extract regulatory changes from old vs new policy
      //    Stage B: for each change, vector-search relevant chunks across all SOPs in workspace,
      //             then ask AI to propose edits anchored ONLY to those real chunks
      console.log(`Starting analysis for ${data.filename}...`);
      const newPolicySource = policySourceFromFile(data.filename, newPolicy, data.fileUrl);
      const oldPolicySource = oldPolicy && oldDoc
        ? policySourceFromFile(oldDoc.title, oldPolicy, oldDoc.file_url)
        : undefined;
      const extractedChanges = await extractRegulatoryChanges(
        newPolicySource,
        oldPolicySource,
        regulatorContext(detected?.doc_type)
      );
      console.log(`Extracted ${extractedChanges.length} regulatory changes. Now mapping each to SOP chunks...`);

      const allImpacts: any[] = [];
      for (const change of extractedChanges) {
        try {
          // Per-change vector search: find the most semantically relevant chunks
          const changeQuery = `${change.change_summary} ${change.new_requirement ?? ""}`;
          const changeEmbedding = await generateQueryEmbedding(changeQuery);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: changeChunks } = await (supabase as any).rpc("match_sop_chunks", {
            query_embedding: changeEmbedding,
            match_threshold: 0.15,
            match_count: 40,
          });
          const matchedChunks: any[] = (changeChunks ?? []).filter((c: any) =>
            relevantSops.some(s => s.id === c.sop_id)
          );

          // Group chunks by SOP
          const chunksBySop = new Map<string, any[]>();
          for (const ch of matchedChunks) {
            if (!chunksBySop.has(ch.sop_id)) chunksBySop.set(ch.sop_id, []);
            chunksBySop.get(ch.sop_id)!.push(ch);
          }

          // Per-SOP fairness: for any internal SOP with NO chunks above threshold,
          // do a per-SOP top-3 fallback search so every SOP gets considered for this change.
          for (const sop of relevantSops) {
            if (chunksBySop.has(sop.id)) continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: sopFallback } = await (supabase as any).rpc("match_sop_chunks", {
              query_embedding: changeEmbedding,
              match_threshold: 0.0,
              match_count: 50,
            });
            const sopOnly = (sopFallback ?? []).filter((c: any) => c.sop_id === sop.id).slice(0, 3);
            if (sopOnly.length > 0) chunksBySop.set(sop.id, sopOnly);
          }

          if (chunksBySop.size === 0) {
            console.log(`  - [${change.chapter_ref}] no SOPs to consider, skipping`);
            continue;
          }

          // Build sops-for-change with chunk text contexts
          const sopsForChange: { title: string; text: string }[] = [];
          for (const [sopId, sopChunks] of chunksBySop.entries()) {
            const sop = relevantSops.find(s => s.id === sopId);
            if (!sop) continue;
            const text = sopChunks
              .map((c: any) => `[Section: ${c.chapter_ref || "unspecified"} | Page: ${c.page_number || "?"}]\n${c.content}`)
              .join("\n\n---\n\n");
            sopsForChange.push({ title: sop.title, text });
          }

          const impacts = await mapChangeToSops(change, sopsForChange);
          console.log(`  - [${change.chapter_ref}] → ${impacts.length} impact(s) across ${chunksBySop.size} SOP(s)`);
          allImpacts.push(...impacts);
        } catch (innerErr: any) {
          console.warn(`Failed to map change [${change.chapter_ref}]:`, innerErr?.message);
        }
      }

      const summary = await generateAnalysisSummary(extractedChanges, allImpacts as any[], data.filename);
      aiResult = { changes: extractedChanges, impacts: allImpacts, summary };
      console.log(`Analysis complete. ${aiResult.changes.length} changes, ${aiResult.impacts.length} SOP impacts.`);
    } catch (e: any) {
      console.error("Intelligence engine encountered an issue during analysis:", e);
      throw new Error(`AI Analysis failed: ${e.message}`);
    }

    const fallbackName = data.filename.replace(/\.[^.]+$/, "").trim() || data.filename;
    const displayName = (data.customTitle ?? "").trim() || fallbackName;

    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: displayName,
        policy_name: displayName,
        status: "pending_validation",
        source_file_url: data.fileUrl,
        workspace_id: workspace,
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
      const sop = matchSopByTitle(m.sop_title, relevantSops);
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
    const workspace = ((report as any).workspace_id as string) ?? "rmit";
    const oldDocTypes = detected?.doc_type
      ? (REGULATION_FAMILIES[detected.doc_type] ?? [detected.doc_type])
      : ["__none__"];
    const { data: oldDocs } = await (supabase as any)
      .from("sop_documents").select("*")
      .eq("workspace_id", workspace)
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
        const { data: sopDocs } = await (supabase as any)
          .from("sop_documents").select("*")
          .eq("workspace_id", workspace)
          .in("id", sopIds).in("doc_type", INTERNAL_DOC_TYPES);
        relevantSops = (sopDocs ?? []) as any[];
      }
      if (relevantSops.length === 0) {
        const { data: allSops } = await (supabase as any)
          .from("sop_documents").select("*")
          .eq("workspace_id", workspace)
          .in("doc_type", INTERNAL_DOC_TYPES);
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

    // 5. Run AI analysis (convert DOCX → text for Gemini compatibility)
    const newPolicySource = policySourceFromFile(report.policy_name ?? "policy", newPolicy, report.source_file_url);
    const oldPolicySource = oldPolicy && oldDoc
      ? policySourceFromFile(oldDoc.title, oldPolicy, oldDoc.file_url)
      : undefined;
    const aiResult = await analyzePolicy(
      newPolicySource,
      oldPolicySource,
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
      const sop = matchSopByTitle(m.sop_title, relevantSops);
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
      workspace: z.enum(["rmit", "fatf"]).default("rmit"),
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
        workspace_id: data.workspace,
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

// ── Document Amendment (Step 9) ─────────────────────────────────────────────

/**
 * Aggregate view of which internal SOPs have approved edits ready to apply.
 * Used to render the "Step 9 · Apply Approved Changes" card.
 */
export const getAmendableDocuments = createServerFn({ method: "GET" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { data: impacts } = await supabase
      .from("sop_impacts")
      .select("*")
      .eq("report_id", data.reportId)
      .eq("status", "approved");

    if (!impacts?.length) return { documents: [] };

    // Group by sop_id (skip unmatched)
    const map = new Map<string, any[]>();
    for (const imp of impacts) {
      if (!imp.sop_id) continue;
      if (!map.has(imp.sop_id)) map.set(imp.sop_id, []);
      map.get(imp.sop_id)!.push(imp);
    }

    const sopIds = Array.from(map.keys());
    if (sopIds.length === 0) return { documents: [] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sops } = await (supabase as any)
      .from("sop_documents")
      .select("id,title,version,doc_type,file_url,is_active,workspace_id")
      .in("id", sopIds);

    const docs = (sops ?? []).map((s: any) => ({
      sop_id: s.id,
      title: s.title,
      version: s.version,
      doc_type: s.doc_type,
      file_url: s.file_url,
      is_active: s.is_active !== false,
      edits_count: map.get(s.id)?.length ?? 0,
      // applied edits won't be re-applied
      applied_count: (map.get(s.id) ?? []).filter((i: any) => i.status === "applied").length,
    }));

    return { documents: docs };
  });

/**
 * Generate a preview of an amended SOP by applying all approved edits.
 * Returns the amended HTML for review BEFORE finalizing.
 */
export const generateDocumentPreview = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string(), sopId: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents").select("*").eq("id", data.sopId).single();
    if (sopErr || !sop) throw new Error("SOP not found");
    if (!sop.file_url) throw new Error("SOP has no source file — cannot amend");

    const { data: impacts } = await supabase
      .from("sop_impacts")
      .select("*")
      .eq("report_id", data.reportId)
      .eq("sop_id", data.sopId)
      .eq("status", "approved")
      .order("position");
    if (!impacts?.length) throw new Error("No approved edits to apply for this SOP");

    const file = await fetchFile(sop.file_url);
    const isDocx = looksLikeDocx(file.mimeType, sop.file_url);
    const nextVersion = bumpVersion(sop.version ?? "1.0");
    const safeTitle = (sop.title ?? "document").replace(/[^A-Za-z0-9._-]+/g, "_");

    if (isDocx) {
      // ── Full-fidelity DOCX path ──────────────────────────────────────
      // Apply edits programmatically — every untouched paragraph stays bit-for-bit
      // identical to the source. Edits are highlighted in yellow.
      const result = applyEditsToDocx(file.buffer, impacts.map((i: any) => ({
        change_type: i.change_type ?? "find_replace",
        find_text: i.find_text,
        replace_text: i.replace_text,
        edited_text: i.edited_text,
        paragraph: i.paragraph,
      })));

      // Upload preview to Storage so the client can download / show it
      const previewPath = `amendments/preview/${Date.now()}-${safeTitle}-v${nextVersion}.docx`;
      const { error: upErr } = await supabase.storage
        .from("policies")
        .upload(previewPath, result.buffer, {
          upsert: false,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      if (upErr) throw new Error(`Failed to upload DOCX preview: ${upErr.message}`);
      const { data: urlData } = supabase.storage.from("policies").getPublicUrl(previewPath);

      return {
        format: "docx" as const,
        sopTitle: sop.title,
        currentVersion: sop.version,
        nextVersion,
        editsApplied: result.appliedCount,
        editsRequested: impacts.length,
        skippedEdits: result.skipped.map(s => ({
          reason: s.reason,
          paragraph: s.edit.paragraph ?? null,
          find_text: (s.edit.find_text ?? "").slice(0, 200),
        })),
        previewUrl: urlData.publicUrl,
        previewPath,
        amendedHtml: null,
      };
    }

    // ── Lossy PDF path (legacy) ────────────────────────────────────────
    // For PDFs we can't do faithful editing — fall back to AI-rendered HTML.
    const amendedHtml = await generateAmendedDocument(
      { title: sop.title, buffer: file.buffer, mimeType: file.mimeType },
      impacts.map((i: any) => ({
        change_type: i.change_type ?? "find_replace",
        paragraph: i.paragraph ?? undefined,
        chapter: i.chapter ?? undefined,
        find_text: i.find_text ?? undefined,
        replace_text: i.replace_text ?? undefined,
        edited_text: i.edited_text ?? undefined,
      }))
    );

    return {
      format: "html" as const,
      sopTitle: sop.title,
      currentVersion: sop.version,
      nextVersion,
      editsApplied: impacts.length,
      editsRequested: impacts.length,
      skippedEdits: [],
      previewUrl: null,
      previewPath: null,
      amendedHtml,
    };
  });

/**
 * Commit the amended document as a new version in the KB.
 * - Stores the preview HTML to Supabase Storage as the new file.
 * - Inserts new sop_documents row marked is_active=true.
 * - Marks the old version is_active=false, superseded_by=<new id>.
 * - Updates impacts: status='applied', applied_in_version=<new version>.
 */
export const finalizeDocumentAmendment = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    reportId: z.string(),
    sopId: z.string(),
    // DOCX path: previewUrl points to the preview file in Storage (we re-upload it under the final amendments/ prefix)
    previewUrl: z.string().nullable().optional(),
    previewPath: z.string().nullable().optional(),
    // HTML path: amended HTML body to wrap and save
    amendedHtml: z.string().nullable().optional(),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: oldSop, error: sopErr } = await (supabase as any)
      .from("sop_documents").select("*").eq("id", data.sopId).single();
    if (sopErr || !oldSop) throw new Error("SOP not found");

    const nextVersion = bumpVersion(oldSop.version ?? "1.0");
    const safeTitle = (oldSop.title ?? "document").replace(/[^A-Za-z0-9._-]+/g, "_");

    let newFileUrl: string;

    if (data.previewUrl && data.previewPath) {
      // ── DOCX path: copy the preview file into a permanent amendments/ path ──
      const finalPath = `amendments/${Date.now()}-${safeTitle}-v${nextVersion}.docx`;
      // Move via copy + delete (Supabase Storage doesn't have a single move on JS client)
      const { error: copyErr } = await supabase.storage
        .from("policies")
        .copy(data.previewPath, finalPath);
      if (copyErr) throw new Error(`Failed to finalise DOCX: ${copyErr.message}`);
      await supabase.storage.from("policies").remove([data.previewPath]).catch(() => {});
      const { data: urlData } = supabase.storage.from("policies").getPublicUrl(finalPath);
      newFileUrl = urlData.publicUrl;
    } else if (data.amendedHtml) {
      // ── HTML path: wrap and save the AI-rendered preview ────────────────
      const fullHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(oldSop.title ?? "Amended Document")} — v${escapeHtml(nextVersion)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;color:#111;max-width:880px;margin:40px auto;padding:0 32px;line-height:1.55;font-size:13px}
  h1{font-size:22px;margin:0 0 6px} h2{font-size:16px;margin:24px 0 8px}
  h3{font-size:14px;margin:18px 0 6px} p{margin:0 0 10px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#f5f5f5;font-weight:700}
  ul,ol{margin:6px 0 10px 24px} li{margin-bottom:3px}
  mark.amended{background:#fffacc;padding:1px 3px;border-radius:2px;border-bottom:2px solid #e0b800}
  .doc-meta{border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:8px 0;margin:0 0 20px;display:flex;gap:24px;font-size:11px;color:#666}
  .doc-meta strong{color:#111;margin-right:4px}
  .toolbar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #eee;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}
  .toolbar button{padding:6px 14px;border:1px solid #111;background:#111;color:#fff;border-radius:4px;cursor:pointer;font-size:12px}
  @media print { .toolbar{display:none} body{margin:20px} }
</style></head><body>
<div class="toolbar"><strong>Amended document — v${escapeHtml(nextVersion)}</strong><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="doc-meta">
  <div><strong>Document:</strong>${escapeHtml(oldSop.title ?? "")}</div>
  <div><strong>Version:</strong>${escapeHtml(nextVersion)}</div>
  <div><strong>Amended:</strong>${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
</div>
${data.amendedHtml}
</body></html>`;
      const path = `amendments/${Date.now()}-${safeTitle}-v${nextVersion}.html`;
      const { error: upErr } = await supabase.storage
        .from("policies")
        .upload(path, new Blob([fullHtml], { type: "text/html" }), { upsert: false, contentType: "text/html" });
      if (upErr) throw new Error(`Failed to upload amended file: ${upErr.message}`);
      const { data: urlData } = supabase.storage.from("policies").getPublicUrl(path);
      newFileUrl = urlData.publicUrl;
    } else {
      throw new Error("Either previewUrl+previewPath (DOCX) or amendedHtml (HTML) must be provided");
    }

    // Insert new sop_documents row (the amended version)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newSop, error: insErr } = await (supabase as any)
      .from("sop_documents")
      .insert({
        title: oldSop.title,
        doc_type: oldSop.doc_type,
        version: nextVersion,
        summary: oldSop.summary,
        tags: oldSop.tags,
        file_url: newFileUrl,
        workspace_id: oldSop.workspace_id ?? "rmit",
        is_active: true,
        parent_id: oldSop.id,
        amended_from_report: data.reportId,
        amended_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insErr || !newSop) throw new Error(`Failed to create new version: ${insErr?.message}`);

    // Mark old version superseded
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_documents")
      .update({ is_active: false, superseded_by: newSop.id })
      .eq("id", oldSop.id);

    // Mark impacts as applied
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_impacts")
      .update({ status: "applied", applied_in_version: nextVersion, applied_at: new Date().toISOString() })
      .eq("report_id", data.reportId)
      .eq("sop_id", data.sopId)
      .eq("status", "approved");

    return {
      newSopId: newSop.id as string,
      newVersion: nextVersion,
      newFileUrl,
    };
  });

/**
 * Match an AI-returned sop_title against the KB sop_documents list.
 * Strategy (in order):
 *   1. Exact (case-insensitive) match on stored title
 *   2. Code-pattern match: extract codes like "R13_GL248", "S08_GL151", "R13.PO004" from either side
 *   3. Substring match (bidirectional)
 */
function matchSopByTitle(aiTitle: string | null | undefined, sops: any[]): any | undefined {
  const ai = (aiTitle ?? "").toLowerCase().trim();
  if (!ai || sops.length === 0) return undefined;

  // 1. Exact match
  let hit = sops.find(s => (s.title ?? "").toLowerCase().trim() === ai);
  if (hit) return hit;

  // 2. Code extraction — handles "R13_GL248", "R13 GL248", "S08-GL151", "S08.PO004", etc.
  const codeRegex = /[a-z]\d+[\s_.\-]?[a-z]+\d+/gi;
  const aiCodes = (ai.match(codeRegex) ?? []).map(normalizeCode);
  if (aiCodes.length > 0) {
    for (const s of sops) {
      const storedCodes = ((s.title ?? "").match(codeRegex) ?? []).map(normalizeCode);
      if (storedCodes.some((c: string) => aiCodes.includes(c))) return s;
    }
  }

  // 3. Bidirectional substring
  hit = sops.find(s => {
    const stored = (s.title ?? "").toLowerCase().trim();
    return stored.includes(ai) || ai.includes(stored);
  });
  return hit;
}

function normalizeCode(code: string): string {
  return code.toLowerCase().replace(/[\s_.\-]+/g, "");
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
