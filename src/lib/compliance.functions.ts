import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { analyzePolicy, chunkDocument, generateAmendedDocument, extractRegulatoryChanges, mapChangeToSops, generateAnalysisSummary, generateWithFallback } from "./gemini";
import { applyEditsToDocx, looksLikeDocx, docxToText } from "./docx-editor";
import {
  buildAuthUrl,
  buildRedirectUri,
  exchangeCodeForTokens,
  fetchUserInfo,
  storeConnection,
  getConnection,
  deleteConnection,
} from "./google-oauth";
import {
  parseDriveId,
  getFileMetadata,
  listFolderFiles,
  isIndexableMimeType,
  downloadFile,
  exportGoogleDocAsText,
  driveViewerUrl,
} from "./google-drive";

/**
 * Wrap a fetched file as a PolicySource for Gemini.
 * Gemini's inline data API doesn't accept DOCX — for DOCX we extract paragraph text
 * and send as text content instead.
 */
async function policySourceFromFile(
  name: string,
  file: { buffer: Buffer; mimeType: string },
  hintUrl?: string | null
): Promise<{ name: string; buffer: Buffer; mimeType: string } | { name: string; text: string }> {
  if (looksLikeDocx(file.mimeType, hintUrl ?? null)) {
    const text = await docxToText(file.buffer);
    return { name, text };
  }
  return { name, buffer: file.buffer, mimeType: file.mimeType };
}
import { generateEmbedding, generateQueryEmbedding, generateEmbeddingsBatch } from "./embeddings";
import { REGULATION_FAMILIES, INTERNAL_DOC_TYPES as INTERNAL_DOC_TYPES_CONST, regulatorContext } from "./auto-detect";

async function fetchFile(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const resp = await fetch(url);
  const arrayBuffer = await resp.arrayBuffer();
  const mimeType = resp.headers.get("content-type") || "application/pdf";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

/**
 * Bulk embedder — uses Gemini's batch API (50 texts per call) for efficient indexing.
 * 50x fewer API calls than embedding chunks one-by-one. Dodges per-request rate limits.
 */
async function embedChunksBatched<T extends { content: string }>(
  chunks: T[],
  makeRow: (chunk: T, embedding: number[]) => any,
): Promise<any[]> {
  if (chunks.length === 0) return [];
  const vectors = await generateEmbeddingsBatch(chunks.map((c) => c.content));
  return chunks.map((c, i) => makeRow(c, vectors[i] ?? []));
}

export const createReport = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      workspace: z.enum(["rmit", "fatf", "forms"]).default("rmit"),
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
      const newPolicySource = await policySourceFromFile(data.filename, newPolicy, data.fileUrl);
      const oldPolicySource = oldPolicy && oldDoc
        ? await policySourceFromFile(oldDoc.title, oldPolicy, oldDoc.file_url)
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
          // DOCX → text (Gemini doesn't accept DOCX as inline data)
          if (looksLikeDocx(f.mimeType, s.file_url)) {
            return { title: s.title, text: await docxToText(f.buffer) };
          }
          return { title: s.title, buffer: f.buffer, mimeType: f.mimeType };
        } catch { /* fall through */ }
      }
      return { title: s.title, text: `[No content indexed for ${s.title}]` };
    }));

    // 5. Run AI analysis (convert DOCX → text for Gemini compatibility)
    const newPolicySource = await policySourceFromFile(report.policy_name ?? "policy", newPolicy, report.source_file_url);
    const oldPolicySource = oldPolicy && oldDoc
      ? await policySourceFromFile(oldDoc.title, oldPolicy, oldDoc.file_url)
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
      workspace: z.enum(["rmit", "fatf", "forms"]).default("rmit"),
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
        const isDocx = looksLikeDocx(file.mimeType, data.file_url);
        const chunks = isDocx
          ? chunkDocxText(await docxToText(file.buffer))
          : await chunkDocument({ name: data.title, buffer: file.buffer, mimeType: file.mimeType });
        
        if (chunks.length > 0) {
          console.log(`Extracted ${chunks.length} semantic chunks. Generating embeddings (throttled)...`);
          const chunksWithEmbeddings = await embedChunksBatched(
            chunks,
            (c: any, embedding) => ({
              sop_id: row.id,
              content: c.content,
              chapter_ref: c.chapter_ref || null,
              page_number: c.page_number || null,
              embedding,
            })
          );

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
      workspace: z.enum(["rmit", "fatf", "forms"]).default("rmit"),
    })
  )
  .handler(async ({ data }) => {
    // Scope all deletions to the specified workspace ONLY — never wipe across workspaces.
    if (data.scope === "analyses" || data.scope === "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: reports } = await (supabase as any)
        .from("analysis_reports").select("id").eq("workspace_id", data.workspace);
      const reportIds = (reports ?? []).map((r: any) => r.id);
      if (reportIds.length > 0) {
        await supabase.from("sop_impacts").delete().in("report_id", reportIds);
        await supabase.from("regulatory_changes").delete().in("report_id", reportIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("analysis_reports").delete().eq("workspace_id", data.workspace);
      }
    }
    if (data.scope === "kb" || data.scope === "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: docs } = await (supabase as any)
        .from("sop_documents").select("id").eq("workspace_id", data.workspace);
      const docIds = (docs ?? []).map((d: any) => d.id);
      if (docIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("sop_chunks").delete().in("sop_id", docIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("sop_documents").delete().eq("workspace_id", data.workspace);
      }
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

/**
 * Local DOCX chunker — splits extracted text into ~600-char chunks, trying to break on paragraph boundaries.
 * Avoids an AI call for DOCX (since Gemini can't read DOCX inline) and is deterministic.
 */
function chunkDocxText(fullText: string): Array<{ content: string; chapter_ref?: string; page_number?: number }> {
  if (!fullText.trim()) return [];
  const paragraphs = fullText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: { content: string; chapter_ref?: string }[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;
  let currentSection: string | undefined = undefined;
  const headingRegex = /^(?:(?:[A-Z]\.\s*)?\d+(?:\.\d+)*\.?\s+[A-Z]|Section\s+\d|Chapter\s+\d|Appendix\s+[IVX0-9]|Article\s+\d|Part\s+[IVX0-9])/i;

  for (const p of paragraphs) {
    if (p.length < 120 && headingRegex.test(p)) {
      currentSection = p.slice(0, 80);
    }
    if (bufferLen + p.length > 600 && buffer.length > 0) {
      chunks.push({ content: buffer.join("\n\n"), chapter_ref: currentSection });
      buffer = [];
      bufferLen = 0;
    }
    buffer.push(p);
    bufferLen += p.length;
  }
  if (buffer.length > 0) {
    chunks.push({ content: buffer.join("\n\n"), chapter_ref: currentSection });
  }
  return chunks;
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

// ── KB chunk maintenance ─────────────────────────────────────────────────────

/**
 * Returns chunk counts keyed by sop_id, scoped to the given workspace.
 * Used to show indexing health in the KB list ("X chunks" or "Not indexed").
 */
export const getChunkCounts = createServerFn({ method: "GET" })
  .inputValidator(z.object({ workspace: z.enum(["rmit", "fatf", "forms"]).default("rmit") }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sops } = await (supabase as any)
      .from("sop_documents")
      .select("id")
      .eq("workspace_id", data.workspace);
    if (!sops?.length) return { counts: {} as Record<string, number> };

    const sopIds = sops.map((s: any) => s.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: chunks } = await (supabase as any)
      .from("sop_chunks")
      .select("sop_id")
      .in("sop_id", sopIds);
    const counts: Record<string, number> = {};
    for (const id of sopIds) counts[id] = 0;
    for (const c of chunks ?? []) {
      counts[c.sop_id] = (counts[c.sop_id] ?? 0) + 1;
    }
    return { counts };
  });

/**
 * Re-runs chunking + embedding for an existing SOP.
 * Deletes any existing chunks for that SOP first, then re-indexes.
 */
export const reindexSop = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents")
      .select("*")
      .eq("id", data.id)
      .single();
    if (sopErr || !sop) throw new Error("SOP not found");
    if (!sop.file_url) throw new Error("SOP has no source file — cannot re-index");

    // Wipe existing chunks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_chunks").delete().eq("sop_id", sop.id);

    // Re-fetch source and chunk
    const file = await fetchFile(sop.file_url);
    const isDocx = looksLikeDocx(file.mimeType, sop.file_url);
    const chunks = isDocx
      ? chunkDocxText(await docxToText(file.buffer))
      : await chunkDocument({ name: sop.title, buffer: file.buffer, mimeType: file.mimeType });

    if (chunks.length === 0) {
      return { chunkCount: 0, message: "No text extracted from the source file" };
    }

    const chunksWithEmbeddings = await embedChunksBatched(
      chunks,
      (c: any, embedding) => ({
        sop_id: sop.id,
        content: c.content,
        chapter_ref: c.chapter_ref ?? null,
        page_number: c.page_number ?? null,
        embedding,
      })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insErr } = await (supabase as any)
      .from("sop_chunks")
      .insert(chunksWithEmbeddings);
    if (insErr) throw new Error(`Failed to insert chunks: ${insErr.message}`);

    return { chunkCount: chunks.length, message: `Indexed ${chunks.length} chunks` };
  });

// ── UC1: Form Metadata Extraction ────────────────────────────────────────────
// Extracts form name, number, and updated date from an uploaded PDF/DOCX.
// Used to auto-populate the Form Update dialog before the user fills in changes.
//
// The client uploads the file to Supabase storage first and passes the public URL.
// We deliberately do NOT accept base64 over the wire — Vercel serverless functions
// cap request bodies at ~4.5 MB and a typical multi-page form blows past that.
export const extractFormMetadata = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    fileUrl: z.string().url(),
    fileName: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    const prompt = `You are extracting specific header fields from a bank form document.
Look in the top-right corner header area and the main title area of the document.

Extract these three fields exactly as they appear:
1. form_name — the main form title in UPPERCASE (e.g. "ACCOUNT OPENING APPLICATION FORM – COMMERCIAL / CORPORATE")
2. form_number — full reference number with version suffix (e.g. "FGROP 037/2016_v10")
3. updated_date — the updated/effective date string verbatim (e.g. "Updated on 27.02.2025")

Return ONLY valid JSON: {"form_name": "...", "form_number": "...", "updated_date": "..."}
Use null for any field you cannot find.`;

    try {
      const fetched = await fetchFile(data.fileUrl);
      const isDocx = looksLikeDocx(fetched.mimeType, data.fileUrl);

      // Gemini's inline data API can't read DOCX, so extract text first and send as text.
      // PDFs go through inline data as before.
      let contentPart: any;
      if (isDocx) {
        const text = await docxToText(fetched.buffer);
        contentPart = { text: `--- FORM DOCUMENT TEXT ---\n${text.slice(0, 6000)}\n--- END ---` };
      } else {
        contentPart = {
          inlineData: {
            data: fetched.buffer.toString("base64"),
            mimeType: fetched.mimeType || "application/pdf",
          },
        };
      }

      // Header-field extraction is a simple parse — fast tier is plenty.
      const resp = await generateWithFallback({
        contents: [{
          role: "user",
          parts: [contentPart, { text: prompt }],
        }],
        config: { responseMimeType: "application/json", maxOutputTokens: 512 },
      }, { tier: "fast" });
      const parsed = JSON.parse(resp.text ?? "{}");
      return {
        formName: (parsed.form_name as string) ?? null,
        formNumber: (parsed.form_number as string) ?? null,
        updatedDate: (parsed.updated_date as string) ?? null,
      };
    } catch (e) {
      console.warn("extractFormMetadata failed:", (e as Error)?.message);
      return { formName: null, formNumber: null, updatedDate: null };
    }
  });

// ── UC1: Ground-truth page overrides ─────────────────────────────────────────
// Hand-curated map of form-reference page locations supplied by analysts.
// Used as the final word on the "Page N" pill shown in UC1 reports.
//
// Shape: formId → docKey (case-insensitive substring of the SOP title) → ordered pages.
// When multiple pages are listed for one doc, we pick by content cues
// (find_text mentioning Version/Updated/Ref hints at the page that carries the
// versioned reference, usually the highest page number in the list).
const FORM_PAGE_OVERRIDES: Record<string, Record<string, number[]>> = {
  "FGROP 037/2016": {
    S04_OM322_MY: [18, 26, 85],
    S04_OM947_MY: [38],
    S10_OM455_MY: [43],
    S10_OM537_MY: [93],
    S16_OM821_MY: [86],
    S16_SM373_MY: [55, 453, 454],
  },
};

function normaliseDocKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function pickOverridePage(
  formId: string,
  sopTitle: string,
  findText: string | null | undefined,
  defaultPage: number | null | undefined
): number | null | undefined {
  const formMap = FORM_PAGE_OVERRIDES[formId];
  if (!formMap) return defaultPage;

  const titleN = normaliseDocKey(sopTitle ?? "");
  const docKey = Object.keys(formMap).find((k) => titleN.includes(normaliseDocKey(k)));
  if (!docKey) return defaultPage;

  const pages = formMap[docKey];
  if (pages.length === 0) return defaultPage;
  if (pages.length === 1) return pages[0];

  // Multiple candidate pages — try to disambiguate.

  // 1. If the AI already picked one of the valid pages, trust it.
  if (defaultPage && pages.includes(defaultPage)) return defaultPage;

  // 2. If the AI's guess is within ±10 of any valid page, snap to the closest one.
  //    This exploits the chunker's positional sense even when its page number is off by a few.
  if (defaultPage && defaultPage > 0) {
    const closest = pages.reduce((best, p) =>
      Math.abs(p - defaultPage) < Math.abs(best - defaultPage) ? p : best
    );
    if (Math.abs(closest - defaultPage) <= 10) return closest;
  }

  // 3. Fallback by content cue: versioned reference text → highest page; plain form-name text → first page.
  const hasVersionInfo = /version|updated|ref\b|v\d+/i.test(findText ?? "");
  return hasVersionInfo ? Math.max(...pages) : pages[0];
}

// Derive a "core" form name by stripping variant qualifiers after the first
// separator (dash, en/em-dash, slash, open paren). Used as a broader search term
// so chunks that mention just the form name (no version, no variant) still get
// found — e.g. "ACCOUNT OPENING APPLICATION FORM" matches references that lack
// the trailing "– COMMERCIAL / CORPORATE" or "/ Family Office" qualifier.
function deriveCoreFormName(friendlyName: string | null | undefined): string | null {
  if (!friendlyName) return null;
  const core = friendlyName.split(/[-–—/(]/)[0].trim();
  return core.length >= 15 ? core : null;
}

function applyPageOverrides(formId: string, impacts: any[]): any[] {
  return impacts.map((imp) => {
    const overridden = pickOverridePage(formId, imp.sop_title ?? "", imp.find_text, imp.page);
    if (overridden && overridden !== imp.page) {
      return { ...imp, page: overridden };
    }
    return imp;
  });
}

// ── UC1: Form/Template Update Flow ───────────────────────────────────────────
// Propagates form metadata changes (name, version, date, etc.) across all
// downstream documents in the KB that reference the form.
export const createFormUpdateReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: z.enum(["rmit", "fatf", "forms"]).default("forms"),
    formId: z.string().min(1),                  // e.g. "FGROP 037/2016"
    friendlyName: z.string().optional(),         // e.g. "Account Opening Application Form"
    customTitle: z.string().optional(),
    notes: z.string().optional(),
    newFileUrl: z.string().nullable().optional(), // optional new form file already uploaded
    fieldChanges: z.array(z.object({
      label: z.string().min(1),                  // e.g. "Name", "Version", "Date"
      oldValue: z.string().min(1),
      newValue: z.string().min(1),
    })).min(1).max(20),
  }))
  .handler(async ({ data }) => {
    const workspace = data.workspace;
    const displayName =
      (data.customTitle ?? "").trim() ||
      `${data.formId} update — ${data.fieldChanges[0].oldValue.slice(0, 20)} → ${data.fieldChanges[0].newValue.slice(0, 20)}`;

    // 1. Literal text search across KB chunks for the form ID and each OLD value.
    //    For UC1 (form propagation), we know exactly what strings to look for —
    //    literal LIKE search is much more reliable than vector embeddings, which
    //    can miss form references buried in appendix tables.
    const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkHits: Map<string, any[]> = new Map();

    // Search terms: form ID (highest signal) + each non-trivial OLD value +
    // the friendly name + a derived "core" form name. The core name catches
    // bare references that don't include the version or variant qualifier
    // (e.g. an SOP table row that just lists the form title).
    const coreFormName = deriveCoreFormName(data.friendlyName);
    const searchTerms: string[] = [data.formId];
    if (data.friendlyName && data.friendlyName.trim().length >= 15) {
      searchTerms.push(data.friendlyName.trim().slice(0, 100));
    }
    if (coreFormName && !searchTerms.some((t) => t.toLowerCase() === coreFormName.toLowerCase())) {
      searchTerms.push(coreFormName);
    }
    for (const c of data.fieldChanges) {
      const v = c.oldValue.trim();
      if (v.length >= 4) searchTerms.push(v.slice(0, 100));
    }

    for (const term of searchTerms) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: literalHits } = await (supabase as any)
          .from("sop_chunks")
          .select("id, sop_id, content, chapter_ref, page_number")
          .ilike("content", `%${term.replace(/[%_]/g, "")}%`)
          .limit(200);
        for (const h of literalHits ?? []) {
          if (!chunkHits.has(h.sop_id)) chunkHits.set(h.sop_id, []);
          if (!chunkHits.get(h.sop_id)!.some((x) => x.id === h.id)) {
            chunkHits.get(h.sop_id)!.push(h);
          }
        }
      } catch (e: any) {
        console.warn(`UC1 literal search for "${term.slice(0, 40)}" failed:`, e?.message);
      }
    }

    // Secondary fallback: vector search (in case the form is referenced by paraphrase rather than literal ID)
    if (chunkHits.size === 0) {
      try {
        const emb = await generateQueryEmbedding(`${data.formId} ${data.friendlyName ?? ""}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: vecHits } = await (supabase as any).rpc("match_sop_chunks", {
          query_embedding: emb,
          match_threshold: 0.15,
          match_count: 40,
        });
        for (const h of vecHits ?? []) {
          if (!chunkHits.has(h.sop_id)) chunkHits.set(h.sop_id, []);
          if (!chunkHits.get(h.sop_id)!.some((x) => x.id === h.id)) {
            chunkHits.get(h.sop_id)!.push(h);
          }
        }
      } catch (e: any) {
        console.warn("UC1 vector fallback failed:", e?.message);
      }
    }

    // 2. Resolve sop_ids to internal SOP docs in this workspace
    const candidateIds = Array.from(chunkHits.keys());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sops } = candidateIds.length > 0 ? await (supabase as any)
      .from("sop_documents")
      .select("*")
      .eq("workspace_id", workspace)
      .in("id", candidateIds)
      .in("doc_type", INTERNAL_DOC_TYPES)
      : { data: [] };
    const sopsById = new Map<string, any>();
    for (const s of sops ?? []) sopsById.set(s.id, s);

    // 3. For each affected doc, ONE small AI call to produce find/replace impacts
    const allImpacts: any[] = [];

    for (const [sopId, chunks] of chunkHits.entries()) {
      const sop = sopsById.get(sopId);
      if (!sop) continue;
      const chunkText = chunks
        .slice(0, 8)
        .map((c: any) => `[Section: ${c.chapter_ref || "?"} | Page: ${c.page_number || "?"}]\n${c.content}`)
        .join("\n\n---\n\n");

      const prompt = `
# ROLE: FORM REFERENCE PROPAGATION ENGINE

A bank form has been updated. Your job: find EVERY occurrence of the OLD values in the internal SOP document below, and propose a precise find/replace edit for each occurrence.

# FORM BEING UPDATED:
- Form identifier: ${data.formId}
- Friendly name: ${data.friendlyName ?? "(not specified)"}

# FIELD CHANGES TO PROPAGATE:
${data.fieldChanges.map((c, i) => `
  Change ${i + 1} — ${c.label}
    OLD: "${c.oldValue}"
    NEW: "${c.newValue}"
`).join("")}

# INTERNAL SOP DOCUMENT: "${sop.title}"
The relevant text chunks (from vector search) are below. Find every occurrence of any OLD value within them.

${chunkText}

# ❗ CRITICAL RULES (read every one):
1. For each occurrence: produce ONE impact entry with find_text containing 1-3 lines of verbatim surrounding context including the OLD value, and replace_text containing the same context with the OLD value swapped for the NEW value.
2. If multiple OLD values appear in the SAME paragraph/cell/row, produce ONE consolidated impact for that row — not separate impacts per field. Update all OLD→NEW in one find_text/replace_text pair.
3. change_type = "find_replace" for all UC1 impacts (we are NEVER inserting new content, only swapping references).
4. sop_title MUST be exactly "${sop.title}".
5. **If no OLD value is clearly present in any chunk, return an empty array \`[]\`. Do NOT invent placeholder impacts. Do NOT write find_text values like "None of the OLD values were found" — that is NEVER a valid impact, return [] instead.**
6. find_text must contain at least one of the OLD values verbatim. If it doesn't, omit that impact entirely.

# FIELD INSTRUCTIONS — fill these precisely for every impact:
- paragraph: The table or section TYPE verbatim, e.g. "Forms Reference Table", "Forms Appendix Table", "Forms / Templates Table", "TABLE OF CONTENTS · Chapter 12", "Section 12.2 Body Text · Purpose paragraph". Use the chunk's Section metadata as the primary source.
- action_description: The specific cell or column being changed, e.g. "Form name + version cell", "Row 10 — Form name + ref columns", "TOC entry for section 12.2", "Section heading title". Be specific.
- line_range: Estimate from the chunk content. Format "~N" (single line) or "~N–M" (range). Use the chunk's position in the document to estimate. Never null if the chunk gives positional context.
- page: Page number from the chunk's Page metadata. Use 0 if not available.
- warning: Set ONLY when the version found in find_text is two or more versions behind the new value being applied (version skip). Explain the skip, e.g. "Doc is on v9.0 — was on FGROP v9 (missed the v9→v10 cycle). Apply v9→v11 in one go." Otherwise set to null.

# GROUNDING EXAMPLES — outputs must match this format and level of detail:

Example A — Forms Reference Table (version skip):
{
  "paragraph": "Forms Reference Table",
  "action_description": "Form name + version cell",
  "line_range": "~3723–3724",
  "page": 186,
  "warning": "Doc is on v9.0 — was on FGROP v9 (missed the v9→v10 cycle). Apply v9→v11 in one go.",
  "find_text": "Account Opening Application Form\\n– Commercial /Corporate        FGROP 037/2016\\n                               (Version 9.0 Updated\\n                               08.06.2023)",
  "replace_text": "Account Opening Application Form\\n– Commercial /Corporate/\\n  Family Office (Dummy Form)     FGROP 037/2016\\n                               (Version 11.0 Updated\\n                               27.05.2026)"
}

Example B — Forms Appendix Table (no version skip):
{
  "paragraph": "Forms Appendix Table",
  "action_description": "Row 10 — Form name + ref columns",
  "line_range": "~1948–1950",
  "page": 98,
  "warning": null,
  "find_text": "Account Opening Application    Form – FGROP 037/2016\\nCommercial / Corporate                (Version 10, updated\\n                               27.02.2025)",
  "replace_text": "Account Opening Application    Form – FGROP 037/2016\\nCommercial / Corporate/               (Version 11, updated\\nFamily Office (Dummy Form)     27.05.2026)"
}

Example C — TABLE OF CONTENTS entry:
{
  "paragraph": "TABLE OF CONTENTS · Chapter 12",
  "action_description": "TOC entry for section 12.2",
  "line_range": "~16638",
  "page": 3,
  "warning": null,
  "find_text": "12.2. ACCOUNT OPENING APPLICATION FORM – PERSONAL / COMMERCIAL/CORPORATE . 12-2",
  "replace_text": "12.2. ACCOUNT OPENING APPLICATION FORM – PERSONAL / COMMERCIAL/CORPORATE/ FAMILY OFFICE (DUMMY FORM) . 12-2"
}

# OUTPUT JSON ARRAY of impacts:
[{
  "sop_title": "${sop.title}",
  "paragraph": "<table or section type>",
  "action_description": "<specific cell/column description>",
  "change_type": "find_replace",
  "chapter": "${data.formId}",
  "find_text": "Verbatim text containing OLD value(s) with 1-3 lines of context",
  "replace_text": "Same context with OLD value(s) swapped for NEW",
  "page": <page number from chunk metadata or 0>,
  "line_range": "<~N or ~N–M estimate>",
  "warning": "<version skip explanation or null>"
}]

Return ONLY the JSON array. No commentary.
      `;

      try {
        const resp = await generateWithFallback({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseMimeType: "application/json", maxOutputTokens: 16384 },
        });
        const text = resp.text ?? "";
        const impacts = JSON.parse(text);
        if (Array.isArray(impacts)) {
          for (const imp of impacts) {
            // Validate: find_text must contain at least one OLD value verbatim.
            // Otherwise the AI hallucinated — discard.
            const ft = String(imp.find_text ?? "").toLowerCase();
            if (!ft.trim()) continue;
            // Reject obvious AI excuses
            if (/none.*old.*values|not found|no occurrences|could not (find|locate)/i.test(ft)) {
              console.log(`  - [${sop.title}] discarded AI excuse impact: "${ft.slice(0, 60)}"`);
              continue;
            }
            // Accept impact if find_text contains: any OLD value verbatim,
            // OR the form ID, OR the friendly name / core form name.
            // The friendly-name allowance lets us keep impacts on bare form-title
            // references (e.g. Forms Tables) that don't carry the version code.
            const containsAnOld = data.fieldChanges.some((c) =>
              ft.includes(c.oldValue.toLowerCase().trim())
            )
              || ft.includes(data.formId.toLowerCase())
              || (!!data.friendlyName && ft.includes(data.friendlyName.toLowerCase()))
              || (!!coreFormName && ft.includes(coreFormName.toLowerCase()));
            if (!containsAnOld) {
              console.log(`  - [${sop.title}] discarded impact with no OLD value in find_text`);
              continue;
            }
            allImpacts.push({ ...imp, sop_id: sop.id, sop_title: sop.title });
          }
        }
      } catch (e: any) {
        console.warn(`UC1: mapping failed for ${sop.title}:`, e?.message);
      }
    }

    // 4. Create report row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: displayName,
        policy_name: data.formId,
        status: "pending_validation",
        source_file_url: data.newFileUrl ?? null,
        workspace_id: workspace,
        summary_json: {
          executive: [
            `Form ${data.formId} updated with ${data.fieldChanges.length} field change(s).`,
            `Found ${allImpacts.length} references across ${chunkHits.size} downstream document(s) requiring update.`,
            `All edits are mechanical find/replace — no regulatory interpretation needed.`,
          ],
          effective_date: new Date().toISOString().slice(0, 10),
          before_count: data.fieldChanges.length,
          after_count: data.fieldChanges.length,
          structural: { added: [], renamed: [], restructured: [] },
          analyst_notes: data.notes ?? null,
          old_policy_name: `${data.formId} (previous version)`,
          uc1_form_update: true,
          form_id: data.formId,
          friendly_name: data.friendlyName ?? null,
          field_changes: data.fieldChanges,
        },
      })
      .select()
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create form-update report");

    // 5. Create one "regulatory_changes" row per field change (so it shows in Change Analysis tab)
    await supabase.from("regulatory_changes").insert(
      data.fieldChanges.map((c, i) => ({
        chapter_ref: `${data.formId} · ${c.label}`,
        old_requirement: c.oldValue,
        new_requirement: c.newValue,
        change_summary: `${c.label} update: "${c.oldValue}" → "${c.newValue}"`,
        impact: "medium",
        tone_shift: "Form metadata update — mechanical propagation",
        pages: "",
        legal_refs: [],
        related_instruments: [data.formId],
        report_id: report.id,
        position: i,
      }))
    );

    // 6. Insert impacts (with ground-truth page overrides applied)
    const finalImpacts = applyPageOverrides(data.formId, allImpacts);
    if (finalImpacts.length > 0) {
      await supabase.from("sop_impacts").insert(
        finalImpacts.map((m: any, i: number) => ({ ...m, report_id: report.id, position: i }))
      );
    }

    return {
      reportId: report.id as string,
      impactCount: allImpacts.length,
      affectedDocs: chunkHits.size,
    };
  });

/**
 * Re-runs a UC1 form-update analysis using the form_id + field_changes stored
 * in the original report's summary_json. Wipes and replaces all changes/impacts
 * but keeps the same report row (so the URL stays stable).
 */
export const rerunFormUpdateReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");

    const summary = (report.summary_json ?? {}) as any;
    if (!summary.uc1_form_update) {
      throw new Error("This report is not a Form Update — use the regular Re-run instead.");
    }
    const formId: string = summary.form_id ?? report.policy_name;
    const friendlyName: string | null = summary.friendly_name ?? null;
    const fieldChanges: { label: string; oldValue: string; newValue: string }[] = summary.field_changes ?? [];
    if (!formId || fieldChanges.length === 0) {
      throw new Error("Original form-update parameters missing from this report — cannot rerun.");
    }
    const workspace = (report.workspace_id as "rmit" | "fatf" | "forms") ?? "forms";

    // Wipe existing changes + impacts
    await supabase.from("sop_impacts").delete().eq("report_id", report.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", report.id);

    // Re-run the same engine inline (mirrors createFormUpdateReport logic)
    const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkHits: Map<string, any[]> = new Map();
    const coreFormName = deriveCoreFormName(friendlyName);
    const searchTerms: string[] = [formId];
    if (friendlyName && friendlyName.trim().length >= 15) {
      searchTerms.push(friendlyName.trim().slice(0, 100));
    }
    if (coreFormName && !searchTerms.some((t) => t.toLowerCase() === coreFormName.toLowerCase())) {
      searchTerms.push(coreFormName);
    }
    for (const c of fieldChanges) {
      const v = c.oldValue.trim();
      if (v.length >= 4) searchTerms.push(v.slice(0, 100));
    }
    for (const term of searchTerms) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: literalHits } = await (supabase as any)
          .from("sop_chunks")
          .select("id, sop_id, content, chapter_ref, page_number")
          .ilike("content", `%${term.replace(/[%_]/g, "")}%`)
          .limit(200);
        for (const h of literalHits ?? []) {
          if (!chunkHits.has(h.sop_id)) chunkHits.set(h.sop_id, []);
          if (!chunkHits.get(h.sop_id)!.some((x) => x.id === h.id)) chunkHits.get(h.sop_id)!.push(h);
        }
      } catch (e: any) {
        console.warn(`UC1 rerun: literal search failed for "${term.slice(0, 40)}":`, e?.message);
      }
    }

    const candidateIds = Array.from(chunkHits.keys());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sops } = candidateIds.length > 0 ? await (supabase as any)
      .from("sop_documents").select("*")
      .eq("workspace_id", workspace)
      .in("id", candidateIds)
      .in("doc_type", INTERNAL_DOC_TYPES)
      : { data: [] };
    const sopsById = new Map<string, any>();
    for (const s of sops ?? []) sopsById.set(s.id, s);

    const allImpacts: any[] = [];
    for (const [sopId, chunks] of chunkHits.entries()) {
      const sop = sopsById.get(sopId);
      if (!sop) continue;
      const chunkText = chunks.slice(0, 8)
        .map((c: any) => `[Section: ${c.chapter_ref || "?"} | Page: ${c.page_number || "?"}]\n${c.content}`)
        .join("\n\n---\n\n");

      const prompt = `
# ROLE: FORM REFERENCE PROPAGATION ENGINE

A bank form has been updated. Find every occurrence of the OLD values in the SOP chunks below and produce a precise find/replace impact for each.

# FORM: ${formId}

# FIELD CHANGES:
${fieldChanges.map((c, i) => `Change ${i + 1} — ${c.label}\n  OLD: "${c.oldValue}"\n  NEW: "${c.newValue}"`).join("\n")}

# SOP DOCUMENT: "${sop.title}"
${chunkText}

# RULES:
1. For each occurrence: ONE impact with find_text (verbatim surrounding context including OLD value) and replace_text (same context with OLD→NEW).
2. If multiple OLD values appear in the SAME row/cell: ONE consolidated impact.
3. If no OLD value found, return [].
4. NEVER write find_text like "None of the OLD values were found" — that is invalid.
5. sop_title MUST be exactly "${sop.title}".

# FIELD INSTRUCTIONS:
- paragraph: Table or section TYPE, e.g. "Forms Reference Table", "Forms Appendix Table", "TABLE OF CONTENTS · Chapter 12". Use the chunk's Section metadata.
- action_description: Specific cell/column, e.g. "Form name + version cell", "Row 10 — Form name + ref columns", "TOC entry for section 12.2".
- line_range: Estimate from chunk position. Format "~N" or "~N–M". Never null if position is derivable.
- page: From chunk Page metadata, or 0.
- warning: Set only if the version in find_text is two or more versions behind the new value (version skip). Explain the skip explicitly. Otherwise null.

# GROUNDING EXAMPLES:
Example A — Forms Reference Table (version skip):
{ "paragraph": "Forms Reference Table", "action_description": "Form name + version cell", "line_range": "~3723–3724", "page": 186, "warning": "Doc is on v9.0 — was on FGROP v9 (missed the v9→v10 cycle). Apply v9→v11 in one go." }

Example B — Forms Appendix Table:
{ "paragraph": "Forms Appendix Table", "action_description": "Row 10 — Form name + ref columns", "line_range": "~1948–1950", "page": 98, "warning": null }

Example C — TABLE OF CONTENTS:
{ "paragraph": "TABLE OF CONTENTS · Chapter 12", "action_description": "TOC entry for section 12.2", "line_range": "~16638", "page": 3, "warning": null }

# OUTPUT JSON:
[{ "sop_title": "${sop.title}", "paragraph": "<table/section type>", "action_description": "<cell/column description>",
   "change_type": "find_replace", "chapter": "${formId}",
   "find_text": "verbatim with OLD value", "replace_text": "same with NEW value",
   "page": <num or 0>, "line_range": "<~N or ~N–M>", "warning": "<version skip explanation or null>" }]
`;
      try {
        const resp = await generateWithFallback({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseMimeType: "application/json", maxOutputTokens: 16384 },
        });
        const impacts = JSON.parse(resp.text ?? "[]");
        if (Array.isArray(impacts)) {
          for (const imp of impacts) {
            const ft = String(imp.find_text ?? "").toLowerCase();
            if (!ft.trim()) continue;
            if (/none.*old.*values|not found|no occurrences|could not (find|locate)/i.test(ft)) continue;
            const containsAnOld = fieldChanges.some((c) =>
              ft.includes(c.oldValue.toLowerCase().trim())
            )
              || ft.includes(formId.toLowerCase())
              || (!!friendlyName && ft.includes(friendlyName.toLowerCase()))
              || (!!coreFormName && ft.includes(coreFormName.toLowerCase()));
            if (!containsAnOld) continue;
            allImpacts.push({ ...imp, sop_id: sop.id, sop_title: sop.title });
          }
        }
      } catch (e: any) {
        console.warn(`UC1 rerun: mapping failed for ${sop.title}:`, e?.message);
      }
    }

    // Update summary, re-insert changes + impacts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...summary,
        executive: [
          `Form ${formId} updated with ${fieldChanges.length} field change(s).`,
          `Found ${allImpacts.length} references across ${chunkHits.size} downstream document(s) requiring update.`,
          `All edits are mechanical find/replace — no regulatory interpretation needed.`,
          `Last re-run: ${new Date().toISOString()}`,
        ],
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    await supabase.from("regulatory_changes").insert(
      fieldChanges.map((c, i) => ({
        chapter_ref: `${formId} · ${c.label}`,
        old_requirement: c.oldValue,
        new_requirement: c.newValue,
        change_summary: `${c.label} update: "${c.oldValue}" → "${c.newValue}"`,
        impact: "medium",
        tone_shift: "Form metadata update — mechanical propagation",
        pages: "",
        legal_refs: [],
        related_instruments: [formId],
        report_id: report.id,
        position: i,
      }))
    );

    const finalImpacts = applyPageOverrides(formId, allImpacts);
    if (finalImpacts.length > 0) {
      await supabase.from("sop_impacts").insert(
        finalImpacts.map((m: any, i: number) => ({ ...m, report_id: report.id, position: i }))
      );
    }

    return {
      reportId: report.id as string,
      changesCount: fieldChanges.length,
      impactCount: allImpacts.length,
      affectedDocs: chunkHits.size,
    };
  });

// ── Google Drive OAuth + connection management ────────────────────────────────

const workspaceSchema = z.enum(["rmit", "fatf", "forms"]);

/** Build the consent URL the browser navigates to when Connect is clicked. */
export const getGoogleAuthUrl = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    origin: z.string().url(),
  }))
  .handler(async ({ data }) => {
    const host = new URL(data.origin).host;
    const proto = data.origin.startsWith("https") ? "https" : "http";
    const redirectUri = buildRedirectUri(host, proto);
    const url = buildAuthUrl({
      workspace: data.workspace,
      redirectUri,
      state: data.workspace, // MVP: workspace doubles as state; nonce/CSRF in a later pass
    });
    return { url };
  });

/** Handle the OAuth callback: exchange code, fetch email, persist tokens. */
export const handleGoogleCallback = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    code: z.string().min(1),
    state: z.string().min(1),
    origin: z.string().url(),
  }))
  .handler(async ({ data }) => {
    const workspace = workspaceSchema.parse(data.state);
    const host = new URL(data.origin).host;
    const proto = data.origin.startsWith("https") ? "https" : "http";
    const redirectUri = buildRedirectUri(host, proto);

    const tokens = await exchangeCodeForTokens(data.code, redirectUri);
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh_token — try Disconnect first then reconnect");
    }
    const { email } = await fetchUserInfo(tokens.access_token);
    await storeConnection({
      workspace,
      email,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    });
    return { email, workspace };
  });

/** Read connection status for the Settings UI. */
export const getGoogleConnectionStatus = createServerFn({ method: "POST" })
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    return await getConnection(data.workspace);
  });

/** Disconnect Google for a workspace. */
export const disconnectGoogle = createServerFn({ method: "POST" })
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    await deleteConnection(data.workspace);
    return { ok: true };
  });

// ── Stage 2: Drive folder configuration + KB sync ────────────────────────────

/** Save the KB folder for this workspace. Validates the ID exists + is a folder. */
export const setDriveFolder = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    folderUrlOrId: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const folderId = parseDriveId(data.folderUrlOrId);
    if (!folderId) throw new Error("Could not parse a Drive folder ID from that input. Paste the URL or just the folder ID.");
    const meta = await getFileMetadata(data.workspace, folderId);
    if (meta.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error(`That Drive ID is a ${meta.mimeType.replace("application/vnd.google-apps.", "")}, not a folder.`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("workspace_google_connections")
      .update({ drive_folder_id: folderId, drive_folder_name: meta.name })
      .eq("workspace_id", data.workspace);
    if (error) throw new Error(error.message);
    return { folderId, folderName: meta.name };
  });

/**
 * Pull every indexable file from the configured Drive folder and run each
 * through the existing chunking + embedding pipeline. Re-running is idempotent —
 * sop_documents rows are upserted on (workspace_id, drive_file_id) and chunks
 * are wiped + reinserted per doc.
 *
 * Returns counts so the UI can show what happened.
 */
export const syncDriveFolder = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    /** Re-process every file regardless of modifiedTime / last_sync_error. */
    force: z.boolean().optional().default(false),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn, error: connErr } = await (supabase as any)
      .from("workspace_google_connections")
      .select("drive_folder_id, drive_folder_name")
      .eq("workspace_id", data.workspace)
      .single();
    if (connErr || !conn?.drive_folder_id) {
      throw new Error("No Drive folder configured. Set one first in Settings.");
    }
    const folderId = conn.drive_folder_id as string;

    const files = await listFolderFiles(data.workspace, folderId);
    const indexable = files.filter((f) => isIndexableMimeType(f.mimeType));
    const skipped = files.filter((f) => !isIndexableMimeType(f.mimeType));

    // Preload existing sop_documents rows for these Drive files (one query, not N)
    const driveIds = indexable.map((f) => f.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingRows } = driveIds.length > 0 ? await (supabase as any)
      .from("sop_documents")
      .select("id, drive_file_id, drive_modified_time, last_sync_error")
      .eq("workspace_id", data.workspace)
      .in("drive_file_id", driveIds) : { data: [] };
    const existingByFileId = new Map<string, any>();
    for (const r of existingRows ?? []) existingByFileId.set(r.drive_file_id, r);

    let succeeded = 0;
    let unchanged = 0;
    const failures: Array<{ name: string; reason: string }> = [];

    for (const f of indexable) {
      const existing = existingByFileId.get(f.id);

      // Skip when not forced AND we have a successful prior sync for the same modifiedTime
      if (!data.force && existing && !existing.last_sync_error && existing.drive_modified_time && f.modifiedTime) {
        const lastSynced = new Date(existing.drive_modified_time).getTime();
        const driveMtime = new Date(f.modifiedTime).getTime();
        if (driveMtime <= lastSynced) {
          unchanged++;
          continue;
        }
      }

      try {
        // 1. Pull text / chunks based on file type
        let chunks: Array<{ content: string; chapter_ref?: string; page_number?: number }>;
        if (f.mimeType === "application/vnd.google-apps.document") {
          const text = await exportGoogleDocAsText(data.workspace, f.id);
          chunks = chunkDocxText(text);
        } else if (f.mimeType === "application/pdf") {
          const buffer = await downloadFile(data.workspace, f.id);
          chunks = await chunkDocument({ name: f.name, buffer, mimeType: f.mimeType });
        } else {
          // .docx / .doc
          const buffer = await downloadFile(data.workspace, f.id);
          const text = await docxToText(buffer);
          chunks = chunkDocxText(text);
        }

        // 2. Upsert sop_documents row keyed on (workspace_id, drive_file_id)
        const cleanTitle = f.name.replace(/\.(pdf|docx?|gdoc)$/i, "");
        const sopRow: any = {
          workspace_id: data.workspace,
          title: cleanTitle,
          doc_type: "policy",
          version: "1.0",
          is_active: true,
          file_url: driveViewerUrl(f.id, f.mimeType),
          drive_file_id: f.id,
          drive_mime_type: f.mimeType,
          drive_modified_time: f.modifiedTime ?? null,
          last_sync_error: null,
        };
        let sopId: string;
        if (existing?.id) {
          sopId = existing.id;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("sop_documents").update(sopRow).eq("id", sopId);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: row, error } = await (supabase as any).from("sop_documents").insert(sopRow).select("id").single();
          if (error) throw error;
          sopId = row.id;
        }

        // 3. Wipe + re-insert chunks for this doc
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("sop_chunks").delete().eq("sop_id", sopId);
        if (chunks.length > 0) {
          const chunksWithEmbeddings = await embedChunksBatched(
            chunks,
            (c: any, embedding: number[]) => ({
              sop_id: sopId,
              content: c.content,
              chapter_ref: c.chapter_ref ?? null,
              page_number: c.page_number ?? null,
              embedding,
            }),
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: insErr } = await (supabase as any).from("sop_chunks").insert(chunksWithEmbeddings);
          if (insErr) throw insErr;
        }

        succeeded++;
      } catch (e: any) {
        const reason = e?.message ?? "unknown";
        failures.push({ name: f.name, reason });
        // Record the failure on the SOP row so the next sync retries this file
        if (existing?.id) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("sop_documents")
            .update({ last_sync_error: reason.slice(0, 500) })
            .eq("id", existing.id);
        }
      }
    }

    return {
      folderName: conn.drive_folder_name ?? folderId,
      total: files.length,
      indexable: indexable.length,
      succeeded,
      unchanged,
      failedCount: failures.length,
      skippedCount: skipped.length,
      failures: failures.slice(0, 10),
      skipped: skipped.slice(0, 10).map((f) => ({ name: f.name, mimeType: f.mimeType })),
    };
  });

// ── Stage 3: Pick a policy doc from Drive to feed into a New Analysis ────────

/** List files in the workspace's configured Drive folder, for the picker UI. */
export const listWorkspaceDriveFiles = createServerFn({ method: "POST" })
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn } = await (supabase as any)
      .from("workspace_google_connections")
      .select("drive_folder_id, drive_folder_name")
      .eq("workspace_id", data.workspace)
      .maybeSingle();
    if (!conn?.drive_folder_id) {
      throw new Error("No Drive folder configured. Connect Google and set a folder in Settings first.");
    }
    const files = await listFolderFiles(data.workspace, conn.drive_folder_id);
    return {
      folderName: conn.drive_folder_name ?? "(unnamed folder)",
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime ?? null,
        sizeBytes: f.size ? Number(f.size) : null,
        indexable: isIndexableMimeType(f.mimeType),
      })),
    };
  });

/**
 * Pull a Drive file into Supabase storage so the existing analysis pipeline
 * (which expects a public fileUrl) can run as if the file were uploaded locally.
 * Returns { filename, fileUrl } ready to pass into createReport.
 */
export const importDriveFileForAnalysis = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    driveFileId: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const meta = await getFileMetadata(data.workspace, data.driveFileId);
    if (!isIndexableMimeType(meta.mimeType)) {
      throw new Error(`Unsupported file type: ${meta.mimeType}`);
    }

    // Google Docs need export; everything else is a straight download.
    let buffer: Buffer;
    let storageContentType: string;
    let storageFilename: string;
    if (meta.mimeType === "application/vnd.google-apps.document") {
      // Export Google Docs as DOCX so chunkers + docxToText work as-is downstream.
      // (alt=media doesn't work on Google Docs; have to use export endpoint.)
      const docsAccessToken = await (await import("./google-oauth")).refreshAccessToken(data.workspace);
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${data.driveFileId}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${docsAccessToken}` } }
      );
      if (!r.ok) throw new Error(`Drive export failed: ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
      storageContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      storageFilename = `${meta.name.replace(/\.(pdf|docx?|gdoc)$/i, "")}.docx`;
    } else {
      buffer = await downloadFile(data.workspace, data.driveFileId);
      storageContentType = meta.mimeType;
      storageFilename = meta.name;
    }

    // Upload into the same bucket existing analyses use.
    const path = `${Date.now()}-${storageFilename.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any).storage
      .from("policies")
      .upload(path, buffer, { upsert: false, contentType: storageContentType });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pub } = (supabase as any).storage.from("policies").getPublicUrl(path);

    return {
      filename: storageFilename,
      fileUrl: pub.publicUrl as string,
      driveMimeType: meta.mimeType,
    };
  });
