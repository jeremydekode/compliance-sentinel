import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { chunkDocument, generateAmendedDocument, extractRegulatoryChanges, extractFatfRequirements, mapChangeToSops, mapChangesToSop, buildSopTopicMap, generateAnalysisSummary, generateWithFallback } from "./gemini";
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
  createDriveComment,
  writeToGoogleDoc,
  copyDriveFile,
  applyImpactsToGoogleDoc,
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
import { REGULATION_FAMILIES, INTERNAL_DOC_TYPES as INTERNAL_DOC_TYPES_CONST, regulatorContext, autoDetectDocMeta } from "./auto-detect";

async function fetchFile(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // Reject Drive viewer URLs straight away — they return HTML, not the file.
  // (Drive-synced SOPs should now store a Supabase storage URL as file_url,
  // but legacy rows from earlier syncs may still hold the viewer URL.)
  if (/drive\.google\.com\/file\/d\//i.test(url) || /docs\.google\.com\/document\/d\//i.test(url)) {
    throw new Error(
      `file_url points at a Google Drive viewer page, not a downloadable file. ` +
      `Re-sync the source document with "Force full re-sync" in Settings → Google Drive ` +
      `to mirror it into Supabase storage.`
    );
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch file at ${url}: HTTP ${resp.status} ${resp.statusText}`);
  }
  const mimeType = resp.headers.get("content-type") || "application/pdf";
  // Catch silent error pages — storage 403/404 redirected to an HTML page would
  // otherwise slip through and get sent to Gemini as application/pdf.
  if (/^text\/html/i.test(mimeType)) {
    throw new Error(
      `File URL returned HTML (mimeType="${mimeType}") — the storage object may have been deleted or is inaccessible. Re-upload or re-sync the file.`
    );
  }
  const arrayBuffer = await resp.arrayBuffer();
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
    // Shared across the analysis: each SOP's full text (fetched once, reused by
    // the topic-index build and the find_text verification pass) and its
    // structural index (governance tier + topic map) used for routing.
    const sopTextCache = new Map<string, string | null>();
    const sopIndex = new Map<string, { tier: string | null; topicMap: Record<string, string[]> | null }>();

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
      const analysisGuidance = await fetchAnalysisGuidance(workspace);
      const extractedChanges = await extractRegulatoryChanges(
        newPolicySource,
        oldPolicySource,
        regulatorContext(detected?.doc_type),
        analysisGuidance
      );
      console.log(`Extracted ${extractedChanges.length} regulatory changes. Now mapping each to SOP chunks...`);

      // Build (or load cached) the structural topic index for each candidate
      // SOP, so the per-change mapping below routes to real clauses instead of
      // guessing. Bounded by a deadline — any SOP not indexed in time simply
      // maps the old way; its index is built and cached on a later run.
      const idxDeadline = Date.now() + 180_000;
      for (const sop of relevantSops) {
        let topicMap: Record<string, string[]> | null = (sop.topic_map as any) ?? null;
        if ((!topicMap || Object.keys(topicMap).length === 0) && Date.now() < idxDeadline) {
          const text = await fetchSopText(sop, workspace);
          sopTextCache.set(sop.id, text);
          if (text && text.trim()) {
            try {
              topicMap = await buildAndVerifyTopicMap(sop.id, sop.title, text);
              console.log(`[createReport] "${sop.title}" — topic index: ${Object.keys(topicMap).length} topic(s)`);
            } catch (e: any) {
              console.warn(`[createReport] topic-map build failed for "${sop.title}":`, e?.message);
            }
          }
        }
        sopIndex.set(sop.id, { tier: sop.governance_tier ?? null, topicMap });
      }

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

          // Build sops-for-change with chunk text contexts + the SOP's
          // structural index, so the mapping routes to real clauses.
          const sopsForChange: { title: string; text: string; governanceTier?: string | null; topicMap?: Record<string, string[]> | null }[] = [];
          for (const [sopId, sopChunks] of chunksBySop.entries()) {
            const sop = relevantSops.find(s => s.id === sopId);
            if (!sop) continue;
            const text = sopChunks
              .map((c: any) => `[Section: ${c.chapter_ref || "unspecified"} | Page: ${c.page_number || "?"}]\n${c.content}`)
              .join("\n\n---\n\n");
            const idx = sopIndex.get(sopId);
            sopsForChange.push({ title: sop.title, text, governanceTier: idx?.tier ?? null, topicMap: idx?.topicMap ?? null });
          }

          const impacts = await mapChangeToSops(change, sopsForChange, analysisGuidance);
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

    // Verify each impact's find_text genuinely exists in its SOP — drop
    // hallucinated anchors and repair whitespace drift, so the chunk-based
    // analysis can't surface a find_text the document doesn't contain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifiedImpacts: any[] = [];
    for (const m of matchedImpacts) {
      if (!m.sop_id) { verifiedImpacts.push(m); continue; }
      if (!sopTextCache.has(m.sop_id)) {
        // Reuses any text already fetched during the topic-index build above.
        const sopDoc = relevantSops.find((s) => s.id === m.sop_id);
        sopTextCache.set(m.sop_id, sopDoc ? await fetchSopText(sopDoc, workspace) : null);
      }
      const srcText = sopTextCache.get(m.sop_id);
      if (!srcText) { verifiedImpacts.push(m); continue; } // couldn't fetch — don't drop
      // Verify the section reference too — never show a clause/section the SOP
      // does not contain (strips Act references, fabricated clause numbers).
      const para = verifyParagraph(srcText, m.paragraph);
      const repaired = makeFindTextVerifier(srcText)(m.find_text);
      if (repaired === null) {
        // The AI's anchor text isn't in the document. Don't drop the impact —
        // downgrade it to a section-level contextual insert so the proposed
        // amendment is never silently lost. The write path places it at the
        // section heading (or end of doc) and highlights it. Cap confidence so
        // an unanchored impact is never fast-tracked.
        console.log(`createReport: downgraded unanchored impact for "${m.sop_title}" to contextual`);
        verifiedImpacts.push({
          ...m,
          paragraph: para,
          change_type: "contextual",
          find_text: para === PARAGRAPH_UNLOCATED ? "[no exact anchor in document]" : `[no exact anchor — see ${para}]`,
          confidence: Math.min(clampConfidence(m.confidence) ?? 60, 70),
        });
        continue;
      }
      verifiedImpacts.push({ ...m, paragraph: para, find_text: repaired });
    }

    if (verifiedImpacts.length > 0) {
      await supabase.from("sop_impacts").insert(
        verifiedImpacts.map((m: any, i: number) => ({
          ...m,
          confidence: clampConfidence(m.confidence),
          report_id: report.id,
          position: i,
        }))
      );
    }

    return {
      reportId: report.id as string,
      impactCount: verifiedImpacts.length,
      matchedToKbCount: verifiedImpacts.filter((m: any) => m.sop_id).length,
      kbSize: kbAll.length,
      candidateKbSize: relevantSops.length,
    };
  });

/**
 * Lightweight regulatory upload — creates the report row only. The analysis
 * itself runs through the phased full-document pipeline (startRegulatoryRerun
 * → analyzeRegulatorySop per SOP → finalizeRegulatoryReport), the same path a
 * re-run uses, so the upload never chunks and never times out.
 */
export const createRegulatoryReport = createServerFn({ method: "POST" })
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
    if (!data.fileUrl) throw new Error("No file URL provided for analysis");
    const fallbackName = data.filename.replace(/\.[^.]+$/, "").trim() || data.filename;
    const displayName = (data.customTitle ?? "").trim() || fallbackName;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: displayName,
        policy_name: displayName,
        status: "pending_validation",
        source_file_url: data.fileUrl,
        workspace_id: data.workspace,
        summary_json: {
          detected: data.detected ?? null,
          analyst_notes: data.notes ?? null,
          executive: ["Analysis queued — extracting regulatory changes…"],
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create report");
    return { reportId: report.id as string };
  });

/** Sanitize the AI's self-reported confidence into an integer 0-100, or null. */
function clampConfidence(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * Builds a verifier for AI-produced find_text. Confirms the text genuinely
 * exists in the source document, and repairs whitespace drift by returning the
 * exact verbatim substring. Returns null when the text is not in the document
 * at all (the AI hallucinated it) so the caller can discard that impact.
 */
function makeFindTextVerifier(sourceText: string): (findText: string) => string | null {
  let normStr = "";
  const rawIdx: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (!prevSpace) { normStr += " "; rawIdx.push(i); }
      prevSpace = true;
    } else {
      normStr += ch; rawIdx.push(i); prevSpace = false;
    }
  }
  return (findText: string): string | null => {
    const ft = (findText ?? "").trim();
    if (!ft) return null;
    if (ft.startsWith("[")) return ft; // bracket markers handled via Comment — pass through
    if (sourceText.includes(ft)) return ft; // already verbatim
    const nFt = ft.replace(/\s+/g, " ").trim();
    if (nFt.length < 6) return null;
    const at = normStr.indexOf(nFt);
    if (at < 0) return null; // not in the document — the AI hallucinated it
    const rawStart = rawIdx[at];
    const rawEnd = rawIdx[Math.min(rawIdx.length - 1, at + nFt.length - 1)] + 1;
    return sourceText.slice(rawStart, rawEnd);
  };
}

const PARAGRAPH_UNLOCATED = "General — section to be confirmed by reviewer";

/**
 * Verifies an AI-produced "paragraph" (the SOP section reference) genuinely
 * exists in the document, so the report never shows a clause number or section
 * the SOP does not contain. A claimed clause number (e.g. "C.14.1.3") MUST be
 * present verbatim; an Act/regulator reference (e.g. "Section 19(2)(b) of
 * AMLA") is never a SOP section and is stripped. When nothing can be verified
 * the value is replaced with an honest "section to be confirmed" label.
 */
function verifyParagraph(sourceText: string, paragraph: string): string {
  const p = String(paragraph ?? "").trim();
  if (!p) return PARAGRAPH_UNLOCATED;
  const lcSource = sourceText.toLowerCase();
  const inDoc = (s: string) => !!s && s.trim().length >= 4 && lcSource.includes(s.trim().toLowerCase());

  // Structural labels that are valid even without literal matching doc text.
  if (/^(introduction|document header|cover page|appendix|general\b)/i.test(p)) return p;

  const parts = p.split(/\s*[·—|]\s*/).map((s) => s.trim()).filter(Boolean);
  const head = parts[0] ?? "";
  const name = parts.length > 1 ? parts.slice(1).join(" · ") : "";

  // A clause number like "C.14.1.3", "D.2.1.8.4" or "8.2.4".
  const clauseTok =
    (head.match(/\b[A-Za-z]\.\d+(?:\.\d+)*\b/) ?? [])[0] ??
    (head.match(/\b\d+(?:\.\d+)+\b/) ?? [])[0];

  // A claimed clause number must physically exist in the SOP.
  if (clauseTok && sourceText.includes(clauseTok)) return p;
  // Clause fabricated (or an Act reference) — keep only the section NAME, and
  // only if that name is real text in the document.
  if (inDoc(name)) return name;
  if (!clauseTok && inDoc(head)) return head;
  return PARAGRAPH_UNLOCATED;
}

/**
 * Extracts an SOP document's full plain text — Google Docs via Drive export,
 * otherwise the mirrored file (docx / pdf / plain). Newlines are normalized to
 * LF. Returns null when the document cannot be read.
 */
async function fetchSopText(
  sopDoc: { title?: string; drive_mime_type?: string | null; drive_file_id?: string | null; file_url?: string | null },
  workspaceId: string,
): Promise<string | null> {
  try {
    let text = "";
    if (sopDoc.drive_mime_type === "application/vnd.google-apps.document" && sopDoc.drive_file_id) {
      text = await exportGoogleDocAsText(workspaceId, sopDoc.drive_file_id);
    } else if (sopDoc.file_url) {
      const f = await fetchFile(sopDoc.file_url);
      if (looksLikeDocx(f.mimeType, sopDoc.file_url)) {
        text = await docxToText(f.buffer);
      } else if (f.mimeType === "application/pdf") {
        const { extractPdfPages } = await import("./pdf-pages");
        text = (await extractPdfPages(f.buffer)).map((p: any) => p.text).join("\n");
      } else {
        text = f.buffer.toString("utf-8");
      }
    }
    return text.replace(/\r\n?/g, "\n");
  } catch (e: any) {
    console.warn(`fetchSopText failed for "${sopDoc.title ?? "?"}":`, e?.message?.slice(0, 100));
    return null;
  }
}

/**
 * Builds the { topic -> [clause refs] } structural index for one SOP, keeps
 * only refs that genuinely appear in the document text, caches the result on
 * the sop_documents row, and returns it.
 */
async function buildAndVerifyTopicMap(
  sopId: string, title: string, fullText: string,
): Promise<Record<string, string[]>> {
  const raw = await buildSopTopicMap({ title, text: fullText });
  const verified: Record<string, string[]> = {};
  for (const [topic, refs] of Object.entries(raw)) {
    const good = (refs as string[]).filter((r) => {
      if (fullText.includes(r)) return true;
      const tok = (r.match(/\b[A-Za-z]?\.?\d+(?:\.\d+)+\b/) ?? [])[0];
      return !!tok && fullText.includes(tok);
    });
    if (good.length > 0) verified[topic] = good;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("sop_documents").update({ topic_map: verified }).eq("id", sopId);
  return verified;
}

/** Regulation-relevant anchor terms — used to section-target a document too
 *  large to analyse whole. */
const REGULATORY_ANCHOR_TERMS = [
  "FATF", "Increased Monitoring", "Call for Action", "high-risk countr", "high risk countr",
  "sanctioned", "prohibited", "virtual asset", "digital currency", "Iran", "Myanmar",
  "DPRK", "North Korea", "country risk", "jurisdiction", "enhanced due diligence", "EDD",
  "correspondent", "watchlist", "worldcheck", "screening", "monitoring", "countermeasure",
];

/**
 * For a document too large to analyse whole, returns context windows around
 * every regulation-relevant term — merged where they overlap and packed into
 * <= maxSeg-char segments. Empty if the document mentions none of the terms.
 */
function buildRelevantWindows(fullText: string, maxSeg: number): string[] {
  const lc = fullText.toLowerCase();
  const ranges: Array<[number, number]> = [];
  const PAD = 1500;
  for (const term of REGULATORY_ANCHOR_TERMS) {
    const t = term.toLowerCase();
    let pos = 0;
    for (;;) {
      const i = lc.indexOf(t, pos);
      if (i < 0) break;
      ranges.push([Math.max(0, i - PAD), Math.min(fullText.length, i + t.length + PAD)]);
      pos = i + t.length;
    }
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: string[] = [];
  let buf = "";
  for (const [s, e] of merged) {
    const piece = fullText.slice(s, e);
    if (buf && buf.length + piece.length + 8 > maxSeg) { out.push(buf); buf = ""; }
    buf = buf ? `${buf}\n\n[…]\n\n${piece}` : piece;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Phase 1 of the regulatory re-run. Extracts the regulatory changes (new vs old
 * policy), stores them, and returns the internal SOPs to analyze. The heavy
 * mapping runs per-SOP via analyzeRegulatorySop so no single call can time out.
 */
export const startRegulatoryRerun = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    if (!report.source_file_url) throw new Error("Report has no source file URL — cannot rerun");

    const detected = (report.summary_json as any)?.detected ?? null;
    const workspace = ((report as any).workspace_id as string) ?? "rmit";

    // FATF runs CONFORMANCE mode — analyse against the CURRENT statement, no
    // prior version. Other regulators run DELTA mode — diff vs the KB's
    // previous version.
    const isFatf = regulatorContext(detected?.doc_type) === "fatf";
    const guidance = await fetchAnalysisGuidance(workspace);
    const newPolicy = await fetchFile(report.source_file_url);
    const newPolicySource = await policySourceFromFile(report.policy_name ?? "policy", newPolicy, report.source_file_url);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let changes: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oldDoc: any = null;
    if (isFatf) {
      changes = await extractFatfRequirements(newPolicySource, guidance);
    } else {
      const oldDocTypes = detected?.doc_type
        ? (REGULATION_FAMILIES[detected.doc_type] ?? [detected.doc_type])
        : ["__none__"];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: oldDocs } = await (supabase as any)
        .from("sop_documents").select("*")
        .eq("workspace_id", workspace)
        .in("doc_type", oldDocTypes)
        .neq("version", detected?.version ?? "")
        .order("created_at", { ascending: false }).limit(1);
      oldDoc = oldDocs?.[0] ?? null;
      let oldPolicy: { buffer: Buffer; mimeType: string } | undefined = undefined;
      if (oldDoc?.file_url) {
        try { oldPolicy = await fetchFile(oldDoc.file_url); }
        catch (e) { console.error("[regulatory rerun] old policy fetch failed:", e); }
      }
      const oldPolicySource = oldPolicy && oldDoc
        ? await policySourceFromFile(oldDoc.title, oldPolicy, oldDoc.file_url)
        : undefined;
      changes = await extractRegulatoryChanges(
        newPolicySource, oldPolicySource, regulatorContext(detected?.doc_type), guidance,
      );
    }
    console.log(`[regulatory rerun ${report.id}] ${isFatf ? "conformance" : "delta"} — extracted ${changes.length} item(s)`);

    // Wipe prior changes/impacts, insert the fresh change rows
    await supabase.from("sop_impacts").delete().eq("report_id", report.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", report.id);

    if (changes.length > 0) {
      await supabase.from("regulatory_changes").insert(
        changes.map((c: any, i: number) => ({
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...(report.summary_json as any ?? {}),
        detected: detected ?? null,
        old_policy_name: oldDoc?.title ?? null,
        analysis_mode: isFatf ? "conformance" : "delta",
        executive: [`Re-analysis in progress — ${changes.length} ${isFatf ? "requirement" : "change"}(s) found…`],
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    // Internal SOPs to analyze — full-document, one analyzeRegulatorySop call each
    const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sopRows } = await (supabase as any)
      .from("sop_documents").select("id, title")
      .eq("workspace_id", workspace)
      .in("doc_type", INTERNAL_DOC_TYPES);
    const sops = ((sopRows ?? []) as any[]).map((s) => ({ id: s.id as string, title: s.title as string }));

    return { reportId: report.id as string, changeCount: changes.length, sops };
  });

/**
 * Phase 2 — analyzes ONE internal SOP against ALL regulatory changes, reading
 * the SOP's FULL text (no chunking, no vector search — nothing gets missed for
 * lack of retrieval). Oversized SOPs are split into large segments so each
 * Gemini call stays within the function time limit. One call per SOP.
 */
export const analyzeRegulatorySop = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string(), sopId: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("id, workspace_id, summary_json").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    const analysisMode: "delta" | "conformance" =
      (report.summary_json as any)?.analysis_mode === "conformance" ? "conformance" : "delta";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: changeRows } = await (supabase as any)
      .from("regulatory_changes").select("*").eq("report_id", report.id).order("position");
    const changes = (changeRows ?? []) as any[];
    if (changes.length === 0) return { sopId: data.sopId, title: "?", impactCount: 0, status: "analyzed" as const };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop } = await (supabase as any)
      .from("sop_documents").select("id, title, file_url, drive_file_id, drive_mime_type, governance_tier, topic_map").eq("id", data.sopId).single();
    if (!sop || !sop.file_url) return { sopId: data.sopId, title: sop?.title ?? "?", impactCount: 0, status: "failed" as const };

    // Extract the SOP's full text. For Google Docs this reads Google's OWN text
    // export — the exact representation the in-doc find/replace later matches.
    const workspaceId = (report.workspace_id as string) ?? "rmit";
    const fullText = await fetchSopText(sop, workspaceId);
    if (!fullText || !fullText.trim()) {
      console.warn(`analyzeRegulatorySop: could not read "${sop.title}"`);
      return { sopId: sop.id, title: sop.title, impactCount: 0, status: "failed" as const };
    }


    // A document small enough is analysed whole. One too large to read whole
    // is section-targeted — context windows around the regulation-relevant
    // terms — rather than sliced into blind segments, so the AI sees focused
    // relevant text instead of arbitrary cuts.
    const SEG = 160_000;
    let segments: string[];
    if (fullText.length <= SEG * 1.4) {
      segments = [fullText];
    } else {
      const windows = buildRelevantWindows(fullText, SEG);
      segments = windows.length > 0
        ? windows
        : Array.from({ length: Math.ceil(fullText.length / SEG) }, (_, i) => fullText.slice(i * SEG, (i + 1) * SEG));
      console.log(`[regulatory] "${sop.title}" — ${fullText.length} chars too large; ${segments.length} targeted window(s)`);
    }
    console.log(`[regulatory] "${sop.title}" — ${fullText.length} chars, ${segments.length} segment(s)`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allImpacts: any[] = [];
    const analysisGuidance = await fetchAnalysisGuidance(workspaceId);
    const deadline = Date.now() + 250_000;
    for (const seg of segments) {
      if (Date.now() > deadline) { console.warn(`[regulatory] "${sop.title}" time budget reached`); break; }
      try {
        const impacts = await mapChangesToSop(changes as any, {
          title: sop.title, text: seg,
          governanceTier: sop.governance_tier ?? null,
        }, analysisGuidance, analysisMode);
        allImpacts.push(...impacts);
      } catch (e: any) {
        console.warn(`[regulatory] mapping failed for "${sop.title}":`, e?.message);
      }
    }

    // Verify every find_text genuinely exists in the document — discard
    // hallucinated anchors, and repair whitespace drift to the exact verbatim
    // substring so the in-doc find/replace later matches it.
    const verify = makeFindTextVerifier(fullText);
    let downgraded = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verified: any[] = [];
    for (const m of allImpacts) {
      // Verify the section reference — never show a clause/section the SOP does
      // not contain (strips Act references and fabricated clause numbers).
      const para = verifyParagraph(fullText, m.paragraph);
      const repaired = verify(m.find_text);
      if (repaired === null) {
        // Anchor not in the document — downgrade to a section-level contextual
        // insert rather than drop, so the proposed amendment is never lost.
        downgraded++;
        verified.push({
          ...m,
          paragraph: para,
          change_type: "contextual",
          find_text: para === PARAGRAPH_UNLOCATED ? "[no exact anchor in document]" : `[no exact anchor — see ${para}]`,
          confidence: Math.min(clampConfidence(m.confidence) ?? 60, 70),
        });
        continue;
      }
      verified.push({ ...m, paragraph: para, find_text: repaired });
    }
    if (downgraded > 0) console.log(`[regulatory] "${sop.title}" — downgraded ${downgraded} unanchored impact(s) to contextual`);

    // Dedupe within the doc — segmenting a document repeats running headers, so
    // the same logical edit can surface in several segments with slightly
    // different anchors. Collapse exact matches, substring-overlapping anchors,
    // and keep only ONE "Document Header" version-bump impact.
    const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kept: any[] = [];
    let headerDone = false;
    for (const m of verified) {
      const ft = norm(m.find_text);
      if (!ft) continue;
      const isHeader = /document header|cover page/i.test(String(m.paragraph ?? ""));
      if (isHeader) {
        if (headerDone) continue;
        headerDone = true;
        kept.push(m);
        continue;
      }
      // Skip if this anchor duplicates, contains, or is contained by a kept one
      const dup = kept.some((k) => {
        const kf = norm(k.find_text);
        return !!kf && (kf === ft || kf.includes(ft) || ft.includes(kf));
      });
      if (!dup) kept.push(m);
    }
    const finalImpacts = kept.map((m: any) => ({ ...m, sop_id: sop.id, sop_title: sop.title }));

    if (finalImpacts.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase as any)
        .from("sop_impacts").select("id", { count: "exact", head: true }).eq("report_id", report.id);
      const offset = count ?? 0;
      await supabase.from("sop_impacts").insert(
        finalImpacts.map((m: any, i: number) => ({ ...m, confidence: clampConfidence(m.confidence), report_id: report.id, position: offset + i }))
      );
    }
    console.log(`[regulatory] "${sop.title}" → ${finalImpacts.length} impact(s)`);
    return { sopId: sop.id, title: sop.title, impactCount: finalImpacts.length, status: "analyzed" as const };
  });

/** Phase 3 — regenerates the executive summary once all changes are mapped. */
export const finalizeRegulatoryReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    reportId: z.string(),
    // Per-SOP outcome from the analysis loop. "failed" = could not be analysed
    // (e.g. document unreadable / call errored) and needs a manual check.
    coverage: z.array(z.object({ title: z.string(), status: z.string() })).optional(),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: changes } = await (supabase as any)
      .from("regulatory_changes").select("*").eq("report_id", report.id).order("position");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: impacts } = await (supabase as any)
      .from("sop_impacts").select("*").eq("report_id", report.id);

    const summary = await generateAnalysisSummary(
      (changes ?? []) as any[], (impacts ?? []) as any[], report.policy_name ?? "policy",
    );
    const prev = (report.summary_json as any) ?? {};
    // SOPs that could not be analysed — surfaced on the report so a failure is
    // never silently invisible.
    const coverageWarnings = (data.coverage ?? [])
      .filter((c) => c.status === "failed")
      .map((c) => ({ title: c.title, status: c.status }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...summary,
        kb_size: prev.kb_size ?? null,
        detected: prev.detected ?? null,
        old_policy_name: prev.old_policy_name ?? null,
        coverage_warnings: coverageWarnings,
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    const matchedToKbCount = ((impacts ?? []) as any[]).filter((m) => m.sop_id).length;
    return {
      reportId: report.id as string,
      changesCount: (changes ?? []).length,
      impactCount: (impacts ?? []).length,
      matchedToKbCount,
      coverageWarnings,
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

/**
 * Fast-track approval: marks every still-pending impact in a report whose AI
 * confidence is at or above the threshold as "approved", in one operation.
 * A human triggers it — so there is still a single accountable approve action.
 */
export const bulkApproveReady = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    reportId: z.string(),
    minConfidence: z.number().min(0).max(100).default(90),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error } = await (supabase as any)
      .from("sop_impacts")
      .update({ status: "approved" })
      .eq("report_id", data.reportId)
      .eq("status", "pending")
      .gte("confidence", data.minConfidence)
      .select("id");
    if (error) throw new Error(error.message);
    return { approved: (rows ?? []).length as number };
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
      doc_type: z.enum(["sop", "rmit", "rmit_reg", "fatf", "circular", "it_policy", "policy", "form"]),
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
      doc_type: z.enum(["sop", "rmit", "rmit_reg", "fatf", "circular", "it_policy", "policy", "form"]),
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

    // Forms workspace docs are compared directly — no chunking needed.
    if (sop.workspace_id === "forms") {
      return { chunkCount: 0, message: "Forms workspace — no indexing required" };
    }

    const file = await fetchFile(sop.file_url);
    const isDocx = looksLikeDocx(file.mimeType, sop.file_url);
    const allChunks = isDocx
      ? chunkDocxText(await docxToText(file.buffer))
      : await chunkDocument({ name: sop.title, buffer: file.buffer, mimeType: file.mimeType });

    if (allChunks.length === 0) {
      return { chunkCount: 0, message: "No text extracted from the source file" };
    }

    // Cap at 100 chunks and stride-sample so large docs get even coverage across
    // the whole document rather than just the first N pages.
    // 100 × 50-per-Gemini-batch = 2 embedding calls — safely within the 60 s budget
    // even for a 450-page DOCX after mammoth extraction.
    const MAX_CHUNKS = 100;
    let chunks: typeof allChunks;
    if (allChunks.length <= MAX_CHUNKS) {
      chunks = allChunks;
    } else {
      // Pick evenly-spaced indices so coverage spans the full document.
      const step = allChunks.length / MAX_CHUNKS;
      chunks = Array.from({ length: MAX_CHUNKS }, (_, i) => allChunks[Math.floor(i * step)]);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_chunks").delete().eq("sop_id", sop.id);

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

    const BATCH = 100;
    for (let i = 0; i < chunksWithEmbeddings.length; i += BATCH) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: insErr } = await (supabase as any)
        .from("sop_chunks")
        .insert(chunksWithEmbeddings.slice(i, i + BATCH));
      if (insErr) throw new Error(`Failed to insert chunks: ${insErr.message}`);
    }

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
    const displayName =
      (data.customTitle ?? "").trim() ||
      `${data.formId} update — ${data.fieldChanges[0].oldValue.slice(0, 20)} → ${data.fieldChanges[0].newValue.slice(0, 20)}`;

    // Create the report shell only. The heavy analysis runs per-document via
    // analyzeDocForForm — one Vercel call each — so no single call can time out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: displayName,
        policy_name: data.formId,
        status: "pending_validation",
        source_file_url: data.newFileUrl ?? null,
        workspace_id: data.workspace,
        summary_json: {
          executive: [
            `Form ${data.formId} updated with ${data.fieldChanges.length} field change(s).`,
            `Analysis in progress…`,
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

    // One regulatory_changes row per field change (shows in the Change Analysis tab)
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

    const docsToAnalyze = await getFormCandidateDocs(data.workspace);
    return { reportId: report.id as string, docsToAnalyze };
  });

/**
 * Resets a UC1 form-update report for re-analysis: wipes existing impacts/changes,
 * re-creates the field-change rows, and returns the candidate docs for the client
 * to analyze one at a time via analyzeDocForForm.
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
    const fieldChanges: { label: string; oldValue: string; newValue: string }[] = summary.field_changes ?? [];
    if (!formId || fieldChanges.length === 0) {
      throw new Error("Original form-update parameters missing from this report — cannot rerun.");
    }

    // Wipe + re-create the field-change rows
    await supabase.from("sop_impacts").delete().eq("report_id", report.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", report.id);
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

    const docsToAnalyze = await getFormCandidateDocs((report.workspace_id as string) ?? "forms");
    return { reportId: report.id as string, docsToAnalyze };
  });

/**
 * Analyzes ONE knowledge-base document for references to an updated form.
 * The client calls this once per candidate doc — each call gets its own Vercel
 * function budget, so a single large document can never make the run time out.
 */
export const analyzeDocForForm = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string(), docId: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    const summary = (report.summary_json ?? {}) as any;
    const formId: string = summary.form_id ?? report.policy_name;
    const friendlyName: string | null = summary.friendly_name ?? null;
    const fieldChanges: { label: string; oldValue: string; newValue: string }[] = summary.field_changes ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: doc } = await (supabase as any)
      .from("sop_documents").select("id, title, file_url, workspace_id, drive_file_id, drive_mime_type").eq("id", data.docId).single();
    if (!doc || !doc.file_url) {
      return { docId: data.docId, title: doc?.title ?? "?", impactCount: 0, status: "failed" as const, referenceHits: 0 };
    }

    // Search terms: form ID + friendly name + core name + each old value
    const coreFormName = deriveCoreFormName(friendlyName);
    const searchTerms: string[] = [formId];
    if (friendlyName && friendlyName.trim().length >= 15) searchTerms.push(friendlyName.trim().slice(0, 100));
    if (coreFormName && !searchTerms.some((t) => t.toLowerCase() === coreFormName.toLowerCase())) {
      searchTerms.push(coreFormName);
    }
    for (const c of fieldChanges) {
      const v = c.oldValue.trim();
      if (v.length >= 4) searchTerms.push(v.slice(0, 100));
    }

    // Extract full text. Google Docs → Google's own text export, so the find_text
    // the AI produces matches what the in-doc find/replace later searches for.
    let fullText = "";
    try {
      if (doc.drive_mime_type === "application/vnd.google-apps.document" && doc.drive_file_id) {
        fullText = await exportGoogleDocAsText((doc.workspace_id as string) ?? "forms", doc.drive_file_id);
      } else {
        const file = await fetchFile(doc.file_url);
        if (looksLikeDocx(file.mimeType, doc.file_url)) {
          fullText = await docxToText(file.buffer);
        } else if (file.mimeType === "application/pdf") {
          const { extractPdfPages } = await import("./pdf-pages");
          const pages = await extractPdfPages(file.buffer);
          fullText = pages.map((p: any) => p.text).join("\n");
        } else {
          fullText = file.buffer.toString("utf-8");
        }
      }
    } catch (e: any) {
      // Couldn't read the document (often a flaky connection / Drive timeout).
      // Report it as a failure so the caller retries and never silently drops it.
      console.warn(`analyzeDocForForm: extract failed for "${doc.title}":`, e?.message?.slice(0, 100));
      return { docId: doc.id, title: doc.title, impactCount: 0, status: "failed" as const, referenceHits: 0 };
    }
    // Drive's text export uses CRLF; the live Google Doc uses LF — normalize.
    fullText = fullText.replace(/\r\n?/g, "\n");
    if (!fullText.trim()) {
      return { docId: doc.id, title: doc.title, impactCount: 0, status: "failed" as const, referenceHits: 0 };
    }

    // Literal search → context windows around every match
    const lowerText = fullText.toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contexts: any[] = [];
    for (const term of searchTerms) {
      const lowerTerm = term.toLowerCase();
      let pos = 0;
      while (contexts.length < 30) {
        const idx = lowerText.indexOf(lowerTerm, pos);
        if (idx === -1) break;
        const start = Math.max(0, idx - 500);
        const end = Math.min(fullText.length, idx + term.length + 500);
        const excerpt = fullText.slice(start, end);
        const key = excerpt.slice(10, 50);
        if (!contexts.some((c: any) => c.content.includes(key))) {
          contexts.push({ content: excerpt });
        }
        pos = idx + term.length;
      }
    }
    if (contexts.length === 0) {
      // No literal occurrence of the form ID / name / any old value anywhere in
      // the document — it genuinely does not reference this form. Zero impacts
      // is the CORRECT answer here, not a miss: nothing to flag.
      return { docId: doc.id, title: doc.title, impactCount: 0, status: "not_referenced" as const, referenceHits: 0 };
    }

    // The document DOES reference the form (referenceHits > 0). So if mapping
    // comes back empty, that is a miss or a failure — never "info not there".
    const referenceHits = contexts.length;
    const chunkText = contexts.slice(0, 8).map((c: any) => c.content).join("\n\n---\n\n");
    const prompt = buildUC1Prompt({ formId, friendlyName, fieldChanges, sopTitle: doc.title, chunkText });
    const verifyForm = makeFindTextVerifier(fullText);

    // Run the mapping with up to 2 attempts — the model is non-deterministic,
    // so a doc that genuinely references the form should not come back empty
    // on a single unlucky roll. Re-runs the Gemini call only (text already
    // extracted), so a retry is cheap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finalImpacts: any[] = [];
    let aiThrew = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any = null;
      try {
        const resp = await generateWithFallback({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseMimeType: "application/json", maxOutputTokens: 16384 },
        });
        parsed = JSON.parse(resp.text ?? "[]");
        aiThrew = false;
      } catch (e: any) {
        aiThrew = true;
        console.warn(`analyzeDocForForm: mapping attempt ${attempt} failed for "${doc.title}":`, e?.message);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const impacts: any[] = [];
      if (Array.isArray(parsed)) {
        for (const imp of parsed) {
          const ft = String(imp.find_text ?? "").toLowerCase();
          if (!ft.trim()) continue;
          if (/none.*old.*values|not found|no occurrences|could not (find|locate)/i.test(ft)) continue;
          const containsAnOld = fieldChanges.some((c) => ft.includes(c.oldValue.toLowerCase().trim()))
            || ft.includes(formId.toLowerCase())
            || (!!friendlyName && ft.includes(friendlyName.toLowerCase()))
            || (!!coreFormName && ft.includes(coreFormName.toLowerCase()));
          if (!containsAnOld) continue;
          impacts.push({ ...imp, sop_id: doc.id, sop_title: doc.title });
        }
      }

      // Verify each find_text genuinely exists in the document — discard
      // hallucinations, repair whitespace drift to the exact verbatim substring.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verifiedImpacts: any[] = [];
      for (const m of impacts) {
        const repaired = verifyForm(m.find_text);
        if (repaired === null) continue;
        verifiedImpacts.push({ ...m, find_text: repaired });
      }

      // Collapse duplicates — the same form reference often appears verbatim in
      // several places (table + TOC + appendix). One find/replace covers them
      // all, so keep a single impact per distinct find_text + replace_text pair.
      const seenImpact = new Set<string>();
      const uniqueImpacts = verifiedImpacts.filter((m: any) => {
        const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const key = `${norm(m.find_text)}|||${norm(m.replace_text)}`;
        if (seenImpact.has(key)) return false;
        seenImpact.add(key);
        return true;
      });

      finalImpacts = applyPageOverrides(formId, uniqueImpacts);
      if (finalImpacts.length > 0) break; // got real impacts — no need to retry
    }

    // Idempotent: clear this doc's prior impacts for the report before inserting
    // so a retried call (e.g. after a dropped connection) can never double-up.
    await supabase.from("sop_impacts").delete().eq("report_id", report.id).eq("sop_id", doc.id);
    if (finalImpacts.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase as any)
        .from("sop_impacts").select("id", { count: "exact", head: true }).eq("report_id", report.id);
      const offset = count ?? 0;
      await supabase.from("sop_impacts").insert(
        finalImpacts.map((m: any, i: number) => ({ ...m, confidence: clampConfidence(m.confidence), report_id: report.id, position: offset + i }))
      );
    }

    // Status — the doc references the form, so 0 impacts is NOT "info absent":
    //   analyzed = produced impacts; missed = AI ran but found nothing;
    //   failed   = the AI call errored on every attempt (retry at caller).
    const status = finalImpacts.length > 0 ? "analyzed" : aiThrew ? "failed" : "missed";
    return { docId: doc.id, title: doc.title, impactCount: finalImpacts.length, status, referenceHits };
  });

/** Writes the final executive summary once all per-doc analysis calls are done. */
export const finalizeFormUpdateReport = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    reportId: z.string(),
    // Per-document outcome from the analysis loop. "failed" = could not be
    // analyzed (e.g. connection dropped); "missed" = the document references
    // the form but the AI produced no edit. Both need a manual check.
    coverage: z.array(z.object({ title: z.string(), status: z.string() })).optional(),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    const summary = (report.summary_json ?? {}) as any;
    const formId: string = summary.form_id ?? report.policy_name;
    const fieldChanges: any[] = summary.field_changes ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: impacts } = await (supabase as any)
      .from("sop_impacts").select("sop_id").eq("report_id", report.id);
    const impactCount = (impacts ?? []).length;
    const affectedDocs = new Set((impacts ?? []).map((i: any) => i.sop_id)).size;

    // Documents that could not be fully verified. A "not_referenced" doc is NOT
    // listed — it genuinely has no reference to this form, which is a correct,
    // expected outcome, not something to flag.
    const coverageWarnings = (data.coverage ?? [])
      .filter((c) => c.status === "failed" || c.status === "missed")
      .map((c) => ({ title: c.title, status: c.status }));

    const executive = [
      `Form ${formId} updated with ${fieldChanges.length} field change(s).`,
      `Found ${impactCount} reference(s) across ${affectedDocs} downstream document(s) requiring update.`,
      `All edits are mechanical find/replace — no regulatory interpretation needed.`,
    ];
    if (coverageWarnings.length > 0) {
      executive.push(
        `${coverageWarnings.length} document(s) could not be fully verified and need a manual check: ${coverageWarnings.map((c) => c.title).join(", ")}.`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      status: "pending_validation",
      summary_json: {
        ...summary,
        executive,
        coverage_warnings: coverageWarnings,
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    return { reportId: report.id as string, changesCount: fieldChanges.length, impactCount, affectedDocs, coverageWarnings };
  });

/** Lists the policy/SOP documents in ONE workspace that could reference a form. */
async function getFormCandidateDocs(workspace: string): Promise<{ docId: string; title: string }[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("sop_documents")
    .select("id, title, file_url, doc_type")
    .eq("workspace_id", workspace)
    .in("doc_type", ["sop", "it_policy", "policy"]);
  return ((data ?? []) as any[])
    .filter((d) => !!d.file_url)
    .map((d) => ({ docId: d.id as string, title: d.title as string }));
}

/** Builds the UC1 find/replace propagation prompt for one SOP document. */
function buildUC1Prompt(opts: {
  formId: string;
  friendlyName: string | null;
  fieldChanges: { label: string; oldValue: string; newValue: string }[];
  sopTitle: string;
  chunkText: string;
}): string {
  return `
# ROLE: FORM REFERENCE PROPAGATION ENGINE

A bank form has been updated. Your job: find EVERY occurrence of the OLD values in the internal SOP document below, and propose a precise find/replace edit for each occurrence.

# FORM BEING UPDATED:
- Form identifier: ${opts.formId}
- Friendly name: ${opts.friendlyName ?? "(not specified)"}

# FIELD CHANGES TO PROPAGATE:
${opts.fieldChanges.map((c, i) => `
  Change ${i + 1} — ${c.label}
    OLD: "${c.oldValue}"
    NEW: "${c.newValue}"
`).join("")}

# INTERNAL SOP DOCUMENT: "${opts.sopTitle}"
The relevant text excerpts (from a literal search of the document) are below. Find every occurrence of any OLD value within them.

${opts.chunkText}

# ❗ CRITICAL RULES (read every one):
0. PROPAGATE EVERY FIELD CHANGE, EVERYWHERE. Every change listed above must be reflected at EVERY place the form appears — every table row, TOC entry, appendix line AND prose/body reference. In particular, if a **Name** change is listed (the form's name/description changed), you MUST produce an impact updating the name at every such place — never skip the name and only do the version/date. The form name often appears as a full OR PARTIAL phrase (e.g. just "Commercial / Corporate"); find that phrase and amend it. A missing name update is a failure.
   COMPLETENESS CHECK before you finish: for each excerpt that contains the form, confirm you produced an impact for the name AND for the number/version/date. If an excerpt mentions the form but you produced no impact for it, you have missed it — go back and add it.
1. For each occurrence: produce ONE impact entry with find_text containing 1-3 lines of verbatim surrounding context including the OLD value, and replace_text containing the same context with the OLD value swapped for the NEW value.
2. ONE CELL PER IMPACT. find_text must contain ONLY the text of the single cell being amended — and NOTHING from any other cell or column.
   - ❗ NEVER include the row number / sequence number (e.g. "10.", "11.") in find_text or replace_text — that number lives in a SEPARATE "No." column cell. Including it makes the anchor span two cells and the edit is silently skipped.
   - The find/replace engine edits text within a single cell — text spanning two cells cannot be placed.
   - If OLD values are in the SAME cell, consolidate them into ONE impact for that cell.
   - If the form's NAME is in one cell and its NUMBER / VERSION / DATE is in a DIFFERENT cell (the usual layout of a Forms Reference / Forms & Templates table — Description column vs Reference No. column), produce TWO SEPARATE impacts:
     • Impact A — the Description cell: find_text = ONLY the old form name (no row number, no reference). replace_text = ONLY the new form name.
     • Impact B — the Reference No. cell: find_text = ONLY the old "FGROP …/… (version …, Updated …)" block. replace_text = ONLY the new number + version + date.
   Do NOT merge a name change and a number/version change into one find_text — they live in different cells.
3. change_type = "find_replace" for all UC1 impacts (we are NEVER inserting new content, only swapping references).
4. sop_title MUST be exactly "${opts.sopTitle}".
5. **If no OLD value is clearly present in any excerpt, return an empty array \`[]\`. Do NOT invent placeholder impacts. Do NOT write find_text values like "None of the OLD values were found" — that is NEVER a valid impact, return [] instead.**
6. find_text must contain at least one of the OLD values verbatim. If it doesn't, omit that impact entirely.

# FIELD INSTRUCTIONS — fill these precisely for every impact:
- paragraph: The table or section TYPE verbatim, e.g. "Forms Reference Table", "Forms Appendix Table", "Forms / Templates Table", "TABLE OF CONTENTS · Chapter 12", "Section 12.2 Body Text · Purpose paragraph".
- action_description: The specific cell or column being changed, e.g. "Form name + version cell", "Row 10 — Form name + ref columns", "TOC entry for section 12.2", "Section heading title". Be specific.
- line_range: Estimate from the excerpt content. Format "~N" (single line) or "~N–M" (range). Use null if not derivable.
- page: Use 0 if not available.
- warning: Set ONLY when the version found in find_text is two or more versions behind the new value being applied (version skip). Explain the skip, e.g. "Doc is on v9.0 — was on FGROP v9 (missed the v9→v10 cycle). Apply v9→v11 in one go." Otherwise set to null.

# OUTPUT JSON ARRAY of impacts:
[{
  "sop_title": "${opts.sopTitle}",
  "paragraph": "<table or section type>",
  "action_description": "<specific cell/column description>",
  "change_type": "find_replace",
  "chapter": "${opts.formId}",
  "find_text": "Verbatim text containing OLD value(s) with 1-3 lines of context",
  "replace_text": "Same context with OLD value(s) swapped for NEW",
  "page": <page number or 0>,
  "line_range": "<~N or ~N–M estimate, or null>",
  "warning": "<version skip explanation or null>",
  "confidence": <integer 0-100 — honest certainty this impact is correct>
}]

# CONFIDENCE — score every impact honestly:
- 90-100: find_text is an exact verbatim quote from the document AND the swap is purely mechanical (form name / number / version / date). Safe to fast-track.
- 70-89: the anchor is solid but the wording or placement needs a human check.
- below 70: the anchor is uncertain or the change needs judgement. Flag for review.
Never inflate — a wrong "95" that gets fast-tracked is a compliance failure.

Return ONLY the JSON array. No commentary.
`;
}

// ── Google Drive OAuth + connection management ────────────────────────────────

const workspaceSchema = z.enum(["rmit", "fatf", "forms"]);

// ── Analysis guidance — user-editable instruction injected into the prompts ───

/** Reads the saved analysis guidance for a workspace (empty string if none). */
async function fetchAnalysisGuidance(workspace: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabase as any)
      .from("analysis_guidance").select("guidance").eq("workspace_id", workspace).maybeSingle();
    return (row?.guidance as string)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Settings — read the current analysis guidance for a workspace. */
export const getAnalysisGuidance = createServerFn({ method: "GET" })
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    return { guidance: await fetchAnalysisGuidance(data.workspace) };
  });

/** Settings — save the analysis guidance for a workspace. */
export const saveAnalysisGuidance = createServerFn({ method: "POST" })
  .inputValidator(z.object({ workspace: workspaceSchema, guidance: z.string().max(20000) }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("analysis_guidance").upsert({
      workspace_id: data.workspace,
      guidance: data.guidance,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Failed to save guidance: ${error.message}`);
    return { ok: true };
  });

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
    const syncedDocs: { id: string; title: string }[] = [];
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
        // Sync = mirror only. Download the file, store in Supabase storage, upsert
        // sop_documents. No chunking or embedding here — indexing runs per-doc after
        // sync completes (client calls reindexSop for each returned sopId one at a
        // time, staying well within the 60 s Vercel function budget per call).
        let fileBuffer: Buffer;
        let storageContentType: string;
        let storageFilename: string;

        if (f.mimeType === "application/vnd.google-apps.document") {
          const token = await (await import("./google-oauth")).refreshAccessToken(data.workspace);
          const r = await fetch(
            `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!r.ok) throw new Error(`Drive export failed: ${r.status}`);
          fileBuffer = Buffer.from(await r.arrayBuffer());
          storageContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          storageFilename = `${f.name.replace(/\.(pdf|docx?|gdoc)$/i, "")}.docx`;
        } else {
          fileBuffer = await downloadFile(data.workspace, f.id);
          storageContentType = f.mimeType;
          storageFilename = f.name;
        }

        // Mirror into Supabase storage so file_url is always a downloadable URL.
        const safeName = storageFilename.replace(/[^A-Za-z0-9._-]+/g, "_");
        const storagePath = `kb/${Date.now()}-${safeName}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upErr } = await (supabase as any).storage
          .from("policies")
          .upload(storagePath, fileBuffer, { upsert: false, contentType: storageContentType });
        if (upErr) throw new Error(`Storage mirror failed: ${upErr.message}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: pub } = (supabase as any).storage.from("policies").getPublicUrl(storagePath);
        const mirroredUrl = pub.publicUrl as string;

        // Upsert sop_documents row.
        const cleanTitle = f.name.replace(/\.(pdf|docx?|gdoc|xlsx?)$/i, "");
        const detected = autoDetectDocMeta(f.name);
        const sopRow: any = {
          workspace_id: data.workspace,
          title: cleanTitle,
          doc_type: detected?.doc_type ?? "policy",
          version: detected?.version ?? "1.0",
          tags: detected?.tags ?? [],
          governance_tier: detected?.governance_tier ?? null,
          // Clear the cached topic index — sync only reaches here when the file
          // changed, so the index is rebuilt on the next regulatory analysis.
          topic_map: null,
          is_active: true,
          file_url: mirroredUrl,
          drive_view_url: driveViewerUrl(f.id, f.mimeType),
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

        syncedDocs.push({ id: sopId, title: cleanTitle });
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
      syncedDocs,
    };
  });

// ── Drive sync — phase 1: list files that need mirroring ─────────────────────

/**
 * Returns the list of Drive files that need to be (re-)mirrored into Supabase
 * storage for this workspace. No downloads happen here — this is fast.
 * The client then calls mirrorDriveFile once per file.
 */
export const listDriveFilesToSync = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    force: z.boolean().optional().default(false),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn, error: connErr } = await (supabase as any)
      .from("workspace_google_connections")
      .select("drive_folder_id, drive_folder_name")
      .eq("workspace_id", data.workspace)
      .single();
    if (connErr || !conn?.drive_folder_id) throw new Error("No Drive folder configured.");

    const files = await listFolderFiles(data.workspace, conn.drive_folder_id);
    const indexable = files.filter((f) => isIndexableMimeType(f.mimeType));
    const skipped = files.filter((f) => !isIndexableMimeType(f.mimeType));

    const driveIds = indexable.map((f) => f.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingRows } = driveIds.length > 0 ? await (supabase as any)
      .from("sop_documents")
      .select("id, drive_file_id, drive_modified_time, last_sync_error")
      .eq("workspace_id", data.workspace)
      .in("drive_file_id", driveIds) : { data: [] };
    const existingByFileId = new Map<string, any>();
    for (const r of existingRows ?? []) existingByFileId.set(r.drive_file_id, r);

    const toSync: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; existingSopId?: string }> = [];
    const unchanged: string[] = [];

    for (const f of indexable) {
      const existing = existingByFileId.get(f.id);
      if (!data.force && existing && !existing.last_sync_error && existing.drive_modified_time && f.modifiedTime) {
        if (new Date(f.modifiedTime).getTime() <= new Date(existing.drive_modified_time).getTime()) {
          unchanged.push(f.name);
          continue;
        }
      }
      toSync.push({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, existingSopId: existing?.id });
    }

    return {
      folderName: conn.drive_folder_name ?? conn.drive_folder_id,
      toSync,
      unchangedCount: unchanged.length,
      skippedCount: skipped.length,
    };
  });

// ── Drive sync — phase 2: mirror one file ─────────────────────────────────────

/**
 * Downloads one Drive file, mirrors it to Supabase storage, and upserts the
 * sop_documents row. Called once per file by the client after listDriveFilesToSync.
 * Returns { sopId, title } so the client can queue it for indexing.
 */
export const mirrorDriveFile = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    workspace: workspaceSchema,
    fileId: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    modifiedTime: z.string().optional(),
    existingSopId: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    const f = { id: data.fileId, name: data.fileName, mimeType: data.mimeType, modifiedTime: data.modifiedTime };

    let fileBuffer: Buffer;
    let storageContentType: string;
    let storageFilename: string;

    if (f.mimeType === "application/vnd.google-apps.document") {
      const token = await (await import("./google-oauth")).refreshAccessToken(data.workspace);
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) throw new Error(`Drive export failed: ${r.status}`);
      fileBuffer = Buffer.from(await r.arrayBuffer());
      storageContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      storageFilename = `${f.name.replace(/\.(pdf|docx?|gdoc)$/i, "")}.docx`;
    } else if (f.mimeType === "application/vnd.google-apps.spreadsheet") {
      const token = await (await import("./google-oauth")).refreshAccessToken(data.workspace);
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) throw new Error(`Drive Sheets export failed: ${r.status}`);
      fileBuffer = Buffer.from(await r.arrayBuffer());
      storageContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      storageFilename = `${f.name.replace(/\.xlsx?$/i, "")}.xlsx`;
    } else {
      fileBuffer = await downloadFile(data.workspace, f.id);
      storageContentType = f.mimeType;
      storageFilename = f.name;
    }

    const safeName = storageFilename.replace(/[^A-Za-z0-9._-]+/g, "_");
    const storagePath = `kb/${Date.now()}-${safeName}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any).storage
      .from("policies")
      .upload(storagePath, fileBuffer, { upsert: false, contentType: storageContentType });
    if (upErr) throw new Error(`Storage mirror failed: ${upErr.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pub } = (supabase as any).storage.from("policies").getPublicUrl(storagePath);
    const mirroredUrl = pub.publicUrl as string;

    const cleanTitle = f.name.replace(/\.(pdf|docx?|gdoc|xlsx?)$/i, "");
    const detected = autoDetectDocMeta(f.name);
    const sopRow: any = {
      workspace_id: data.workspace,
      title: cleanTitle,
      doc_type: detected?.doc_type ?? "policy",
      version: detected?.version ?? "1.0",
      tags: detected?.tags ?? [],
      governance_tier: detected?.governance_tier ?? null,
      topic_map: null,
      is_active: true,
      file_url: mirroredUrl,
      drive_view_url: driveViewerUrl(f.id, f.mimeType),
      drive_file_id: f.id,
      drive_mime_type: f.mimeType,
      drive_modified_time: f.modifiedTime ?? null,
      last_sync_error: null,
    };

    let sopId: string;
    if (data.existingSopId) {
      sopId = data.existingSopId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("sop_documents").update(sopRow).eq("id", sopId);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: row, error } = await (supabase as any)
        .from("sop_documents").insert(sopRow).select("id").single();
      if (error) throw error;
      sopId = row.id;
    }

    return { sopId, title: cleanTitle };
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

// ── Stage 4: insert an approved impact as a Drive comment on the source ──────

/**
 * Push an approved impact back to the source Drive file as a comment.
 * Works on Google Docs (anchored to quoted text), PDFs (anchored if text-
 * selectable, else file-level), and DOCX (file-level quoted comment).
 *
 * Idempotent: if drive_comment_id is already set on the impact, returns it.
 */
export const insertImpactAsDriveComment = createServerFn({ method: "POST" })
  .inputValidator(z.object({ impactId: z.string().min(1) }))
  .handler(async ({ data }) => {
    // 1. Load the impact + its source SOP
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: imp, error: impErr } = await (supabase as any)
      .from("sop_impacts")
      .select("id, sop_id, chapter, paragraph, change_type, find_text, replace_text, edited_text, drive_comment_id, status")
      .eq("id", data.impactId)
      .single();
    if (impErr || !imp) throw new Error("Impact not found");

    // Already inserted — return the existing comment ID instead of duplicating
    if (imp.drive_comment_id) {
      return { commentId: imp.drive_comment_id as string, alreadyInserted: true };
    }
    if (!imp.sop_id) throw new Error("This impact is not linked to a KB document.");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents")
      .select("workspace_id, title, drive_file_id, drive_mime_type")
      .eq("id", imp.sop_id)
      .single();
    if (sopErr || !sop) throw new Error("Source SOP not found");
    if (!sop.drive_file_id) {
      throw new Error("This SOP wasn't synced from Drive — there's no source file to comment on. Re-add the doc through the Drive folder if you want comments to flow back.");
    }

    // 2. Build the comment body
    const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section";
    const newText = (imp.edited_text ?? imp.replace_text ?? "").trim();
    const headline = isInsertion
      ? "Suggested Amendments — Insert new content"
      : "Suggested Amendments";
    const lines: string[] = [headline];
    if (imp.paragraph) lines.push(`Section: ${imp.paragraph}`);
    if (imp.chapter) lines.push(`Regulator ref: ${imp.chapter}`);
    if (!isInsertion && imp.find_text) {
      lines.push("", "Replace:", `"${String(imp.find_text).slice(0, 600)}"`);
    }
    lines.push("", isInsertion ? "Insert:" : "With:", `"${newText.slice(0, 1500)}"`);

    // 3. Post the comment via Drive API
    const r = await createDriveComment({
      workspaceId: sop.workspace_id,
      fileId: sop.drive_file_id,
      content: lines.join("\n"),
      quotedText: (imp.find_text && !imp.find_text.startsWith("[")) ? imp.find_text : (imp.paragraph || undefined),
    });

    // 4. Record it on the impact so the UI shows "Inserted" + re-clicks are no-ops
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_impacts").update({
      drive_comment_id: r.id,
      inserted_at: new Date().toISOString(),
    }).eq("id", imp.id);

    return { commentId: r.id, alreadyInserted: false };
  });

/**
 * Writes an impact's amendment directly into the source document.
 * Google Docs: edits in place via the Docs API (insert/replace + yellow highlight).
 * PDF/DOCX-in-Drive: falls back to a Drive comment, since those can't be edited in place.
 */
export const writeImpactToDoc = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    impactId: z.string().min(1),
    // comment = Drive comment; insert = add new text after the found statement;
    // replace = swap the found text for the amended text. Both in-doc modes highlight.
    mode: z.enum(["comment", "insert", "replace"]).default("comment"),
  }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: imp, error: impErr } = await (supabase as any)
      .from("sop_impacts")
      .select("id, sop_id, chapter, paragraph, change_type, find_text, replace_text, edited_text, drive_comment_id, inserted_at, status")
      .eq("id", data.impactId)
      .single();
    if (impErr || !imp) throw new Error("Impact not found");
    if (imp.inserted_at || imp.drive_comment_id) {
      return { alreadyApplied: true, method: "previous" as const };
    }
    if (!imp.sop_id) throw new Error("This impact is not linked to a KB document.");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents")
      .select("workspace_id, title, drive_file_id, drive_mime_type")
      .eq("id", imp.sop_id)
      .single();
    if (sopErr || !sop) throw new Error("Source SOP not found");
    if (!sop.drive_file_id) {
      throw new Error("This SOP wasn't synced from Drive — re-add it through the Drive folder to enable edits.");
    }

    const isInsertion = imp.change_type === "insertion" || imp.change_type === "new_section" || imp.change_type === "contextual";
    const newText = (imp.edited_text ?? imp.replace_text ?? "").trim();
    if (!newText) throw new Error("This impact has no amended text to apply.");
    const isGoogleDoc = sop.drive_mime_type === "application/vnd.google-apps.document";

    // ── COMMENT — a Drive comment (works on any file type) ──────────────────
    // Also the automatic fallback for PDF/DOCX, which can't be edited in place.
    if (data.mode === "comment" || !isGoogleDoc) {
      const headline = isInsertion ? "Suggested Amendments — Insert new content" : "Suggested Amendments";
      const lines: string[] = [headline];
      if (imp.paragraph) lines.push(`Section: ${imp.paragraph}`);
      if (imp.chapter) lines.push(`Regulator ref: ${imp.chapter}`);
      if (!isInsertion && imp.find_text) lines.push("", "Replace:", `"${String(imp.find_text).slice(0, 600)}"`);
      lines.push("", isInsertion ? "Insert:" : "With:", `"${newText.slice(0, 1500)}"`);
      const r = await createDriveComment({
        workspaceId: sop.workspace_id,
        fileId: sop.drive_file_id,
        content: lines.join("\n"),
        quotedText: (imp.find_text && !imp.find_text.startsWith("[")) ? imp.find_text : (imp.paragraph || undefined),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("sop_impacts").update({
        drive_comment_id: r.id,
        inserted_at: new Date().toISOString(),
      }).eq("id", imp.id);
      return { alreadyApplied: false, method: "comment" as const };
    }

    // ── INSERT / REPLACE — edit the Google Doc in place, highlighted ────────
    const result = await writeToGoogleDoc({
      workspaceId: sop.workspace_id,
      fileId: sop.drive_file_id,
      findText: imp.find_text ?? "",
      anchor: imp.paragraph ?? imp.chapter ?? "",
      newText,
      mode: data.mode === "replace" ? "replace" : "insert",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("sop_impacts").update({
      inserted_at: new Date().toISOString(),
    }).eq("id", imp.id);
    return {
      alreadyApplied: false,
      method: data.mode as "insert" | "replace",
      highlighted: result.highlighted,
      occurrences: result.occurrences,
    };
  });

/**
 * Phase 3 — versioned amended draft. For each affected SOP, COPIES the source
 * Google Doc and applies every APPROVED impact to the copy (highlighted). The
 * live document is never touched — the copy is the reviewable draft version.
 * Draft links are recorded on the report's summary_json.amended_drafts.
 */
export const generateAmendedDraft = createServerFn({ method: "POST" })
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: impactRows } = await (supabase as any)
      .from("sop_impacts").select("*").eq("report_id", report.id).eq("status", "approved");
    const approved = (impactRows ?? []) as any[];
    if (approved.length === 0) {
      throw new Error("No approved impacts yet — approve impacts first, then generate the amended draft.");
    }

    // Group approved impacts by their source SOP
    const bySop = new Map<string, any[]>();
    for (const imp of approved) {
      if (!imp.sop_id) continue;
      if (!bySop.has(imp.sop_id)) bySop.set(imp.sop_id, []);
      bySop.get(imp.sop_id)!.push(imp);
    }

    const drafts: any[] = [];
    const skipped: { title: string; reason: string }[] = [];
    const stamp = new Date().toISOString().slice(0, 10);

    for (const [sopId, imps] of bySop.entries()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sop } = await (supabase as any)
        .from("sop_documents")
        .select("title, workspace_id, drive_file_id, drive_mime_type, drive_view_url")
        .eq("id", sopId).single();
      if (!sop?.drive_file_id || sop.drive_mime_type !== "application/vnd.google-apps.document") {
        skipped.push({ title: sop?.title ?? "Unknown SOP", reason: "not a Google Doc — can't draft a copy" });
        continue;
      }
      try {
        const copy = await copyDriveFile(
          sop.workspace_id, sop.drive_file_id,
          `${sop.title} — AMENDED DRAFT (pending sign-off) ${stamp}`,
        );
        const result = await applyImpactsToGoogleDoc(
          sop.workspace_id, copy.id,
          imps.map((im) => ({
            findText: im.find_text ?? "",
            newText: (im.edited_text ?? im.replace_text ?? "").trim(),
            anchor: im.paragraph ?? im.chapter ?? "",
            mode: (im.change_type === "insertion" || im.change_type === "new_section" || im.change_type === "contextual")
              ? "insert" as const : "replace" as const,
          })),
        );
        drafts.push({
          sopId, sopTitle: sop.title, draftFileId: copy.id, draftUrl: copy.url,
          originalUrl: sop.drive_view_url ?? driveViewerUrl(sop.drive_file_id, sop.drive_mime_type),
          impactCount: imps.length, applied: result.applied,
        });
      } catch (e: any) {
        console.warn(`generateAmendedDraft: failed for "${sop.title}":`, e?.message);
        skipped.push({ title: sop.title, reason: e?.message?.slice(0, 140) ?? "draft failed" });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...(report.summary_json as any ?? {}),
        amended_drafts: drafts,
        amended_drafts_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    return { drafts, skipped };
  });

// ── Stage 5: open-ended form-diff detection ──────────────────────────────────
// Compares a newly uploaded form against the matching version already in the
// Internal Forms KB and returns every substantive change (not just 3 fields).

/** Pull plain text from a file URL — handles PDF and DOCX. */
async function fetchAndExtractText(fileUrl: string): Promise<{ text: string; mimeType: string }> {
  const file = await fetchFile(fileUrl);
  const isDocx = looksLikeDocx(file.mimeType, fileUrl);
  if (isDocx) {
    const text = await docxToText(file.buffer);
    return { text, mimeType: file.mimeType };
  }
  // PDF
  const { extractPdfPages } = await import("./pdf-pages");
  const pages = await extractPdfPages(file.buffer);
  const text = pages.map((p) => p.text).join("\n\n");
  return { text, mimeType: file.mimeType };
}

/** Strip the version suffix from a form number to get the canonical base ID. */
function deriveBaseFormId(formNumber: string): string {
  return formNumber.replace(/_v\d+$/i, "").trim();
}

export const detectFormChanges = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    newFileUrl: z.string().url(),
    oldFormSopId: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    // 1. Extract metadata from the new file using existing helper
    const newFetched = await fetchFile(data.newFileUrl);
    const newMeta = await (async () => {
      const isDocx = looksLikeDocx(newFetched.mimeType, data.newFileUrl);
      const prompt = `Extract these three fields from this bank form (look at the header / top of page 1):
1. form_name - the main form title in uppercase
2. form_number - full reference number with version suffix (e.g. "FGROP 037/2016_v11")
3. updated_date - the updated/effective date string verbatim
Return ONLY JSON: {"form_name":"...","form_number":"...","updated_date":"..."}. null for fields you can't find.`;
      let part: any;
      if (isDocx) {
        const text = await docxToText(newFetched.buffer);
        part = { text: `--- FORM DOCUMENT TEXT ---\n${text.slice(0, 6000)}\n--- END ---` };
      } else {
        part = { inlineData: { data: newFetched.buffer.toString("base64"), mimeType: newFetched.mimeType } };
      }
      const r = await generateWithFallback({
        contents: [{ role: "user", parts: [part, { text: prompt }] }],
        config: { responseMimeType: "application/json", maxOutputTokens: 512 },
      }, { tier: "fast" });
      try { return JSON.parse(r.text ?? "{}"); } catch { return {}; }
    })();
    const newFormNumber: string | null = newMeta.form_number ?? null;
    const newFormName: string | null = newMeta.form_name ?? null;
    const newUpdatedDate: string | null = newMeta.updated_date ?? null;

    // 2. Find the matching old form in the Internal Forms KB
    const baseFormId = newFormNumber ? deriveBaseFormId(newFormNumber) : null;
    let oldForm: any = null;
    if (data.oldFormSopId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: r } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, file_url, doc_type, workspace_id")
        .eq("id", data.oldFormSopId)
        .maybeSingle();
      oldForm = r;
    } else if (baseFormId) {
      // Try a relaxed title match — handle "FGROP 037/2016" vs "FGROP_037_2016"
      // by trimming separators and matching the alpha-num core.
      const flat = baseFormId.replace(/[^A-Za-z0-9]/g, "");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: candidates } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, file_url, doc_type, workspace_id")
        .eq("workspace_id", "forms")
        .order("created_at", { ascending: false });
      oldForm = (candidates ?? []).find((c: any) => {
        const flatTitle = (c.title ?? "").replace(/[^A-Za-z0-9]/g, "");
        return flatTitle.toUpperCase().includes(flat.toUpperCase());
      }) ?? null;
    }

    if (!oldForm) {
      return {
        oldForm: null,
        newForm: { form_number: newFormNumber, form_name: newFormName, updated_date: newUpdatedDate, base_form_id: baseFormId },
        detectedChanges: [],
        message: baseFormId
          ? `No existing version of "${baseFormId}" found in the Internal Forms KB. You can register this as a new form.`
          : "Couldn't extract a form number from the uploaded file. Try a different file or use manual entry.",
      };
    }

    // 3. Pull text from both files
    if (!oldForm.file_url) {
      throw new Error(`Old form "${oldForm.title}" has no source file in KB to compare against.`);
    }
    const oldExtracted = await fetchAndExtractText(oldForm.file_url);
    const newExtracted = await fetchAndExtractText(data.newFileUrl);

    // 4. Open-ended diff via Gemini
    const diffPrompt = `# ROLE: BANK FORM DIFF ANALYST

Compare two versions of an internal bank form and list every substantive change.

# WHAT TO LOOK FOR:
- Header fields: form name/title, form reference number, version, updated/effective date
- Structural changes: new/removed/renamed section, new/removed/relabeled checkbox or field, signature block changes
- Instruction / disclosure / note changes: modified clause text, new mandatory note, changed footer text

# WHAT TO IGNORE:
- Pure whitespace / line-wrap differences
- Page numbers and page headers/footers repeating on every page
- Formatting-only changes (capitalisation that doesn't change meaning, font hints in source)
- The page-by-page header repetition of "FGROP 037/2016_v11 (Updated on 27.05.2026)" — count it ONCE as a header change, not per page

# OUTPUT — JSON array, each entry:
{
  "label": "short name e.g. 'Form version', 'Account Type — Family Office checkbox', 'E-Invoice disclosure clause'",
  "oldValue": "verbatim text from OLD (null if newly added)",
  "newValue": "verbatim text in NEW (null if removed)",
  "category": "header" | "structure" | "instruction",
  "propagatable": true | false,
  "explanation": "one sentence — why this change does or doesn't cascade to downstream SOPs that reference this form"
}

Set propagatable=true when downstream SOPs that NAME this form would need updating:
  - Header fields (form name, number, date) — almost always propagatable
  - Renamed section that's referenced by name in SOPs — propagatable
  - New/removed sections — usually NOT propagatable (SOPs don't enumerate sections)
  - Internal disclosure text — NOT propagatable
  - New checkbox label — NOT propagatable unless it changes a section name SOPs reference

# OLD FORM CONTENT:
${oldExtracted.text.slice(0, 30000)}

# NEW FORM CONTENT:
${newExtracted.text.slice(0, 30000)}

Return ONLY the JSON array. No commentary, no markdown fences.`;

    const r = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: diffPrompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    });
    let detectedChanges: any[] = [];
    try {
      const parsed = JSON.parse(r.text ?? "[]");
      detectedChanges = Array.isArray(parsed) ? parsed : (parsed.changes ?? []);
    } catch (e: any) {
      console.warn("Form diff parse failed:", e?.message);
    }

    return {
      oldForm: { id: oldForm.id, title: oldForm.title },
      newForm: { form_number: newFormNumber, form_name: newFormName, updated_date: newUpdatedDate, base_form_id: baseFormId },
      detectedChanges,
    };
  });
