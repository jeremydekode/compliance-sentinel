// ============================================================================
// RUDY.AI — the tenant-aware chat concierge.
// ----------------------------------------------------------------------------
// Rudy interviews the user about what they need, then PROPOSES the right
// workflow as a structured action the client renders as a confirmation card —
// the model never triggers anything itself (human-in-the-loop by design).
//
// Context assembled per call, all tenant-scoped server-side:
//   1. document index    — the tenant's reports + knowledge-base docs
//   2. enabled features  — Rudy only offers workflows the tenant has
//   3. workflow catalog  — plain-language description of each workflow
//   4. uploaded document — optional; extracted text + a RAG pass over the
//      tenant's KB ("how does this impact us / which policies apply")
//
// Output = one JSON object {reply, action}. Validated server-side: malformed
// JSON degrades to a plain reply; unknown doc refs downgrade the action.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateWithFallback } from "./gemini";
import { getCallerTenant, requireFeature } from "./tenant.functions";
import { docxToSimplifyText, docxToText, looksLikeDocx } from "./docx-editor";
import { generateQueryEmbedding } from "./embeddings";

// ── Action contract (shared with the client card renderer) ──────────────────

export type RudyActionKind = "simplify_v2" | "redraft" | "regulatory" | "create_document" | "none";

export interface RudyAction {
  kind: RudyActionKind;
  label: string;
  description: string;
  params: {
    /** id from the DOCUMENT INDEX ("report:<uuid>" | "kb:<uuid>") or "uploaded". */
    docRef?: string;
    workflowMode?: "simplify" | "recommend" | "recommend_edit";
    profile?: "standard" | "max";
    brief?: string;
    title?: string;
    docType?: string;
    regulationHint?: string;
  };
}

export interface RudyReply {
  reply: string;
  action: RudyAction | null;
  /** Resolved source info for the confirmation card (when docRef was given). */
  resolvedDoc?: { ref: string; title: string; fileUrl: string | null } | null;
}

// ── Workflow catalog (only enabled entries are shown to the model) ──────────

const CATALOG: { kind: Exclude<RudyActionKind, "none">; feature: string; text: string }[] = [
  {
    kind: "simplify_v2",
    feature: "simplify_v2",
    text: `simplify_v2 — Document quality work on ONE existing document. workflowMode:
  - "recommend": whole-document AUDIT — finds contradictions, incomplete steps, ambiguous owners, undefined terms, stale references, duplication. Produces a findings report with evidence. Choose when the user wants to know what's WRONG with a document.
  - "simplify": plain-language rewrite proposals (per-paragraph edits, reviewable). profile "max" = aggressive page reduction. Choose when the document is too wordy/hard to read.
  - "recommend_edit": audit THEN (after human review of findings) generate a restructured document. Choose when they want findings AND a fixed document, with control over each fix.`,
  },
  {
    kind: "redraft",
    feature: "simplify_v2",
    text: `redraft — Fast-track redraft of ONE document: audits it, then PRE-SELECTS the verified fixes and stops at the findings for the user to review. The user clicks "Generate redraft" themselves to produce the restructured copy (original logo/headers preserved) — nothing is rewritten or downloaded without that click. Needs a short "brief" describing the direction (e.g. "align with the 2026 outsourcing policy"). Choose when the user says "redraft/rewrite/restructure it for me" and wants the fixes chosen for them rather than triaging each finding by hand. Describe it as preparing the redraft for their review — never promise a finished document up front.`,
  },
  {
    kind: "regulatory",
    feature: "rmit",
    text: `regulatory — Impact analysis of a NEW regulation/circular (e.g. a BNM mandate) against the document library: extracts the regulatory changes and maps which internal documents need updating. The user will be asked to upload the regulation in the workflow. Choose when the trigger is an external regulatory document, not an internal one.`,
  },
  {
    kind: "create_document",
    feature: "create_document",
    text: `create_document — Draft a brand-NEW policy/SOP from a written brief, in the bank's house structure and template. Needs: title, docType (e.g. "policy", "operations manual", "circular"), brief. Choose when nothing exists yet and they want a first draft.`,
  },
];

/**
 * Tolerant parser for Rudy's JSON contract. Models occasionally wrap the JSON
 * in markdown fences or append a stray closing brace — salvage those instead
 * of leaking raw JSON into the chat:
 *   1. strip ```json fences, try a straight parse;
 *   2. retry on progressively shorter substrings, trimming from the last "}"
 *      backwards (fixes the trailing "}}" case);
 *   3. last resort: extract the "reply" string field by regex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRudyJson(raw: string): any | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try { return JSON.parse(cleaned); } catch { /* keep salvaging */ }

  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let end = cleaned.length;
  for (let i = 0; i < 6; i++) {
    const idx = cleaned.lastIndexOf("}", end - 1);
    if (idx <= start) break;
    try { return JSON.parse(cleaned.slice(start, idx + 1)); } catch { end = idx; }
  }

  const m = cleaned.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try { return { reply: JSON.parse(`"${m[1]}"`), action: null }; } catch { /* fall through */ }
  }
  return null;
}

// ── Attachment context cache ─────────────────────────────────────────────────
// The client re-sends the same fileUrl on EVERY message while an attachment
// stays pinned to the chat. Without this cache each message re-downloads,
// re-parses, re-embeds and re-queries the KB — latency and embedding spend
// scale with conversation length instead of once per attachment. Keyed per
// tenant (the RAG excerpts are tenant-scoped). Best-effort by design: it lives
// per warm server instance and resets on cold start — a miss just redoes the
// work, correctness never depends on a hit.
const ATTACHMENT_CACHE_TTL_MS = 15 * 60 * 1000;
const ATTACHMENT_CACHE_MAX = 20;
const attachmentCache = new Map<string, { text: string; ragBlock: string; at: number }>();

function buildUploadedBlock(filename: string | undefined, text: string, ragBlock: string): string {
  return `\n# UPLOADED DOCUMENT: "${filename ?? "document"}" (the user just attached this — docRef "uploaded")\n${text}\n${ragBlock}\n`;
}

// ── serverFn ─────────────────────────────────────────────────────────────────

export const rudyChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      message: z.string().min(1).max(4000),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(20).default([]),
      fileUrl: z.string().url().optional(),
      filename: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<RudyReply> => {
    const supabase = context.supabase;
    const { tenantId, features } = await getCallerTenant(context.userId);
    requireFeature(features, "rudy");

    // 1 — tenant-scoped document index (reports + KB docs).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [reportsRes, sopsRes] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("analysis_reports")
        .select("id, title, workspace_id, source_file_url, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(60),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("sop_documents")
        .select("id, title, workspace_id, file_url, doc_type")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reports: any[] = reportsRes.data ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sops: any[] = sopsRes.data ?? [];
    const docIndexLines = [
      ...reports.map((r) => `report:${r.id} | ${r.title} | workspace ${r.workspace_id}`),
      ...sops.map((s) => `kb:${s.id} | ${s.title} | ${s.doc_type ?? "doc"} | workspace ${s.workspace_id}`),
    ];
    const docByRef = new Map<string, { title: string; fileUrl: string | null }>();
    for (const r of reports) docByRef.set(`report:${r.id}`, { title: r.title, fileUrl: r.source_file_url ?? null });
    for (const s of sops) docByRef.set(`kb:${s.id}`, { title: s.title, fileUrl: s.file_url ?? null });

    // 2 — enabled workflow catalog.
    const catalog = CATALOG.filter((c) => features.includes(c.feature)).map((c) => c.text);

    // 3 — uploaded document: extract text + RAG over the tenant's KB.
    // Cached per (tenant, fileUrl) so a pinned attachment is processed once
    // per conversation, not once per message.
    let uploadedBlock = "";
    if (data.fileUrl) {
      const cacheKey = `${tenantId}:${data.fileUrl}`;
      const cached = attachmentCache.get(cacheKey);
      if (cached && Date.now() - cached.at < ATTACHMENT_CACHE_TTL_MS) {
        uploadedBlock = buildUploadedBlock(data.filename, cached.text, cached.ragBlock);
      } else {
        try {
          const res = await fetch(data.fileUrl);
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          let text = "";
          if (looksLikeDocx(null, data.fileUrl)) {
            try { text = docxToSimplifyText(buffer); } catch { text = ""; }
            if (!text) text = await docxToText(buffer).catch(() => "");
          } else if (/\.pdf($|\?)/i.test(data.fileUrl)) {
            const { extractPdfPages } = await import("./pdf-pages");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            text = (await extractPdfPages(buffer)).map((p: any) => p.text).join("\n\n");
          } else {
            text = buffer.toString("utf-8");
          }
          text = text.slice(0, 60_000);

          // RAG: what tenant policies relate to this document?
          let ragBlock = "";
          try {
            const emb = await generateQueryEmbedding(text.slice(0, 4_000));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: matched } = await (supabase as any).rpc("match_sop_chunks", {
              query_embedding: emb,
              match_threshold: 0.2,
              match_count: 60,
            });
            const tenantSopIds = new Set(sops.map((s) => s.id));
            const titleById = new Map(sops.map((s) => [s.id, s.title] as const));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const top = ((matched ?? []) as any[]).filter((m) => tenantSopIds.has(m.sop_id)).slice(0, 8);
            if (top.length > 0) {
              ragBlock =
                `\n# RELATED INTERNAL POLICY EXCERPTS (from this organisation's knowledge base — cite these when explaining impact):\n` +
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                top.map((m: any) => `--- from "${titleById.get(m.sop_id)}"${m.chapter_ref ? ` (${m.chapter_ref})` : ""} ---\n${String(m.content ?? "").slice(0, 1200)}`).join("\n");
            }
          } catch (e) {
            console.warn("[rudy] RAG pass failed:", (e as Error)?.message?.slice(0, 100));
          }

          attachmentCache.set(cacheKey, { text, ragBlock, at: Date.now() });
          if (attachmentCache.size > ATTACHMENT_CACHE_MAX) {
            const oldest = attachmentCache.keys().next().value;
            if (oldest !== undefined) attachmentCache.delete(oldest);
          }
          uploadedBlock = buildUploadedBlock(data.filename, text, ragBlock);
        } catch (e) {
          uploadedBlock = `\n# UPLOADED DOCUMENT: could not be read (${(e as Error)?.message?.slice(0, 80)}). Tell the user and suggest re-uploading as DOCX.\n`;
        }
      }
    }

    // 4 — the prompt.
    const systemPrompt = `# YOU ARE RUDY — the document-intelligence assistant for this organisation.
You help bank staff figure out what they need, then set up the right workflow for them. You are talking to a non-technical user.

# HOW TO BEHAVE
- INTERVIEW FIRST. Until you know (a) WHICH document (from the DOCUMENT INDEX, or the uploaded one) and (b) WHAT OUTCOME they want, ask short, concrete questions — set action kind "none".
- When you have enough, PROPOSE exactly one workflow action. The user sees it as a confirmation card and must click Confirm — so make "label" a short imperative ("Audit S16 Operations Manual") and "description" one honest sentence about what will happen.
- If the user asks a question you can answer from the uploaded document or the policy excerpts, ANSWER IT well (markdown, cite the policy titles) — an action is optional, not mandatory.
- Never invent documents: docRef must be an id from the DOCUMENT INDEX or the literal "uploaded".
- Only offer workflows from the catalog below. If the request maps to nothing, say what you CAN do instead.
- Keep replies under 150 words.

# AVAILABLE WORKFLOWS
${catalog.join("\n\n")}

# DOCUMENT INDEX (this organisation's documents — the ONLY valid docRef values besides "uploaded")
${docIndexLines.length > 0 ? docIndexLines.join("\n") : "(no documents yet — the user can upload one here in the chat or in a workflow)"}
${uploadedBlock}
# OUTPUT — return ONLY one JSON object:
{ "reply": "<markdown reply to the user>", "action": null | { "kind": "simplify_v2|redraft|regulatory|create_document", "label": "<button text>", "description": "<one sentence>", "params": { "docRef": "...", "workflowMode": "...", "profile": "...", "brief": "...", "title": "...", "docType": "...", "regulationHint": "..." } } }
`;

    const contents = [
      ...data.history.slice(-10).map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      })),
      { role: "user" as const, parts: [{ text: data.message }] },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any = null;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await generateWithFallback({
          contents,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
          },
        }, { tier: "quality" });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }

    // 5 — validate. Malformed JSON is SALVAGED (models occasionally emit a
    // stray closing brace); raw JSON must never reach the user's chat bubble.
    const raw = String(response.text ?? "").trim();
    const parsed = parseRudyJson(raw);
    if (!parsed || typeof parsed.reply !== "string") {
      // Only show raw text when it's clearly prose, never JSON-ish output.
      const isProse = raw.length > 0 && !raw.startsWith("{") && !raw.startsWith("```");
      return {
        reply: isProse ? raw : "Sorry — I hit a glitch composing that answer. Could you say it again?",
        action: null,
      };
    }

    let action: RudyAction | null = null;
    let resolvedDoc: RudyReply["resolvedDoc"] = null;
    const a = parsed.action;
    if (a && a.kind && a.kind !== "none") {
      const kind = a.kind as RudyActionKind;
      // CATALOG is the single registry: a kind is known iff it has an entry,
      // and allowed iff that entry's feature is enabled for the tenant.
      const entry = CATALOG.find((c) => c.kind === kind);
      const known = !!entry;
      const allowed = !!entry && features.includes(entry.feature);
      const params = (a.params ?? {}) as RudyAction["params"];
      const docRefOk = !params.docRef || params.docRef === "uploaded" || docByRef.has(params.docRef);
      if (known && allowed && docRefOk) {
        if (params.docRef === "uploaded" && data.fileUrl) {
          resolvedDoc = { ref: "uploaded", title: data.filename ?? "Uploaded document", fileUrl: data.fileUrl };
        } else if (params.docRef && docByRef.has(params.docRef)) {
          const d = docByRef.get(params.docRef)!;
          resolvedDoc = { ref: params.docRef, title: d.title, fileUrl: d.fileUrl };
        }
        action = {
          kind,
          label: String(a.label ?? "Run workflow").slice(0, 60),
          description: String(a.description ?? "").slice(0, 200),
          params,
        };
      }
    }

    return { reply: parsed.reply, action, resolvedDoc };
  });
