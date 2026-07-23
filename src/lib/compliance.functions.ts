import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { chunkDocument, generateAmendedDocument, extractRegulatoryChanges, extractFatfRequirements, mapChangeToSops, routeChangesToSops, analyzeSopAgainstGaps, buildSopTopicMap, generateAnalysisSummary, generateWithFallback, simplifyDocument, simplifyDocumentByUnits, detectDocumentDuplication, summarizeDocument, analyzeDocFigures, type FigureReview, analyzeCreditRisk, extractCreditRiskRetrievalQueries, chatCreditRisk, generateCreditMitigations, detectFinancialAnomalies, searchAdverseNews, AVAILABLE_MODELS, getDefaultModel, clearDefaultModelCache } from "./gemini";
import { attachEvidence } from "./credit-evidence";
import PizZip from "pizzip";
import { applyEditsToDocx, looksLikeDocx, docxToText, docxToHtml, docxToSimplifyText, docxToSimplifyUnits, docxToStructuredUnits, dominantBodyProps, extractDocxFigures, applySimplificationToDocx, rebuildDocxBody, type SimplifyDocxEdit } from "./docx-editor";
import { verifyActions, analyzeStructure, crossCheckSections, DEFAULT_SIMPLIFY_GUIDANCE, AGGRESSIVE_SIMPLIFY_ADDENDUM, initialDecision } from "./simplify";
import type { VerificationSummary, DocStructure, SectionCrossCheck, VerifiedAction } from "./simplify";
import { runAuditPipeline, countFindings, generateRestructured, generateDocumentFromBrief, DEFAULT_RECOMMEND_GUIDANCE, proposeTargetedEdits, verifyFindings, deriveConcreteEdits, findingNeedsInput, findingInputSuggestion, generateFindingsExecSummary, type Finding, type ClaimUnit, type FindingCategory, type FindingSeverity } from "./recommend";
import type { SimplificationAction } from "./gemini";
import { getCallerTenant, assertRowTenant, ALL_TENANT_FEATURES } from "./tenant.functions";
import { computeCost, addUsage, type RunCost } from "./pricing";

/**
 * Appends one AI-spend entry to the report's cumulative cost ledger
 * (summary_json.costLog). Every metered operation records here so the reviewer
 * can audit total spend across re-runs — the legacy `cost` field only ever
 * showed the LAST analysis run. Capped at the 50 most recent entries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appendCostLog(sj: Record<string, any>, op: string, cost: RunCost | null | undefined): Record<string, any> {
  if (!cost || !(cost.usd > 0)) return sj;
  const log = Array.isArray(sj.costLog) ? sj.costLog.slice(-49) : [];
  log.push({
    op,
    usd: Number(cost.usd.toFixed(4)),
    calls: cost.calls,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens + (cost.thinkingTokens ?? 0),
    at: new Date().toISOString(),
  });
  return { ...sj, costLog: log };
}
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

// Allowed workspace identifiers — shared across every workspace-scoped input
// validator. Declared up here so server fns defined anywhere in the file can
// reference it in their .inputValidator() (evaluated at module load).
const workspaceSchema = z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]);

// Guidance rows are keyed by workspace_id, plus synthetic sub-keys for flows
// that need a second editable prompt within one workspace (v2 recommendation).
const guidanceKeySchema = z.union([workspaceSchema, z.literal("simplify_v2_recommend")]);

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

/**
 * Append-only audit write for a workflow transition. Records who/when/what for
 * every state change on a report. Writes via the SERVICE-ROLE client only —
 * workflow_events has no client write policy under RLS (it is tamper-resistant:
 * clients can read history but cannot forge or delete it).
 *
 * NEVER throws: a failed audit write must not break the transition the user
 * requested, so any error is swallowed with a console.warn.
 */
async function logWorkflowEvent(
  reportId: string,
  event: string,
  fromStatus: string | null,
  toStatus: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { userId?: string; claims?: any },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: any,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any).from("workflow_events").insert({
      report_id: reportId,
      event,
      from_status: fromStatus,
      to_status: toStatus,
      actor_id: context.userId ?? null,
      actor_email: context.claims?.email ?? null,
      detail: detail ?? null,
    });
    if (error) console.warn(`logWorkflowEvent(${event}) failed:`, error.message);
  } catch (e: any) {
    console.warn(`logWorkflowEvent(${event}) threw:`, e?.message);
  }
}

export const createReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("rmit"),
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
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const detected = data.detected;
    const workspace = data.workspace;
    const { tenantId } = await getCallerTenant(context.userId);

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
      .eq("tenant_id", tenantId)
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
          .eq("tenant_id", tenantId)
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
          .eq("tenant_id", tenantId)
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
      const analysisGuidance = await fetchAnalysisGuidance(supabase, workspace);
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
              topicMap = await buildAndVerifyTopicMap(supabase, sop.id, sop.title, text);
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
        // (fetchSopText reads via Drive API / public file_url — no supabase client needed)
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
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("rmit"),
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
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
          // The report page reads this on load and auto-starts the analysis,
          // so the upload screen can navigate away immediately. Cleared by
          // startRegulatoryRerun once the run begins.
          pending_analysis: true,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create report");
    return { reportId: report.id as string };
  });

/**
 * Creates a 'policy_change' workflow report — an internal policy revision that
 * runs through the same report state machine as regulatory/form reports, but is
 * discriminated by workflow_type = "policy_change". No AI extraction at create
 * time: the analyst seeds the report (optionally from a regulatory_changes row)
 * and the impacts are curated through the normal review flow.
 */
export const createPolicyChangeReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      workspace: workspaceSchema,
      title: z.string().min(1),
      description: z.string().max(20000).optional(),
      sourceChangeId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const title = data.title;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title,
        policy_name: title,
        status: "pending_validation",
        workflow_type: "policy_change",
        workspace_id: data.workspace,
        source_file_url: null,
        summary_json: {
          workflow_type: "policy_change",
          analyst_notes: data.description ?? null,
          source_change_id: data.sourceChangeId ?? null,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create policy change report");

    // When seeded from a regulatory change, look up that row and create ONE
    // starter impact so the analyst has a concrete anchor to expand from.
    if (data.sourceChangeId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: srcChange } = await (supabase as any)
        .from("regulatory_changes")
        .select("chapter_ref")
        .eq("id", data.sourceChangeId)
        .maybeSingle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("sop_impacts").insert({
        report_id: report.id,
        sop_title: "(policy change) " + title,
        change_type: "contextual",
        chapter: srcChange?.chapter_ref ?? null,
        status: "pending",
        position: 0,
      });
    }

    await logWorkflowEvent(report.id as string, "created", null, "pending_validation", context, {
      workflow_type: "policy_change",
      source_change_id: data.sourceChangeId ?? null,
    });

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
  const parseBytes = async (buf: Buffer, mime: string, hint: string | null): Promise<string> => {
    if (looksLikeDocx(mime, hint)) return await docxToText(buf);
    if (mime === "application/pdf" || /\.pdf($|\?)/i.test(hint ?? "")) {
      const { extractPdfPages } = await import("./pdf-pages");
      return (await extractPdfPages(buf)).map((p: any) => p.text).join("\n");
    }
    return buf.toString("utf-8");
  };
  try {
    let text = "";
    if (sopDoc.drive_file_id) {
      // Drive is the source of truth. A stored file_url may be a stale viewer-
      // page link from an older sync (drive.google.com/file/d/…/view), which is
      // not downloadable — so read straight from the Drive API: text export for
      // a native Google Doc, byte download for a PDF/DOCX held in Drive.
      if (sopDoc.drive_mime_type === "application/vnd.google-apps.document") {
        text = await exportGoogleDocAsText(workspaceId, sopDoc.drive_file_id);
      } else {
        const buf = await downloadFile(workspaceId, sopDoc.drive_file_id);
        text = await parseBytes(buf, sopDoc.drive_mime_type ?? "", sopDoc.title ?? null);
      }
    } else if (sopDoc.file_url) {
      const f = await fetchFile(sopDoc.file_url);
      text = await parseBytes(f.buffer, f.mimeType, sopDoc.file_url);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any, sopId: string, title: string, fullText: string,
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, tenantId);
    if (!report.source_file_url) throw new Error("Report has no source file URL — cannot rerun");

    const detected = (report.summary_json as any)?.detected ?? null;
    const workspace = ((report as any).workspace_id as string) ?? "rmit";

    await supabase.from("sop_impacts").delete().eq("report_id", report.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", report.id);

    // STAGE 1 — extract the regulatory GAP LIST. For an RMiT/circular regulation
    // this is a DELTA: the new policy is diffed against its prior version held
    // in the Knowledge Base (the sop_documents row of the same regulation
    // doc_type in this workspace), so only what genuinely CHANGED is extracted —
    // not the whole policy restated. With no prior version on file it falls back
    // to extracting the new policy's material requirements. A FATF statement is
    // conformance-checked as standing obligations (no diff). The gap list drives
    // the "Change Analysis" panel and is what every SOP is checked against in
    // Stage 2 (analyzeRegulatorySop reads it back from regulatory_changes).
    const docType: string = (detected as any)?.doc_type ?? "";
    const isFatf = workspace === "fatf" || docType === "fatf";
    const regulatorCtx: "fatf" | "circular" | "rmit" =
      isFatf ? "fatf" : docType === "circular" ? "circular" : "rmit";

    // Prior version of this regulation in the KB — the other document of the
    // same regulation doc_type in this workspace — used as the diff baseline.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let baseline: any = null;
    if (!isFatf && docType) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: priorRows } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, file_url, drive_file_id, drive_mime_type, created_at")
        .eq("workspace_id", workspace)
        .eq("tenant_id", tenantId)
        .eq("doc_type", docType)
        .order("created_at", { ascending: false });
      baseline = ((priorRows ?? []) as any[]).find((r) => r.file_url !== report.source_file_url) ?? null;
      if (baseline) console.log(`[regulatory] diff baseline: "${baseline.title}"`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let requirements: any[] = [];
    let insertedChanges: { id: string; chapter_ref: string }[] = [];
    let regulationStatus: "ok" | "failed" = "failed";
    let regulationError: string | null = null;
    try {
      const guidance = await fetchAnalysisGuidance(supabase, workspace);
      if (isFatf) {
        const regFile = await fetchFile(report.source_file_url);
        const regSource = await policySourceFromFile(report.policy_name ?? "regulation", regFile, report.source_file_url);
        requirements = await extractFatfRequirements(regSource, guidance);
      } else {
        // Read the new regulation and the KB baseline as text — a text-vs-text
        // forensic diff is fast and stays well within the function time limit.
        const newText = await fetchSopText(
          { title: report.policy_name ?? "regulation", file_url: report.source_file_url },
          workspace,
        );
        if (!newText || !newText.trim()) throw new Error("Could not read the uploaded regulation file");
        let oldSource: { name: string; text: string } | undefined;
        if (baseline) {
          const oldText = await fetchSopText(baseline, workspace);
          if (oldText && oldText.trim()) oldSource = { name: baseline.title as string, text: oldText };
        }
        requirements = await extractRegulatoryChanges(
          { name: report.policy_name ?? "new regulation", text: newText },
          oldSource,
          regulatorCtx,
          guidance,
        );
      }
      if (requirements.length > 0) {
        // Every field is defaulted: some extractors (e.g. extractFatfRequirements)
        // omit related_instruments / legal_refs, and those columns are NOT NULL —
        // an omitted field would fail the whole batch insert.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: ins, error: insErr } = await (supabase as any).from("regulatory_changes").insert(
          requirements.map((c: any, i: number) => ({
            chapter_ref: c.chapter_ref ?? "Unspecified",
            old_requirement: c.old_requirement ?? "N/A - new requirement",
            new_requirement: c.new_requirement ?? "",
            change_summary: c.change_summary ?? "",
            impact: c.impact ?? "medium",
            tone_shift: c.tone_shift ?? "",
            pages: c.pages ?? "",
            legal_refs: c.legal_refs ?? [],
            related_instruments: c.related_instruments ?? [],
            report_id: report.id,
            position: i,
          }))
        ).select("id, chapter_ref");
        if (insErr) {
          // The extraction succeeded but the rows could not be stored — surface
          // it as a failure, never a silent "0 changes".
          regulationError = `Could not store the extracted changes: ${insErr.message ?? "insert error"}`.slice(0, 200);
          console.warn(`[regulatory] regulatory_changes insert failed:`, insErr.message);
        } else {
          regulationStatus = "ok";
          insertedChanges = (ins ?? []) as { id: string; chapter_ref: string }[];
        }
      } else {
        // A real regulation always yields changes — an empty extraction means
        // the AI model was overloaded or returned nothing. Surface it as a
        // FAILURE (regulationStatus stays "failed") so the report says "re-run",
        // never a silent, misleading "0 changes / analysis queued".
        regulationError =
          "The regulation was read but no changes were extracted — the AI model was likely overloaded. Please re-run the analysis.";
        console.warn(`[regulatory] Stage 1 extracted 0 changes (model likely overloaded)`);
      }
    } catch (e: any) {
      regulationError = e?.message?.slice(0, 200) ?? "unknown error";
      console.warn(`[regulatory] Stage 1 gap extraction failed:`, regulationError);
    }

    // STAGE 2 — EXECUTIVE SUMMARY (a change-level artefact; does not need the
    // SOP mapping). STAGE 3 — ROUTING: match each change to the internal
    // document(s) that own it, so Stage 4 drafts edits only inside those.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let summaryFields: any = {};
    const routing: Record<string, string[]> = {};
    if (insertedChanges.length > 0) {
      const INTERNAL_DOC_TYPES = INTERNAL_DOC_TYPES_CONST as readonly string[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sopRows } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, file_url, drive_file_id, drive_mime_type")
        .eq("workspace_id", workspace)
        .eq("tenant_id", tenantId)
        .in("doc_type", INTERNAL_DOC_TYPES);
      // Catalogue: title + opening-scope blurb for each internal document.
      const catalogue = await Promise.all(
        ((sopRows ?? []) as any[]).map(async (s) => {
          const txt = await fetchSopText(s, workspace);
          return {
            id: s.id as string,
            title: s.title as string,
            blurb: String(txt ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
          };
        }),
      );
      const readableCat = catalogue.filter((c) => c.blurb.length > 0);

      try {
        summaryFields = await generateAnalysisSummary(requirements as any[], [], report.policy_name ?? "policy");
      } catch (e: any) {
        console.warn(`[regulatory] Stage 2 summary failed:`, e?.message?.slice(0, 120));
      }

      if (readableCat.length > 0) {
        try {
          const routeIdx = await routeChangesToSops(
            requirements.map((c: any) => ({ chapter_ref: c.chapter_ref, change_summary: c.change_summary })),
            readableCat.map((c) => ({ title: c.title, blurb: c.blurb })),
            await fetchAnalysisGuidance(supabase, workspace),
          );
          for (const [ci, docIdxs] of Object.entries(routeIdx)) {
            const change = insertedChanges[Number(ci)];
            if (!change) continue;
            routing[change.id] = (docIdxs as number[])
              .map((di) => readableCat[di]?.id)
              .filter((id): id is string => !!id);
          }
        } catch (e: any) {
          console.warn(`[regulatory] Stage 3 routing failed:`, e?.message?.slice(0, 120));
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...(report.summary_json as any ?? {}),
        ...summaryFields,
        detected: detected ?? null,
        pending_analysis: false,
        regulation_status: regulationStatus,
        regulation_error: regulationError,
        old_policy_name: baseline?.title ?? null,
        routing,
        last_rerun_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    // The regulatory CHANGES are the unit of analysis. The client maps each one
    // to the internal SOPs it affects via mapRegulatoryChange, run in parallel —
    // one focused call per change (the proven extract-changes → map-to-SOPs flow).
    return {
      reportId: report.id as string,
      changeCount: insertedChanges.length,
      changes: insertedChanges,
    };
  });

/**
 * Phase 2 (proven flow) — maps ONE regulatory change to the internal SOPs it
 * affects. Reads every internal SOP's FULL text and asks the model, for this
 * single change, which clause(s) in which document(s) must be amended. One
 * focused call per change keeps the impact set tight (a change usually has one
 * owning document) — unlike checking every SOP against every change, which
 * over-triggers. The client runs these in parallel, one per change.
 */
export const mapRegulatoryChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), changeId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("id, workspace_id, summary_json, tenant_id").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const workspaceId = (report.workspace_id as string) ?? "rmit";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: change } = await (supabase as any)
      .from("regulatory_changes").select("*").eq("id", data.changeId).single();
    if (!change) return { changeId: data.changeId, chapter_ref: "?", impactCount: 0, status: "failed" as const };

    // STAGE 4 — read this change's routed document(s) from Stage 3. The change
    // is mapped ONLY against the documents that own it, so an impact cannot
    // spread across every overlapping policy. No routed document = the change
    // is not covered by any SOP (a valid, surfaced result — not a failure).
    const routing = ((report.summary_json as any)?.routing ?? {}) as Record<string, string[]>;
    const routedIds = Array.isArray(routing[data.changeId]) ? routing[data.changeId] : [];
    if (routedIds.length === 0) {
      console.log(`[regulatory] change "${change.chapter_ref}" → no owning document`);
      return { changeId: data.changeId, chapter_ref: change.chapter_ref as string, impactCount: 0, status: "mapped" as const };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sopRows } = await (supabase as any)
      .from("sop_documents")
      .select("id, title, file_url, drive_file_id, drive_mime_type, governance_tier")
      .in("id", routedIds);
    const sops = (sopRows ?? []) as any[];
    const withText = await Promise.all(
      sops.map(async (s) => ({ ...s, text: await fetchSopText(s, workspaceId) })),
    );
    const readable = withText.filter((s) => s.text && (s.text as string).trim());
    if (readable.length === 0) {
      return { changeId: data.changeId, chapter_ref: change.chapter_ref, impactCount: 0, status: "failed" as const };
    }

    let impacts: any[] = [];
    try {
      impacts = await mapChangeToSops(
        change as any,
        readable.map((s) => ({
          title: s.title as string,
          text: s.text as string,
          governanceTier: s.governance_tier ?? null,
        })),
        await fetchAnalysisGuidance(supabase, workspaceId),
      );
    } catch (e: any) {
      console.warn(`[regulatory] mapChangeToSops failed for "${change.chapter_ref}":`, e?.message);
      return { changeId: data.changeId, chapter_ref: change.chapter_ref, impactCount: 0, status: "failed" as const };
    }

    // Verify each impact against the FULL text of the SOP it was mapped to —
    // discard hallucinated anchors (downgraded to a section-level contextual
    // insert, never dropped), strip fabricated clause refs, link to the sop_id.
    const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kept: any[] = [];
    for (const m of impacts) {
      const t = norm(m.sop_title);
      const sop =
        readable.find((s) => norm(s.title) === t) ??
        readable.find((s) => norm(s.title).includes(t) || (t.length > 6 && t.includes(norm(s.title))));
      if (!sop) continue; // mapped to a document that is not in the KB
      const verify = makeFindTextVerifier(sop.text as string);
      const para = verifyParagraph(sop.text as string, m.paragraph);
      const repaired = verify(m.find_text);
      const base = { ...m, sop_id: sop.id, sop_title: sop.title, chapter: change.chapter_ref, paragraph: para };
      if (repaired === null) {
        kept.push({
          ...base,
          change_type: "contextual",
          find_text: para === PARAGRAPH_UNLOCATED ? "[no exact anchor in document]" : `[no exact anchor — see ${para}]`,
          confidence: Math.min(clampConfidence(m.confidence) ?? 60, 70),
        });
      } else {
        kept.push({ ...base, find_text: repaired });
      }
    }

    if (kept.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase as any)
        .from("sop_impacts").select("id", { count: "exact", head: true }).eq("report_id", report.id);
      const offset = count ?? 0;
      await supabase.from("sop_impacts").insert(
        kept.map((m: any, i: number) => {
          const conf = clampConfidence(m.confidence);
          return {
            ...m,
            confidence: conf,
            // Auto-approve high-confidence impacts so reviewers only triage the
            // borderline ones — matches the UC4 simplification rule (>90).
            status: (conf ?? 0) > 90 ? "approved" : "pending",
            report_id: report.id,
            position: offset + i,
          };
        }),
      );
    }
    console.log(`[regulatory] change "${change.chapter_ref}" → ${kept.length} impact(s)`);
    return { changeId: data.changeId, chapter_ref: change.chapter_ref as string, impactCount: kept.length, status: "mapped" as const };
  });

/**
 * Phase 2 — analyzes ONE internal SOP against ALL regulatory changes, reading
 * the SOP's FULL text (no chunking, no vector search — nothing gets missed for
 * lack of retrieval). Oversized SOPs are split into large segments so each
 * Gemini call stays within the function time limit. One call per SOP.
 */
export const analyzeRegulatorySop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), sopId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("id, workspace_id, policy_name, source_file_url, tenant_id").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, tenantId);
    if (!report.source_file_url) return { sopId: data.sopId, title: "?", impactCount: 0, status: "failed" as const };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop } = await (supabase as any)
      .from("sop_documents").select("id, title, file_url, drive_file_id, drive_mime_type, governance_tier, tenant_id").eq("id", data.sopId).single();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((sop as any)?.tenant_id, tenantId);
    if (!sop || (!sop.file_url && !sop.drive_file_id)) return { sopId: data.sopId, title: sop?.title ?? "?", impactCount: 0, status: "failed" as const };

    // STAGE 2 — check this SOP against the Stage-1 GAP LIST. The gaps (the
    // regulatory requirements extracted in startRegulatoryRerun) are the rules;
    // the regulation document is NOT re-read here. The SOP's FULL text is read
    // so nothing is missed for lack of retrieval. For Google Docs the SOP is
    // read via Google's OWN text export — the exact representation the in-doc
    // edit later matches.
    const workspaceId = (report.workspace_id as string) ?? "rmit";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: gapRows } = await (supabase as any)
      .from("regulatory_changes")
      .select("chapter_ref, old_requirement, new_requirement, change_summary, impact, tone_shift, pages, legal_refs, related_instruments")
      .eq("report_id", report.id)
      .order("position");
    const gaps = (gapRows ?? []) as any[];
    if (gaps.length === 0) {
      // No gaps were extracted from the regulation — there is nothing to check
      // this SOP against. Not a SOP failure; the regulation-level status is
      // surfaced separately by finalizeRegulatoryReport.
      return { sopId: sop.id, title: sop.title, impactCount: 0, status: "analyzed" as const };
    }
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
    const analysisGuidance = await fetchAnalysisGuidance(supabase, workspaceId);
    const deadline = Date.now() + 250_000;
    for (const seg of segments) {
      if (Date.now() > deadline) { console.warn(`[regulatory] "${sop.title}" time budget reached`); break; }
      try {
        const impacts = await analyzeSopAgainstGaps(gaps, {
          title: sop.title, text: seg,
          governanceTier: sop.governance_tier ?? null,
        }, analysisGuidance);
        allImpacts.push(...impacts);
      } catch (e: any) {
        console.warn(`[regulatory] analysis failed for "${sop.title}":`, e?.message);
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
        finalImpacts.map((m: any, i: number) => {
          const conf = clampConfidence(m.confidence);
          return {
            ...m,
            confidence: conf,
            // Auto-approve high-confidence impacts so reviewers only triage the
            // borderline ones — matches the UC4 simplification rule (>90).
            status: (conf ?? 0) > 90 ? "approved" : "pending",
            report_id: report.id,
            position: offset + i,
          };
        })
      );
    }
    console.log(`[regulatory] "${sop.title}" → ${finalImpacts.length} impact(s)`);
    return { sopId: sop.id, title: sop.title, impactCount: finalImpacts.length, status: "analyzed" as const };
  });

/** Phase 3 — regenerates the executive summary once all changes are mapped. */
export const finalizeRegulatoryReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    // Per-SOP outcome from the analysis loop. "failed" = could not be analysed
    // and needs a manual check; "analyzed" with impactCount 0 = reviewed and
    // conformant (no amendment needed).
    coverage: z.array(z.object({
      title: z.string(),
      status: z.string(),
      impactCount: z.number().optional(),
    })).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: changes } = await (supabase as any)
      .from("regulatory_changes").select("*").eq("report_id", report.id).order("position");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: impacts } = await (supabase as any)
      .from("sop_impacts").select("*").eq("report_id", report.id);

    const prev = (report.summary_json as any) ?? {};
    const cov = data.coverage ?? [];
    const regulationFailed = prev.regulation_status === "failed";
    // Regulatory changes that could not be mapped — surfaced so a failure is
    // never invisible.
    const coverageWarnings = cov
      .filter((c) => c.status === "failed")
      .map((c) => ({ title: c.title, status: c.status }));
    // Changes that mapped with no SOP amendment — already compliant, or not
    // owned by any internal document. Suppressed when the regulation itself
    // failed to read (then "conformant" would be a false statement).
    const reviewedClean = regulationFailed
      ? []
      : cov
          .filter((c) => c.status !== "failed" && (c.impactCount ?? 0) === 0)
          .map((c) => c.title);
    // The executive summary was generated in Stage 2 (from the changes) and is
    // kept as-is — UNLESS the run was incomplete, in which case it must not read
    // as a clean compliance pass.
    let executive = prev.executive;
    if (regulationFailed || coverageWarnings.length > 0) {
      const lines: string[] = [];
      if (regulationFailed) {
        lines.push(
          "⚠️ **This analysis is INCOMPLETE.** The regulation could not be read, so no changes were extracted. Re-run the analysis; if it persists, re-upload the regulation file.",
        );
      }
      if (coverageWarnings.length > 0) {
        const n = coverageWarnings.length;
        lines.push(
          `⚠️ **${n} regulatory change${n === 1 ? "" : "s"} could not be mapped** to the internal documents — ${n === 1 ? "it needs" : "they need"} a manual check. Do NOT treat this report as a clean compliance pass.`,
        );
      }
      const impCount = (impacts ?? []).length;
      lines.push(
        `${impCount} SOP amendment${impCount === 1 ? "" : "s"} ${impCount === 1 ? "was" : "were"} identified across the changes that mapped successfully.`,
      );
      executive = lines;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...prev,
        executive,
        coverage_warnings: coverageWarnings,
        reviewed_clean: reviewedClean,
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (supabase as any)
      .from("analysis_reports")
      .select("status, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!before) throw new Error("Report not found");
    assertRowTenant(before.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "pending_legal" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    await logWorkflowEvent(
      data.reportId, "submitted_legal", (before?.status as string | null) ?? null, "pending_legal", context,
    );
    return { ok: true };
  });

export const finalizeLegalSignOff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabase as any)
      .from("analysis_reports")
      .select("status, summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!row) throw new Error("Report not found");
    assertRowTenant(row.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const summary = (row?.summary_json ?? {}) as Record<string, unknown>;
    const { error } = await supabase
      .from("analysis_reports")
      .update({
        status: "signed_off",
        summary_json: { ...summary, signed_off_at: new Date().toISOString() },
      })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    await logWorkflowEvent(
      data.reportId, "signed_off", (row?.status as string | null) ?? null, "signed_off", context,
    );
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: beforeRow } = await (supabase as any)
      .from("analysis_reports")
      .select("status, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!beforeRow) throw new Error("Report not found");
    assertRowTenant(beforeRow.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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

    await logWorkflowEvent(
      data.reportId, "published", (beforeRow?.status as string | null) ?? null, "published", context,
    );

    return { ok: true, updatedSops: updated };
  });

export const markPendingManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (supabase as any)
      .from("analysis_reports")
      .select("status, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!before) throw new Error("Report not found");
    assertRowTenant(before.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "pending_manual" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    await logWorkflowEvent(
      data.reportId, "pending_manual", (before?.status as string | null) ?? null, "pending_manual", context,
    );
    return { ok: true };
  });

export const confirmManualCompletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (supabase as any)
      .from("analysis_reports")
      .select("status, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!before) throw new Error("Report not found");
    assertRowTenant(before.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const { error } = await supabase
      .from("analysis_reports")
      .update({ status: "published" })
      .eq("id", data.reportId);
    if (error) throw new Error(error.message);
    await logWorkflowEvent(
      data.reportId, "published", (before?.status as string | null) ?? null, "published", context,
    );
    return { ok: true };
  });

export const updateImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string(),
      status: z.enum(["pending", "approved", "rejected", "routed"]).optional(),
      edited_text: z.string().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { id, ...rest } = data;
    // Grab the impact's report + prior status so the audit can record the change.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prior } = await (supabase as any)
      .from("sop_impacts")
      .select("report_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!prior) throw new Error("Impact not found");
    // Tenant boundary: the impact's owning report must belong to the caller.
    if (prior.report_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: impReport } = await (supabase as any)
        .from("analysis_reports").select("tenant_id").eq("id", prior.report_id).maybeSingle();
      assertRowTenant(impReport?.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    }
    const { error } = await supabase.from("sop_impacts").update(rest).eq("id", id);
    if (error) throw new Error(error.message);
    // Only audit when a status decision was actually requested, and only when we
    // could resolve the owning report (workflow_events.report_id is NOT NULL).
    if (data.status && prior?.report_id) {
      await logWorkflowEvent(
        prior.report_id as string,
        "impact_decided",
        (prior.status as string | null) ?? null,
        data.status,
        context,
        { impact_id: id, status: data.status },
      );
    }
    return { ok: true };
  });

/**
 * Fast-track approval: marks every still-pending impact in a report whose AI
 * confidence is at or above the threshold as "approved", in one operation.
 * A human triggers it — so there is still a single accountable approve action.
 */
export const bulkApproveReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    minConfidence: z.number().min(0).max(100).default(90),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // Tenant boundary: a report id from another tenant behaves like a 404.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: repRow } = await (supabase as any)
      .from("analysis_reports").select("tenant_id").eq("id", data.reportId).maybeSingle();
    if (!repRow) throw new Error("Report not found");
    assertRowTenant(repRow.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      message: z.string().min(1).max(4000),
    })
  )
  .handler(async function* ({ data, context }) {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports")
      .select("title, policy_name, summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!report) throw new Error("Report not found");
    assertRowTenant(report.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // Tenant boundary: a report id from another tenant behaves like a 404 —
    // never delete across the wall.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabase as any)
      .from("analysis_reports").select("tenant_id").eq("id", data.id).maybeSingle();
    if (!row) throw new Error("Report not found");
    assertRowTenant(row.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    await supabase.from("chat_messages").delete().eq("report_id", data.id);
    await supabase.from("sop_impacts").delete().eq("report_id", data.id);
    await supabase.from("regulatory_changes").delete().eq("report_id", data.id);
    const { error } = await supabase.from("analysis_reports").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteSop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // Tenant boundary: a document id from another tenant behaves like a 404 —
    // never delete across the wall.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabase as any)
      .from("sop_documents").select("tenant_id").eq("id", data.id).maybeSingle();
    if (!row) throw new Error("Document not found");
    assertRowTenant(row.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const { error } = await supabase.from("sop_documents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createSop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      title: z.string().min(2).max(200),
      doc_type: z.enum(["sop", "rmit", "rmit_reg", "fatf", "circular", "it_policy", "policy", "form"]),
      version: z.string().min(1).max(20),
      workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("rmit"),
      summary: z.string().max(2000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      file_url: z.string().nullable().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
  .middleware([requireSupabaseAuth])
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
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: current, error: readError } = await (supabase as any)
      .from("sop_documents")
      .select("version, tenant_id")
      .eq("id", data.id)
      .single();
    if (readError || !current) throw new Error(readError?.message || "SOP not found");
    assertRowTenant(current.tenant_id, (await getCallerTenant(context.userId)).tenantId);

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
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      scope: z.enum(["analyses", "kb", "all"]),
      workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("rmit"),
    })
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // Scope all deletions to the specified workspace AND the caller's tenant —
    // never wipe across workspaces, and never touch another tenant's rows.
    const { tenantId } = await getCallerTenant(context.userId);
    if (data.scope === "analyses" || data.scope === "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: reports } = await (supabase as any)
        .from("analysis_reports").select("id").eq("workspace_id", data.workspace).eq("tenant_id", tenantId);
      const reportIds = (reports ?? []).map((r: any) => r.id);
      if (reportIds.length > 0) {
        await supabase.from("sop_impacts").delete().in("report_id", reportIds);
        await supabase.from("regulatory_changes").delete().in("report_id", reportIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("analysis_reports").delete().in("id", reportIds);
      }
    }
    if (data.scope === "kb" || data.scope === "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: docs } = await (supabase as any)
        .from("sop_documents").select("id").eq("workspace_id", data.workspace).eq("tenant_id", tenantId);
      const docIds = (docs ?? []).map((d: any) => d.id);
      if (docIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("sop_chunks").delete().in("sop_id", docIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("sop_documents").delete().in("id", docIds);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // Tenant boundary: a report id from another tenant behaves like a 404.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: repRow } = await (supabase as any)
      .from("analysis_reports").select("tenant_id").eq("id", data.reportId).maybeSingle();
    if (!repRow) throw new Error("Report not found");
    assertRowTenant(repRow.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), sopId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents").select("*").eq("id", data.sopId).single();
    if (sopErr || !sop) throw new Error("SOP not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(sop.tenant_id, tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: repRow } = await (supabase as any)
      .from("analysis_reports").select("tenant_id").eq("id", data.reportId).maybeSingle();
    if (!repRow) throw new Error("Report not found");
    assertRowTenant(repRow.tenant_id, tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    sopId: z.string(),
    // DOCX path: previewUrl points to the preview file in Storage (we re-upload it under the final amendments/ prefix)
    previewUrl: z.string().nullable().optional(),
    previewPath: z.string().nullable().optional(),
    // HTML path: amended HTML body to wrap and save
    amendedHtml: z.string().nullable().optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: oldSop, error: sopErr } = await (supabase as any)
      .from("sop_documents").select("*").eq("id", data.sopId).single();
    if (sopErr || !oldSop) throw new Error("SOP not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(oldSop.tenant_id, tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: repRow } = await (supabase as any)
      .from("analysis_reports").select("tenant_id").eq("id", data.reportId).maybeSingle();
    if (!repRow) throw new Error("Report not found");
    assertRowTenant(repRow.tenant_id, tenantId);

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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("rmit") }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { tenantId } = await getCallerTenant(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sops } = await (supabase as any)
      .from("sop_documents")
      .select("id")
      .eq("workspace_id", data.workspace)
      .eq("tenant_id", tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents")
      .select("*")
      .eq("id", data.id)
      .single();
    if (sopErr || !sop) throw new Error("SOP not found");
    assertRowTenant(sop.tenant_id, (await getCallerTenant(context.userId)).tenantId);
    if (!sop.file_url && !sop.drive_file_id) throw new Error("SOP has no source file — cannot re-index");

    // Forms workspace docs are compared directly — no chunking needed.
    if (sop.workspace_id === "forms") {
      return { chunkCount: 0, message: "Forms workspace — no indexing required" };
    }

    let allChunks: Array<{ content: string; chapter_ref?: string; page_number?: number }>;
    if (sop.drive_file_id) {
      if (sop.drive_mime_type === "application/vnd.google-apps.document") {
        const text = await exportGoogleDocAsText(sop.workspace_id, sop.drive_file_id);
        allChunks = chunkDocxText(text);
      } else {
        const buf = await downloadFile(sop.workspace_id, sop.drive_file_id);
        const isDocx = looksLikeDocx(sop.drive_mime_type ?? "", sop.title ?? "");
        allChunks = isDocx
          ? chunkDocxText(await docxToText(buf))
          : await chunkDocument({ name: sop.title, buffer: buf, mimeType: sop.drive_mime_type ?? "application/pdf" });
      }
    } else {
      const file = await fetchFile(sop.file_url);
      const isDocx = looksLikeDocx(file.mimeType, sop.file_url);
      allChunks = isDocx
        ? chunkDocxText(await docxToText(file.buffer))
        : await chunkDocument({ name: sop.title, buffer: file.buffer, mimeType: file.mimeType });
    }

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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    fileUrl: z.string().url(),
    fileName: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    const prompt = `You are extracting header fields from an RHB Banking Group internal form.

LOOK IN TWO ZONES on page 1:
  • TOP-RIGHT CORNER — small text, usually contains the form reference and updated date.
  • CENTRE TOP — the main title block.

Extract these THREE fields EXACTLY as they appear (verbatim — preserve capitalisation, punctuation,
slashes, en-dashes "–" and em-dashes "—"):

1. form_number  (reference + version)
   • Pattern:  "{LETTERS} {DIGITS}/{YEAR}_v{N}"  or  "{LETTERS} {DIGITS}/{YEAR} v{N}"
   • Example:  "FGROP 037/2016_v10"
   • Where:    top-right header.
   • Keep the version suffix attached. Do NOT split it off.

2. updated_date  (date string with its prefix word)
   • Pattern:  "Updated on DD.MM.YYYY"  or  "(Updated on DD.MM.YYYY)"  or  "Effective DD/MM/YYYY"
   • Example:  "Updated on 27.02.2025"
   • Where:    directly below or beside the form_number. Include parentheses if printed.

3. form_name  (English title — UPPERCASE)
   • Pattern:  ALL UPPERCASE, usually contains "FORM" or "APPLICATION".
   • Example:  "ACCOUNT OPENING APPLICATION FORM – COMMERCIAL / CORPORATE"
   • Where:    centred title block. ENGLISH LINE ONLY — if the form has a Malay translation line below
              (e.g. "BORANG PERMOHONAN MEMBUKA AKAUN..."), ignore it. Downstream SOPs only reference
              the English title, so the Malay line doesn't need to be captured.

GROUNDING RULES — non-negotiable:
- Every field must appear LITERALLY in the document. Copy character-for-character.
- Do NOT generate, paraphrase, translate, or "correct" typos.
- If a field truly cannot be located, return null (not an empty string, not your best guess).

Return ONLY this JSON, no markdown fences:
{"form_number":"...","updated_date":"...","form_name":"..."}`;

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
      // Output cap bumped to 1024 because the 4-field response (incl. Malay)
      // can be ~250-400 tokens of UTF-8 verbatim text.
      const resp = await generateWithFallback({
        contents: [{
          role: "user",
          parts: [contentPart, { text: prompt }],
        }],
        config: { responseMimeType: "application/json", maxOutputTokens: 1024 },
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspace: z.enum(["rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy", "credit_risk", "credit_risk_demo"]).default("forms"),
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
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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

    const docsToAnalyze = await getFormCandidateDocs(supabase, data.workspace, (await getCallerTenant(context.userId)).tenantId);
    return { reportId: report.id as string, docsToAnalyze };
  });

/**
 * Resets a UC1 form-update report for re-analysis: wipes existing impacts/changes,
 * re-creates the field-change rows, and returns the candidate docs for the client
 * to analyze one at a time via analyzeDocForForm.
 */
export const rerunFormUpdateReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(report.tenant_id, tenantId);

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

    const docsToAnalyze = await getFormCandidateDocs(supabase, (report.workspace_id as string) ?? "forms", tenantId);
    return { reportId: report.id as string, docsToAnalyze };
  });

/**
 * Analyzes ONE knowledge-base document for references to an updated form.
 * The client calls this once per candidate doc — each call gets its own Vercel
 * function budget, so a single large document can never make the run time out.
 */
export const analyzeDocForForm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), docId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(report.tenant_id, tenantId);
    const summary = (report.summary_json ?? {}) as any;
    const formId: string = summary.form_id ?? report.policy_name;
    const friendlyName: string | null = summary.friendly_name ?? null;
    const fieldChanges: { label: string; oldValue: string; newValue: string }[] = summary.field_changes ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: doc } = await (supabase as any)
      .from("sop_documents").select("id, title, file_url, workspace_id, drive_file_id, drive_mime_type, tenant_id").eq("id", data.docId).single();
    if (!doc || (!doc.file_url && !doc.drive_file_id)) {
      return { docId: data.docId, title: doc?.title ?? "?", impactCount: 0, status: "failed" as const, referenceHits: 0 };
    }
    assertRowTenant(doc.tenant_id, tenantId);

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

    // Extract full text. fetchSopText reads a Google Doc via text export and a
    // Drive PDF/DOCX via the Drive API, so a stale viewer-page file_url is never
    // the read path. A null result is reported as a failure so the caller
    // retries and never silently drops the document.
    const fullText = await fetchSopText(doc, (doc.workspace_id as string) ?? "forms");
    if (!fullText || !fullText.trim()) {
      console.warn(`analyzeDocForForm: extract failed for "${doc.title}"`);
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
        finalImpacts.map((m: any, i: number) => {
          const conf = clampConfidence(m.confidence);
          return {
            ...m,
            confidence: conf,
            // Auto-approve high-confidence impacts so reviewers only triage the
            // borderline ones — matches the UC4 simplification rule (>90).
            status: (conf ?? 0) > 90 ? "approved" : "pending",
            report_id: report.id,
            position: offset + i,
          };
        })
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    // Per-document outcome from the analysis loop. "failed" = could not be
    // analyzed (e.g. connection dropped); "missed" = the document references
    // the form but the AI produced no edit. Both need a manual check.
    coverage: z.array(z.object({ title: z.string(), status: z.string() })).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
async function getFormCandidateDocs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any, workspace: string, tenantId: string,
): Promise<{ docId: string; title: string }[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("sop_documents")
    .select("id, title, file_url, drive_file_id, doc_type")
    .eq("workspace_id", workspace)
    .eq("tenant_id", tenantId)
    .in("doc_type", ["sop", "it_policy", "policy", "circular", "rmit_reg", "fatf"]);
  return ((data ?? []) as any[])
    .filter((d) => !!d.file_url || !!d.drive_file_id)
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

// ── Analysis guidance — user-editable instruction injected into the prompts ───

/** Reads the saved analysis guidance for a workspace (empty string if none). */
async function fetchAnalysisGuidance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any, workspace: string,
): Promise<string> {
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: guidanceKeySchema }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    return { guidance: await fetchAnalysisGuidance(supabase, data.workspace) };
  });

/** Settings — save the analysis guidance for a workspace. */
export const saveAnalysisGuidance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: guidanceKeySchema, guidance: z.string().max(20000) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    return await getConnection(data.workspace);
  });

/** Disconnect Google for a workspace. */
export const disconnectGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    await deleteConnection(data.workspace);
    return { ok: true };
  });

// ── Stage 2: Drive folder configuration + KB sync ────────────────────────────

/** Save the KB folder for this workspace. Validates the ID exists + is a folder. */
export const setDriveFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
    // workspace_google_connections is deny-all under RLS — service role only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspace: workspaceSchema,
    /** Re-process every file regardless of modifiedTime / last_sync_error. */
    force: z.boolean().optional().default(false),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // workspace_google_connections is deny-all under RLS — service role only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn, error: connErr } = await (supabaseAdmin as any)
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
    const { tenantId } = await getCallerTenant(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingRows } = driveIds.length > 0 ? await (supabase as any)
      .from("sop_documents")
      .select("id, drive_file_id, drive_modified_time, last_sync_error")
      .eq("workspace_id", data.workspace)
      .eq("tenant_id", tenantId)
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspace: workspaceSchema,
    force: z.boolean().optional().default(false),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // workspace_google_connections is deny-all under RLS — service role only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn, error: connErr } = await (supabaseAdmin as any)
      .from("workspace_google_connections")
      .select("drive_folder_id, drive_folder_name")
      .eq("workspace_id", data.workspace)
      .single();
    if (connErr || !conn?.drive_folder_id) throw new Error("No Drive folder configured.");

    const files = await listFolderFiles(data.workspace, conn.drive_folder_id);
    const indexable = files.filter((f) => isIndexableMimeType(f.mimeType));
    const skipped = files.filter((f) => !isIndexableMimeType(f.mimeType));

    const driveIds = indexable.map((f) => f.id);
    const { tenantId } = await getCallerTenant(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingRows } = driveIds.length > 0 ? await (supabase as any)
      .from("sop_documents")
      .select("id, drive_file_id, drive_modified_time, last_sync_error")
      .eq("workspace_id", data.workspace)
      .eq("tenant_id", tenantId)
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspace: workspaceSchema,
    fileId: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    modifiedTime: z.string().optional(),
    existingSopId: z.string().optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
      // Tenant boundary: an existing sop id from another tenant behaves like a 404.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingRow } = await (supabase as any)
        .from("sop_documents").select("tenant_id").eq("id", data.existingSopId).maybeSingle();
      if (!existingRow) throw new Error("Document not found");
      assertRowTenant(existingRow.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspace: workspaceSchema }))
  .handler(async ({ data }) => {
    // workspace_google_connections is deny-all under RLS — service role only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conn } = await (supabaseAdmin as any)
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspace: workspaceSchema,
    driveFileId: z.string().min(1),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ impactId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
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
      .select("workspace_id, title, drive_file_id, drive_mime_type, tenant_id")
      .eq("id", imp.sop_id)
      .single();
    if (sopErr || !sop) throw new Error("Source SOP not found");
    assertRowTenant(sop.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    impactId: z.string().min(1),
    // comment = Drive comment; insert = add new text after the found statement;
    // replace = swap the found text for the amended text. Both in-doc modes highlight.
    mode: z.enum(["comment", "insert", "replace"]).default("comment"),
    // Set TRUE to re-apply an impact that was previously inserted/commented —
    // skips the alreadyApplied short-circuit so the "Re-insert" UX works.
    force: z.boolean().optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: imp, error: impErr } = await (supabase as any)
      .from("sop_impacts")
      .select("id, sop_id, chapter, paragraph, change_type, find_text, replace_text, edited_text, drive_comment_id, inserted_at, status")
      .eq("id", data.impactId)
      .single();
    if (impErr || !imp) throw new Error("Impact not found");
    if (!data.force && (imp.inserted_at || imp.drive_comment_id)) {
      return { alreadyApplied: true, method: "previous" as const };
    }
    if (!imp.sop_id) throw new Error("This impact is not linked to a KB document.");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sop, error: sopErr } = await (supabase as any)
      .from("sop_documents")
      .select("workspace_id, title, drive_file_id, drive_mime_type, tenant_id")
      .eq("id", imp.sop_id)
      .single();
    if (sopErr || !sop) throw new Error("Source SOP not found");
    assertRowTenant(sop.tenant_id, (await getCallerTenant(context.userId)).tenantId);
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
    // Prefix the highlighted amendment with "Change Note:" so a reviewer opening
    // the document immediately sees the block is a suggested change, not
    // original text. (Idempotent — never double-prefixed.)
    const docText = newText.startsWith("Change Note:") ? newText : `Change Note: ${newText}`;
    const result = await writeToGoogleDoc({
      workspaceId: sop.workspace_id,
      fileId: sop.drive_file_id,
      findText: imp.find_text ?? "",
      anchor: imp.paragraph ?? imp.chapter ?? "",
      newText: docText,
      mode: data.mode === "replace" ? "replace" : "insert",
      // Track-changes annotation: when replacing, also drop " (was: <original>)"
      // in strike-through grey right after the amendment so reviewers see what
      // it displaced. No-op for inserts (no original to strike).
      originalText: data.mode === "replace" ? (imp.find_text ?? undefined) : undefined,
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
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      // How replaces land in the draft:
      //  - "trackChanges": original kept in red + strikethrough, new appended yellow.
      //  - "clean":        original deleted, new inserted yellow (finalised look).
      renderMode: z.enum(["clean", "trackChanges"]).default("trackChanges"),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (!report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);

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
      if (!sop?.drive_file_id) {
        skipped.push({ title: sop?.title ?? "Unknown SOP", reason: "not synced to Drive — can't draft a copy" });
        continue;
      }
      try {
        // The render mode is shown in the copy's name so multiple mode-flavoured
        // drafts can coexist side-by-side in Drive.
        const modeLabel = data.renderMode === "clean" ? "Clean" : "Track Changes";
        // Non-Google-Doc sources (PDF / DOCX) get converted to a native Google
        // Doc on copy — Drive runs OCR/conversion as part of the copy, so the
        // Docs API can then apply edits the same way as Doc-sourced SOPs. This
        // is how RMiT-style PDF SOPs get amended drafts. Quality caveats: OCR
        // on scanned PDFs varies, and complex layouts (multi-column, tables,
        // footnotes) often degrade on conversion.
        const needsConversion = sop.drive_mime_type !== "application/vnd.google-apps.document";
        const copy = await copyDriveFile(
          sop.workspace_id, sop.drive_file_id,
          `${sop.title} — AMENDED DRAFT — ${modeLabel} (pending sign-off) ${stamp}`,
          { convertToGoogleDoc: needsConversion },
        );
        const result = await applyImpactsToGoogleDoc(
          sop.workspace_id, copy.id,
          imps.map((im) => {
            const isInsert =
              im.change_type === "insertion" ||
              im.change_type === "new_section" ||
              im.change_type === "contextual";
            return {
              findText: im.find_text ?? "",
              newText: (im.edited_text ?? im.replace_text ?? "").trim(),
              anchor: im.paragraph ?? im.chapter ?? "",
              mode: isInsert ? ("insert" as const) : ("replace" as const),
              // For replaces in track-changes mode, this is also what gets red+strike.
              originalText: isInsert ? undefined : (im.find_text ?? undefined),
            };
          }),
          { renderMode: data.renderMode },
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
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    newFileUrl: z.string().url(),
    oldFormSopId: z.string().optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // 1. Extract metadata from the new file using existing helper
    const newFetched = await fetchFile(data.newFileUrl);
    const newMeta = await (async () => {
      const isDocx = looksLikeDocx(newFetched.mimeType, data.newFileUrl);
      // Same grounded extraction prompt as extractFormMetadata — kept inline
      // here so the diff path doesn't depend on the helper, and so we can
      // tune them independently if the diff needs different anchors later.
      const prompt = `Extract these THREE header fields from the RHB bank form on page 1.
Copy EXACTLY (case, punctuation, dashes, parentheses). DO NOT paraphrase.

1. form_number — reference + version, top-right header.   e.g. "FGROP 037/2016_v11"
2. updated_date — date string WITH its prefix word.        e.g. "Updated on 27.05.2026"
3. form_name — English title in UPPERCASE, centre top.     e.g. "ACCOUNT OPENING APPLICATION FORM – COMMERCIAL / CORPORATE"
   English line ONLY — if a Malay translation line ("BORANG...") sits below it, ignore that line.

Every field must appear LITERALLY in the document. Use null if you cannot locate it (no guessing).
Return ONLY JSON: {"form_number":"...","updated_date":"...","form_name":"..."}.`;
      let part: any;
      if (isDocx) {
        const text = await docxToText(newFetched.buffer);
        part = { text: `--- FORM DOCUMENT TEXT ---\n${text.slice(0, 6000)}\n--- END ---` };
      } else {
        part = { inlineData: { data: newFetched.buffer.toString("base64"), mimeType: newFetched.mimeType } };
      }
      const r = await generateWithFallback({
        contents: [{ role: "user", parts: [part, { text: prompt }] }],
        config: { responseMimeType: "application/json", maxOutputTokens: 1024 },
      }, { tier: "fast" });
      try { return JSON.parse(r.text ?? "{}"); } catch { return {}; }
    })();
    const newFormNumber: string | null = newMeta.form_number ?? null;
    const newFormName: string | null = newMeta.form_name ?? null;
    const newUpdatedDate: string | null = newMeta.updated_date ?? null;

    // 2. Find the matching old form in the Internal Forms KB
    const baseFormId = newFormNumber ? deriveBaseFormId(newFormNumber) : null;
    let oldForm: any = null;
    const { tenantId } = await getCallerTenant(context.userId);
    if (data.oldFormSopId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: r } = await (supabase as any)
        .from("sop_documents")
        .select("id, title, file_url, doc_type, workspace_id, tenant_id")
        .eq("id", data.oldFormSopId)
        .maybeSingle();
      if (r) assertRowTenant(r.tenant_id, tenantId);
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
        .eq("tenant_id", tenantId)
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
- Header fields — treat each of these as a SEPARATE detected change if it differs:
    • Form reference + version (e.g. "FGROP 037/2016_v10" vs "FGROP 037/2016_v11")
    • Updated/effective date (e.g. "Updated on 27.02.2025" vs "Updated on 27.05.2026")
    • English form title (UPPERCASE line, usually contains "FORM" or "APPLICATION")
  Focus on the English title only — Malay translation lines ("BORANG…") are not referenced by downstream SOPs, so ignore them unless their absence/presence is itself the change.
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

// ════════════════════════════════════════════════════════════════════════════
// UC4 — DOCUMENT SIMPLIFICATION
// One internal document is simplified into a list of reviewable edits. The AI
// PROPOSES; deterministic code (verifyActions) anchors every proposed `before`
// span to the real document, so an invented or hallucinated clause is caught
// and quarantined. Reports live in analysis_reports with workspace_id
// "simplify"; the whole result is stored in summary_json (no per-action rows in
// v1). These functions are self-contained — they do not touch the regulatory
// or forms workflows.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates a simplification report row (lightweight — no analysis yet). The
 * report page reads `pending_analysis` and kicks off runSimplificationReport,
 * so the upload screen can navigate away immediately — mirroring
 * createRegulatoryReport's create-then-run-on-the-page pattern.
 */
export const createSimplificationReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      customTitle: z.string().optional(),
      instruction: z.string().optional(),
      // Set when the source is a Google Drive file — recorded so the apply step
      // can copy the original document straight in Drive.
      driveFileId: z.string().optional(),
      driveMimeType: z.string().optional(),
      mode: z.enum(["thorough", "quick"]).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    if (!data.fileUrl) throw new Error("No file URL provided for simplification");
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
        workspace_id: "simplify",
        summary_json: {
          kind: "simplification",
          simplify_mode: data.mode ?? "thorough",
          instruction: data.instruction?.trim() || null,
          driveFileId: data.driveFileId ?? null,
          driveMimeType: data.driveMimeType ?? null,
          executive: ["Simplification queued — analysing the document…"],
          // The report page reads this on load and auto-runs the analysis.
          pending_analysis: true,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create simplification report");
    return { reportId: report.id as string };
  });

/**
 * Runs document simplification end to end for one report:
 *   1. fetch the source file → plain TEXT for the model + HTML for structure;
 *   2. parse structure (headings / tables / word count);
 *   3. AI proposes simplification actions (chunked over the WHOLE document);
 *   4. DETERMINISTIC verification — anchor every `before` to the real document,
 *      classifying each action verified / review / rejected;
 *   5. cross-check each action's claimed section against the real heading index.
 * The full result is stored in analysis_reports.summary_json.
 */
export const runSimplificationReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), mode: z.enum(["thorough", "quick"]).optional() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    if (!report.source_file_url) throw new Error("Report has no source file — cannot run simplification");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevJson = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const instruction: string | null = prevJson.instruction ?? null;
    const title = (report.policy_name as string) ?? "Document";
    // "thorough" = per-unit (every paragraph/cell — comprehensive, slower);
    // "quick" = chunk-based (fast, fewer high-confidence edits). Explicit choice
    // wins; otherwise reuse the report's last mode; otherwise default thorough.
    const mode: "thorough" | "quick" = data.mode ?? prevJson.simplify_mode ?? "thorough";

    let status: "ok" | "failed" = "failed";
    let errorMsg: string | null = null;
    let summary: VerificationSummary | null = null;
    let structure: DocStructure | null = null;
    let crossCheck: SectionCrossCheck | null = null;
    let cost: RunCost | null = null;
    let figureReviews: FigureReview[] = [];
    let figuresScanned = 0;
    let figuresSkipped = 0;
    let documentSummary = "";

    try {
      // 1 — fetch the source file. DOCX is read as plain TEXT for the model
      // (~5x fewer tokens than HTML) and ALSO as HTML, used only to count
      // tables/headings for the provenance header. PDF/other → text only.
      const file = await fetchFile(report.source_file_url);
      const isDocx = looksLikeDocx(file.mimeType, report.source_file_url);
      const html = isDocx ? await docxToHtml(file.buffer) : "";
      // Cell-aware extraction: emits each table cell's prose as its own clean,
      // anchorable line (mammoth's flat extractRawText tab-joins table rows, so
      // cell prose can't be quoted verbatim and the simplifier skips it). Falls
      // back to flat text if anything goes wrong. Still plain text (not HTML),
      // so the ~5x token saving over HTML is preserved.
      let text = "";
      if (isDocx) {
        try { text = docxToSimplifyText(file.buffer); } catch { text = ""; }
        if (!text) text = await docxToText(file.buffer).catch(() => "");
      }
      if (!text) {
        if (file.mimeType === "application/pdf" || /\.pdf($|\?)/i.test(report.source_file_url)) {
          const { extractPdfPages } = await import("./pdf-pages");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          text = (await extractPdfPages(file.buffer)).map((p: any) => p.text).join("\n\n");
        } else {
          text = file.buffer.toString("utf-8");
        }
      }
      if (!text.trim()) throw new Error("Could not read any text from the uploaded document");

      // 2 — document structure (feeds the provenance header + section check).
      structure = analyzeStructure(html || text);

      // 3 — AI proposes simplification actions across the whole document. The
      // simplify workspace's editable Analysis Guidance (Settings → Analysis
      // Guidance) is folded into the prompt here, so tuning that guidance
      // changes the rules every subsequent run applies.
      // No saved guidance yet → fall back to the built-in starter house rules.
      const guidance = (await fetchAnalysisGuidance(supabase, "simplify")) || DEFAULT_SIMPLIFY_GUIDANCE;
      // THOROUGH → per-unit batched: the model evaluates EVERY paragraph & table
      // cell, batches retry so none silently drop, and `before` is each unit's
      // exact text so edits anchor cleanly. QUICK → the chunk-based pass (fast,
      // a curated set). Per-unit units come from DOCX structure; for non-DOCX we
      // split the extracted text into paragraph units. Either falls back to the
      // chunk pass if no units can be derived.
      const units = mode === "thorough"
        ? (isDocx
            ? docxToSimplifyUnits(file.buffer)
            : text.split(/\n+/).map((t) => ({ text: t.trim(), section: "" })).filter((u) => u.text))
        : [];
      // Per-unit/chunk simplification + a whole-document de-duplication pass run
      // together; de-dup catches the cross-section repeats the slice-based pass can't see.
      const [main, dedup, docSum] = await Promise.all([
        units.length
          ? simplifyDocumentByUnits({ title, units }, { instruction, guidance })
          : simplifyDocument({ title, text }, { instruction, guidance }),
        detectDocumentDuplication({ title, text }, { guidance }).catch((e: any) => {
          console.warn("[simplify] de-dup pass failed:", e?.message?.slice(0, 120));
          return { actions: [], usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 } };
        }),
        summarizeDocument({ title, text }, { guidance }).catch((e: any) => {
          console.warn("[simplify] summary pass failed:", e?.message?.slice(0, 120));
          return { summary: "", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 } };
        }),
      ]);
      const actions = [...main.actions, ...dedup.actions];
      documentSummary = docSum.summary;
      const usage = addUsage(addUsage(main.usage, dedup.usage), docSum.usage);
      cost = computeCost(usage, await getDefaultModel()); // metered even if the run yields nothing
      if (actions.length === 0) {
        throw new Error(
          "No simplification actions were produced — the AI model was likely overloaded or rate-limited. Please re-run.",
        );
      }

      // 4 + 5 — deterministic verification and section cross-check.
      summary = verifyActions(actions, text);
      crossCheck = crossCheckSections(summary.actions, structure);

      // 6 — FIGURES: charts/flowcharts embedded as images are invisible to the
      // text pass, so each unique image goes to the vision model; its suggested
      // changes become a Word COMMENT anchored on the figure at apply time.
      // Never fails the run — a figure error just means no figure notes.
      if (isDocx) {
        try {
          const { figures, skipped } = extractDocxFigures(file.buffer);
          figuresScanned = figures.length;
          figuresSkipped = skipped;
          if (figures.length > 0) {
            const fr = await analyzeDocFigures(title, figures, { guidance });
            figureReviews = fr.reviews;
            cost = computeCost(addUsage(usage, fr.usage), await getDefaultModel()); // fold vision tokens into the metered cost
          }
        } catch (e: any) {
          console.warn("[simplify] figure review failed:", e?.message?.slice(0, 120));
        }
      }
      status = "ok";
    } catch (e: any) {
      errorMsg = e?.message?.slice(0, 250) ?? "unknown error";
      console.warn(`[simplify] run failed for "${title}":`, errorMsg);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: {
        ...prevJson,
        kind: "simplification",
        simplify_mode: mode,
        pending_analysis: false,
        simplification_status: status,
        simplification_error: errorMsg,
        structure: structure ?? null,
        cross_check: crossCheck ?? null,
        document_summary: documentSummary || null,
        verification: summary
          ? { total: summary.total, verified: summary.verified, review: summary.review, rejected: summary.rejected }
          : null,
        // Each action carries its initial Accept/Reject decision: verified +
        // confidence > 90 → accepted; quarantined → rejected; else pending.
        actions: (summary?.actions ?? []).map((a) => ({ ...a, decision: initialDecision(a) })),
        // Vision review of embedded charts/figures — applied as Word comments.
        figure_reviews: figureReviews,
        figures_scanned: figuresScanned,
        figures_skipped: figuresSkipped,
        cost: cost ?? null,
        last_run_at: new Date().toISOString(),
      },
    }).eq("id", report.id);

    return {
      reportId: report.id as string,
      status,
      error: errorMsg,
      total: summary?.total ?? 0,
      verified: summary?.verified ?? 0,
      review: summary?.review ?? 0,
      rejected: summary?.rejected ?? 0,
      costUsd: cost?.usd ?? 0,
    };
  });

/**
 * UC4 — records a reviewer's Accept/Reject decision on one simplification
 * action. Decisions live in summary_json.actions[index].decision. A quarantined
 * action (the verifier found it is not in the document) can never be accepted.
 */
export const setSimplificationDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      index: z.number().int().min(0),
      decision: z.enum(["accepted", "rejected", "pending"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .select("summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: any[] = Array.isArray(sj.actions) ? sj.actions : [];
    if (data.index >= actions.length) throw new Error("Action index out of range");
    if (actions[data.index]?.verification?.status === "rejected" && data.decision === "accepted") {
      throw new Error("A quarantined action cannot be accepted — it was not found in the document.");
    }

    actions[data.index] = { ...actions[data.index], decision: data.decision };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, actions } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save decision: ${upErr.message}`);
    return { ok: true };
  });

/**
 * UC4 — bulk Accept/Pending for simplification actions in one call. Quarantined
 * actions (not found in the document) are NEVER touched — a confident-sounding
 * invention must never be auto-applied. Used by the "Accept all" button.
 */
export const bulkSetSimplificationDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      decision: z.enum(["accepted", "pending"]).default("accepted"),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .select("summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: any[] = Array.isArray(sj.actions) ? sj.actions : [];
    let changed = 0;
    const updated = actions.map((a) => {
      if (a?.verification?.status === "rejected") return a; // never accept a quarantined edit
      if (a?.decision === data.decision) return a;
      changed++;
      return { ...a, decision: data.decision };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, actions: updated } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save decisions: ${upErr.message}`);
    return { changed, total: updated.length };
  });

/**
 * UC4 — generates an amended copy of the source document with every accepted
 * simplification applied (highlighted) and a Word/Drive comment carrying the
 * original "Before:" text on each amended span. Two paths:
 *  - Drive source : copies the original in Drive (converting DOCX → Google Doc
 *                   if needed for anchored comments), then writeToGoogleDoc +
 *                   createDriveComment per accepted edit. Returns the Drive URL.
 *  - Local upload : runs applySimplificationToDocx on the original .docx (which
 *                   does paragraph-aware sub-text replacement + Word comments),
 *                   uploads the amended .docx to storage, returns a download URL.
 * Edits whose `before` cannot be located in the document structure are NOT
 * silently dropped — they are returned in `skipped`.
 */
export const applySimplificationReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports")
      .select("*")
      .eq("id", data.reportId)
      .single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allActions: any[] = Array.isArray(sj.actions) ? sj.actions : [];
    const accepted = allActions.filter((a) => a?.decision === "accepted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figureReviews: any[] = Array.isArray(sj.figure_reviews) ? sj.figure_reviews : [];
    if (accepted.length === 0 && figureReviews.length === 0)
      throw new Error("No accepted actions to apply.");

    const title = (report.policy_name as string) ?? "Document";
    const edits: SimplifyDocxEdit[] = accepted.map((a) => ({
      before: String(a.before ?? ""),
      after: String(a.after ?? ""),
      // The Word/Drive comment carries "Before:" + the rule + a one-line rationale,
      // so a reviewer reading the amended copy sees what was changed and why.
      rationale:
        a.rule || a.rationale
          ? `${a.rule ?? ""}${a.rule && a.rationale ? " — " : ""}${a.rationale ?? ""}`.trim() || undefined
          : undefined,
    }));

    const appliedAt = new Date().toISOString();

    // ── Drive source path ───────────────────────────────────────────────────
    if (sj.driveFileId) {
      const copy = await copyDriveFile("simplify", sj.driveFileId, `${title} — simplified`, {
        convertToGoogleDoc: true,
      });
      let applied = 0;
      const skipped: { reason: string; before: string }[] = [];
      for (const edit of edits) {
        try {
          // The replacement is highlighted AND followed by " (was: <before>)"
          // in strike-through italic grey — a reliable in-document track-
          // changes annotation, no Drive comment needed.
          const r = await writeToGoogleDoc({
            workspaceId: "simplify",
            fileId: copy.id,
            findText: edit.before,
            anchor: edit.before,
            newText: edit.after,
            mode: "replace",
            originalText: edit.before,
          });
          if ((r.occurrences ?? 0) > 0) applied++;
          else skipped.push({ reason: "text not found in Google Doc", before: edit.before });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          skipped.push({ reason: e?.message?.slice(0, 120) ?? "Drive write error", before: edit.before });
        }
      }
      const apply = {
        kind: "drive" as const,
        driveUrl: copy.url,
        driveFileId: copy.id,
        appliedCount: applied,
        totalAccepted: accepted.length,
        skipped,
        appliedAt,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("analysis_reports")
        .update({ summary_json: { ...sj, apply } })
        .eq("id", report.id);
      return apply;
    }

    // ── Local-upload path ───────────────────────────────────────────────────
    if (!report.source_file_url) throw new Error("Report has no source file URL");
    const file = await fetchFile(report.source_file_url);
    if (!looksLikeDocx(file.mimeType, report.source_file_url)) {
      throw new Error(
        "Local apply currently supports DOCX sources only. For PDFs, re-upload as DOCX.",
      );
    }
    // Figure reviews ride along as comment-only edits anchored on each figure's
    // drawing (DOCX path only — the Drive path has no comment plumbing).
    for (const f of figureReviews) {
      if (f?.anchorRelId && f?.comment) {
        edits.push({ before: "", after: "", commentOnly: true, anchorRelId: f.anchorRelId, comment: f.comment });
      }
    }
    const result = applySimplificationToDocx(file.buffer, edits, { author: "AI Document Workflow", mode: "redline" });

    // Upload the amended .docx to storage and surface a download URL.
    const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "amended";
    const path = `simplify/amended-${Date.now()}-${safeName}.docx`;
    const up = await supabase.storage.from("policies").upload(path, result.buffer, {
      upsert: false,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
    const downloadUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

    const apply = {
      kind: "local" as const,
      downloadUrl,
      downloadName: `${safeName}.docx`,
      appliedCount: result.appliedCount,
      totalAccepted: accepted.length,
      skipped: result.skipped,
      appliedAt,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, apply } })
      .eq("id", report.id);
    return apply;
  });

// ============================================================================
// SIMPLIFY V2 — three-mode workspace (simplify / recommend / recommend_edit).
// ----------------------------------------------------------------------------
// A separate workspace so the proven v1 simplify flow stays untouched as a
// backup. "simplify" mode reuses the same analysis engine; "recommend" runs the
// whole-document quality audit (recommend.ts); "recommend_edit" adds a gated
// second stage that regenerates the document from accepted findings while
// preserving the original DOCX package (logo/headers/styles).
// Reports: analysis_reports rows, workspace_id "simplify_v2",
// summary_json.kind "simplification_v2" + workflow_mode discriminator.
// The v1 decision serverFns (setSimplificationDecision / bulk) are reused for
// v2 simplify-mode actions — they operate purely on summary_json.actions.
// ============================================================================

const v2WorkflowModeSchema = z.enum(["simplify", "recommend", "recommend_edit"]);

/**
 * SCAN-FIRST INTAKE ("plan mode"): a cheap, fast look at a freshly uploaded
 * document BEFORE any deep analysis — structure stats plus a sampled read that
 * surfaces 3-5 concrete observations and recommends an intent. The upload
 * dialog shows this as a plan card and asks the user to choose the action
 * (find gaps / light simplify / max simplify / full redraft) instead of
 * dumping 70 proposed changes on them unprompted.
 */
export const scanDocumentV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ fileUrl: z.string().url() }))
  .handler(async ({ data }) => {
    const src = await readV2Source(data.fileUrl);
    const words = src.text.split(/\s+/).filter(Boolean).length;
    const stats = {
      words,
      estPages: Math.max(1, Math.round(words / 450)),
      sections: src.structure.sections.length,
      tables: src.structure.tableCount,
    };

    const sample = src.text.slice(0, 25_000);
    const prompt = `# ROLE: RAPID DOCUMENT TRIAGE for a bank operations/policy document.
Read the excerpt below (the document's opening ~${Math.min(25, stats.estPages)} pages of ${stats.estPages}) and produce a quick quality triage.

# OUTPUT — ONLY one JSON object:
{
  "observations": ["<3-5 short, concrete one-liners about THIS document — verbosity level, repetition, structure quality, clarity of ownership, anything a reviewer should know. Be specific, not generic.>"],
  "recommended": "recommend | simplify_light | simplify_max | redraft",
  "rationale": "<one sentence: why that action fits this document>"
}

# MEANING OF THE ACTIONS
- recommend: run a quality AUDIT first (gaps, contradictions, incomplete steps) — right when the document's correctness is the concern.
- simplify_light: propose plain-language edits — right when it's basically sound but wordy.
- simplify_max: aggressive shrink — right when it's heavily bloated/repetitive.
- redraft: automatic audit + restructure — right when it's structurally degraded beyond spot fixes.

# EXCERPT:
${sample}
`;
    let observations: string[] = [];
    let recommended = "recommend";
    let rationale = "";
    try {
      const response = await generateWithFallback({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", maxOutputTokens: 4096 },
      }, { tier: "fast" });
      const parsed = JSON.parse(String(response.text ?? "{}"));
      if (Array.isArray(parsed.observations)) observations = parsed.observations.map(String).slice(0, 5);
      if (["recommend", "simplify_light", "simplify_max", "redraft"].includes(parsed.recommended)) recommended = parsed.recommended;
      if (typeof parsed.rationale === "string") rationale = parsed.rationale;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.warn("[simplify_v2] scan failed:", e?.message?.slice(0, 120));
      observations = ["Quick scan unavailable — the document stats below are exact; pick the action that matches your goal."];
    }
    return { stats, observations, recommended, rationale };
  });

export const createSimplifyV2Report = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      customTitle: z.string().optional(),
      instruction: z.string().optional(),
      workflowMode: v2WorkflowModeSchema,
      simplifyMode: z.enum(["thorough", "quick"]).optional(),
      // "max" = aggressive page-reduction profile (simplify mode only).
      simplifyProfile: z.enum(["standard", "max"]).optional(),
      // Rudy's fully-automatic redraft: after the audit completes, the report
      // page auto-accepts verified findings and generates the restructured doc.
      redraftAuto: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    if (!data.fileUrl) throw new Error("No file URL provided");
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
        workspace_id: "simplify_v2",
        summary_json: {
          kind: "simplification_v2",
          workflow_mode: data.workflowMode,
          simplify_mode: data.simplifyMode ?? "thorough",
          simplify_profile: data.simplifyProfile ?? "standard",
          redraft_auto: data.redraftAuto === true,
          instruction: data.instruction?.trim() || null,
          executive: ["Queued — analysing the document…"],
          pending_analysis: true,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create report");
    return { reportId: report.id as string };
  });

/**
 * CREATE FROM BRIEF — drafts a brand-new document in the bank's house
 * structure, packaged inside a DONOR document's DOCX template (logo, headers,
 * styles). Lazy create-then-run: this inserts the pending row; the report page
 * auto-runs runSimplifyV2Report, which does the actual generation.
 */
export const createDocFromBriefReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      title: z.string().min(3).max(160),
      docType: z.string().min(2).max(60),
      brief: z.string().min(20).max(8000),
      donorReportId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { tenantId, features } = await getCallerTenant(context.userId);
    if (!features.includes("create_document")) {
      throw new Error("Document creation is not enabled for your organisation.");
    }
    // Donor must be the caller's tenant's document with a DOCX source.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: donor } = await (supabase as any)
      .from("analysis_reports")
      .select("id, title, source_file_url, tenant_id")
      .eq("id", data.donorReportId)
      .maybeSingle();
    if (!donor || (donor.tenant_id && donor.tenant_id !== tenantId)) throw new Error("Template document not found");
    if (!donor.source_file_url || !looksLikeDocx(null, donor.source_file_url)) {
      throw new Error("The template document must be a DOCX file.");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: data.title.trim(),
        policy_name: data.title.trim(),
        status: "pending_validation",
        source_file_url: donor.source_file_url, // the donor package
        workspace_id: "simplify_v2",
        summary_json: {
          kind: "simplification_v2",
          workflow_mode: "create",
          doc_brief: {
            title: data.title.trim(),
            docType: data.docType.trim(),
            brief: data.brief.trim(),
            donorReportId: donor.id,
            donorTitle: donor.title,
          },
          executive: ["Queued — drafting the document…"],
          pending_analysis: true,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create report");
    return { reportId: report.id as string };
  });

/** Shared v2 preamble: fetch the source file and derive text/units/structure. */
async function readV2Source(sourceFileUrl: string): Promise<{
  isDocx: boolean;
  text: string;
  units: { text: string; section: string }[];
  structure: DocStructure;
  buffer: Buffer;
}> {
  const file = await fetchFile(sourceFileUrl);
  const isDocx = looksLikeDocx(file.mimeType, sourceFileUrl);
  const html = isDocx ? await docxToHtml(file.buffer) : "";
  let text = "";
  if (isDocx) {
    try { text = docxToSimplifyText(file.buffer); } catch { text = ""; }
    if (!text) text = await docxToText(file.buffer).catch(() => "");
  }
  if (!text) {
    if (file.mimeType === "application/pdf" || /\.pdf($|\?)/i.test(sourceFileUrl)) {
      const { extractPdfPages } = await import("./pdf-pages");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text = (await extractPdfPages(file.buffer)).map((p: any) => p.text).join("\n\n");
    } else {
      text = file.buffer.toString("utf-8");
    }
  }
  if (!text.trim()) throw new Error("Could not read any text from the uploaded document");
  const units = isDocx
    ? docxToSimplifyUnits(file.buffer)
    : text.split(/\n+/).map((t) => ({ text: t.trim(), section: "" })).filter((u) => u.text);
  return { isDocx, text, units, structure: analyzeStructure(html || text), buffer: file.buffer };
}

/**
 * Runs the analysis stage for a v2 report, branching on workflow_mode:
 *  - simplify        → same engine as v1 (per-unit/chunk + de-dup + summary +
 *                      figure review), guidance key "simplify_v2".
 *  - recommend /
 *    recommend_edit  → whole-document quality audit (multi-pass, evidence-
 *                      verified findings), guidance key "simplify_v2_recommend".
 *                      Claims are stored for the later restructure stage.
 */
export const runSimplifyV2Report = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    simplifyMode: z.enum(["thorough", "quick"]).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    if (!report.source_file_url) throw new Error("Report has no source file");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevJson = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const workflowMode: string = prevJson.workflow_mode ?? "simplify";
    const instruction: string | null = prevJson.instruction ?? null;
    const title = (report.policy_name as string) ?? "Document";

    let status: "ok" | "failed" = "failed";
    let errorMsg: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: Record<string, any> = {};

    try {
      // ── CREATE-FROM-BRIEF: no source analysis — generate into the donor
      // package. Handled before readV2Source (the "source" is just the donor).
      if (workflowMode === "create") {
        const briefMeta = prevJson.doc_brief ?? {};
        const guidance = (await fetchAnalysisGuidance(supabase, "simplify_v2"))
          || (await fetchAnalysisGuidance(supabase, "simplify"))
          || DEFAULT_SIMPLIFY_GUIDANCE;
        const gen = await generateDocumentFromBrief(
          String(briefMeta.title ?? title),
          String(briefMeta.docType ?? "policy"),
          String(briefMeta.brief ?? ""),
          guidance,
        );
        const donorFile = await fetchFile(report.source_file_url);
        const buffer = rebuildDocxBody(donorFile.buffer, gen.sections, { author: "AI Document Workflow" });
        const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "draft";
        const path = `simplify-v2/created-${Date.now()}-${safeName}.docx`;
        const up = await supabase.storage.from("policies").upload(path, buffer, {
          upsert: false,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
        patch.created = {
          downloadUrl: supabase.storage.from("policies").getPublicUrl(path).data.publicUrl,
          downloadName: `${safeName}.docx`,
          outline: gen.sections.map((s) => ({ heading: s.heading, level: s.level })),
          generatedAt: new Date().toISOString(),
        };
        patch.cost = computeCost(gen.usage, await getDefaultModel());
        status = "ok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("analysis_reports").update({
          summary_json: {
            ...prevJson,
            ...patch,
            kind: "simplification_v2",
            workflow_mode: workflowMode,
            pending_analysis: false,
            simplification_status: status,
            simplification_error: null,
            last_run_at: new Date().toISOString(),
          },
        }).eq("id", report.id);
        return { reportId: report.id as string, status, error: null };
      }

      const src = await readV2Source(report.source_file_url);
      patch.structure = src.structure;

      if (workflowMode === "simplify") {
        const mode: "thorough" | "quick" = data.simplifyMode ?? prevJson.simplify_mode ?? "thorough";
        let guidance = (await fetchAnalysisGuidance(supabase, "simplify_v2"))
          || (await fetchAnalysisGuidance(supabase, "simplify"))
          || DEFAULT_SIMPLIFY_GUIDANCE;
        // "max" profile — the aggressive page-reduction addendum rides on top
        // of whatever guidance is configured.
        if (prevJson.simplify_profile === "max") guidance = `${guidance}\n${AGGRESSIVE_SIMPLIFY_ADDENDUM}`;
        const [main, dedup, docSum] = await Promise.all([
          mode === "thorough" && src.units.length
            ? simplifyDocumentByUnits({ title, units: src.units }, { instruction, guidance })
            : simplifyDocument({ title, text: src.text }, { instruction, guidance }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          detectDocumentDuplication({ title, text: src.text }, { guidance }).catch((e: any) => {
            console.warn("[simplify_v2] de-dup pass failed:", e?.message?.slice(0, 120));
            return { actions: [], usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 } };
          }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          summarizeDocument({ title, text: src.text }, { guidance }).catch((e: any) => {
            console.warn("[simplify_v2] summary pass failed:", e?.message?.slice(0, 120));
            return { summary: "", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 } };
          }),
        ]);
        const actions = [...main.actions, ...dedup.actions];
        let usage = addUsage(addUsage(main.usage, dedup.usage), docSum.usage);
        if (actions.length === 0) {
          throw new Error("No simplification actions were produced — the model was likely overloaded. Please re-run.");
        }
        const summary = verifyActions(actions, src.text);
        patch.simplify_mode = mode;
        patch.document_summary = docSum.summary || null;
        patch.cross_check = crossCheckSections(summary.actions, src.structure);
        patch.verification = { total: summary.total, verified: summary.verified, review: summary.review, rejected: summary.rejected };
        patch.actions = summary.actions.map((a) => ({ ...a, decision: initialDecision(a) }));
        // Figure review rides along exactly like v1 — comments on apply.
        if (src.isDocx) {
          try {
            const { figures, skipped } = extractDocxFigures(src.buffer);
            patch.figures_scanned = figures.length;
            patch.figures_skipped = skipped;
            if (figures.length > 0) {
              const fr = await analyzeDocFigures(title, figures, { guidance });
              patch.figure_reviews = fr.reviews;
              usage = addUsage(usage, fr.usage);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            console.warn("[simplify_v2] figure review failed:", e?.message?.slice(0, 120));
          }
        }
        patch.cost = computeCost(usage, await getDefaultModel());
      } else {
        // recommend / recommend_edit — the whole-document quality audit.
        const guidance = (await fetchAnalysisGuidance(supabase, "simplify_v2_recommend")) || DEFAULT_RECOMMEND_GUIDANCE;
        const [audit, docSum] = await Promise.all([
          runAuditPipeline(title, src.text, src.units, src.structure, guidance),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          summarizeDocument({ title, text: src.text }, { guidance }).catch((e: any) => {
            console.warn("[simplify_v2] summary pass failed:", e?.message?.slice(0, 120));
            return { summary: "", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 } };
          }),
        ]);
        patch.document_summary = docSum.summary || null;
        patch.findings = audit.findings;
        // Claims feed the restructure stage's content-preservation check.
        patch.claims = audit.claims;
        patch.audit = {
          status: "ok",
          claimCount: audit.claims.length,
          clusterCount: audit.clusterCount,
          counts: countFindings(audit.findings),
        };
        patch.cost = computeCost(addUsage(audit.usage, docSum.usage), await getDefaultModel());
      }
      status = "ok";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      errorMsg = e?.message?.slice(0, 250) ?? "unknown error";
      console.warn(`[simplify_v2] run failed for "${title}":`, errorMsg);
    }

    // Carry the reviewer's typed decision inputs ACROSS the re-run: findings
    // are fresh objects with new ids, so remap each saved input onto the new
    // finding flagging the same passage (normalised evidence quote). Without
    // this a re-run silently discards work the reviewer already did.
    const prevInputs = (prevJson.decisionInputs ?? {}) as Record<string, string>;
    const carried: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newFindings: any[] = Array.isArray((patch as any)?.findings) ? (patch as any).findings : [];
    if (Object.keys(prevInputs).length && newFindings.length) {
      const qNorm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const oldByQuote = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oldFindings: any[] = Array.isArray(prevJson.findings) ? prevJson.findings : [];
      for (const f of oldFindings) {
        const v = prevInputs[f?.id];
        const q = qNorm(f?.evidence?.[0]?.quote);
        if (v?.trim() && q) oldByQuote.set(q, v);
      }
      for (const f of newFindings) {
        const v = oldByQuote.get(qNorm(f?.evidence?.[0]?.quote));
        if (v) carried[f.id] = v;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("analysis_reports").update({
      summary_json: appendCostLog({
        ...prevJson,
        // A re-run INVALIDATES prior outputs: stale exports/restructures from
        // the previous action/finding set must not survive next to fresh
        // results (and a lingering restructure{} would block redraft_auto).
        apply: null,
        restructure: null,
        finalDoc: null,
        ...patch,
        decisionInputs: carried,
        kind: "simplification_v2",
        workflow_mode: workflowMode,
        pending_analysis: false,
        simplification_status: status,
        simplification_error: errorMsg,
        last_run_at: new Date().toISOString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, "Analysis run", (patch as any).cost),
    }).eq("id", report.id);

    return { reportId: report.id as string, status, error: errorMsg };
  });

/**
 * Persists the reviewer's typed decision-input values (findingId → value) on
 * the report, so they survive reloads and sessions — and re-runs, via the
 * quote-based carry-over in runSimplifyV2Report. Values are merged; an empty
 * string deletes the entry.
 */
export const saveDecisionInputs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    inputs: z.record(z.string(), z.string().max(600)),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("summary_json, tenant_id").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const merged: Record<string, string> = { ...(sj.decisionInputs ?? {}) };
    for (const [id, v] of Object.entries(data.inputs)) {
      if (v.trim()) merged[id] = v;
      else delete merged[id];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, decisionInputs: merged } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save inputs: ${upErr.message}`);
    return { saved: Object.keys(merged).length };
  });

/** Records a reviewer's Accept/Dismiss decision on one audit finding (by id). */
export const setV2FindingDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      findingId: z.string(),
      decision: z.enum(["accepted", "dismissed", "pending"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("summary_json, tenant_id").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const idx = findings.findIndex((f) => f?.id === data.findingId);
    if (idx < 0) throw new Error("Finding not found");
    if (findings[idx].verification?.status === "rejected" && data.decision === "accepted") {
      throw new Error("A quarantined finding cannot be accepted — its evidence was not found in the document.");
    }
    findings[idx] = { ...findings[idx], decision: data.decision };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, findings } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save decision: ${upErr.message}`);
    return { ok: true };
  });

/** Edits a finding's suggested fix (reviewer refinement before accepting).
 *  The edited text is what the restructure stage will implement. */
export const updateV2FindingFix = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      findingId: z.string(),
      suggestedFix: z.string().min(1).max(4000),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("summary_json, tenant_id").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const idx = findings.findIndex((f) => f?.id === data.findingId);
    if (idx < 0) throw new Error("Finding not found");
    findings[idx] = {
      ...findings[idx],
      suggestedFix: data.suggestedFix.trim(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( { fixEditedAt: new Date().toISOString() } as any ),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, findings } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save fix: ${upErr.message}`);
    return { ok: true };
  });

/** Edits a simplify-mode action's replacement text ("after"). The reviewer's
 *  wording is what export applies; marked edited for transparency. */
export const updateV2ActionAfter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      index: z.number().int().min(0),
      after: z.string().max(8000),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("summary_json, tenant_id").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: any[] = Array.isArray(sj.actions) ? sj.actions : [];
    if (data.index >= actions.length) throw new Error("Action index out of range");
    actions[data.index] = {
      ...actions[data.index],
      after: data.after,
      afterEditedAt: new Date().toISOString(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, actions } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save edit: ${upErr.message}`);
    return { ok: true };
  });

/** Reviewer-driven "Edit with AI": scans the whole source document for
 *  passages relevant to a free-text instruction and appends verified
 *  candidates as new actions/findings (mode-dependent), same trust
 *  boundary as the initial run — nothing reaches the reviewer ungrounded. */
export const requestTargetedEdit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      instruction: z.string().min(3).max(2000),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    if (!report.source_file_url) throw new Error("Report has no source file");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevJson = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const workflowMode: string = prevJson.workflow_mode ?? "simplify";
    const title = (report.policy_name as string) ?? "Document";

    const src = await readV2Source(report.source_file_url);
    const { candidates } = await proposeTargetedEdits(title, src.text, data.instruction);
    if (candidates.length === 0) {
      throw new Error("Nothing in the document matched that request — try rephrasing or pointing to a specific section.");
    }

    if (workflowMode === "simplify") {
      const newActions: SimplificationAction[] = candidates.map((c) => ({
        section: c.section,
        type: "plain_english",
        before: c.quote,
        after: c.suggestion,
        rule: "User-requested edit",
        rationale: c.rationale,
        confidence: c.confidence,
      }));
      const verified = verifyActions(newActions, src.text);
      const acceptedVerified = verified.actions.filter((a) => a.verification.status !== "rejected");
      if (acceptedVerified.length === 0) {
        throw new Error("The AI's suggestion couldn't be verified against the document — try rephrasing your request.");
      }
      const existingActions: VerifiedAction[] = Array.isArray(prevJson.actions) ? prevJson.actions : [];
      const added = acceptedVerified.map((a) => ({ ...a, decision: initialDecision(a) }));
      const merged = [...existingActions, ...added];
      // Adding an edit changes the action set, so any prior export/restructure is
      // now stale (its download wouldn't include this edit) — clear them, exactly
      // as a re-run does, so no mismatched artefact survives next to fresh results.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabase as any)
        .from("analysis_reports")
        .update({ summary_json: { ...prevJson, actions: merged, apply: null, restructure: null } })
        .eq("id", report.id);
      if (upErr) throw new Error(`Failed to save edit: ${upErr.message}`);
      return { addedIndexes: added.map((_, i) => existingActions.length + i) };
    } else {
      const newFindings: Finding[] = candidates.map((c, i) => ({
        id: `AI-${Date.now()}-${i}`,
        category: "user_requested" as FindingCategory,
        severity: "info" as FindingSeverity,
        title: c.rationale || "Requested edit",
        description: c.rationale,
        evidence: [{ section: c.section, quote: c.quote }],
        suggestedFix: c.suggestion,
        confidence: c.confidence,
        source: "llm" as const,
        verification: { status: "review" as const },
        decision: "pending" as const,
      }));
      const { findings: verified } = await verifyFindings(newFindings, src.text);
      const survivors = verified.filter((f) => f.verification.status !== "rejected");
      if (survivors.length === 0) {
        throw new Error("The AI's suggestion couldn't be verified against the document — try rephrasing your request.");
      }
      const existingFindings: Finding[] = Array.isArray(prevJson.findings) ? prevJson.findings : [];
      const merged = [...existingFindings, ...survivors];
      // Adding a finding changes the finding set, so a prior in-place export or
      // redraft is now stale (wouldn't include this finding) — clear them, exactly
      // as a re-run does, so no mismatched artefact survives next to fresh results.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabase as any)
        .from("analysis_reports")
        .update({ summary_json: { ...prevJson, findings: merged, apply: null, restructure: null } })
        .eq("id", report.id);
      if (upErr) throw new Error(`Failed to save edit: ${upErr.message}`);
      return { addedIds: survivors.map((f) => f.id) };
    }
  });

/** Bulk Accept/Dismiss/Pending over findings — optionally scoped to ids.
 *  Quarantined findings are never touched. */
export const bulkSetV2FindingDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      decision: z.enum(["accepted", "dismissed", "pending"]),
      findingIds: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports").select("summary_json, tenant_id").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const scope = data.findingIds ? new Set(data.findingIds) : null;
    let changed = 0;
    const updated = findings.map((f) => {
      if (scope && !scope.has(f.id)) return f;
      if (f.verification?.status === "rejected") return f;
      if (f.decision === data.decision) return f;
      changed++;
      return { ...f, decision: data.decision };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, findings: updated } })
      .eq("id", data.reportId);
    if (upErr) throw new Error(`Failed to save decisions: ${upErr.message}`);
    return { changed, total: updated.length };
  });

/**
 * V2 simplify-mode export. Applies accepted actions to the ORIGINAL docx:
 *  - "annotated" → Word tracked changes + a rationale comment per change, so a
 *    recipient opens it in Word and reviews native Accept/Reject revisions.
 *  - "clean"     → plain replacement, no markup — the final copy.
 * Both preserve the original package (logo, headers, styles) because the edit
 * engine mutates only matching paragraph runs in word/document.xml.
 */
export const applySimplifyV2Report = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    exportMode: z.enum(["clean", "annotated"]),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allActions: any[] = Array.isArray(sj.actions) ? sj.actions : [];
    const accepted = allActions.filter((a) => a?.decision === "accepted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figureReviews: any[] = Array.isArray(sj.figure_reviews) ? sj.figure_reviews : [];
    if (accepted.length === 0) throw new Error("No accepted actions to apply.");
    if (!report.source_file_url) throw new Error("Report has no source file URL");

    const file = await fetchFile(report.source_file_url);
    if (!looksLikeDocx(file.mimeType, report.source_file_url)) {
      throw new Error("Export currently supports DOCX sources only. For PDFs, re-upload as DOCX.");
    }

    const title = (report.policy_name as string) ?? "Document";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edits: SimplifyDocxEdit[] = accepted.map((a: any) => ({
      before: String(a.before ?? ""),
      after: String(a.after ?? ""),
      rationale:
        a.rule || a.rationale
          ? `${a.rule ?? ""}${a.rule && a.rationale ? " — " : ""}${a.rationale ?? ""}`.trim() || undefined
          : undefined,
    }));
    // Figure comments only make sense on the annotated copy.
    if (data.exportMode === "annotated") {
      for (const f of figureReviews) {
        if (f?.anchorRelId && f?.comment) {
          edits.push({ before: "", after: "", commentOnly: true, anchorRelId: f.anchorRelId, comment: f.comment });
        }
      }
    }

    const result = applySimplificationToDocx(file.buffer, edits, {
      author: "AI Document Workflow",
      mode: data.exportMode === "clean" ? "clean" : "redline",
      redlineComments: data.exportMode === "annotated",
    });

    const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "amended";
    const path = `simplify-v2/${data.exportMode}-${Date.now()}-${safeName}.docx`;
    const up = await supabase.storage.from("policies").upload(path, result.buffer, {
      upsert: false,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
    const downloadUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

    // Keep the OTHER export mode's copy only if it was built from the same
    // accepted set (reviewer may want both clean + tracked-changes). If the
    // accepted actions changed since, both prior URLs are dropped as stale.
    // `sig` fingerprints the accepted set by original action index.
    const sig = allActions.map((a, i) => (a?.decision === "accepted" ? i : -1)).filter((i) => i >= 0).join(",");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevApply = (sj.apply ?? {}) as Record<string, any>;
    const carry = prevApply.sig === sig ? prevApply : {};
    const isClean = data.exportMode === "clean";
    const apply = {
      ...carry,
      kind: "local" as const,
      sig,
      [isClean ? "cleanUrl" : "annotatedUrl"]: downloadUrl,
      [isClean ? "cleanName" : "annotatedName"]: `${safeName}-${data.exportMode}.docx`,
      appliedCount: result.appliedCount,
      totalAccepted: accepted.length,
      skipped: result.skipped,
      appliedAt: new Date().toISOString(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, apply } })
      .eq("id", report.id);
    return apply;
  });

/**
 * Recommend & Edit — RHB-style alternative to the full redraft. Applies each
 * accepted finding's evidence quote → suggestedFix as an in-place edit into
 * the ORIGINAL docx, via the exact same engine as Simplify mode — so the
 * original package (logo, headers, styles, tables) is preserved untouched.
 * Only findings with ONE evidence quote confined to a single paragraph
 * qualify for a clean swap: "incompleteness" findings describe content to
 * INSERT (no real "before" to replace), and contradiction/redundancy findings
 * carry evidence from two different locations. Those are skipped and reported
 * for manual review rather than guessed at — same for any quote the apply
 * engine can't anchor (e.g. one spanning a paragraph boundary).
 */
export const applyFindingsInPlaceV2Report = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    exportMode: z.enum(["clean", "annotated"]),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const allFindings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const accepted = allFindings.filter((f) => f.decision === "accepted" && f.verification.status !== "rejected");
    if (accepted.length === 0) throw new Error("No accepted findings to apply.");
    if (!report.source_file_url) throw new Error("Report has no source file URL");

    const file = await fetchFile(report.source_file_url);
    if (!looksLikeDocx(file.mimeType, report.source_file_url)) {
      throw new Error("Export currently supports DOCX sources only. For PDFs, re-upload as DOCX.");
    }

    const ineligible: { id: string; title: string; reason: string }[] = [];
    const eligible = accepted.filter((f) => {
      if (f.category === "incompleteness") {
        ineligible.push({ id: f.id, title: f.title, reason: "Inserts new content — no single passage to replace" });
        return false;
      }
      if (f.evidence.length !== 1) {
        ineligible.push({ id: f.id, title: f.title, reason: "Evidence spans multiple locations in the document" });
        return false;
      }
      // An empty fix would replace the quoted clause with nothing — a silent
      // deletion, never what a reviewer means by an in-place edit. Skip it.
      if (!f.suggestedFix?.trim()) {
        ineligible.push({ id: f.id, title: f.title, reason: "No replacement text on the finding — nothing to apply" });
        return false;
      }
      if (!f.evidence[0]?.quote?.trim()) {
        ineligible.push({ id: f.id, title: f.title, reason: "No quoted passage to locate in the document" });
        return false;
      }
      return true;
    });

    const title = (report.policy_name as string) ?? "Document";
    const edits: SimplifyDocxEdit[] = eligible.map((f) => ({
      before: f.evidence[0].quote,
      after: f.suggestedFix,
      rationale: f.title || f.description || undefined,
    }));

    const result = applySimplificationToDocx(file.buffer, edits, {
      author: "AI Document Workflow",
      mode: data.exportMode === "clean" ? "clean" : "redline",
      redlineComments: data.exportMode === "annotated",
    });

    const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "amended";
    const path = `simplify-v2/${data.exportMode}-${Date.now()}-${safeName}.docx`;
    const up = await supabase.storage.from("policies").upload(path, result.buffer, {
      upsert: false,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
    const downloadUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

    // Keep the OTHER export mode's copy only if it was built from the exact same
    // accepted set (so a reviewer can hold both clean + tracked-changes). If the
    // accepted findings changed since, its download would be stale/mismatched, so
    // both prior URLs are dropped. `sig` fingerprints the accepted set.
    const sig = accepted.map((f) => f.id).sort().join(",");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevApply = (sj.apply ?? {}) as Record<string, any>;
    const carry = prevApply.sig === sig ? prevApply : {};
    const isClean = data.exportMode === "clean";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apply: Record<string, any> = {
      ...carry,
      kind: "local" as const,
      sig,
      [isClean ? "cleanUrl" : "annotatedUrl"]: downloadUrl,
      [isClean ? "cleanName" : "annotatedName"]: `${safeName}-${data.exportMode}.docx`,
      appliedCount: result.appliedCount,
      totalAccepted: accepted.length,
      skipped: result.skipped,
      ineligible,
      appliedAt: new Date().toISOString(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...sj, apply } })
      .eq("id", report.id);
    return apply;
  });

/**
 * Executive summary for the dashboard — generated from the findings already on
 * the report (never re-reads the document, so it costs ~1–2 cents). Cached by
 * a hash of the finding set: repeat calls with unchanged findings return the
 * stored copy with zero AI spend. Spend is recorded in the cost ledger.
 */
export const generateExecSummaryV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    if (!findings.length) throw new Error("No findings to summarise yet.");

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1")
      .update(JSON.stringify(findings.map((f) => [f.id, f.title, f.severity])))
      .digest("hex").slice(0, 16);
    if (sj.execSummary?.hash === hash) return { ...sj.execSummary, cached: true };

    const title = (report.policy_name as string) ?? "Document";
    const { summary, groups, usage } = await generateFindingsExecSummary(title, findings);
    if (!summary) throw new Error("Summary generation returned nothing.");
    const execSummary = { hash, summary, groups, generatedAt: new Date().toISOString() };
    await supabase.from("analysis_reports")
      .update({
        summary_json: appendCostLog(
          { ...sj, execSummary },
          "Executive summary",
          computeCost(usage, await getDefaultModel()),
        ),
      })
      .eq("id", data.reportId);
    return { ...execSummary, cached: false };
  });

/**
 * THE FINAL DOCUMENT — the reliable path. One LLM call derives a verbatim
 * find→replace pair per accepted finding (reviewer decisions baked in), each
 * pair is verified to anchor in the source, then the deterministic redline
 * engine applies them to the ORIGINAL docx as Word tracked changes + rationale
 * comments. Fidelity is preserved by construction (cover, headers, sections,
 * TOC untouched); anything that can't be applied is reported, never faked.
 * Cached on the report keyed to (accepted ids + effective inputs).
 */
export const buildFinalDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    userInputs: z.record(z.string(), z.string().max(600)).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const allFindings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const accepted = allFindings.filter((f) => f.decision === "accepted" && f.verification.status !== "rejected");
    if (accepted.length === 0) throw new Error("No accepted findings to apply.");
    if (!report.source_file_url) throw new Error("Report has no source file URL");

    // Effective inputs, in priority order: what this session typed → the value
    // persisted on the report (survives reloads and re-runs) → the suggestion
    // the decision box displayed (never visually blank ⇒ shown value applies).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedInputs = (sj.decisionInputs ?? {}) as Record<string, string>;
    const inputs: Record<string, string> = {};
    for (const f of accepted) {
      const typed = data.userInputs?.[f.id]?.trim();
      const saved = savedInputs[f.id]?.trim();
      if (typed) inputs[f.id] = typed;
      else if (saved) inputs[f.id] = saved;
      else if (findingNeedsInput(f)) {
        const sugg = findingInputSuggestion(f)?.trim();
        if (sugg) inputs[f.id] = sugg;
      }
    }

    const { createHash } = await import("node:crypto");
    // "v4" engine salt: bumping it invalidates finals built by an older engine
    // (v4: exact short anchors — "CA 2010"-style glossary cells — now locate).
    const sig = createHash("sha1")
      .update(JSON.stringify({ v: "v4", ids: accepted.map((f) => f.id).sort(), inputs }))
      .digest("hex").slice(0, 16);
    if (sj.finalDoc?.url && sj.finalDoc.sig === sig) return sj.finalDoc;

    const file = await fetchFile(report.source_file_url);
    if (!looksLikeDocx(file.mimeType, report.source_file_url)) {
      throw new Error("The final document needs a DOCX source. For PDFs, re-upload as DOCX.");
    }
    const title = (report.policy_name as string) ?? "Document";
    let srcText = "";
    try { srcText = docxToSimplifyText(file.buffer); } catch { /* validated below */ }
    if (!srcText.trim()) throw new Error("Could not extract text from the source document.");

    const { edits, unresolved, usage: deriveUsage } = await deriveConcreteEdits(title, srcText, accepted, inputs);
    if (!edits.length) throw new Error("No applicable edits could be derived — see unresolved findings.");

    const simplifyEdits: SimplifyDocxEdit[] = edits.map((e) =>
      e.insert_row_after
        ? { before: "", after: "", insertRowAfter: e.insert_row_after, cells: e.cells ?? [], rationale: e.rationale }
        : e.insert_after
          ? { before: "", after: e.replace_text, insertAfter: e.insert_after, rationale: e.rationale }
          : { before: e.find_text, after: e.replace_text, rationale: e.rationale },
    );
    const result = applySimplificationToDocx(file.buffer, simplifyEdits, {
      author: "AI Document Workflow",
      mode: "redline",          // Word tracked changes: deletions struck through, insertions marked
      redlineComments: true,    // rationale as a margin comment per change
    });

    const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "final";
    const path = `simplify-v2/finaldoc-${Date.now()}-${safeName}.docx`;
    const up = await supabase.storage.from("policies").upload(path, result.buffer, {
      upsert: false,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
    const url = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;

    // Per-edit application report: which finding each edit served and whether
    // the engine landed it — so "18 accepted, how many are in?" is answerable
    // from the dashboard instead of by asking.
    const skippedAnchors = new Set((result.skipped ?? []).map((s) => s.before));
    const editReport = edits.map((e) => {
      const anchor = e.find_text || e.insert_after || e.insert_row_after || "";
      const kind = e.insert_row_after ? "table row" : e.insert_after ? "insertion" : "replacement";
      const skip = skippedAnchors.has(anchor) ? (result.skipped ?? []).find((s) => s.before === anchor) : null;
      return { findingId: e.findingId, kind, status: skip ? "skipped" : "applied", reason: skip?.reason };
    });
    const coveredIds = new Set(editReport.filter((r) => r.status === "applied").map((r) => r.findingId));

    const finalDoc = {
      url,
      sig,
      // Basis lets the CLIENT tell whether the cached build is still current
      // (button shows "opens instantly" vs "will re-derive") without a call.
      basis: { ids: accepted.map((f) => f.id).sort(), inputs },
      builtAt: new Date().toISOString(),
      derived: edits.length,
      appliedCount: result.appliedCount,
      coveredFindings: coveredIds.size,
      editReport,
      skipped: result.skipped,
      unresolved,
      totalAccepted: accepted.length,
    };
    await supabase.from("analysis_reports")
      .update({
        summary_json: appendCostLog(
          { ...sj, finalDoc },
          "Final document build",
          computeCost(deriveUsage, await getDefaultModel()),
        ),
      })
      .eq("id", report.id);
    return finalDoc;
  });

/**
 * Recommend & Edit stage 2 — regenerates the document from accepted findings.
 * Produces a CLEAN restructured docx (original package preserved: logo/headers/
 * styles; body rebuilt) plus an ANNOTATED companion whose section headings
 * carry Word comments listing the changes made there. Content preservation is
 * verified by bidirectional claim coverage with a capped repair loop; residual
 * losses are reported honestly, never hidden.
 */
export const generateRestructuredV2Document = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    // Reviewer-provided decisions (findingId → value) collected before generating,
    // so the redraft applies them directly instead of leaving [CONFIRM] markers.
    userInputs: z.record(z.string(), z.string().max(600)).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error: repErr } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (repErr || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    if (sj.workflow_mode !== "recommend_edit") {
      throw new Error("Restructure generation is only available in Recommend & Edit mode.");
    }
    const findings: Finding[] = Array.isArray(sj.findings) ? sj.findings : [];
    const accepted = findings.filter((f) => f?.decision === "accepted");
    if (accepted.length === 0) throw new Error("Accept at least one finding before generating.");
    if (!report.source_file_url) throw new Error("Report has no source file URL");

    const file = await fetchFile(report.source_file_url);
    if (!looksLikeDocx(file.mimeType, report.source_file_url)) {
      throw new Error("Restructure currently supports DOCX sources only. For PDFs, re-upload as DOCX.");
    }

    const title = (report.policy_name as string) ?? "Document";
    // Table-aware extraction so the redraft reproduces tables as real tables
    // instead of flattening them into loose paragraphs.
    const units = docxToStructuredUnits(file.buffer);
    const claims: ClaimUnit[] = Array.isArray(sj.claims) ? sj.claims : [];
    const simplifyGuidance = (await fetchAnalysisGuidance(supabase, "simplify_v2"))
      || (await fetchAnalysisGuidance(supabase, "simplify"))
      || DEFAULT_SIMPLIFY_GUIDANCE;

    const result = await generateRestructured(title, units, claims, accepted, simplifyGuidance, data.userInputs);

    // Per-section change notes → Word comments on the annotated copy.
    const sectionComments: Record<string, string> = {};
    for (const c of result.changeReport) {
      const line = `${c.findingId}: ${c.summary}${c.before ? `\nBefore: ${c.before}` : ""}`;
      sectionComments[c.section] = sectionComments[c.section]
        ? `${sectionComments[c.section]}\n\n${line}` : line;
    }

    // Rebuild carrying the source's own body formatting and pagination, so the
    // output reads like the original document rather than bare text.
    const rebuildOpts = {
      author: "AI Document Workflow",
      bodyPPr: dominantBodyProps(units),
      pageBreakBeforeSections: true,
    };
    const cleanBuffer = rebuildDocxBody(file.buffer, result.sections, rebuildOpts);
    const annotatedBuffer = rebuildDocxBody(file.buffer, result.sections, {
      ...rebuildOpts,
      sectionComments,
    });

    // Figure accounting — the preservation score only ever measured TEXT
    // claims, so a redraft could drop every diagram and still report 100%.
    // Count the drawings the body actually references, before and after.
    const countFigures = (buf: Buffer): number => {
      try {
        const xml = new PizZip(buf).file("word/document.xml")?.asText() ?? "";
        return (xml.match(/r:embed/g) ?? []).length;
      } catch { return 0; }
    };
    const figuresInSource = countFigures(file.buffer);
    const figuresCarried = countFigures(cleanBuffer);

    const safeName = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "restructured";
    const stamp = Date.now();
    const uploads: { key: "downloadUrl" | "annotatedUrl"; path: string; buffer: Buffer }[] = [
      { key: "downloadUrl", path: `simplify-v2/restructured-${stamp}-${safeName}.docx`, buffer: cleanBuffer },
      { key: "annotatedUrl", path: `simplify-v2/restructured-${stamp}-${safeName}-annotated.docx`, buffer: annotatedBuffer },
    ];
    const urls: Record<string, string> = {};
    for (const u of uploads) {
      const up = await supabase.storage.from("policies").upload(u.path, u.buffer, {
        upsert: false,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);
      urls[u.key] = supabase.storage.from("policies").getPublicUrl(u.path).data.publicUrl;
    }

    // Collect the [CONFIRM: …] placeholders the redraft inserted for values a
    // human must decide (an owner role, an acronym's full name…), so the UI can
    // offer to fill each one and write it back into the document. Unique by token.
    const phMap = new Map<string, { token: string; suggested: string; context: string; section: string }>();
    const scan = (text: string, section: string) => {
      for (const m of String(text ?? "").matchAll(/\[CONFIRM:\s*([^\]]+?)\s*\]/g)) {
        const token = m[0];
        if (phMap.has(token)) continue;
        const at = String(text).indexOf(token);
        const context = String(text).slice(Math.max(0, at - 70), at + token.length + 70).replace(/\s+/g, " ").trim();
        phMap.set(token, { token, suggested: m[1].trim(), context, section });
      }
    };
    for (const s of result.sections) {
      for (const b of s.blocks) {
        if (b.type === "para" && b.text) scan(b.text, s.heading);
        else if (b.type === "bullets" && b.items) b.items.forEach((it) => scan(it, s.heading));
        else if (b.type === "table" && b.rows) b.rows.forEach((row) => row.forEach((c) => scan(c, s.heading)));
      }
    }
    const placeholders = [...phMap.values()];

    const restructure = {
      downloadUrl: urls.downloadUrl,
      annotatedUrl: urls.annotatedUrl,
      downloadName: `${safeName}-restructured.docx`,
      generatedAt: new Date().toISOString(),
      changeReport: result.changeReport,
      preservation: { ...result.preservation, figuresInSource, figuresCarried },
      placeholders,
      cost: computeCost(result.usage, await getDefaultModel()),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: appendCostLog({ ...sj, restructure }, "Redraft generation", restructure.cost) })
      .eq("id", report.id);
    return restructure;
  });

/**
 * Fills the redraft's [CONFIRM: …] placeholders with values the reviewer entered
 * (e.g. OM → "Operations Manual"), writing them back into the restructured
 * document(s). Each token is a literal string inside a single text run, so a
 * plain XML-escaped find/replace is exact. Re-uploads the patched files, updates
 * the download URLs, and records which placeholders are now resolved.
 */
export const resolveRedraftPlaceholders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    values: z.record(z.string(), z.string().max(600)),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const restructure = sj.restructure;
    if (!restructure?.downloadUrl) throw new Error("No redraft to update");

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    // Only apply non-empty values.
    const pairs = Object.entries(data.values).filter(([, v]) => v.trim().length > 0);
    if (pairs.length === 0) throw new Error("Enter at least one value.");

    const patch = async (fileUrl: string): Promise<string> => {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Could not fetch redraft (${res.status})`);
      const zip = new PizZip(Buffer.from(await res.arrayBuffer()));
      const docFile = zip.file("word/document.xml");
      if (!docFile) throw new Error("Invalid redraft DOCX");
      let xml = docFile.asText();
      for (const [token, value] of pairs) {
        // Replace the escaped form (as stored in the doc) and, defensively, the raw.
        xml = xml.split(esc(token)).join(esc(value)).split(token).join(esc(value));
      }
      zip.file("word/document.xml", xml);
      const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
      const path = `simplify-v2/restructured-${Date.now()}-filled.docx`;
      const up = await supabase.storage.from("policies").upload(path, out, {
        upsert: false, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
      return supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
    };

    const downloadUrl = await patch(restructure.downloadUrl);
    const annotatedUrl = restructure.annotatedUrl ? await patch(restructure.annotatedUrl) : restructure.annotatedUrl;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const placeholders = (restructure.placeholders ?? []).map((p: any) => {
      const v = data.values[p.token];
      return v && v.trim() ? { ...p, value: v.trim(), resolved: true } : p;
    });
    const newRestructure = { ...restructure, downloadUrl, annotatedUrl, placeholders };
    await supabase.from("analysis_reports")
      .update({ summary_json: { ...sj, restructure: newRestructure } })
      .eq("id", data.reportId);
    return newRestructure;
  });

/**
 * Returns a PDF rendering of the redraft for the EXACT (pdf.js) viewer,
 * converting the docx once with CloudConvert and caching the result on the
 * report (keyed to the current downloadUrl, so a regenerate re-converts).
 */
export const getRedraftPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const rs = sj.restructure;
    if (!rs?.downloadUrl) throw new Error("No redraft to convert yet.");
    // Cached and still current (same source docx)?
    if (rs.pdfUrl && rs.pdfFromUrl === rs.downloadUrl) return { pdfUrl: rs.pdfUrl as string };

    const { convertDocxToPdf } = await import("./pdf-convert");
    const pdf = await convertDocxToPdf(rs.downloadUrl);
    const path = `simplify-v2/redraft-${Date.now()}.pdf`;
    const up = await supabase.storage.from("policies").upload(path, pdf, { upsert: false, contentType: "application/pdf" });
    if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
    const pdfUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
    await supabase.from("analysis_reports")
      .update({ summary_json: { ...sj, restructure: { ...rs, pdfUrl, pdfFromUrl: rs.downloadUrl } } })
      .eq("id", data.reportId);
    return { pdfUrl };
  });

/**
 * Exact PDF of the ORIGINAL source document (as Word draws it — EMF logos,
 * tables, fonts). Powers the "Exact" view during review, available immediately
 * (no redraft needed). Cached on the report keyed to source_file_url.
 */
export const getSourcePdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceUrl = (report as any).source_file_url as string | null;
    if (!sourceUrl) throw new Error("No source document to convert.");
    // Cached and still current (same source docx)?
    if (sj.sourcePdfUrl && sj.sourcePdfFromUrl === sourceUrl) return { pdfUrl: sj.sourcePdfUrl as string };

    const { convertDocxToPdf } = await import("./pdf-convert");
    const pdf = await convertDocxToPdf(sourceUrl);
    const path = `simplify-v2/source-${Date.now()}.pdf`;
    const up = await supabase.storage.from("policies").upload(path, pdf, { upsert: false, contentType: "application/pdf" });
    if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
    const pdfUrl = supabase.storage.from("policies").getPublicUrl(path).data.publicUrl;
    await supabase.from("analysis_reports")
      .update({ summary_json: { ...sj, sourcePdfUrl: pdfUrl, sourcePdfFromUrl: sourceUrl } })
      .eq("id", data.reportId);
    return { pdfUrl };
  });

/** Storage path (inside the `policies` bucket) from a Supabase public URL. */
function policiesPathFromUrl(url: string): string | null {
  const m = url.match(/\/object\/public\/policies\/(.+)$/);
  return m ? decodeURIComponent(m[1].split("?")[0]) : null;
}

/**
 * Build the OnlyOffice editor config for the exact in-app editor. Resolves the
 * target docx (redraft or source), pins the save-back path in a signed token,
 * and returns { apiUrl, config } for the client to mount. Editing/saving needs
 * the OnlyOffice server (ONLYOFFICE_URL) reachable over HTTPS.
 */
export const getEditorConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    reportId: z.string(),
    target: z.enum(["redraft", "source", "final"]).default("redraft"),
    origin: z.string().url(),
  }))
  .handler(async ({ data, context }) => {
    const apiUrl = process.env.ONLYOFFICE_URL;
    if (!apiUrl) throw new Error("Exact editor isn't configured yet (ONLYOFFICE_URL not set).");
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title = ((report as any).title as string) ?? "Document";

    let docUrl = data.target === "redraft"
      ? (sj.restructure?.downloadUrl as string | undefined)
      : data.target === "final"
        ? (sj.finalDoc?.url as string | undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : ((report as any).source_file_url as string | undefined);
    if (!docUrl) {
      throw new Error(
        data.target === "redraft" ? "No redraft to edit yet."
        : data.target === "final" ? "No final document built yet."
        : "No source document to edit.",
      );
    }

    const { createHash } = await import("node:crypto");

    // For the REDRAFT (the final output), serve a WORKING COPY with the change
    // report baked in: edited/added paragraphs get margin comments (+highlight),
    // removals appear as red strikethrough paragraphs under their section. The
    // reviewer's edits save to this working copy; regeneration re-annotates.
    if (data.target === "redraft") {
      const rs = sj.restructure ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const changes: any[] = Array.isArray(rs.changeReport) ? rs.changeReport : [];
      const cHash = createHash("sha1").update(JSON.stringify(changes) + String(rs.downloadUrl)).digest("hex").slice(0, 16);
      if (rs.editorDocUrl && rs.editorDocHash === cHash) {
        docUrl = rs.editorDocUrl as string; // reuse (carries prior edits)
      } else if (changes.length) {
        try {
          const res = await fetch(docUrl);
          const srcBuf = Buffer.from(await res.arrayBuffer());
          const { annotateRedraftDocx } = await import("./docx-comments");
          const { buffer, annotated } = annotateRedraftDocx(srcBuf, changes);
          if (annotated > 0) {
            const cpath = `simplify-v2/final-${data.reportId}-${Date.now()}.docx`;
            const up = await supabase.storage.from("policies").upload(cpath, buffer, {
              upsert: false,
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            if (!up.error) {
              docUrl = supabase.storage.from("policies").getPublicUrl(cpath).data.publicUrl;
              await supabase.from("analysis_reports")
                .update({ summary_json: { ...sj, restructure: { ...rs, editorDocUrl: docUrl, editorDocHash: cHash } } })
                .eq("id", data.reportId);
            }
          }
        } catch { /* fall back to the clean redraft */ }
      }
    }

    // For the SOURCE, serve a copy with the AI findings baked in as native Word
    // comments + highlights. Generated once (cached, keyed to the findings), then
    // reused so the reviewer's edits + comments persist across opens.
    if (data.target === "source") {
      const { buildFindingComments } = await import("./docx-comments");
      const comments = buildFindingComments(sj.findings);
      const cHash = createHash("sha1").update(JSON.stringify(comments)).digest("hex").slice(0, 16);
      if (sj.commentedSourceUrl && sj.commentedHash === cHash) {
        docUrl = sj.commentedSourceUrl as string;   // reuse (has comments + prior edits)
      } else if (comments.length) {
        try {
          const res = await fetch(docUrl);
          const srcBuf = Buffer.from(await res.arrayBuffer());
          const { injectCommentsIntoDocx } = await import("./docx-comments");
          const { buffer, injected } = injectCommentsIntoDocx(srcBuf, comments);
          if (injected > 0) {
            const cpath = `simplify-v2/commented-${data.reportId}-${Date.now()}.docx`;
            const up = await supabase.storage.from("policies").upload(cpath, buffer, {
              upsert: false,
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            if (!up.error) {
              docUrl = supabase.storage.from("policies").getPublicUrl(cpath).data.publicUrl;
              await supabase.from("analysis_reports")
                .update({ summary_json: { ...sj, commentedSourceUrl: docUrl, commentedHash: cHash } })
                .eq("id", data.reportId);
            }
          }
        } catch { /* fall back to the raw source */ }
      }
    }

    const path = policiesPathFromUrl(docUrl);
    if (!path) throw new Error("Editable copy must live in the policies bucket.");

    const { buildEditorConfig, signJwt } = await import("./onlyoffice");
    // Fresh key + cache-busted URL on EVERY open. OnlyOffice identifies a doc by
    // its `key` and caches it; a stable key made it serve a locked, read-only
    // copy of the just-closed session on reopen (and could serve stale content).
    // A per-open key forces a clean editing session that re-fetches the LATEST
    // saved docx. The `?v=` also busts any CDN cache on the Supabase URL.
    const freshUrl = `${docUrl}${docUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
    const key = createHash("sha1").update(freshUrl).digest("hex").slice(0, 20);
    // Path-pinned token: the callback will only save to exactly this object.
    const pathToken = signJwt({ path, reportId: data.reportId, target: data.target });
    const callbackUrl = `${data.origin}/api/onlyoffice-callback?t=${encodeURIComponent(pathToken)}`;

    const { config } = buildEditorConfig({
      key,
      title: `${title}.docx`,
      docUrl: freshUrl,
      callbackUrl,
      user: { id: context.userId, name: "Reviewer" },
      mode: "edit",
    });
    // config is a plain JSON object (with a signed `token`); typed loosely so
    // the RPC serializer doesn't choke on its `unknown`-valued fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { apiUrl, config: config as any, key, docUrl };
  });

/**
 * Fire-and-forget force-save — triggered whenever the editor unmounts (any exit
 * path: nav click, view switch, etc.), so an immediate save always happens even
 * when the reviewer doesn't use the explicit "Back to dashboard" button.
 */
export const forceSaveEditor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), key: z.string() }))
  .handler(async ({ data, context }) => {
    const { data: report } = await context.supabase
      .from("analysis_reports").select("tenant_id").eq("id", data.reportId).single();
    if (!report) return { ok: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    const { forceSave } = await import("./onlyoffice");
    const r = await forceSave(data.key);
    return { ok: r.ok };
  });

/**
 * Called when the reviewer leaves the exact editor. Force-saves the open
 * document and WAITS until the save-back callback has actually written it to
 * storage (the callback bumps `editSavedAt`). This removes the "one version
 * behind" race where reopening fetched the doc before OnlyOffice's lazy save.
 */
export const finalizeEdit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string(), key: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: report, error } = await supabase
      .from("analysis_reports").select("*").eq("id", data.reportId).single();
    if (error || !report) throw new Error("Report not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertRowTenant((report as any).tenant_id, (await getCallerTenant(context.userId)).tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sj = ((report.summary_json as any) ?? {}) as Record<string, any>;
    const before = (sj.editSavedAt as number) ?? 0;

    const { forceSave } = await import("./onlyoffice");
    const r = await forceSave(data.key);
    if (r.code === 4) return { saved: true };   // nothing changed — already current
    if (!r.ok) return { saved: false };

    // Poll for the callback to land the file (bumps editSavedAt), up to ~12s.
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const { data: r2 } = await supabase
        .from("analysis_reports").select("summary_json").eq("id", data.reportId).single();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const now = ((r2?.summary_json as any)?.editSavedAt as number) ?? 0;
      if (now > before) return { saved: true };
    }
    return { saved: false };
  });

// ── Demo seeding — clone generic demo content into a tenant (super-admin) ────

/** Lists a source tenant's clonable content (titles only) for the seed dialog. */
export const listSeedableContent = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ sourceTenant: z.string().min(1).max(40).default("rhb") }))
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [reportsRes, sopsRes] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabaseAdmin as any)
        .from("analysis_reports")
        .select("id, title, workspace_id, workflow_type, created_at")
        .eq("tenant_id", data.sourceTenant)
        .order("created_at", { ascending: false })
        .limit(200),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabaseAdmin as any)
        .from("sop_documents")
        .select("id, title, workspace_id, doc_type, created_at")
        .eq("tenant_id", data.sourceTenant)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    return {
      reports: reportsRes.data ?? [],
      sops: sopsRes.data ?? [],
    };
  });

/**
 * Clones the selected reports and KB documents (WITH their embedding chunks)
 * into the target tenant, entirely inside Postgres via clone_demo_to_tenant.
 * Storage files are shared by URL — nothing is re-uploaded or re-embedded.
 */
export const seedTenantDemo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      targetTenant: z.string().min(1).max(40),
      reportIds: z.array(z.string().uuid()).max(200).default([]),
      sopIds: z.array(z.string().uuid()).max(200).default([]),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);
    if (data.reportIds.length === 0 && data.sopIds.length === 0) {
      throw new Error("Select at least one document or report to clone.");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result, error } = await (supabaseAdmin as any).rpc("clone_demo_to_tenant", {
      p_report_ids: data.reportIds,
      p_sop_ids: data.sopIds,
      p_target: data.targetTenant,
    });
    if (error) throw new Error(`Clone failed: ${error.message}`);
    return result as { reports: number; sops: number; chunks: number; target: string };
  });

// ── AI model settings — the admin-picked default model (Settings → AI Model).
// The picked model always leads the quality chain; fallbacks apply on failure.

export const getModelSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from("app_settings").select("value").eq("key", "default_model").maybeSingle();
    const m = data?.value?.model;
    return {
      model: typeof m === "string" && (AVAILABLE_MODELS as readonly string[]).includes(m)
        ? m
        : AVAILABLE_MODELS[1], // gemini-3.5-flash — the built-in default
      available: [...AVAILABLE_MODELS],
    };
  });

export const setModelSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ model: z.enum(AVAILABLE_MODELS) }))
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any).from("app_settings").upsert({
      key: "default_model",
      value: { model: data.model },
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Failed to save model setting: ${error.message}`);
    clearDefaultModelCache();
    return { ok: true };
  });

// ── Workspace visibility (master toggle) ─────────────────────────────────────
// A super-admin can flip workspaces on/off here without touching deploy. The
// workspace switcher reads this and hides any workspace marked invisible. If
// the `workspace_settings` table has no row for a workspace, it is treated as
// VISIBLE — so the feature degrades safely when the migration hasn't been run.

/** Returns the per-workspace visibility map. Missing rows default to true. */
export const getWorkspaceVisibility = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
  async ({ context }) => {
    const supabase = context.supabase;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("workspace_settings")
        .select("workspace_id, visible");
      if (error) {
        // Most likely the table hasn't been created yet — treat all as visible.
        return { visibility: {} as Record<string, boolean> };
      }
      const visibility: Record<string, boolean> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of (data ?? []) as any[]) {
        visibility[row.workspace_id as string] = !!row.visible;
      }
      return { visibility };
    } catch {
      return { visibility: {} as Record<string, boolean> };
    }
  },
);

/** Sets a workspace's visibility (super-admin action). */
export const setWorkspaceVisibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      workspace: workspaceSchema,
      visible: z.boolean(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("workspace_settings")
      .upsert({
        workspace_id: data.workspace,
        visible: data.visible,
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(`Failed to save workspace visibility: ${error.message}`);
    return { ok: true };
  });

// ============================================================================
// ADMIN / TEAM MANAGEMENT (super-admin only)
// ----------------------------------------------------------------------------
// Manage WHO may use the app and at what level, and surface last-sign-in. These
// run as service-role (supabaseAdmin) because they read auth.users and change
// roles (which the guard trigger would otherwise pin for a normal caller).
// Because service-role bypasses RLS, every handler FIRST verifies the CALLER is
// a super_admin — never trust the client.
// ============================================================================

export type AccessLevel = "none" | "viewer" | "member" | "super_admin";

export interface AppUserRow {
  id: string | null;          // null = invited email that has never signed in
  email: string;
  role: "super_admin" | "member" | "viewer";
  level: AccessLevel;         // collapsed "access level" for the single picker UI
  approved: boolean;          // passes is_approved() (role>=member OR allowlisted)
  signedIn: boolean;
  lastSignInAt: string | null;
  createdAt: string | null;
  tenantId: string;           // branding tenant (see public.tenants); "default" if unset
}

/** Throws unless the calling auth user is a super_admin. */
async function assertCallerSuperAdmin(userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Authorization check failed: ${error.message}`);
  if (!data || data.role !== "super_admin") {
    throw new Error("Forbidden: this action is restricted to the super admin.");
  }
}

function levelFromRole(role: string, approved: boolean): AccessLevel {
  if (role === "super_admin") return "super_admin";
  if (role === "member") return "member";
  return approved ? "viewer" : "none";
}

/** Lists every account that has signed in (with last-sign-in) plus pending invites. */
export const listAppUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ users: AppUserRow[] }> => {
    await assertCallerSuperAdmin(context.userId);

    // 1. Everyone who has ever signed in — auth.users is service-role only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authRes = await (supabaseAdmin as any).auth.admin.listUsers({ perPage: 1000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authUsers: any[] = authRes?.data?.users ?? [];

    // 2. Roles + tenant, keyed by user id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profs } = await (supabaseAdmin as any)
      .from("profiles")
      .select("id, email, role, tenant_id");
    const roleById = new Map<string, string>();
    const emailById = new Map<string, string>();
    const tenantById = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (profs ?? []) as any[]) {
      roleById.set(p.id, p.role);
      tenantById.set(p.id, p.tenant_id ?? "default");
      if (p.email) emailById.set(p.id, String(p.email).toLowerCase());
    }

    // 3. Allowlist (table may not exist until the lockdown migration — tolerate).
    // Maps email -> tenant_id so invited-but-never-signed-in rows can show it too.
    const allow = new Map<string, string>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: al } = await (supabaseAdmin as any)
        .from("login_allowlist")
        .select("email, tenant_id");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (al ?? []) as any[]) {
        if (r.email) allow.set(String(r.email).toLowerCase(), r.tenant_id ?? "default");
      }
    } catch {
      /* allowlist not present yet */
    }

    const rows: AppUserRow[] = [];
    const seen = new Set<string>();

    for (const u of authUsers) {
      const emailLc = String(u.email ?? emailById.get(u.id) ?? "").toLowerCase();
      const role = (roleById.get(u.id) ?? "viewer") as AppUserRow["role"];
      const approved = role === "super_admin" || role === "member" || allow.has(emailLc);
      rows.push({
        id: u.id,
        email: u.email ?? emailLc,
        role,
        level: levelFromRole(role, approved),
        approved,
        signedIn: true,
        lastSignInAt: u.last_sign_in_at ?? null,
        createdAt: u.created_at ?? null,
        tenantId: tenantById.get(u.id) ?? "default",
      });
      if (emailLc) seen.add(emailLc);
    }

    // 4. Invited-but-never-signed-in emails.
    for (const [emailLc, tenantId] of allow) {
      if (seen.has(emailLc)) continue;
      rows.push({
        id: null,
        email: emailLc,
        role: "viewer",
        level: "viewer",
        approved: true,
        signedIn: false,
        lastSignInAt: null,
        createdAt: null,
        tenantId,
      });
    }

    // Most-recent sign-in first; never-signed-in (invites) sink to the bottom.
    rows.sort((a, b) => {
      if (a.lastSignInAt && b.lastSignInAt) return a.lastSignInAt < b.lastSignInAt ? 1 : -1;
      if (a.lastSignInAt) return -1;
      if (b.lastSignInAt) return 1;
      return a.email.localeCompare(b.email);
    });

    return { users: rows };
  });

/**
 * Sets a user's access level. Collapses the two underlying concepts (allowlist
 * membership + role) into one intuitive picker:
 *   none        -> de-list + role viewer  => is_approved() false => fully blocked
 *   viewer      -> allowlist + role viewer => read-only
 *   member      -> allowlist + role member => read + write
 *   super_admin -> allowlist + role super_admin
 * Works for invites too: pass an email with no userId to allowlist someone who
 * hasn't signed in yet (they become a viewer on first login).
 */
export const setUserAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      userId: z.string().uuid().optional(),
      email: z.string().email(),
      level: z.enum(["none", "viewer", "member", "super_admin"]),
      tenantId: z.string().optional(), // branding tenant; omitted = leave unchanged
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);

    const email = data.email.toLowerCase();

    // Self-lockout guard: a super-admin cannot downgrade their own access.
    if (data.userId && data.userId === context.userId && data.level !== "super_admin") {
      throw new Error("You can't change your own access level.");
    }

    // Allowlist membership: 'none' removes the email; any other level grants it.
    if (data.level === "none") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).from("login_allowlist").delete().eq("email", email);
    } else {
      const allowlistRow: Record<string, string> = { email };
      if (data.tenantId) allowlistRow.tenant_id = data.tenantId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from("login_allowlist")
        .upsert(allowlistRow, { onConflict: "email" });
    }

    // Role/tenant: only updatable once the user exists (has signed in => has a profile).
    if (data.userId) {
      const role = data.level === "none" ? "viewer" : data.level;
      const profileUpdate: Record<string, string> = { role };
      if (data.tenantId) profileUpdate.tenant_id = data.tenantId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabaseAdmin as any)
        .from("profiles")
        .update(profileUpdate)
        .eq("id", data.userId);
      if (error) throw new Error(`Failed to update role: ${error.message}`);
    }

    return { ok: true };
  });

// ============================================================================
// TENANTS — branding config for re-skinning the app per external prospect
// (e.g. RHB). Deliberately NOT a data/RLS boundary: every tenant's users see
// every workspace, exactly as today (see 20260716_tenant_branding.sql). Only
// affects name/tagline/logo/colors.
// ============================================================================

export interface TenantRow {
  slug: string;
  name: string;
  tagline: string | null;
  logoUrl: string | null;
  colorPrimary: string | null;
  colorSidebar: string | null;
  colorSidebarPrimary: string | null;
  colorSidebarAccent: string | null;
  /** Enabled feature keys (workspace ids + legal_cms/rudy/create_document). */
  features: string[];
}

// select("*") so reads tolerate schema drift (features arrived in a later
// migration than the branding columns).
const TENANT_COLUMNS = "*";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTenantRow(r: any): TenantRow {
  return {
    slug: r.slug,
    name: r.name,
    tagline: r.tagline ?? null,
    logoUrl: r.logo_url ?? null,
    colorPrimary: r.color_primary ?? null,
    colorSidebar: r.color_sidebar ?? null,
    colorSidebarPrimary: r.color_sidebar_primary ?? null,
    colorSidebarAccent: r.color_sidebar_accent ?? null,
    features: Array.isArray(r.features) ? r.features : [...ALL_TENANT_FEATURES],
  };
}

/** Lists every tenant (super-admin only — the admin UI). */
export const listTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ tenants: TenantRow[] }> => {
    await assertCallerSuperAdmin(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("tenants")
      .select(TENANT_COLUMNS)
      .order("slug");
    if (error) throw new Error(`Failed to list tenants: ${error.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { tenants: ((data ?? []) as any[]).map(toTenantRow) };
  });

const tenantInputSchema = z.object({
  slug: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, "lowercase letters, numbers, - or _ only"),
  name: z.string().min(1).max(120),
  tagline: z.string().max(160).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  colorPrimary: z.string().max(80).optional().or(z.literal("")),
  colorSidebar: z.string().max(80).optional().or(z.literal("")),
  colorSidebarPrimary: z.string().max(80).optional().or(z.literal("")),
  colorSidebarAccent: z.string().max(80).optional().or(z.literal("")),
  // Per-tenant capability toggles. Optional so branding-only saves (and
  // pre-migration clients) don't clobber a tenant's feature set.
  features: z.array(z.enum(ALL_TENANT_FEATURES)).optional(),
});

function tenantUpsertPayload(data: z.infer<typeof tenantInputSchema>) {
  return {
    slug: data.slug,
    name: data.name,
    tagline: data.tagline || null,
    logo_url: data.logoUrl || null,
    color_primary: data.colorPrimary || null,
    color_sidebar: data.colorSidebar || null,
    color_sidebar_primary: data.colorSidebarPrimary || null,
    color_sidebar_accent: data.colorSidebarAccent || null,
    ...(data.features ? { features: data.features } : {}),
  };
}

/** Creates a new tenant (super-admin only). */
export const createTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(tenantInputSchema)
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from("tenants")
      .insert(tenantUpsertPayload(data));
    if (error) throw new Error(`Failed to create tenant: ${error.message}`);
    return { ok: true };
  });

/** Updates an existing tenant's branding (super-admin only). */
export const updateTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(tenantInputSchema)
  .handler(async ({ data, context }) => {
    await assertCallerSuperAdmin(context.userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from("tenants")
      .update(tenantUpsertPayload(data))
      .eq("slug", data.slug);
    if (error) throw new Error(`Failed to update tenant: ${error.message}`);
    return { ok: true };
  });

/**
 * Public branding lookup by slug — used by the pre-login screen to preview a
 * tenant's look before the visitor has authenticated (e.g. /login?org=rhb).
 * Deliberately NO auth middleware: branding is non-sensitive, and the real
 * tenant a signed-in user gets always comes from their own profile, never
 * from this call — this is cosmetic-only. Uses supabaseAdmin so it works
 * independently of the `tenants` RLS policy and is explicit about being
 * intentionally public.
 */
export const getTenantBranding = createServerFn({ method: "GET" })
  .inputValidator(z.object({ slug: z.string().min(1).max(40) }))
  .handler(async ({ data }): Promise<{ tenant: TenantRow | null }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (supabaseAdmin as any)
      .from("tenants")
      .select(TENANT_COLUMNS)
      .eq("slug", data.slug)
      .maybeSingle();
    if (error || !row) return { tenant: null };
    return { tenant: toTenantRow(row) };
  });

// ============================================================================
// CREDIT RISK ALERT — upload a credit application, screen it against the Case
// knowledge base, store a structured KB-traceable risk report. Mirrors the
// regulatory create→auto-run pattern; analysis lives in analyzeCreditRisk().
// ============================================================================

/**
 * Creates a Credit Risk Alert report from an uploaded credit application.
 * Lazy: stores the upload + borrower and marks pending_analysis; the report
 * page auto-starts runCreditRiskAnalysis on load (same pattern as regulatory).
 */
export const createCreditRiskReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      filename: z.string(),
      fileUrl: z.string().nullable(),
      workspace: workspaceSchema,
      borrowerName: z.string().min(1).max(200),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    if (!data.fileUrl) throw new Error("No file URL provided for analysis");
    const borrower = data.borrowerName.trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error } = await (supabase as any)
      .from("analysis_reports")
      .insert({
        title: borrower,
        policy_name: borrower,
        status: "pending_validation",
        workflow_type: "credit_risk",
        source_file_url: data.fileUrl,
        workspace_id: data.workspace,
        summary_json: {
          workflow_type: "credit_risk",
          borrower_name: borrower,
          source_filename: data.filename,
          executive: ["Analysis queued — screening the credit application against the case knowledge base…"],
          pending_analysis: true,
        },
      })
      .select("id")
      .single();
    if (error || !report) throw new Error(error?.message || "Failed to create credit risk report");
    return { reportId: report.id as string };
  });

/**
 * Runs the Credit Risk Alert analysis: extracts the application text, loads the
 * workspace's Case KB (all cases, capped), calls the analyzer, and stores the
 * structured result on the report's summary_json.credit_analysis.
 */
export const runCreditRiskAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ reportId: z.string() }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;

    // 1. Load the report.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error: repErr } = await (supabase as any)
      .from("analysis_reports")
      .select("id, title, source_file_url, workspace_id, summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (repErr || !report) throw new Error(repErr?.message || "Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(report.tenant_id, tenantId);
    if (!report.source_file_url) throw new Error("Report has no source file — cannot analyze");
    const workspace = (report.workspace_id ?? "credit_risk") as string;
    const borrowerName = (report.summary_json?.borrower_name ?? report.title ?? "Applicant") as string;

    // Clear the pending flag so the report page doesn't re-trigger.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("analysis_reports")
      .update({ summary_json: { ...(report.summary_json ?? {}), pending_analysis: false, credit_status: "running" } })
      .eq("id", report.id);

    try {
    // 2. Extract the credit application text. Keep per-page text so the evidence
    //    locator can deep-link the application PDF to the right page.
    const f = await fetchFile(report.source_file_url);
    let applicationText = "";
    let appPages: { page: number; text: string }[] = [];
    if (looksLikeDocx(f.mimeType, report.source_file_url)) {
      applicationText = await docxToText(f.buffer);
    } else if (f.mimeType === "application/pdf" || /\.pdf($|\?)/i.test(report.source_file_url)) {
      const { extractPdfPages } = await import("./pdf-pages");
      appPages = await extractPdfPages(f.buffer);
      applicationText = appPages.map((p) => p.text).join("\n");
    } else {
      applicationText = f.buffer.toString("utf-8");
    }
    applicationText = applicationText.replace(/\r\n?/g, "\n").trim();
    if (applicationText.length < 40) {
      throw new Error("Could not read the credit application — text extraction returned almost nothing.");
    }
    const MAX_APP_CHARS = 120_000;
    if (applicationText.length > MAX_APP_CHARS) applicationText = applicationText.slice(0, MAX_APP_CHARS);

    // 3. Load case-KB metadata for this workspace (caller's tenant only — this
    // id-set is also what tenant-scopes the match_sop_chunks RAG results).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: caseDocs } = await (supabase as any)
      .from("sop_documents")
      .select("id, title, summary, file_url")
      .eq("workspace_id", workspace)
      .eq("tenant_id", tenantId);
    const docs = ((caseDocs ?? []) as { id: string; title: string; summary: string | null; file_url: string | null }[]);
    const titleById = new Map(docs.map((d) => [d.id, d.title] as const));
    const creditSopIds = new Set(docs.map((d) => d.id));

    // 3a. RETRIEVAL-GROUNDED case selection — pull the borrower's risk signals,
    //     embed them, and retrieve the genuinely most-similar historical cases.
    //     (match_sop_chunks isn't workspace-scoped, so over-fetch then filter.)
    let retrievalUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
    let retrievalQueries: string[] = [];
    let relevantIds: string[] = [];
    try {
      if (docs.length > 0) {
        const q = await extractCreditRiskRetrievalQueries(applicationText);
        retrievalUsage = q.usage;
        retrievalQueries = q.queries;
        const seen = new Set<string>();
        for (const query of q.queries) {
          const emb = await generateQueryEmbedding(query);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: matched } = await (supabase as any).rpc("match_sop_chunks", {
            query_embedding: emb,
            match_threshold: 0.2,
            match_count: 150,
          });
          let added = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const mrow of ((matched ?? []) as any[])) {
            if (!creditSopIds.has(mrow.sop_id) || seen.has(mrow.sop_id)) continue;
            seen.add(mrow.sop_id);
            relevantIds.push(mrow.sop_id);
            if (++added >= 3) break; // top-3 NEW cases per risk signal
          }
        }
        relevantIds = relevantIds.slice(0, 16);
      }
    } catch (e) {
      console.warn("[credit] retrieval failed, using full KB:", (e as Error)?.message);
    }
    // Fallback to all cases if retrieval surfaced nothing.
    const kbIds = relevantIds.length ? relevantIds : docs.map((d) => d.id);
    const availableRefs = kbIds.map((id) => titleById.get(id)).filter(Boolean).join("\n") || "None";

    // 3b. Load chunks for the SELECTED cases → kbContext + evidence map.
    const chunksByCase = new Map<string, { content: string; page_number: number | null; chapter_ref: string | null }[]>();
    let kbContext = "No knowledge base documents available.";
    if (kbIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: chunkRows } = await (supabase as any)
        .from("sop_chunks")
        .select("sop_id, content, page_number, chapter_ref")
        .in("sop_id", kbIds);
      const byCase = new Map<string, string[]>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of ((chunkRows ?? []) as any[])) {
        const title = titleById.get(c.sop_id) ?? "Case";
        if (!byCase.has(title)) byCase.set(title, []);
        byCase.get(title)!.push(String(c.content ?? ""));
        if (!chunksByCase.has(c.sop_id)) chunksByCase.set(c.sop_id, []);
        chunksByCase.get(c.sop_id)!.push({
          content: String(c.content ?? ""),
          page_number: c.page_number ?? null,
          chapter_ref: c.chapter_ref ?? null,
        });
      }
      // Fall back to the doc summary for any selected case that wasn't chunked.
      for (const id of kbIds) {
        const t = titleById.get(id);
        const d = docs.find((x) => x.id === id);
        if (t && !byCase.has(t) && d?.summary) byCase.set(t, [d.summary]);
      }
      const MAX_KB_CHARS = 200_000;
      let total = 0;
      const blocks: string[] = [];
      for (const [title, parts] of byCase) {
        const body = parts.join("\n").trim();
        if (!body) continue;
        const block = `[${title}]\n${body}`;
        if (total + block.length > MAX_KB_CHARS) break;
        total += block.length;
        blocks.push(block);
      }
      if (blocks.length) kbContext = blocks.join("\n\n---\n\n");
    }

    // 4. Optional per-workspace analysis guidance.
    let guidance: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: g } = await (supabase as any)
        .from("analysis_guidance").select("guidance").eq("workspace_id", workspace).maybeSingle();
      guidance = g?.guidance ?? null;
    } catch { /* guidance is optional */ }

    // 5. Analyze.
    const { analysis, usage } = await analyzeCreditRisk({ borrowerName, applicationText, kbContext, availableRefs, guidance });

    // 5b. Locate each finding's source evidence (application page + KB case page)
    //     so the report's evidence viewer can deep-link and highlight both PDFs.
    attachEvidence(analysis.riskTable, {
      appPages,
      applicationFileUrl: report.source_file_url,
      caseDocs: docs.map((d) => ({ id: d.id, title: d.title, file_url: d.file_url })),
      chunksByCase,
    });

    // 5c. Recommend mitigations per flagged risk (KB recommendations + best practice).
    try {
      const mit = await generateCreditMitigations({ borrowerName, findings: analysis.riskTable, kbContext });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of analysis.riskTable as any[]) if (mit[f.segment]) f.mitigations = mit[f.segment];
    } catch (e) {
      console.warn("[credit] mitigation pass failed:", (e as Error)?.message);
    }

    // 5d. Forensic financial-statement anomaly detection on the application.
    try {
      const fin = await detectFinancialAnomalies({ borrowerName, applicationText });
      analysis.financialAnomalies = fin.anomalies;
    } catch (e) {
      console.warn("[credit] financial anomaly pass failed:", (e as Error)?.message);
    }

    // 5e. External adverse-news / negative screening (Gemini Google Search grounding).
    try {
      const news = await searchAdverseNews({ borrowerName, context: analysis.applicationSummary });
      analysis.adverseNews = news.result;
    } catch (e) {
      console.warn("[credit] adverse-news search failed:", (e as Error)?.message);
    }

    // 6. Store the structured result.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("analysis_reports")
      .update({
        status: "completed",
        summary_json: {
          ...(report.summary_json ?? {}),
          workflow_type: "credit_risk",
          borrower_name: borrowerName,
          pending_analysis: false,
          credit_status: "completed",
          credit_analysis: analysis,
          executive: [analysis.applicationSummary || "Credit risk analysis complete."],
          usage: addUsage(usage, retrievalUsage),
          retrieval: { queries: retrievalQueries, casesSelected: kbIds.length, used: relevantIds.length > 0 },
        },
      })
      .eq("id", report.id);
    if (upErr) throw new Error(`Failed to save analysis: ${upErr.message}`);

    return { reportId: report.id as string, analysis };
    } catch (e: any) {
      // Persist a durable failure state so a reloaded report page shows Retry
      // instead of spinning forever.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("analysis_reports")
        .update({
          summary_json: {
            ...(report.summary_json ?? {}),
            pending_analysis: false,
            credit_status: "failed",
            credit_error: String(e?.message ?? e).slice(0, 500),
          },
        })
        .eq("id", report.id);
      throw e;
    }
  });

/**
 * Conversational Q&A over one Credit Risk report. Grounds the answer in the
 * report's stored analysis plus KB excerpts retrieved for the question (scoped
 * to the workspace's case KB via over-fetch + filter on match_sop_chunks).
 */
export const askCreditRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      reportId: z.string(),
      question: z.string().min(1).max(2000),
      history: z
        .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
        .max(20)
        .optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (supabase as any)
      .from("analysis_reports")
      .select("title, workspace_id, summary_json, tenant_id")
      .eq("id", data.reportId)
      .single();
    if (!report) throw new Error("Report not found");
    const { tenantId } = await getCallerTenant(context.userId);
    assertRowTenant(report.tenant_id, tenantId);
    const analysis = report.summary_json?.credit_analysis;
    if (!analysis) throw new Error("This report has not been analysed yet.");
    const borrower = report.summary_json?.borrower_name ?? report.title ?? "the borrower";
    const workspace = report.workspace_id ?? "credit_risk";

    const SEG: Record<string, string> = {
      management: "Management",
      cash_flow: "Cash Flow",
      asset_quality: "Asset Quality",
      market_industry: "Market/Industry",
      operational_project: "Operational/Project",
      fraud_integrity: "Fraud/Integrity",
      related_party: "Related Party",
      legal_recovery: "Legal/Recovery",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findingsCtx = (analysis.riskTable ?? [])
      .map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f: any) =>
          `• ${SEG[f.segment] ?? f.segment} — ${String(f.indicator).toUpperCase()}${f.confidence ? ` (${f.confidence}%)` : ""}${f.traceReference ? ` · mirrors ${f.traceReference}` : " · no precedent"}\n  Flag: ${f.headline ?? ""}\n  Detail: ${f.finding ?? ""}${f.traceExcerpt ? `\n  Case lesson: "${f.traceExcerpt}"` : ""}`,
      )
      .join("\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policyCtx = (analysis.policyAlerts ?? [])
      .map((a: any) => `• [${a.status}] ${a.reference}: ${a.description}`)
      .join("\n");
    const probeCtx = (analysis.probeQuestions ?? []).map((q: string) => `• ${q}`).join("\n");

    // RAG: retrieve KB chunks relevant to the question, scoped to this workspace.
    let kbCtx = "";
    try {
      const emb = await generateQueryEmbedding(data.question);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: matched } = await (supabase as any).rpc("match_sop_chunks", {
        query_embedding: emb,
        match_threshold: 0.2,
        match_count: 100,
      });
      // Tenant-scoped id-set: this filter is what keeps the global
      // match_sop_chunks results inside the caller's tenant.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: docs } = await (supabase as any)
        .from("sop_documents")
        .select("id, title")
        .eq("workspace_id", workspace)
        .eq("tenant_id", tenantId);
      const titleById = new Map((docs ?? []).map((d: { id: string; title: string }) => [d.id, d.title]));
      const ids = new Set((docs ?? []).map((d: { id: string }) => d.id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const top = ((matched ?? []) as any[]).filter((mm) => ids.has(mm.sop_id)).slice(0, 6);
      kbCtx = top.map((mm) => `[${titleById.get(mm.sop_id)}] ${String(mm.content).slice(0, 800)}`).join("\n\n");
    } catch {
      /* RAG is best-effort */
    }

    const contextBlock = `BORROWER: ${borrower}
OVERALL RISK: ${String(analysis.overallRisk).toUpperCase()}

RISK ASSESSMENT:
${analysis.riskNarrative || analysis.applicationSummary || "(none)"}

FINDINGS (8 dimensions):
${findingsCtx || "(none)"}

POLICY ALERTS:
${policyCtx || "(none)"}

OPEN PROBE QUESTIONS:
${probeCtx || "(none)"}

KNOWLEDGE-BASE EXCERPTS (retrieved for this question):
${kbCtx || "(none retrieved)"}`;

    const { answer } = await chatCreditRisk({
      contextBlock,
      history: data.history ?? [],
      question: data.question,
    });
    return { answer };
  });
