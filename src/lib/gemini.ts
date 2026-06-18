import { GoogleGenAI } from "@google/genai";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "./pricing";
import { extractPdfPages, pagesToMarkedText } from "./pdf-pages";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

// Two fallback chains keyed by call tier. Each chain is tried in order; a model
// that returns a capacity error (503 "high demand") is retried once, then the
// next model is used.
//
//  - "quality" (default): high-stakes reasoning — regulatory delta extraction,
//    SOP mapping, change routing, amended-document generation.
//  - "fast": high-volume / low-stakes — chunking, header-field extraction,
//    one-liner summaries.
//
// Available on the project key (probed 2026-05-22): gemini-3.5-flash,
// gemini-2.5-flash, gemini-2.5-pro, gemini-3.1-flash-lite (+ older -lite).
// "quality" LEADS with gemini-3.5-flash — newer and stronger than 2.5-flash,
// on a fresher capacity pool, so far less prone to the 503 overload 2.5-flash
// hits at peak. 2.5-flash is the fallback; flash-lite is the LAST resort only
// (the weak tier — capable of returning an empty extraction — so it is never
// the primary for a quality call).
const FALLBACK_CHAINS = {
  quality: ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
  fast:    ["gemini-3.1-flash-lite", "gemini-3.5-flash"],
} as const;

export type ModelTier = keyof typeof FALLBACK_CHAINS;

type GenerateParams = Omit<Parameters<typeof ai.models.generateContent>[0], "model">;

export async function generateWithFallback(
  params: GenerateParams,
  opts?: { tier?: ModelTier }
): Promise<Awaited<ReturnType<typeof ai.models.generateContent>>> {
  const models = FALLBACK_CHAINS[opts?.tier ?? "quality"];
  let lastError: unknown;
  for (const model of models) {
    // A transient capacity/network error ("high demand"/503/429/rate-limit/
    // RESOURCE_EXHAUSTED/UNAVAILABLE/"fetch failed") gets SEVERAL retries on the
    // SAME model with exponential backoff — so a momentary overload does not
    // permanently downgrade to a weaker fallback model, and a flaky network blip
    // doesn't silently drop the call. Only after exhausting those do we fall
    // through to the next model in the chain.
    const CAPACITY_RETRIES = 4; // 3 retries, then fall to next model
    for (let attempt = 1; attempt <= CAPACITY_RETRIES; attempt++) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (e: any) {
        const msg: string = e?.message ?? "";
        const capacity =
          msg.includes("high demand") || msg.includes("overloaded") || msg.includes("503") ||
          msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("UNAVAILABLE") ||
          msg.includes("rate limit") || msg.includes("fetch failed");
        const notFound = msg.includes("NOT_FOUND") || msg.includes("not found") || msg.includes("404");
        if (capacity && attempt < CAPACITY_RETRIES) {
          const wait = 4000 * attempt; // 4s, 8s, 12s
          console.warn(`Model ${model} busy (${msg.slice(0, 60)}) — retry ${attempt}/${CAPACITY_RETRIES - 1} in ${wait / 1000}s…`);
          lastError = e;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (capacity || notFound) {
          console.warn(`Model ${model} unavailable (${msg.slice(0, 80)}), trying next…`);
          lastError = e;
          break;
        }
        throw e;
      }
    }
  }
  throw lastError;
}

export interface AnalysisResult {
  changes: {
    chapter_ref: string;
    old_requirement: string;
    new_requirement: string;
    change_summary: string;
    impact: "high" | "medium" | "low";
    tone_shift: string;
    pages?: string;
    legal_refs?: string[];
    related_instruments?: string[];
  }[];
  impacts: {
    sop_title: string;
    change_type: "find_replace" | "insertion" | "full_rewrite" | "new_section" | "contextual";
    page: number;
    paragraph: string;
    chapter: string;
    find_text?: string;
    replace_text: string;
  }[];
  summary: {
    executive: string;
    effective_date: string;
    before_count: number;
    after_count: number;
    immediate_actions: string[];
    structural: { added: string[]; renamed: string[]; restructured: string[] };
    timeline: { phase: string; window: string; focus: string; bullets: string[] }[];
  };
}

export interface RegulatoryDelta {
  title?: string;
  chapter_ref: string;
  pages: string;
  legal_refs: string[];
  related_instruments: string[];
  impact: "high" | "medium" | "low";
  old_requirement: string;
  new_requirement: string;
  change_summary: string;
  tone_shift: string;
}

export interface SopGap {
  sop_title: string;
  paragraph: string;
  change_type: "find_replace" | "insertion" | "full_rewrite" | "new_section" | "contextual";
  chapter: string;
  find_text: string;
  replace_text: string;
  page: number;
  /** Short action headline rendered as the card title (e.g. "Plenary date reference — 'June 2025' → 'February 2026'") */
  action_description?: string;
  /** Best-effort line range from the SOP (e.g. "~19056" or "~4378–4435") */
  line_range?: string;
}

/**
 * STAGE 1: TWO-POLICY FORENSIC DELTA EXTRACTION
 * Compares old vs new policy directly to extract all material regulatory changes.
 */
export type RegulatorContext = "rmit" | "fatf" | "circular" | "generic";

function regulatorGuidance(ctx: RegulatorContext): string {
  if (ctx === "rmit") {
    return `
# REGULATOR CONTEXT: BNM RMiT (Risk Management in Technology)
This document is from Bank Negara Malaysia's RMiT family. Apply these BNM-specific rules:
- BNM uses an explicit classifier prefix in every paragraph: **S** = Standard (MANDATORY), **G** = Guidance (NON-MANDATORY, "may consider"/"is encouraged to"), **P** = neutral Paragraph. PRESERVE this distinction in your tone_shift field — never call a "G" clause a mandate.
- A typical RMiT revision (2023 → 2025) contains 10–15 material changes. If your output is under 10, you have almost certainly missed something — re-sweep.

## RMiT — DO NOT MISS THESE CATEGORIES
Past extractions have systematically under-reported the following. Inspect each one by name before finalising:

1. **Scope / Applicability expansion (Paragraph 5.x)** — additions of new covered institutions (e.g. Registered Merchant Acquirers, Intermediary Remittance Institutions, payment system operators). A two-line addition to ¶5.2 IS a material change. Title it "Expanded Applicability — [new institution types]".

2. **Board / Governance obligations (Paragraph 8.x)** — new topics the board must discuss (liquidity risks tied to cyber, operational disruption impact). Even when the wording change is short, it expands director duties. Title it "Board Oversight — [new topic]".

3. **Authentication mandates (Appendix 3)** — RMiT 2025 explicitly disfavours unencrypted SMS OTPs and mandates transaction-bound dynamic OTPs. ANY change to Appendix 3 paragraphs is material. Open Appendix 3 by name and compare.

4. **Emerging Tech Governance (Section 17 / Appendix 9)** — section was renamed from "Cloud Services" (§15) to "Cloud Services and Emerging Technology" (§17) and Appendix 9 was expanded. The rename + expansion together IS a substantive change — extract it as "Emerging Technologies Governance". Do NOT dismiss this as renumbering only.

5. **Cloud Exit Strategy (Appendix 10, Item 7)** — moved from a vague mention of "termination capabilities" to a mandated, tested exit plan with alternative provider identification. Appendix 10 must be opened and compared in full.

6. **Out-of-Band Communications & Cyber Insurance (Paragraphs 11.15 + 11.17)** — these are TWO distinct paired changes within the Cyber Incident Response chapter. Out-of-band comms infrastructure mandate (¶11.15) and cyber insurance review obligation (¶11.17) should each produce their own change entry — do NOT consolidate them into one "incident response" change.

7. **Stricter quantitative thresholds** — vulnerability assessment frequency, threat report cadence, downtime caps, transition deadlines. These are often single-number changes that read as cosmetic but are operationally material.

## RMiT — STRUCTURAL SWEEP CHECKLIST (run this before finalising):
For RMiT specifically, you MUST examine each of these sections by name and compare old vs new even if your initial pass found nothing there:
- Paragraph 5.x (Applicability)
- Paragraph 8.x (Governance & board)
- Paragraphs 10.15, 10.20, 10.31, 10.35, 10.41, 10.67, 10.71 (technology risk core)
- Paragraph 12.8 (digital fraud)
- Paragraphs 11.15, 11.17, 11.23 (incident response)
- Section 17 (Emerging Technology — renamed from §15)
- Appendix 3 (Authentication / MFA / OTP)
- Appendix 5, Parts D + E (Vulnerability assessment + API security)
- Appendix 9 (Emerging Technology assurance)
- Appendix 10 (Cloud Services — exit strategy in Item 7)
- Appendix 11 (Threat assessment reporting)

## RMiT — Renumbering rule clarification
The general "renumbering alone is not a change" rule still holds, BUT: when a section is BOTH renumbered AND substantively expanded/restructured (e.g. §15 "Cloud Services" → §17 "Cloud Services and Emerging Technology"), the substantive part IS a material change. Do not let the renumbering trip you into skipping it. Quote both old and new to prove the substantive delta.`;
  }
  if (ctx === "fatf") {
    // Intentionally empty — FATF analysis runs on the generic extraction prompt
    // plus whatever the compliance team configures in the editable Analysis
    // Guidance (Settings). No hard-coded grouping or change-count rules.
    return "";
  }
  if (ctx === "circular") {
    return `
# REGULATOR CONTEXT: Regulator Circular
This document is a supervisory circular communicating clarifications, thematic findings, or updated expectations. Most circulars introduce a small number of focused changes (1-8) rather than a full framework revision. Map each clarified expectation against existing operating procedures.`;
  }
  return `
# REGULATOR CONTEXT: Generic Compliance Document
No specific regulator-family hints available. Apply general compliance-officer judgement.`;
}

type PolicySource =
  | { name: string; buffer: Buffer; mimeType: string }
  | { name: string; text: string };

function policyToParts(label: string, src: PolicySource): any[] {
  if ("text" in src) {
    return [
      { text: `\n--- ${label}: "${src.name}" (verbatim text) ---\n${src.text}\n--- END ${label} ---\n` },
    ];
  }
  return [
    { text: `\n--- ${label}: "${src.name}" (attached file) ---` },
    { inlineData: { data: src.buffer.toString("base64"), mimeType: src.mimeType } },
  ];
}

/**
 * Wraps the compliance team's editable analysis guidance as a prompt section.
 * It is ADDITIVE — it refines approach/emphasis and never overrides the JSON
 * output contract or the find_text / verification rules.
 */
function guidanceBlock(guidance?: string | null): string {
  const g = (guidance ?? "").trim();
  if (!g) return "";
  return `
# ⚙️ ANALYST GUIDANCE — configured by the compliance team (apply throughout):
The guidance below refines your APPROACH, FOCUS and EMPHASIS. It does NOT change the required JSON output format, the find_text rules, or the verification rules in this prompt — those remain authoritative. Where the guidance conflicts with the output contract, follow the output contract.

${g}
`;
}

/**
 * Parses a JSON array out of a model response. If the response was truncated
 * (the model ran into maxOutputTokens mid-array, leaving invalid JSON), this
 * SALVAGES every COMPLETE top-level object rather than losing the whole batch —
 * a partial gap/impact list is far more useful than zero. String contents
 * (including braces inside quoted values) are tracked so depth stays correct.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonArrayLoose(raw: string | null | undefined): any[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.changes)) return parsed.changes;
    if (Array.isArray(parsed?.requirements)) return parsed.requirements;
    if (Array.isArray(parsed?.impacts)) return parsed.impacts;
    if (parsed && typeof parsed === "object") return [parsed];
    return [];
  } catch {
    const start = text.indexOf("[");
    if (start < 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") { if (depth === 0) objStart = i; depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip partial */ }
          objStart = -1;
        }
      }
    }
    return out;
  }
}

export async function extractRegulatoryChanges(
  newPolicy: PolicySource,
  oldPolicy?: PolicySource,
  regulatorCtx: RegulatorContext = "generic",
  guidance?: string | null
): Promise<RegulatoryDelta[]> {
  const prompt = `
# ROLE: CHIEF COMPLIANCE OFFICER — FORENSIC POLICY CHANGE DETECTOR

You are performing a forensic comparison of two versions of a regulatory document. Your mandate is to identify EVERY policy change that requires an organisation to update its internal procedures, SOPs, or controls.

${regulatorGuidance(regulatorCtx)}
${guidanceBlock(guidance)}

${oldPolicy ? `# DOCUMENTS PROVIDED:
- DOCUMENT A (NEW/UPDATED POLICY): First attachment
- DOCUMENT B (LEGACY BASELINE): Second attachment

Compare Document A against Document B section by section.` : `# DOCUMENT PROVIDED:
- NEW POLICY: First attachment (treat as entirely new requirements)
`}

# WHAT CONSTITUTES A MATERIAL POLICY CHANGE (these are the RAW SIGNALS — you GROUP related ones into thematic changes, see CONSOLIDATE below):

## Category A — Quantitative shifts
- A reporting/notification deadline changed (e.g. "24 hours" → "6 hours", "annual" → "semi-annual")
- A monetary or quantitative threshold changed (e.g. "RM 10 million" → "RM 5 million")
- A compliance review/audit frequency changed (e.g. "every 3 years" → "annually")
- A retention period, downtime cap, response time, or coverage % changed

## Category B — New requirements (often have NO old equivalent — STILL EXTRACT)
- A new mandatory control, capability, or system is introduced (e.g. kill-switch, stand-in processing arrangements, out-of-band communication, public uptime disclosure)
- An entirely new section, chapter, or appendix was added with substantive obligations
- A new technical security standard appears (e.g. API security controls, MFA upgrade, SBOM adoption)
- A new emerging-technology governance requirement (e.g. AI, quantum, cloud exit strategy)
- A new disclosure or transparency obligation (e.g. public reporting, customer notification)
- A new sub-paragraph mandating something the old policy didn't address at all
**For NEW requirements with no prior baseline, set old_requirement to "N/A - new requirement" — do NOT skip the entry.**

## Category C — Tone or scope shifts
- A requirement scope expanded or contracted (e.g. now applies to third-party arrangements, merchant acquirers, intra-group transactions)
- A "should" / "may" / "encouraged to" / "strongly encourages" became a "shall" / "must" / "is required to" (guidance hardened into mandate)
- A new definition was added that changes the scope of who is regulated
- An exemption was removed or a new exemption was added
- Even soft language like "strongly encourages adopting X" counts as a material shift if X was previously unmentioned — extract it.

## Category D — Cross-reference / consolidation
- A control was moved from one section to another AND its wording strengthened
- Multiple existing requirements were consolidated under a single mandatory standard

# WHERE TO LOOK (cover ALL these locations exhaustively):
- Main numbered paragraphs (5.x, 8.x, 10.x, 11.x, 12.x …)
- ALL Appendices (Appendix 1, 2, 3, 5, 9, 10, etc.) — appendices often contain critical new technical mandates
- Footnotes and tables that introduce new obligations
- Sub-paragraphs (a), (b), (c), (i), (ii), (iii)

# WHAT IS NOT A MATERIAL CHANGE (DO NOT INCLUDE):
- Rewording the same obligation without changing the substantive meaning
- Pure renumbering with no wording change
- Grammar, punctuation, or typographical corrections
- Adding a cross-reference or footnote without changing the obligation
- Purely cosmetic restructuring of identical content into sub-paragraphs

# ❗ CRITICAL ANTI-HALLUCINATION RULES (apply BEFORE every entry):

## Rule 1 — Verbatim verification
Before claiming a change exists, you MUST extract the verbatim text of the old requirement AND the verbatim text of the new requirement, side by side. If the substantive wording is identical (only the paragraph number changed, e.g. 10.38 → 10.42), this is NOT a delta. Do NOT include it. Renumbering alone is not a material change.

## Rule 2 — Respect any mandate-strength classifier the regulator uses
If the regulator uses a classifier prefix (BNM uses S/G/P; FATF distinguishes Recommendations from Guidance/Best Practices), preserve that distinction faithfully. NEVER call a clause a "mandate" if the regulator labels it as Guidance, Recommendation only (without INR), or "may consider"/"is encouraged to" language. Read the actual modal verb: "shall"/"must" = mandate; "should"/"may"/"is encouraged" = non-mandate. Your tone_shift field must reflect the actual strength.

## Rule 3 — Effective date vs transition deadline
- "Effective date" = when the policy comes into force (the regulator's stated come-into-effect date, e.g. "28 November 2025").
- "Transition deadline" = a future date by which institutions must complete implementation of a specific capability (e.g. "30 September 2027" for stand-in processing).
Do NOT conflate these. The summary's effective_date field must be the policy's come-into-force date, NOT a transition deadline.

# SELF-CHECK BEFORE EACH ENTRY:
1. Did I quote the old text verbatim? Is it substantively different from the new text (not just renumbered)?
2. Did I check the S/G/P prefix? Is my tone_shift accurate to that classifier?
3. Would the Head of Compliance need to commission a project, write a new control, update an SOP, retrain staff, modify a system, or notify a customer because of this change?
If YES to all → extract it. If text is identical but renumbered → SKIP. If unsure on substance → extract it (false positives are easy to filter; missing a real change is a compliance risk).

# ❗ CONSOLIDATE INTO THEMATIC CHANGES — this is critical:
Report changes at the level a compliance team briefs its board: THEMATIC changes, not atomic paragraph diffs. When comparing two full policies, group EVERY paragraph-, sub-paragraph- and appendix-level edit that serves the SAME underlying control or obligation into ONE entry.
- Example: a "should → must" hardening of authentication that repeats across Appendix 3 points 1(a), 1(b), 1(g)…1(j), 2, 3, 7, 8 and 9 is ONE thematic change — "Stricter MFA & OTP Rules" — NOT nine or twelve.
- Example: a new appendix PLUS every paragraph that now points to it = ONE thematic change.
- A thematic change's chapter_ref may list several references (e.g. "Paragraph 10.67, 10.71 → Appendix 3"); its new_requirement should still capture the substantive sub-points, grouped under the one entry.
- A major regulation revision typically yields ~10-15 thematic changes — the ones a board would be briefed on. If you have more than 15, you are itemising too finely: merge the smaller related items into their parent theme, and drop genuinely minor or purely administrative changes. If you are about to output 30+ entries you are diffing atomically — STOP and regroup.

# COVERAGE:
Sweep the ENTIRE document including all appendices and annexes so no THEME of change is missed — but report each theme ONCE. Coverage means every distinct changed control is represented, not that every paragraph gets its own row. Pure renumbering, cosmetic rewording and identical-text-moved are NOT changes — drop them.

# STRUCTURED COMPARISON DOCUMENTS — STRICT RULE:
If the NEW POLICY document is itself a comparison table or change-log that already enumerates the changes (rows beginning "1.", "2.", … "N.", or columns like "Impacted Item / Old Policy / New Policy / Explanation"), then this is a pre-digested map — your job is to extract EVERY numbered row, not to re-analyse from scratch:
- Output ONE change entry per numbered row. If the document lists 12 numbered rows, your output array MUST contain 12 entries. Never consolidate or drop rows in this case.
- Use the row's "Impacted Item" / heading text as the title.
- Copy the "Old Policy" cell verbatim into old_requirement (or "N/A - new requirement" if empty).
- Copy the "New Policy" cell verbatim into new_requirement.
- Use the chapter/paragraph reference stated in the row (e.g. "Paragraph 5.2", "Paragraph 12.8", "Appendix 5, Part E") as chapter_ref.
- Use the row's "Explanation" or "Changes Summary" text as change_summary.
- impact: infer from the explanation tone (mandate/scope expansion/new control = high; quantitative tightening = medium; clarification = low).
- Do this even if the document is short (3 pages, 12 rows) — the row count is the ground truth.

# OUTPUT FORMAT (JSON Array):
[{
  "title": "Short 3-6 word headline naming the change (e.g. 'Digital Fraud Kill Switch', 'Public Uptime Disclosure', 'Stricter MFA & OTP Rules', 'Cloud Exit Strategy')",
  "chapter_ref": "Specific chapter/paragraph/section reference from the NEW document (e.g. 'Paragraph 10.31(a)' or 'Appendix 5, Part E')",
  "pages": "",
  "legal_refs": ["Statutory or regulatory references cited"],
  "related_instruments": ["Related guidelines or instruments mentioned"],
  "impact": "high" | "medium" | "low",
  "old_requirement": "The previous obligation verbatim from the legacy doc, or 'N/A - new requirement'",
  "new_requirement": "The new/changed obligation verbatim from the updated doc. The UI word-diffs this against old_requirement — keep them PARALLEL. If the change adds or removes items within a list, reproduce the FULL list on both sides (same wording/order) so only the genuinely added/removed items differ; never summarise one side, or unchanged items will wrongly show as struck-through.",
  "change_summary": "One sentence: what operationally changed",
  "tone_shift": "e.g. 'Guidance → Mandate', 'Relaxed → Prescriptive', 'New requirement'"
}]

Return ONLY material, actionable, THEMATIC changes — consolidated per the CONSOLIDATE rule above. Aim for roughly 10-15 entries for a major revision; a long list of atomic paragraph diffs is wrong. Cover every distinct control that changed, but report each as ONE thematic entry.
  `;

  const parts: any[] = [{ text: prompt }];
  parts.push(...policyToParts("NEW POLICY DOCUMENT", newPolicy));
  if (oldPolicy) {
    parts.push(...policyToParts("LEGACY BASELINE POLICY DOCUMENT", oldPolicy));
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  });

  const out = parseJsonArrayLoose(response.text);
  if (out.length === 0) {
    console.error("extractRegulatoryChanges: no changes parsed:", (response.text ?? "").slice(0, 400));
  }
  return out;
}

/**
 * CONFORMANCE EXTRACTION (FATF). Unlike extractRegulatoryChanges (which diffs a
 * new vs old document), this reads ONE current FATF statement and extracts its
 * STANDING obligations — the positions a bank's SOPs must currently reflect,
 * whether or not they changed recently. Output is shaped as RegulatoryDelta[]
 * (old_requirement = "N/A") so the rest of the pipeline is unchanged.
 */
export async function extractFatfRequirements(
  statement: PolicySource,
  guidance?: string | null,
): Promise<RegulatoryDelta[]> {
  const prompt = `
# ROLE: FATF COMPLIANCE ANALYST — STANDING-REQUIREMENT EXTRACTOR

You are given the CURRENT FATF statement / circular issued to reporting institutions. Do NOT diff it against any previous version. Extract its STANDING OBLIGATIONS — every position a bank's internal AML/CFT/CPF SOPs must currently reflect to be compliant.
${guidanceBlock(guidance)}
# WHAT TO EXTRACT — one entry per distinct standing obligation:
- Each High-Risk Jurisdiction subject to a Call for Action (e.g. DPRK, Iran, Myanmar): name it, and capture its required measures verbatim/closely — enhanced CDD, countermeasures, and any SPECIFIC restrictions (correspondent banking, branches/subsidiaries/representative offices, **virtual asset service providers and virtual asset transactions**, wire-transfer information), plus any stated deadline.
- The Jurisdictions under Increased Monitoring ("grey list"): ONE entry capturing the CURRENT list of jurisdictions named in this statement.
- Cross-cutting obligations: the risk-based approach, no blanket de-risking / NPO and humanitarian-flow carve-outs.
- Any explicit date or deadline the statement sets.
Each entry is a requirement the SOP must conform to — include it even if it is long-standing, not only if it is new.

# OUTPUT FORMAT (JSON array):
[{
  "chapter_ref": "short reference, e.g. 'Call for Action — Iran', 'Jurisdictions under Increased Monitoring', 'Risk-based approach'",
  "old_requirement": "N/A - standing FATF requirement",
  "new_requirement": "the obligation, quoted or closely paraphrased from the statement — exactly what the SOP must reflect",
  "change_summary": "one line: what the bank's SOPs must ensure",
  "impact": "high" | "medium" | "low",
  "tone_shift": "Standing requirement",
  "legal_refs": ["any references cited, e.g. 'AMLA section 83', 'FATF Recommendation 19'"],
  "pages": ""
}]

Return ONLY the JSON array. Extract EVERY distinct standing obligation — a quarterly FATF statement typically yields 5-10.

# FATF STATEMENT:
`;
  const parts: any[] = [{ text: prompt }];
  parts.push(...policyToParts("FATF STATEMENT", statement));
  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  });
  const out = parseJsonArrayLoose(response.text);
  if (out.length === 0) {
    console.error("extractFatfRequirements: no requirements parsed:", (response.text ?? "").slice(0, 400));
  }
  return out;
}

/**
 * SEMANTIC CHUNKING ENGINE
 * Extracts granular text pieces from a document for full-text indexing.
 */
/**
 * Deterministic chunker for plain text (used for DOCX files to avoid
 * sending a huge binary to Gemini — mammoth extracts text in milliseconds,
 * then we split on paragraph/section boundaries locally).
 *
 * Targets ~800 chars per chunk. Tracks the most recent heading-like line as
 * chapter_ref. No page numbers (DOCX has no inherent pages).
 */
function chunkTextDeterministic(
  text: string
): Array<{ content: string; chapter_ref?: string }> {
  // Split on blank lines to get paragraph-level units.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const TARGET = 800;
  const chunks: Array<{ content: string; chapter_ref?: string }> = [];
  let currentChapter: string | undefined;
  let buffer = "";

  const flush = () => {
    const c = buffer.trim();
    if (c) chunks.push({ content: c, chapter_ref: currentChapter });
    buffer = "";
  };

  for (const para of paragraphs) {
    // Detect headings: short lines that look like "1.2 Title", "CHAPTER X", numbered clauses, etc.
    const isHeading =
      para.length < 120 &&
      (/^(\d+(\.\d+)*\.?\s+\S)/.test(para) ||  // "1.2.3 Something"
       /^(chapter|section|clause|part|appendix)\b/i.test(para) ||
       /^[A-Z][A-Z\s\d]{3,60}$/.test(para));     // ALL-CAPS short line

    if (isHeading) {
      flush();
      currentChapter = para.slice(0, 120);
    }

    if (buffer.length + para.length + 2 > TARGET * 1.5 && buffer.length > 0) {
      flush();
    }
    buffer = buffer ? buffer + "\n\n" + para : para;
    if (buffer.length >= TARGET) flush();
  }
  flush();
  return chunks;
}

export async function chunkDocument(
  doc: { name: string; buffer: Buffer; mimeType: string }
): Promise<Array<{ content: string; chapter_ref?: string; page_number?: number }>> {
  const isPdf = doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.name);
  const isDocx =
    doc.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    doc.mimeType === "application/msword" ||
    /\.docx?$/i.test(doc.name);
  const isXlsx =
    doc.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    doc.mimeType === "application/vnd.ms-excel" ||
    /\.xlsx?$/i.test(doc.name);

  // For XLSX: extract sheet data with SheetJS — fast, no Gemini needed.
  if (isXlsx) {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(doc.buffer, { type: "buffer" });
      const chunks: Array<{ content: string; chapter_ref?: string }> = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        // Convert to CSV rows, filter blanks
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as string[][];
        const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim()));
        if (nonEmpty.length === 0) continue;
        // Chunk every 20 rows so individual chunks stay manageable
        const ROW_BATCH = 20;
        for (let i = 0; i < nonEmpty.length; i += ROW_BATCH) {
          const slice = nonEmpty.slice(i, i + ROW_BATCH);
          const content = slice.map((r) => r.map((c) => String(c).trim()).join("\t")).join("\n");
          chunks.push({ content, chapter_ref: `Sheet: ${sheetName} (rows ${i + 1}–${i + slice.length})` });
        }
      }
      if (chunks.length > 0) return chunks;
    } catch (e) {
      console.warn(`[chunkDocument] XLSX extraction failed for ${doc.name}, falling back to Gemini:`, (e as Error)?.message);
    }
  }

  // For DOCX: extract text locally with mammoth (fast, no AI call needed).
  // Sending a 400-page DOCX binary to Gemini routinely times out on Vercel.
  if (isDocx) {
    try {
      const { docxToText } = await import("./docx-editor");
      const text = await docxToText(doc.buffer);
      if (text.length > 0) return chunkTextDeterministic(text);
    } catch (e) {
      console.warn(`[chunkDocument] DOCX text extraction failed for ${doc.name}, falling back to Gemini:`, (e as Error)?.message);
    }
  }

  // For PDFs: extract real page boundaries first so the chunker can use them as
  // ground truth instead of guessing page numbers from layout cues.
  let pdfPagesText: string | null = null;
  if (isPdf) {
    try {
      const pages = await extractPdfPages(doc.buffer);
      if (pages.length > 0 && pages.some((p) => p.text.length > 0)) {
        pdfPagesText = pagesToMarkedText(pages);
      }
    } catch (e) {
      console.warn(`PDF page extraction failed for ${doc.name}, falling back to AI page guessing:`, (e as Error)?.message);
    }
  }

  const prompt = `
# ROLE: DOCUMENT PARSER & SEMANTIC CHUNKER

Extract the FULL text of this compliance document and split it into semantic chunks for indexing.

# CHUNKING RULES:
- Split by logical unit: Chapter, Clause, Paragraph, or Sub-paragraph.
- Each chunk: 300–800 characters. Split long sections into multiple parts.
- Preserve the exact Chapter/Section reference and Page Number for every chunk.
- Include the complete text of each unit — do not truncate or summarise.

${pdfPagesText ? `# PAGE NUMBERS — STRICT RULE:
The document text below has been pre-segmented with explicit page markers of the form "=== PAGE N ===". These markers are the GROUND TRUTH for page numbers. For every chunk, page_number MUST be the number from the most recent "=== PAGE N ===" marker that precedes the chunk's text. Do NOT guess — use the markers verbatim. If a chunk spans a page boundary, use the page where it starts.` : ""}

# OUTPUT FORMAT (JSON Array):
[{
  "content": "Full verbatim text of the chunk",
  "chapter_ref": "e.g. 'Paragraph 10.31(a)' or 'Section 4.2'",
  "page_number": 12
}]
  `;

  const parts: any[] = [{ text: prompt }];
  if (pdfPagesText) {
    parts.push({ text: `\n--- DOCUMENT TEXT (page-tagged) ---\n${pdfPagesText}\n--- END DOCUMENT ---` });
  } else {
    parts.push({ inlineData: { data: doc.buffer.toString("base64"), mimeType: doc.mimeType } });
  }

  // chunkDocument: high-volume / low-stakes parsing — use the fast tier.
  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json" },
  }, { tier: "fast" });

  const text = response.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.chunks ?? []);
  } catch (e) {
    console.error("Failed to parse document chunks:", text.slice(0, 500));
    return [];
  }
}

/**
 * ROUTING — given the regulatory change list and a catalogue of the internal
 * documents (title + opening-scope text), decides which document(s) each change
 * belongs to. This is the relevance filter: the per-change mapping then drafts
 * edits ONLY inside the routed documents, so an impact cannot spread across
 * every overlapping policy. Returns { changeIndex -> [docIndex] }.
 */
export async function routeChangesToSops(
  changes: { chapter_ref: string; change_summary: string }[],
  docs: { title: string; blurb: string }[],
  guidance?: string | null,
): Promise<Record<string, number[]>> {
  if (changes.length === 0 || docs.length === 0) return {};
  const docList = docs
    .map((d, i) => `[${i}] "${d.title}"\n     scope: ${d.blurb}`)
    .join("\n\n");
  const changeList = changes
    .map((c, i) => `CHANGE ${i} — ${c.chapter_ref}: ${c.change_summary}`)
    .join("\n");
  const prompt = `
# ROLE: COMPLIANCE ANALYST — ROUTE EACH REGULATORY CHANGE TO ITS OWNING DOCUMENT(S)

You are given a list of regulatory CHANGES and a numbered catalogue of the bank's INTERNAL DOCUMENTS. For EVERY change, decide which internal document(s) must be amended to implement it.
${guidanceBlock(guidance)}
# RULES:
- A change is OWNED by the document whose subject is the natural home for that topic. MOST changes have exactly ONE owning document. Some genuinely span 2. Use 3 only when the change truly cuts across that many.
- Do NOT route a change to a document just because the document mentions the topic in passing — list only the document(s) that must actually be edited.
- Judge by each document's stated SCOPE, not keyword overlap.
- If no internal document plausibly owns a change, return an empty array — that is a valid and important answer (it means no SOP yet covers the new requirement).

# INTERNAL DOCUMENTS (catalogue):
${docList}

# REGULATORY CHANGES:
${changeList}

# OUTPUT — a JSON object. Key = change number (as a string). Value = array of document numbers.
{ "0": [3], "1": [0, 5], "2": [] }
Every change number from 0 to ${changes.length - 1} MUST appear as a key. Return ONLY the JSON object.
`;
  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    },
    { tier: "fast" },
  );
  try {
    const parsed = JSON.parse(response.text ?? "{}");
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[k] = (v as unknown[])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < docs.length);
      }
    }
    return out;
  } catch {
    console.error("routeChangesToSops: parse failed:", (response.text ?? "").slice(0, 300));
    return {};
  }
}

/**
 * STAGE 2: TARGETED SOP GAP MAPPING
 * For a single regulatory change, finds the EXACT paragraph(s) in internal SOPs that need updating.
 * Runs independently per change so the model has full focus on one gap at a time.
 */
export async function mapChangeToSops(
  change: RegulatoryDelta,
  sops: (
    | { title: string; text: string; governanceTier?: string | null; topicMap?: Record<string, string[]> | null }
    | { title: string; buffer: Buffer; mimeType: string }
  )[],
  guidance?: string | null
): Promise<SopGap[]> {
  const prompt = `
# ROLE: COMPLIANCE GAP ANALYST — PRECISION SOP MAPPER

You have one specific REGULATORY CHANGE. Your task is to find the EXACT location(s) in our internal SOPs that need to be updated to comply with this change.
${guidanceBlock(guidance)}

# REASONING STEP — do this SILENTLY first, inside a <thinking></thinking> block:
1. DEFINE — what exactly did this regulatory change add, remove, reclassify, or re-deadline?
2. MATCH — which SOP clause(s) below topically OWN this control? Name the clause number.
3. ANCHOR — what is the single most distinctive short sentence in that clause to use as find_text?
4. FLAG — would the current SOP wording become NON-COMPLIANT or directly CONFLICT with the new requirement if left unchanged? If so, say so in the action_description.
Then output ONLY the JSON array — NEVER include the <thinking> block or any prose in your final output.

# REGULATORY CHANGE TO MAP:
- Chapter Reference: ${change.chapter_ref}
- Impact Level: ${change.impact}
- Change Summary: ${change.change_summary}
- Old Requirement: ${change.old_requirement}
- New Requirement: ${change.new_requirement}
- Tone Shift: ${change.tone_shift}

# MAPPING INSTRUCTIONS:
1. The SOPs below have been PRE-FILTERED by semantic search — they are the chunks most likely to be relevant to this specific regulatory change. Treat them as your candidate pool, not arbitrary documents.
2. Find sections, paragraphs, or clauses that:
   a) Reference the old requirement directly (use exact text matching where possible), OR
   b) Cover the same topic/process that is now affected by the new requirement, OR
   c) Would be non-compliant with the new requirement if left unchanged.
3. For each affected location:
   - Identify the EXACT current text that needs to change.
   - Propose precise replacement text that satisfies the new regulatory requirement.
   - Be specific — use the same professional regulatory tone as the original SOP.
4. Prefer "find_replace" when you can identify exact text. Use "insertion" for new clauses. Use "contextual" when the SOP topically owns this area but no precise anchor text exists. Use "new_section" only if an entirely new section must be created.
5. Be PRECISE, not exhaustive. Per internal document, find the SINGLE clause that is the primary home for this change and emit ONE impact for it. Emit a second impact for the same document ONLY if the change genuinely cannot be implemented at one clause (e.g. it both revises an existing rule AND requires a new sub-clause). Never more than 2 per document. Do NOT enumerate every clause that merely touches the topic — the goal is the precise primary edit a reviewer applies, not wall-to-wall coverage.

# EVERY CHANGE SHOULD FIND AN OWNER (when candidates were pre-filtered):
The SOP chunks below were ranked by semantic similarity to this change. At least one of them is almost certainly the owning document for this control.
- BEFORE returning an empty array, re-read each candidate SOP once more and ask: "if a regulator audited us, which of these SOPs is the closest match for owning this new requirement?"
- If you find a thematic owner but no exact anchor text, return ONE entry with change_type="contextual", find_text="[end of {nearest existing section heading}]", and replace_text containing the new requirement framed in SOP language. This is BETTER than returning nothing.
- Only return [] when none of the candidate SOPs is even tangentially related to the topic of this change (which is rare — semantic search rarely surfaces totally unrelated chunks).

# TOPIC MATCHING — match by intent, not just keyword overlap:
Examples of topic alignment that should trigger an impact:
- Change about "kill switch" / "customer-initiated freeze" → SOP sections on account suspension, fraud freeze, customer lockdown, incident response
- Change about "API security controls" / "API token lifecycle" → SOP sections on API gateway, OAuth, token management, authentication
- Change about "stand-in processing" / "service continuity" → SOP sections on disaster recovery, failover, business continuity, transaction switch
- Change about "MFA" / "OTP binding" → SOP sections on authentication, multi-factor, second-channel, transaction signing
- Change about "VAPT" / "vulnerability assessment" → SOP sections on penetration testing, security testing, vulnerability scans, red team
- Change about "kill chain" / "monthly threat report" → SOP sections on SOC operations, threat intel, security monitoring
- Change about "cryptographic standards" / "algorithm review" → SOP sections on encryption, key management, cipher suites
- Change about "SBOM" / "third-party software inventory" → SOP sections on vendor management, supplier risk, third-party security
- Change about "uptime disclosure" → SOP sections on service availability, customer communications, public reporting

# ❗❗ CRITICAL — find_text is a LITERAL QUOTE you COPY, never a sentence you WRITE:
find_text is fed to an exact text-locator that searches the real SOP document. Treat it like a Ctrl+F string: if the exact characters are not in the document, the search returns nothing and the impact is THROWN AWAY.

MANDATORY PROCEDURE for every find_text — no exceptions:
1. Find the sentence in the SOP text below — point to where it physically sits.
2. Select a contiguous run of 6-25 words on word boundaries. SHORTER IS BETTER — one precise sentence beats a whole paragraph; a long multi-line quote will not match.
3. Reproduce it character-for-character: same words, same order, same spelling, same punctuation, same dates and numbers.
4. Re-scan the SOP and confirm that exact string is present as one unbroken run. If you cannot find it, you do NOT have an anchor — use the FALLBACK in Rule A.

A find_text is a HALLUCINATION — silently DISCARDED, the whole impact LOST — if you:
- paraphrase, summarise, "tidy up", or rebuild the sentence from memory instead of copying it;
- swap any word for a synonym (SOP says "Guideline" → do NOT write "circular");
- merge two lines, fix a typo, or add an ellipsis ("...");
- include a date, year, or number that is not in that exact SOP sentence (e.g. writing "October 2025" when the sentence has no such date).
- Pick the most unique fragment available: a sentence containing a specific date, number, defined term, proper noun, or clause number.
- Never quote the chunk's "[Section: … | Page: …]" header — that is metadata, not document text.

# ❗ ANTI-HALLUCINATION RULES — READ CAREFULLY:

## Rule A — find_text must come from the SOP, NEVER from the regulation
The "Old Requirement" and "New Requirement" fields above contain REGULATION text. They are PROVIDED FOR CONTEXT ONLY — to help you understand what change to look for.
You MUST NOT copy text from "Old Requirement" or "New Requirement" into the find_text field.
The find_text field is a verbatim quote from the BANK'S INTERNAL SOP PDF that you can see attached below — NOT from the regulation.
If the SOP does not contain matching anchor text, do NOT invent it from the regulation. Use change_type "insertion" with find_text="[end of {nearest existing section heading}]" pointing at the right SOP section, OR change_type "contextual" if the SOP topically owns the area but no precise insertion point exists.
✅ A square-bracket marker is the CORRECT answer when no verbatim sentence can be copied — NOT a failure. It is handled as a review comment on the right section. A bracket marker that ships always beats a fabricated sentence that gets discarded. NEVER invent a sentence just to avoid a bracket marker.
This ban covers ALL of: Change Summary, Old Requirement, New Requirement, and Tone Shift — every word of the REGULATORY CHANGE block. A country name (Burkina Faso, Myanmar…), a FATF list name ("Jurisdictions under Increased Monitoring"), or a plenary month/year ("October 2025", "February 2026") may appear in find_text ONLY if you found that exact wording in the SOP body. Most SOPs reference FATF/sanctions lists generically and name no countries or plenary dates — so for a country-list or plenary-date change the EXPECTED, CORRECT output is change_type "contextual" with a "[bracket marker]". Do not force a find_replace.
FINAL SELF-CHECK: before output, re-read every impact:
- find_text — if it contains a country name, a plenary date, or any phrase you took from the REGULATORY CHANGE block, DELETE it and switch the impact to change_type "contextual" with a "[bracket marker]" naming the SOP section.
- paragraph — if it contains an Act/regulator reference ("of AMLA", "RMiT", "FATF Recommendation"), or a clause number you cannot find printed in the SOP text, fix it: use the SOP's own real heading, or just "General". A fabricated paragraph is stripped automatically — so it only makes the report look wrong.

## Rule B — Consolidate related edits
If a single regulatory change affects multiple closely-related items in the SAME SECTION of an SOP (e.g. "add Kuwait, Papua New Guinea, and update Myanmar" all in the same risk-country table), return ONE consolidated impact entry that updates the whole list/table at once, NOT one impact per item. Do not split a list update into N separate find/replace entries.

## Rule C — Page numbers
The page number MUST be the actual page where the find_text appears in the SOP PDF. If uncertain, set page to 0 — do NOT guess. A wrong page number is worse than no page number.

## Rule D — "paragraph" is COPIED from the SOP, never invented:
Like find_text, the "paragraph" field is a quote you COPY — the SOP's own clause number / heading, exactly as printed in the SOP body (e.g. "C.25.3.1 · AML/CFT Program Controls"). Before you write a clause number, find it in the SOP text and confirm it is there.
- ❌ NEVER put a regulation/Act reference here. "Section 19(2)(b) of AMLA", "Paragraph 10.31 of RMiT", "FATF Recommendation 16" are REGULATOR references — they go in "chapter", NEVER in "paragraph". The bank's SOP does not have a section called "19(2)(b) of AMLA".
- ❌ NEVER invent a clause number. If the SOP only numbers sections 1-3, do not write "Section 4.2". A clause number that is not physically in the SOP is a hallucination.
- If you cannot find the SOP's own clause number, use the SOP's own section HEADING text (copied verbatim) instead. If you cannot find either, leave "paragraph" as just a short generic label like "General" — do NOT fabricate a number.
- VERIFICATION: every "paragraph" is checked against the SOP; a clause number or heading the document does not contain is stripped and replaced with "General — section to be confirmed". So a fabricated paragraph helps nobody — copy a real one or say "General".

## Rule E — sop_title must match the actual document title
Use the document title EXACTLY as it appears in the "--- INTERNAL DOCUMENT" header below (e.g., "R13 GL248"), NOT the long descriptive name from inside the document.

## Rule F — Replacement-text quality bar (this is the standard you MUST hit)
Every replace_text / insertion you produce must be implementation-ready, not a vague summary:
- END with a "Reference:" line citing the regulator source(s) and date(s) — e.g. "Reference: BNM Notification 26 March 2026; FATF Statement 24 March 2026".
- State the effective date and any compliance deadline explicitly — e.g. "effective 24 March 2026", "RHB deadline June 2026".
- Cross-reference the authoritative sibling section when one exists — e.g. "See Section C.14.1.3 for the updated classification table".
- PRESERVE the SOP's existing numbering and layout: if you amend item "3.", keep "3." and append the note; if you add table rows, keep the exact column layout of the existing table.
- KEEP the original obligation text intact and ADD the new note — never delete an existing obligation unless the regulation explicitly revokes it.
- DATES: use ONLY dates that literally appear in the REGULATORY CHANGE block above or in the SOP text. NEVER invent or guess a year. If this is the February 2026 plenary, every date you write is 2026 or later — writing "2024" or "2025" is a hallucination and is forbidden. When unsure of an exact date, omit it rather than guess.

## Rule G — Document version bump
ONLY when the internal SOP's header/cover page shows an effective date that is clearly EARLIER than this regulatory change's effective date, emit ONE extra impact. If the SOP header is already dated on or after the change, do NOT emit a version bump. When you do bump, emit:
- paragraph: "Document Header / Cover Page"
- change_type: "find_replace"
- action_description: "Version bump after changes applied"
- find_text: the verbatim "Version" + "Effective Date" lines from the header
- replace_text: the bumped version, the original effective date kept, plus an "Amended:" line and a "Reason:" line citing this regulatory update.

## Rule H — Contextual, not mechanical
FATF / AML changes require Compliance Officer + Legal interpretation. Treat every impact as a DRAFT for human sign-off — accurate and specific, but never framed as an auto-publishable mechanical edit.

# OUTPUT FORMAT (JSON Array):
[{
  "sop_title": "Exact title of the internal SOP/policy document (short code from the document header, e.g. 'R13 GL248')",
  "paragraph": "The SOP's OWN clause number then its REAL heading — e.g. 'C.14.1.4 · High-risk country customer types'. When you route via the TOPIC INDEX, copy the index ref VERBATIM (it already has the clause's real heading). The name MUST be the clause's actual heading from the SOP — NEVER the topic-index grouping label (e.g. never 'C.14.1.3 · Sanctioned & Prohibited Jurisdictions' unless that is literally the clause's printed heading). NEVER a regulation/Act reference. Use 'General' ONLY as a genuine last resort.",
  "action_description": "ONE-LINE imperative headline describing what changes. Examples: 'Plenary date reference — \\'June 2025\\' → \\'February 2026\\'', 'Add 2 new rows; update Myanmar row', 'Add cross-reference note after existing FATF reference clause', 'Myanmar countermeasure note — add after existing Iran / North Korea entry', 'Version bump after all changes applied'. Be specific and action-oriented.",
  "justification": "ONE sentence: WHY this amendment belongs at this clause — name the clause's subject and how the regulatory change connects to it (e.g. 'C.6.3.1 governs Digital Currency Exchangers, and the FATF Iran update extends restrictions to VASPs'). If paragraph is 'General', say plainly why no specific clause fits.",
  "change_type": "find_replace" | "insertion" | "full_rewrite" | "new_section" | "contextual",
  "chapter": "${change.chapter_ref}",
  "find_text": "ONE short, distinctive sentence (6-25 words) COPIED character-for-character from the SOP body — never written from memory. For find_replace: the exact text to be replaced. For insertion: the exact existing sentence the new content goes immediately AFTER. If no sentence can be copied verbatim, use a square-bracket marker like '[end of existing monitoring procedures clause]' — that is a correct, equally-valid answer, not a fallback to avoid.",
  "replace_text": "The full new text content. For find_replace: the replacement. For insertion: the new paragraphs/rows being added.",
  "page": <page number in the SOP document where this text appears, or 0 if unknown>,
  "line_range": "Best-effort line reference such as '~19056' (single line) or '~4378-4435' (range), or null if unknown",
  "confidence": <integer 0-100 — honest certainty: 90-100 = exact verbatim anchor + mechanical change; 70-89 = solid anchor, wording needs a human check; below 70 = uncertain. Never inflate.>
}]

# ❗ PARAGRAPH IS ALWAYS A REAL CLAUSE: even when find_text is a bracket marker (no verbatim anchor), "paragraph" must still point at a real clause that owns this topic — pick the closest one from the TOPIC INDEX. A bracketed find_text means "no exact anchor sentence"; it does NOT mean "no known location". Only fall back to "General" when the topic genuinely is not covered anywhere in this SOP.

# REFERENCE EXAMPLES OF GOOD OUTPUT (use as a STRUCTURAL template; substitute real values from the attached SOPs):
[
  {
    "sop_title": "R13 GL248",
    "paragraph": "Section C.14.1.4 · High-risk country customer types",
    "action_description": "Plenary date reference — 'June 2025' → 'February 2026'",
    "change_type": "find_replace",
    "find_text": "Please refer to the FATF country list adjustment updated as June 2025.",
    "replace_text": "Please refer to the FATF country list adjustment updated as February 2026 (effective 24 March 2026). Note: Myanmar countermeasures enhanced — RHB deadline June 2026. Kuwait and Papua New Guinea newly added to Increased Monitoring. See Section C.14.1.3 for updated classification table. Reference: BNM Notification 26 March 2026; FATF Statement 24 March 2026.",
    "page": 327,
    "line_range": "~19056"
  },
  {
    "sop_title": "S08 GL151",
    "paragraph": "Section C.8.1.8 · Jurisdiction Monitoring Procedures",
    "action_description": "Add jurisdiction update note after existing FATF reference",
    "change_type": "insertion",
    "find_text": "[end of existing monitoring procedures clause for FATF-listed jurisdiction customers]",
    "replace_text": "Update effective 24 March 2026 (FATF February 2026 Plenary):\\n- Kuwait: newly added to Increased Monitoring. Apply EDD for all new and existing accounts with Kuwait connections. Review within 30 days.\\n- Papua New Guinea: newly added to Increased Monitoring. Same requirements.\\n- Myanmar: countermeasures escalated — deadline June 2026.\\nReference: BNM Notification 26 March 2026. See R13_GL248 Section C.14.1.3.",
    "page": 0,
    "line_range": "~2497-2502"
  }
]
  `;

  const parts: any[] = [{ text: prompt }];
  let anyPdfWithPageMarkers = false;
  for (const sop of sops) {
    if ("buffer" in sop) {
      const isPdf = sop.mimeType === "application/pdf" || /\.pdf$/i.test(sop.title);
      // For PDFs: try to send page-tagged text (pdf-parse) so the model has
      // ground-truth page numbers. Fall back to binary inline data if extraction
      // fails — analysis must not regress.
      let pageTagged: string | null = null;
      if (isPdf) {
        try {
          const pages = await extractPdfPages(sop.buffer);
          if (pages.length > 0 && pages.some((p) => p.text.length > 0)) {
            pageTagged = pagesToMarkedText(pages);
          }
        } catch (e) {
          console.warn(`[mapChangeToSops] page extraction failed for ${sop.title}, falling back to binary:`, (e as Error)?.message);
        }
      }
      if (pageTagged) {
        anyPdfWithPageMarkers = true;
        parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" (page-tagged text) ---\n${pageTagged}\n--- END ---` });
      } else {
        parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" ---` });
        parts.push({ inlineData: { data: sop.buffer.toString("base64"), mimeType: sop.mimeType } });
      }
    } else {
      const roleBlock = buildSopRoleBlock(sop.governanceTier);
      parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" ---${roleBlock}\n${sop.text}` });
    }
  }

  if (anyPdfWithPageMarkers) {
    parts.unshift({
      text: `\n# PAGE NUMBER RULE (PDF documents below):\nFor any internal document marked "(page-tagged text)", the lines "=== PAGE N ===" are GROUND TRUTH page boundaries. When emitting an impact's "page" field, you MUST use the number from the most recent "=== PAGE N ===" marker that precedes the find_text. Do NOT guess — use the markers.`,
    });
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  });

  const out = parseJsonArrayLoose(response.text);
  if (out.length === 0 && (response.text ?? "").trim()) {
    console.error(`Failed to parse SOP mapping for ${change.chapter_ref}:`, (response.text ?? "").slice(0, 300));
  }
  return out;
}

/**
 * Maps a LIST of regulatory changes against the FULL TEXT of ONE internal SOP.
 * Unlike mapChangeToSops (which sees only vector-matched chunks), this sees the
 * entire document — nothing can be missed for lack of retrieval. Used by the
 * full-document regulatory analysis (one call per SOP, or per large segment).
 */
const TIER_ROLE: Record<string, string> = {
  policy: "the high-level GROUP POLICY — it states principles and obligations. Amendments here update a principle or obligation statement, not operational numbers.",
  guideline: "the operational GUIDELINE — it holds the concrete parameters, thresholds, lists and procedures. Amendments here update specific values and clauses.",
  sector_guideline: "a SECTOR / SUBSIDIARY GUIDELINE — sector-specific parameters and adaptations. Amend its own clauses.",
};

/** Builds the optional "document role" block (governance tier) for the prompt. */
function buildSopRoleBlock(governanceTier?: string | null): string {
  const role = governanceTier ? TIER_ROLE[governanceTier] : null;
  if (!role) return "";
  return `\n# DOCUMENT ROLE:\nThis SOP is ${role}\n`;
}

/** Renders the Stage-1 gap list as a compact, numbered ruleset for the prompt. */
function renderGapList(gaps: RegulatoryDelta[]): string {
  return gaps
    .map((g, i) => {
      const prev = String(g.old_requirement ?? "").trim();
      const hasPrev = prev.length > 0 && !/^n\/?a\b/i.test(prev);
      return [
        `GAP ${i + 1} — ${g.chapter_ref}  [${g.impact ?? "medium"} impact]`,
        `  Requirement the SOP must satisfy: ${g.new_requirement}`,
        hasPrev ? `  Previously (for reference only): ${prev}` : null,
        g.change_summary ? `  In short: ${g.change_summary}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * STAGE 2 — checks ONE internal SOP against the Stage-1 GAP LIST (the ruleset
 * already extracted from the regulation). For every gap it decides whether this
 * SOP is affected and, if so, produces the precise amendment. The gaps ARE the
 * rules, so the analysis is driven by the regulation's real content — not a
 * domain-specific re-derivation — and every impact is tagged to the gap it
 * answers (the "chapter" field), which makes the gap→document mapping traceable.
 */
export async function analyzeSopAgainstGaps(
  gaps: RegulatoryDelta[],
  sop: { title: string; text: string; governanceTier?: string | null },
  guidance?: string | null,
): Promise<SopGap[]> {
  if (gaps.length === 0) return [];
  const promptHead = `
# ROLE: COMPLIANCE GAP ANALYST — SOP vs REGULATORY GAP LIST

You are given a fixed list of REGULATORY GAPS (the ruleset, already extracted from the regulation — see the bottom of this prompt) and the FULL TEXT of ONE internal SOP (below the gap list). Work through the gap list and find EVERY place this SOP must be amended to satisfy it.
${buildSopRoleBlock(sop.governanceTier)}
${guidanceBlock(guidance)}

# REASONING STEP — do this SILENTLY first, inside a <thinking></thinking> block:
1. INDEX the SOP — scan the FULL SOP top to bottom; for each section record its REAL clause number and its actual printed heading. From its title and headings, decide this SOP's SUBJECT AREA (what it is the document-of-record for).
2. WALK THE GAP LIST — take each gap in turn. FIRST apply the OWNERSHIP test below: does this gap's topic belong to THIS SOP? If NO, skip it. If YES, find the owning SOP clause and decide whether the SOP is STALE, SILENT, INCONSISTENT, or in CONFLICT with the gap. "paragraph" = that clause's real number + real heading. NEVER a topic label, NEVER an invented clause.
3. ANCHOR — for each impact you keep, pick the single most distinctive short sentence to use as find_text (verbatim), or a [bracket marker] if no clean anchor sentence exists.
Then output ONLY the JSON array — NEVER include the <thinking> block or any prose.

# ❗ OWNERSHIP — only amend this SOP for the gaps it actually owns:
This SOP is ONE document in a library of many; each gap belongs to whichever document governs that subject. Before emitting ANY impact, ask: "Is this SOP a natural home for this gap's topic?"
- YES — the SOP already has a section on this subject (even if out of date), OR the topic squarely falls under this SOP's stated scope / title. → produce an impact.
- NO — the gap belongs to a DIFFERENT document (a board-governance gap belongs in the governance policy; a cryptography gap in the security policy; an incident-handling gap in the incident SOP; a third-party gap in the vendor policy). → emit NOTHING for it. Another document owns it.
A gap this SOP OWNS but is SILENT on → "insertion" / "new_section". A gap this SOP does NOT own → skip entirely. Do NOT force an unrelated requirement into this SOP just to have an answer for every gap.
REALITY CHECK: a typical SOP is touched by only a HANDFUL of the gaps — the ones in its subject area. If you are emitting an impact for nearly every gap in the list, you are forcing unrelated content in — stop and re-apply the ownership test. A focused set of well-owned impacts is the goal; a long scattershot list is a failure.

# MAPPING INSTRUCTIONS:
- Consider every gap, but emit impacts ONLY for the gaps this SOP owns. A gap the SOP already fully satisfies needs NO impact — do not invent busy-work edits.
- There is no fixed cap, but a focused set of well-owned impacts beats a long scattershot list. One owned gap may affect several SOP clauses — one entry per location.
- Prefer "find_replace" when there is exact text to anchor on; "insertion" / "new_section" when the SOP owns the topic but lacks the requirement; "contextual" when the SOP owns the topic but has no precise anchor sentence.
- Every impact's "chapter" field MUST be the GAP reference it answers — copied verbatim from the gap list.

# ❗ find_text is a LITERAL QUOTE — you COPY it, you do not WRITE it:
find_text is fed to an automatic text-locator that runs an exact search against the real SOP. Treat it like a Ctrl+F string: if the exact characters are not in the document, the search returns nothing and the impact is THROWN AWAY.

MANDATORY PROCEDURE — do this for every find_text, no exceptions:
1. Find the sentence in the "INTERNAL SOP DOCUMENT" text below — point to where it physically sits.
2. Select a contiguous run of 6-25 words starting and ending on a word boundary.
3. Reproduce it character-for-character: same words, same order, same spelling, same punctuation, same dates and numbers.
4. Re-scan the SOP text and confirm that exact string is present as one unbroken run. If you cannot find it, you do NOT have an anchor — use the FALLBACK below.

A find_text is a HALLUCINATION — it will be silently DISCARDED and the entire impact LOST — if you:
- paraphrase, summarise, "tidy up", or rebuild the sentence from memory instead of copying it;
- swap any word for a synonym (SOP says "Guideline" → do NOT write "circular");
- merge two lines, fix a typo, or add an ellipsis ("...");
- include a date, year, or number that is not in that exact SOP sentence.

# ✅ FALLBACK — when no exact anchor exists, this is the CORRECT answer, NOT a failure:
If no contiguous prose sentence can be copied verbatim, set change_type "contextual" and put a plain-language description in square brackets as the find_text, e.g. "[end of the incident-escalation clause]". This is handled as a review comment on the right section — a perfectly good, fully-usable outcome. A bracket marker that ships always beats a fabricated sentence that gets discarded. NEVER invent a sentence just to avoid using a bracket marker — there is no penalty for the bracket marker and a total loss for the fabrication.

# Rules for a real (non-bracket) find_text:
- It must be running PROSE with a verb — NOT a heading, section title, table row/cell, "Version"/"Effective Date" line, list label, or anything starting with a bare section number (e.g. "C.1.2 Risk Profiling"). Those live in tables/headings the find/replace engine cannot target and the edit silently fails — use a bracket marker for those instead.
- Avoid any candidate with a run of 3+ spaces or a tab — that is table/column layout, not a sentence.
- Prefer a sentence containing a date, number, defined term, or proper noun, for distinctiveness.

# 🚫 RULE — find_text comes ONLY from the SOP, NEVER from the GAP LIST:
The gap list's sentences are crisp and tempting — but copying ANY of them into find_text is the #1 cause of failure.
- find_text must be text you located INSIDE the "INTERNAL SOP DOCUMENT" section — nowhere else.
- A specific value from a gap (a named entity, a threshold, a date, a list item) may ONLY appear in find_text if you found that exact wording in the SOP body itself. If you took it from the gap list, it is FORBIDDEN.
- When a gap concerns something the SOP only references generically — or does not mention at all — the SOP usually has NO verbatim anchor. The EXPECTED, CORRECT output is then change_type "contextual" (or "insertion") with a "[bracket marker]". Do not force a find_replace.

# ✅ FINAL SELF-CHECK — before you output, re-read every impact:
- find_text — ask: "Could I find this exact string by searching the INTERNAL SOP DOCUMENT text — not the gap list?" If it contains a phrase you took from a gap, DELETE it and use change_type "contextual" + a "[bracket marker]" naming the SOP section. Keep the replace_text — a comment is a success; a fabricated find_replace is discarded entirely.
- paragraph — ask: "Is this clause number / heading actually printed in the SOP text?" If it is a regulator/Act reference ("of AMLA", "RMiT", "FATF Recommendation") or a clause number not in the SOP, fix it: use the SOP's own real heading, or just "General".

# RULE — "paragraph" is COPIED from the SOP, never invented:
"paragraph" MUST be the SOP's own clause/section number or heading, exactly as printed in the SOP body (e.g. "8.2 · Incident Management and Escalation") — confirm it is physically in the SOP text before writing it. NEVER put a regulation/Act reference here ("Section 19(2)(b) of AMLA", "Paragraph 10.31 of RMiT") — those go in "chapter". NEVER invent a clause number. If you cannot find a real SOP clause/heading, write just "General". Every paragraph is verified against the SOP — a fabricated one is stripped automatically.

# RULE F — Replacement-text quality bar:
Every replace_text / insertion must be implementation-ready:
- Your replace_text MUST contain the ENTIRE find_text reproduced WORD-FOR-WORD, then your additions appended. NEVER drop, shorten, reorder, or reword any part of the original text — only ADD to it.
- END with a "Reference:" line citing the regulator source(s) and date(s).
- State effective dates and deadlines explicitly.
- Cross-reference the authoritative sibling section when one exists.
- PRESERVE the SOP's existing numbering and table layout.
- KEEP the original obligation text intact and ADD the new note — never delete unless the regulation revokes it.
- DATES: use ONLY dates that literally appear in a gap above or in the SOP. NEVER invent or guess a year.

# RULE G — Document version bump:
Emit the version bump AT MOST ONCE for the whole document, ONLY if the SOP header/cover shows an effective date EARLIER than these changes. Anchor it ONLY on the verbatim "Version" + "Effective Date" lines of the cover page — NEVER on the document title or filename string. If those header lines do not appear in this text, do NOT emit a version bump at all. When you do: paragraph "Document Header / Cover Page", change_type "find_replace", replace_text = bumped version + original effective date kept + an "Amended:" line + a "Reason:" line.

# RULE H — Contextual, not mechanical: treat every impact as a DRAFT for Compliance + Legal sign-off.

# OUTPUT FORMAT (JSON Array):
[{
  "sop_title": "${sop.title}",
  "paragraph": "<a REAL SOP clause — its clause number + its ACTUAL heading exactly as printed in the SOP, taken from your step-1 INDEX. NEVER an invented clause, NEVER a topic label as the heading. 'General' ONLY as a genuine last resort.>",
  "action_description": "<one-line imperative headline of what changes>",
  "justification": "<ONE sentence: WHY this amendment belongs at this clause — the clause's subject and how the gap connects to it. If paragraph is 'General', state plainly why no specific clause fits.>",
  "change_type": "find_replace" | "insertion" | "contextual" | "new_section",
  "chapter": "<the GAP reference (its 'GAP N — <chapter_ref>' chapter_ref) this impact answers — copied verbatim from the gap list>",
  "find_text": "<short verbatim anchor sentence from the SOP, or a [bracket marker]>",
  "replace_text": "<the full amended/inserted text, meeting Rule F>",
  "page": <page number or 0>,
  "line_range": "<~N or ~N–M, or null>",
  "confidence": <integer 0-100 — your honest certainty this impact is correct (see CONFIDENCE below)>
}]

# ❗ PARAGRAPH IS ALWAYS A REAL CLAUSE: even when find_text is a [bracket marker] (no verbatim anchor), "paragraph" must still name a real clause (number + real heading) that owns this topic — use the closest one from your step-1 INDEX of the SOP. A bracketed find_text means "no exact anchor sentence", NOT "no known location". Only use "General" when the topic genuinely is not covered anywhere in this SOP.

# CONFIDENCE — score every impact honestly:
- 90-100: the find_text is an exact, unambiguous verbatim quote from the SOP AND the change is mechanical (a clear date/number/term swap or a clearly-scoped note). Safe to fast-track.
- 70-89: the anchor is solid but the replacement wording needs human judgement, OR the gap mapping is sound but not certain.
- below 70: the anchor is uncertain, the SOP ownership is debatable, or the change needs interpretation. Flag for review.
Never inflate. A wrong "95" that gets fast-tracked is a compliance failure.

Return ONLY the JSON array. If this SOP already satisfies every gap, return [].

# REGULATORY GAPS (the ruleset — check the SOP against each gap):
${renderGapList(gaps)}
`;
  const sopBlock = `\n# INTERNAL SOP DOCUMENT (full text) — "${sop.title}":\n${sop.text}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [{ text: promptHead }, { text: sopBlock }];

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  });
  const out = parseJsonArrayLoose(response.text);
  if (out.length === 0 && (response.text ?? "").trim()) {
    console.error(`analyzeSopAgainstGaps: no impacts parsed for "${sop.title}":`, (response.text ?? "").slice(0, 300));
  }
  return out;
}

/**
 * Fixed AML/compliance topic taxonomy for the structural index. A stable list
 * keeps the topic map consistent across documents and usable as a routing key.
 */
export const SOP_TOPIC_TAXONOMY = [
  "Country / Jurisdiction Risk",
  "Sanctioned & Prohibited Jurisdictions",
  "Prohibited Customers & Business Relationships",
  "Virtual Assets / Digital Currency / VASP",
  "Customer Due Diligence (CDD)",
  "Enhanced Due Diligence (EDD) triggers",
  "Beneficial Ownership (UBO)",
  "Name & Sanctions Screening",
  "Politically Exposed Persons (PEP)",
  "Transaction Thresholds & Monitoring",
  "Record Keeping & Retention",
  "Suspicious Transaction Reporting & Escalation",
  "Risk-Based Approach & Governance",
] as const;

/**
 * Builds a { topic -> [clause refs] } index for ONE internal SOP — a one-time
 * structural map so the regulatory analysis can route a change straight to the
 * owning clause instead of guessing. Clause refs are copied verbatim from the
 * document; the caller verifies them against the source text before storing.
 */
export async function buildSopTopicMap(
  opts: { title: string; text: string },
): Promise<Record<string, string[]>> {
  const text = opts.text.slice(0, 250_000);
  const prompt = `
# ROLE: SOP STRUCTURAL INDEXER
Build a topic index for ONE internal compliance document: for each topic below
that the document actually covers, list the clause number(s) / section
heading(s) where it is governed.

# TOPICS (use these labels EXACTLY; omit any the document does not cover):
${SOP_TOPIC_TAXONOMY.map((t) => `- ${t}`).join("\n")}

# RULES:
- Each ref MUST be the clause's number FOLLOWED BY its actual heading, both
  copied VERBATIM from the document as printed — e.g. "C.6.3.1 Digital Currency
  Exchanger", "Appendix D.2.1.4 Country Risk Scoring", "Section 8.2 Record
  Keeping". The heading is the clause's OWN title in the SOP — NOT the topic
  label above. If a clause has only a number and no printed heading, the ref is
  just the number. NEVER invent a clause or a heading.
- If a topic has no clear owning clause in this document, omit that topic.
- List the most specific owning clause(s). 1-3 refs per topic is typical.
- Output a JSON object: keys are topic labels, values are arrays of ref
  strings. Include ONLY topics that are present. If the document covers none
  of these topics, return {}.

# OUTPUT (JSON object):
{ "<topic label>": ["<clause number + verbatim heading>", ...], ... }

# INTERNAL DOCUMENT — "${opts.title}":
${text}
`;
  const response = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", maxOutputTokens: 4096 },
  });
  try {
    const parsed = JSON.parse(response.text ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [topic, refs] of Object.entries(parsed)) {
      if (!Array.isArray(refs)) continue;
      const clean = refs.map((r) => String(r ?? "").trim()).filter(Boolean);
      if (clean.length > 0) out[topic] = clean;
    }
    return out;
  } catch {
    console.error(`Failed to parse topic map for "${opts.title}"`);
    return {};
  }
}

export async function analyzePolicy(
  newPolicyData: PolicySource,
  oldPolicyData?: PolicySource,
  sops?: ({ title: string; text: string } | { title: string; buffer: Buffer; mimeType: string })[],
  regulatorCtx: RegulatorContext = "generic"
): Promise<AnalysisResult> {
  const changes = await extractRegulatoryChanges(newPolicyData, oldPolicyData, regulatorCtx);

  let allImpacts: SopGap[] = [];
  if (sops && sops.length > 0) {
    const impactResults = await Promise.all(changes.map((c) => mapChangeToSops(c, sops)));
    allImpacts = impactResults.flat();
  }

  const summaryPrompt = `
Generate a concise executive summary JSON for a compliance gap report.
POLICY: ${newPolicyData.name}
CHANGES FOUND: ${changes.length}
IMPACTS FOUND: ${allImpacts.length}
CHANGE SUMMARIES: ${changes.map(c => `[${c.chapter_ref}] ${c.change_summary}`).join("; ")}

OUTPUT JSON:
{
  "executive": ["4-6 concise bullet points (each 15-30 words) summarising the paradigm shift and key operational impacts. Each bullet must be a complete, standalone thought. Avoid invented numbers — do NOT cite specific paragraph numbers, downtime caps, or dates unless they were quoted verbatim in the extracted changes above. **Wrap the 1-3 most important phrases per bullet in markdown bold** (e.g. control names like **kill switch**, **stand-in processing**, **SBOM**; scope additions like **merchant acquirers and IRIs**; quantitative shifts like **annually instead of every three years**; named obligations like **public quarterly uptime disclosure**) so the reader's eye lands on what matters."],
  "effective_date": "The come-into-force date of the policy itself (e.g. '28 November 2025'), NOT a transition deadline for any specific capability. If unknown, use 'Refer to policy document'.",
  "transition_deadline": "If the policy specifies a separate future date by which institutions must complete migration of a capability (e.g. '30 September 2027' for stand-in processing), record it here. Otherwise omit or use null.",
  "before_count": ${changes.length},
  "after_count": ${changes.length},
  "structural": { "added": [], "renamed": [], "restructured": [] }
}
  `;

  // Exec summary bullets — fast tier is plenty.
  const summaryResponse = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
    config: { responseMimeType: "application/json" },
  }, { tier: "fast" });

  const summary = JSON.parse(summaryResponse.text ?? "{}");
  return { changes, impacts: allImpacts, summary };
}

/**
 * Build just the summary section (used when impacts are computed externally
 * via per-change chunk search instead of analyzePolicy's all-in-one flow).
 */
export async function generateAnalysisSummary(
  changes: RegulatoryDelta[],
  allImpacts: SopGap[],
  policyName: string
): Promise<AnalysisResult["summary"]> {
  const summaryPrompt = `
Generate a concise executive summary JSON for a compliance gap report.
POLICY: ${policyName}
CHANGES FOUND: ${changes.length}
IMPACTS FOUND: ${allImpacts.length}
CHANGE SUMMARIES: ${changes.map(c => `[${c.chapter_ref}] ${c.change_summary}`).join("; ")}

OUTPUT JSON:
{
  "executive": ["4-6 concise bullet points (each 15-30 words) summarising the paradigm shift and key operational impacts. Each bullet must be a complete, standalone thought. **Wrap the 1-3 most important phrases per bullet in markdown bold** (control names, scope additions, quantitative shifts, named obligations) so the reader's eye lands on what matters."],
  "effective_date": "Come-into-force date of the policy (e.g. '28 February 2026'), NOT a transition deadline. If unknown, 'Refer to policy document'.",
  "transition_deadline": "Separate future date for migration of a capability, if applicable. Otherwise null.",
  "before_count": ${changes.length},
  "after_count": ${changes.length},
  "structural": { "added": [], "renamed": [], "restructured": [] }
}
  `;
  // Standalone summary generator — fast tier.
  const response = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
    config: { responseMimeType: "application/json" },
  }, { tier: "fast" });
  return JSON.parse(response.text ?? "{}") as AnalysisResult["summary"];
}

/**
 * DOCUMENT AMENDMENT ENGINE
 * Takes a source document + approved edits, returns the full amended document as styled HTML.
 * Used for the "Apply Changes to Source Documents" workflow.
 */
export async function generateAmendedDocument(
  source: { title: string; buffer: Buffer; mimeType: string },
  edits: Array<{
    change_type: string;
    paragraph?: string;
    chapter?: string;
    find_text?: string;
    replace_text?: string;
    edited_text?: string;
  }>
): Promise<string> {
  const editsBlock = edits.map((e, i) => `
EDIT ${i + 1} — ${(e.change_type || "edit").toUpperCase()}
  Section / paragraph: ${e.paragraph ?? e.chapter ?? "(not specified)"}
  Find (verbatim text to locate): ${e.find_text || "(none — locate by section heading)"}
  Apply: ${e.edited_text ?? e.replace_text ?? "(no text)"}
`).join("\n---\n");

  const prompt = `
# ROLE: DOCUMENT AMENDMENT ENGINE

You are taking a source document and applying a set of approved edits to produce the FULL amended document.

# RULES:
1. Apply each edit EXACTLY as instructed. Do not add, remove, or modify any other content.
2. For "find_replace": locate the find_text verbatim, replace it with the apply text.
3. For "insertion" / "new_section": insert the apply text immediately AFTER the find_text (or at the end of the named section if find_text is empty).
4. PRESERVE the document's original structure: section headings, numbering, lists, tables.
5. Do NOT summarise, abbreviate, or paraphrase any text — output the FULL document text, edits applied.
6. Output as clean semantic HTML. Allowed tags: <h1> <h2> <h3> <h4> <p> <ul> <ol> <li> <table> <thead> <tbody> <tr> <th> <td> <strong> <em> <blockquote>. No inline styles, no classes, no external resources.
7. Wrap any newly inserted text in <mark class="amended">…</mark> so reviewers can spot the changes at a glance. Wrap any text that was replaced (the new replacement only, not the old) in the same <mark> tag.
8. Do NOT include <html>, <head>, or <body> wrappers — output a fragment that starts at <h1>.

# EDITS TO APPLY:
${editsBlock}

Output ONLY the amended document HTML. No commentary, no markdown fences.
  `;

  const response = await generateWithFallback({
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { data: source.buffer.toString("base64"), mimeType: source.mimeType } },
      ],
    }],
    config: { maxOutputTokens: 32768 },
  });

  // Strip any accidental markdown code fences
  let html = (response.text ?? "").trim();
  html = html.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  return html;
}

// ── UC4: Document Simplification ─────────────────────────────────────────────

/** One reviewable simplification edit at a specific place in a document. */
export interface SimplificationAction {
  section: string;
  type: "delete_redundant" | "merge" | "to_bullets" | "plain_english" | "shorten" | "table_restructure";
  before: string;
  after: string;
  rule: string;
  rationale: string;
  confidence: number;
}

/** Splits plain document text into <= maxChars chunks at paragraph (line)
 *  boundaries, so each chunk holds whole paragraphs. A single oversized line
 *  (e.g. a flattened table) is hard-split as a last resort. */
function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { if (buf.trim()) chunks.push(buf); buf = ""; };
  for (const line of text.split(/\n/)) {
    if (line.length > maxChars) {
      flush();
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf && buf.length + line.length + 1 > maxChars) flush();
    buf += (buf ? "\n" : "") + line;
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * DOCUMENT SIMPLIFICATION (UC4). Reads ONE internal document and proposes a
 * list of concrete, reviewable simplification ACTIONS — plain-English rewrites,
 * merges, de-duplication, paragraph→bullets, table restructuring. Terminology
 * standardisation and numbering harmonisation are handled deterministically by
 * the caller and are NOT produced here. Each action's `before` is a verbatim
 * span so a downstream locator can anchor it; the caller verifies it against
 * the source and discards anything that does not match.
 *
 * The document is supplied as PLAIN TEXT (not HTML) — ~5x fewer tokens than the
 * marked-up form — and processed in section-sized chunks run concurrently, so
 * every part is covered thoroughly. Real token usage is metered and returned.
 */
export async function simplifyDocument(
  doc: { title: string; text: string },
  opts?: { instruction?: string | null; guidance?: string | null },
): Promise<{ actions: SimplificationAction[]; usage: TokenUsage }> {
  const chunks = chunkText(doc.text, 80_000);
  const results = await mapLimit(chunks, 6, (chunk) =>
    simplifyDocSegment(doc.title, chunk, opts).catch((e: any) => {
      console.warn(`simplifyDocument: a segment failed:`, e?.message?.slice(0, 100));
      return { actions: [] as SimplificationAction[], usage: EMPTY_USAGE };
    }),
  );
  return {
    actions: results.flatMap((r) => r.actions),
    usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE),
  };
}

/** Simplifies ONE section-sized chunk of a document, metering token usage. */
async function simplifyDocSegment(
  title: string,
  text: string,
  opts?: { instruction?: string | null; guidance?: string | null },
): Promise<{ actions: SimplificationAction[]; usage: TokenUsage }> {
  const prompt = `
# ROLE: DOCUMENT SIMPLIFICATION EDITOR — BANK POLICY & OPERATIONS MANUALS

You are given a SECTION of an internal bank document (plain text, at the bottom
of this prompt). Produce a list of concrete simplification ACTIONS for this
section — each one a specific, reviewable edit.
${opts?.instruction ? `\n# THIS RUN'S SPECIFIC INSTRUCTION (apply in addition to the rules below):\n${opts.instruction}\n` : ""}${guidanceBlock(opts?.guidance)}
# ACTION TYPES — what to look for:
- "delete_redundant" — a clause/sentence that repeats something already stated elsewhere. "after" is an empty string.
- "merge" — two or more nearby points that say the same thing or belong together, combined into one.
- "to_bullets" — a long prose paragraph that reads more clearly as a bulleted list.
- "plain_english" — convoluted, legalistic or passive wording rewritten in plain, direct English.
- "shorten" — a verbose sentence tightened, with no loss of content.
- "table_restructure" — text that is clearly tabular and would read more clearly as a table; "after" describes the proposed layout.
Look across ALL of these types, not just rewording. Terminology standardisation should be folded INTO a plain_english or shorten edit (rephrase the sentence and make its wording consistent in the same action). Do NOT produce standalone actions for numbering or cross-reference renumbering — those need a separate deterministic pass.

# TABLE CELLS — analyse these, do not skip them:
Spans wrapped in "[TABLE n] … [END TABLE n]" markers are table cells, one cell per line. Treat verbose PROSE inside a cell exactly like body prose — simplify it with plain_english / shorten / merge, quoting the cell's text verbatim as "before". Do NOT touch labels, codes, reference numbers, dates, monetary amounts, or short values (a 1-4 word cell has nothing to simplify). NEVER quote a "[TABLE n]" or "[END TABLE n]" marker line as "before".

# ❗ GUARDRAILS — non-negotiable:
- PRESERVE factual accuracy and meaning. NEVER alter a number, threshold, percentage, date, monetary amount, name, role title, or authority limit.
- Do NOT invent information. Do NOT introduce any new normative statement ("must", "shall", "may not", "is required to") that is not already in the source.
- ❌ WORK ONLY FROM THE TEXT BELOW. Never produce an action for a section, heading or sentence that is not literally present in that text. Do NOT pattern-complete the document with topics a bank manual "usually" covers (physical/vault storage, retention schedules, archive rooms, etc.) — if it is not in the text below, it does not exist for you.
- A "delete_redundant" is valid ONLY when the meaning is genuinely stated elsewhere — never drop a unique obligation, control, or requirement.
- Simplify the wording, never the substance. Keep a professional tone.

# ❗ "before" IS A VERBATIM QUOTE — you COPY it, you do not WRITE it:
"before" is matched by an exact text-locator against the real document. Copy a contiguous run of the document text character-for-character — same words, order, spelling, punctuation, numbers. If you cannot copy a clean verbatim span for an action, SKIP that action rather than fabricate one.

# OUTPUT FORMAT (JSON array — return ONLY this):
[{
  "section": "<the section / heading this sits under, copied from the document, e.g. 'C.3'>",
  "type": "delete_redundant" | "merge" | "to_bullets" | "plain_english" | "shorten" | "table_restructure",
  "before": "<verbatim text copied from the document>",
  "after": "<the simplified replacement; empty string for delete_redundant>",
  "rule": "<short label, e.g. 'Plain English', 'Remove redundancy', 'Paragraph to bullets'>",
  "rationale": "<ONE sentence: what this improves and why it is safe>",
  "confidence": <integer 0-100 — honest certainty the meaning is fully preserved>
}]

Work through the WHOLE section and report every genuine simplification you can ground word-for-word in the text above, across all the action types. Do not invent and do not pad with marginal edits — but do not under-report either: a section of dense bank prose usually has real simplifications. If a section genuinely has nothing to simplify, return [].

# DOCUMENT — "${title}":
${text}
`;
  const response = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  }, { tier: "fast" }); // flash-lite first: fast + high capacity. Quick mode must NOT wait on the high-demand 3.5-flash.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  const out = parseJsonArrayLoose(response.text);
  if (out.length === 0 && (response.text ?? "").trim()) {
    console.error(`simplifyDocument: no actions parsed for "${title}":`, (response.text ?? "").slice(0, 300));
  }
  return { actions: out as SimplificationAction[], usage };
}

/** Heuristic pre-filter: is this unit worth sending to the model? Skips short
 *  labels, codes, pure numbers/dates and all-caps headings, so we don't spend a
 *  slot on "v1.0" or "Reference No." cells. */
function isProseCandidate(t: string): boolean {
  if (!t || t.length < 40) return false;
  if (t.split(/\s+/).filter(Boolean).length < 7) return false;
  if (t === t.toUpperCase() && /^[-A-Z0-9 .,&()/'"]+$/.test(t)) return false; // heading / label
  return true;
}

/**
 * PER-UNIT BATCHED SIMPLIFICATION (UC4). Instead of asking the model to "find
 * simplifications" in a big blob — which returns a curated ~10 per call no matter
 * the size — this gives it a NUMBERED list of units (paragraphs + table cells)
 * and asks for a verdict on EACH. Coverage then scales with the document, not
 * the model's selection bias. `before` is the unit's exact text, so every
 * accepted edit anchors cleanly (no quarantine). Batches run with bounded
 * concurrency and each call RETRIES transient failures, so no batch silently
 * drops the way whole chunks did before.
 */
export async function simplifyDocumentByUnits(
  doc: { title: string; units: { text: string; section: string }[] },
  opts?: { instruction?: string | null; guidance?: string | null },
): Promise<{ actions: SimplificationAction[]; usage: TokenUsage }> {
  const candidates = doc.units.filter((u) => isProseCandidate(u.text));
  if (candidates.length === 0) return { actions: [], usage: EMPTY_USAGE };
  const BATCH = 50; // bigger batches = fewer calls = faster (coverage is per-unit, unaffected by batch size)
  const batches: { text: string; section: string }[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));
  // Concurrency 4 on the FAST tier (flash-lite leads — see simplifyUnitBatch):
  // flash-lite sits on a much larger capacity pool than 3.5-flash, so 4 parallel
  // calls are BOTH faster AND less prone to "high demand" than 2 calls on the hot model.
  const results = await mapLimit(batches, 4, (batch) =>
    simplifyUnitBatch(doc.title, batch, opts).catch((e: any) => {
      console.warn(`simplifyDocumentByUnits: a batch failed after retries:`, e?.message?.slice(0, 100));
      return { actions: [] as SimplificationAction[], usage: EMPTY_USAGE };
    }),
  );
  return {
    actions: results.flatMap((r) => r.actions),
    usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE),
  };
}

/** Evaluates ONE batch of units; the model returns an object per unit it changes.
 *  Retries transient errors (e.g. "fetch failed", rate limits) up to 3x. */
async function simplifyUnitBatch(
  title: string,
  units: { text: string; section: string }[],
  opts?: { instruction?: string | null; guidance?: string | null },
): Promise<{ actions: SimplificationAction[]; usage: TokenUsage }> {
  const numbered = units.map((u, i) => `${i + 1}. ${u.text}`).join("\n\n");
  const prompt = `# ROLE: DOCUMENT SIMPLIFICATION — PER-ITEM EVALUATION
You are given NUMBERED text units (paragraphs and table cells) from the bank document "${title}". EVALUATE EVERY UNIT.
For each unit that can be made plainer, shorter, or more active WITHOUT changing meaning, numbers, dates, names, defined terms, or the scope of any obligation, output ONE object. If a unit is already clear, or is a heading/label/code/number/date, OMIT it (output nothing for it).
${opts?.instruction ? `\nThis run's instruction (apply too): ${opts.instruction}\n` : ""}${guidanceBlock(opts?.guidance)}
# RULES
- "after" is the simplified version of the WHOLE unit (you rewrite the entire unit, not a span inside it).
- Preserve EXACTLY: every number, date, %, monetary amount, authority limit, role title, committee name, defined term, system/product name, and cross-reference (e.g. Section 4.2.1, Appendix B).
- British English. Active voice. Short sentences (<= 20 words). Plain verbs. Keep the formal bank-policy register.
- confidence is 70-100; if you would score below 70, OMIT the unit instead.

# OUTPUT — return ONLY a JSON array, one object per unit you are CHANGING:
[{ "i": <unit number>, "type": "plain_english|shorten|merge|to_bullets|delete_redundant", "after": "<simplified whole unit>", "rule": "<short label, e.g. 'Plain English'>", "rationale": "<one sentence>", "confidence": <70-100> }]

# UNITS:
${numbered}
`;
  let response: any = null;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await generateWithFallback({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
      }, { tier: "fast" }); // flash-lite first (fast + high capacity); falls back to 3.5-flash. Per-unit rewriting is simple enough for the lite model.
      break;
    } catch (e: any) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const meta = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    thinkingTokens: meta.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  const raw = parseJsonArrayLoose(response.text) as any[];
  const actions: SimplificationAction[] = [];
  for (const r of raw) {
    const idx = Number(r?.i) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= units.length) continue;
    const before = units[idx].text;
    const after = typeof r?.after === "string" ? r.after.trim() : "";
    if (!after || after === before) continue;
    actions.push({
      section: units[idx].section || "",
      type: (r?.type ?? "plain_english") as SimplificationAction["type"],
      before,
      after,
      rule: typeof r?.rule === "string" ? r.rule : "Plain English",
      rationale: typeof r?.rationale === "string" ? r.rationale : "",
      confidence: typeof r?.confidence === "number" ? r.confidence : 80,
    });
  }
  return { actions, usage };
}

// ── UC4: figure review (vision) ──────────────────────────────────────────────

export interface FigureSuggestion {
  where: string;
  current: string;
  proposed: string;
  rationale: string;
}

export interface FigureReview {
  anchorRelId: string;
  name: string;
  figureType: string;
  summary: string;
  suggestions: FigureSuggestion[];
  /** Ready-to-attach Word comment text built from the suggestions. */
  comment: string;
}

/**
 * FIGURE REVIEW (UC4). Charts/flowcharts/diagrams are embedded as images, which
 * the text pipeline can't see. Each unique figure is shown to the vision model,
 * which reads the text INSIDE the image and proposes simplifications. Since an
 * image can't be redlined, the output is a Word COMMENT (anchored on the figure
 * by the caller) telling a human what should change. Logos/decorative images
 * are recognised and dropped. Runs on the fast tier with per-call retry.
 */
export async function analyzeDocFigures(
  title: string,
  figures: { anchorRelId: string; name: string; mimeType: string; dataBase64: string }[],
  opts?: { guidance?: string | null },
): Promise<{ reviews: FigureReview[]; usage: TokenUsage }> {
  const guidance = (opts?.guidance ?? "").slice(0, 2000);
  const results = await mapLimit(figures, 3, async (fig) => {
    const prompt = `# FIGURE REVIEW — BANK DOCUMENT SIMPLIFICATION
The image above is a figure from the bank document "${title}" (figure name: "${fig.name}").

1. If it is a logo, signature, stamp, decorative element, photo, or software-UI screenshot with no policy/process wording → return {"is_content": false} and nothing else matters.
2. Otherwise (flowchart, process diagram, org chart, decision tree, table rendered as an image, annotated callout):
   - Read ALL text visible in the image.
   - Apply the simplification rules to that text: flag verbose, passive, legalistic or redundant wording and propose plainer phrasing. NEVER change numbers, dates, percentages, names, role titles, committee names or defined terms.
   - This tool cannot edit the image itself — your suggestions will be attached as a Word COMMENT on the figure for a designer to apply manually. Make each suggestion concrete and self-contained.
${guidance ? `\n# HOUSE RULES (apply on top):\n${guidance}\n` : ""}
# OUTPUT — return ONLY one JSON object:
{
  "is_content": true|false,
  "figure_type": "<flowchart | process diagram | org chart | table image | other>",
  "summary": "<one line: what the figure shows>",
  "suggestions": [{ "where": "<which box/label/arrow>", "current": "<verbatim text in the image>", "proposed": "<simplified wording>", "rationale": "<short>" }]
}
If the figure's wording is already clear, return is_content true with an empty suggestions array.`;

    let response: any = null;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await generateWithFallback(
          {
            contents: [
              {
                role: "user",
                parts: [
                  { inlineData: { mimeType: fig.mimeType, data: fig.dataBase64 } },
                  { text: prompt },
                ],
              },
            ],
            config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
          },
          { tier: "fast" },
        );
        break;
      } catch (e: any) {
        if (attempt >= 2) {
          console.warn(`analyzeDocFigures: "${fig.name}" failed:`, e?.message?.slice(0, 80));
          return null;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const meta = (response.usageMetadata ?? {}) as any;
    const usage: TokenUsage = {
      inputTokens: meta.promptTokenCount ?? 0,
      outputTokens: meta.candidatesTokenCount ?? 0,
      thinkingTokens: meta.thoughtsTokenCount ?? 0,
      calls: 1,
    };
    let obj: any = null;
    const raw = (response.text ?? "").replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      obj = JSON.parse(raw);
    } catch {
      const mm = raw.match(/\{[\s\S]*\}/);
      if (mm) {
        try {
          obj = JSON.parse(mm[0]);
        } catch { /* unparseable — treated as no result */ }
      }
    }
    if (!obj || obj.is_content !== true) return { review: null, usage };
    const suggestions: FigureSuggestion[] = (Array.isArray(obj.suggestions) ? obj.suggestions : [])
      .filter((s: any) => s && typeof s.current === "string" && typeof s.proposed === "string" && s.proposed.trim())
      .map((s: any) => ({
        where: String(s.where ?? ""),
        current: String(s.current),
        proposed: String(s.proposed),
        rationale: String(s.rationale ?? ""),
      }));
    if (suggestions.length === 0) return { review: null, usage };
    const comment =
      `AI figure review — this ${obj.figure_type || "figure"} can't be edited automatically; suggested changes:\n` +
      suggestions
        .map((s, i) => `${i + 1}. ${s.where ? `[${s.where}] ` : ""}"${s.current}" → "${s.proposed}"${s.rationale ? ` (${s.rationale})` : ""}`)
        .join("\n");
    const review: FigureReview = {
      anchorRelId: fig.anchorRelId,
      name: fig.name,
      figureType: String(obj.figure_type ?? "figure"),
      summary: String(obj.summary ?? ""),
      suggestions,
      comment,
    };
    return { review, usage };
  });
  const ok = results.filter(Boolean) as { review: FigureReview | null; usage: TokenUsage }[];
  return {
    reviews: ok.map((r) => r.review).filter(Boolean) as FigureReview[],
    usage: ok.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE),
  };
}

// ============================================================================
// CREDIT RISK ALERT — ported from the WCO "AI Credit Alert" methodology.
// Analyzes a credit application against a KB of historical post-mortem "Cases"
// and returns a structured, KB-traceable risk report. Mirrors the WCO system
// prompt + submit_risk_analysis schema, but runs on this app's Gemini fallback
// chain via JSON mode (responseMimeType) instead of OpenAI-style tool calls.
// ============================================================================

export type CreditRiskIndicator = "high" | "probe" | "low";

export type CreditRiskSegment =
  | "management"
  | "cash_flow"
  | "asset_quality"
  | "market_industry"
  | "operational_project"
  | "fraud_integrity"
  | "related_party"
  | "legal_recovery";

/** Located source evidence — computed server-side after analysis (see credit-evidence.ts). */
export interface CreditRiskEvidence {
  applicationFileUrl?: string; // the credit application PDF (public storage URL)
  applicationPage?: number;    // page in the application where applicationQuote was found
  caseDocId?: string;          // sop_documents.id of the cited KB case
  caseFileUrl?: string;        // the KB case source file (public storage URL)
  casePage?: number;           // page in the case doc where traceExcerpt lives
  caseChapter?: string;        // chunk chapter_ref, e.g. "Case 48 - Lessons learnt"
}

/** A recommended mitigation action for a risk, tagged with where it's drawn from. */
export interface CreditMitigation {
  action: string;                                // concrete, actionable measure
  source: "case" | "policy" | "best_practice";   // KB case recommendation, internal policy, or industry best practice
  reference?: string;                            // case/policy title when source is case/policy
}

export interface CreditRiskFinding {
  segment: CreditRiskSegment;
  indicator: CreditRiskIndicator;
  headline?: string;        // "<condition/clause that flags it> — <risk impact>" (≤16 words)
  finding: string;          // "<observation>. This mirrors [Case XX] logic, which warns that ..."
  traceReference: string;   // EXACT KB case title (may be "" when no precedent genuinely fits)
  traceExcerpt: string;     // 2-3 sentence quoted lesson from that case ("" when none)
  confidence?: number;       // 0-100 — strength of the evidence behind this flag
  applicationQuote?: string; // VERBATIM sentence copied from the application (for source highlighting)
  matchTerms?: string[];     // key phrases/figures shared by both sides — bolded in the UI + .docx
  mitigations?: CreditMitigation[]; // recommended mitigation actions (added post-analysis)
  evidence?: CreditRiskEvidence; // located source pages/URLs (added post-analysis)
}

export interface CreditPolicyAlert {
  status: "pass" | "fail" | "probe";
  reference: string;
  description: string;
}

/** A flagged inconsistency or anomaly in the application's financial statements. */
export interface FinancialAnomaly {
  label: string;                                                              // short title (≤8 words)
  category: "spike" | "tax" | "ratio" | "reconciliation" | "liquidity" | "other";
  severity: "high" | "medium" | "low";
  detail: string;                                                             // 1-2 sentences WITH the figures
}

/** Result of an external adverse-news / negative screening (Google Search grounded). */
export interface AdverseNewsResult {
  summary: string;                              // markdown briefing of findings (or "none found")
  sources: { title: string; uri: string }[];    // web sources cited by the grounded search
  foundConcerns: boolean;                       // whether material adverse items surfaced
}

export interface CreditRiskAnalysis {
  applicationSummary: string;
  riskNarrative: string;   // plain-English prose risk assessment for the reviewer
  riskTable: CreditRiskFinding[];
  policyAlerts: CreditPolicyAlert[];
  edgeCases: { assumptions: string[]; ambiguities: string[] };
  probeQuestions: string[];
  referencesUsed: string[];
  overallRisk: CreditRiskIndicator;
  financialAnomalies?: FinancialAnomaly[]; // forensic checks on the statements (added post-analysis)
  adverseNews?: AdverseNewsResult;          // external negative-news screening (added post-analysis)
}

/** Display order + labels for the 8 risk segments (used by the report UI + .docx). */
export const CREDIT_RISK_SEGMENTS: { key: CreditRiskSegment; label: string }[] = [
  { key: "management",          label: "Management" },
  { key: "cash_flow",           label: "Cash Flow" },
  { key: "asset_quality",       label: "Asset Quality" },
  { key: "market_industry",     label: "Market / Industry" },
  { key: "operational_project", label: "Operational / Project" },
  { key: "fraud_integrity",     label: "Fraud / Integrity" },
  { key: "related_party",       label: "Related Party" },
  { key: "legal_recovery",      label: "Legal / Recovery" },
];

const CREDIT_RISK_SYSTEM = `## ROLE
You are a Senior Credit Risk Architect & Policy Analyst in the Credit Department — a technical Subject Matter Expert (SME) in credit risk mitigation, specialising in early-warning signals and policy deviations grounded in historical "Lessons Learnt."

## TASK
Perform a comprehensive risk analysis of an incoming Credit Application by cross-referencing it against the provided Knowledge Base of post-mortem case files and internal credit risk notes.

## STRICT DIRECTIVES
1. RISK HIGHLIGHTING ONLY — do NOT make an approve/reject decision. Produce a "Risk Radar" for the CD Manager.
2. SUMMARISE & SIMPLIFY — synthesise a long application into itemised, risk-focused segments.
3. TRACEABILITY — when a finding cites precedent it MUST use a KB case by its EXACT title from the AVAILABLE REFERENCES list (e.g. "Case 18"), and the finding text follows: describe the observation, then "This mirrors [Case XX] logic, which warns that [the specific lesson]." NEVER invent a case number or cite a title not in AVAILABLE REFERENCES.
   DO NOT FORCE A MATCH: the AVAILABLE REFERENCES are the cases retrieved as most similar to this borrower. If none of them genuinely mirrors a segment's observation, that is normal — set indicator to "low", traceReference to "", traceExcerpt to "", and state plainly e.g. "No close historical precedent in the knowledge base; aligns with policy." A forced, weak case link is WORSE than an honest "no concern".
4. TRAFFIC-LIGHT INDICATORS:
   - "high"  = significant policy mismatch or a clear match to a historical failure.
   - "probe" = ambiguous data, thin margins, or something needing further verification.
   - "low"   = aligns with policy, no historical red-flag pattern.
5. EVIDENCE — for every finding, copy "applicationQuote" VERBATIM from the credit application (exact characters, so it can be located in the source PDF) and list "matchTerms": the specific figures/phrases that prove the parallel between this application and the cited case.

## PROCESSING PIPELINE
1. Ingestion & summarisation: identify core borrower data, requested facilities, and business model.
2. Multidimensional extraction across the 8 risk segments: management, cash_flow, asset_quality, market_industry, operational_project, fraud_integrity, related_party, legal_recovery.
3. Traceability matching: map each finding to a specific KB case by its exact case number.
4. Policy validation against the credit notes (policy alerts).
5. Scoring & reporting: an indicator + justification per segment, plus one overall risk.

## OUTPUT — return ONLY a valid JSON object (no markdown fences, no prose) with EXACTLY this shape:
{
  "applicationSummary": "3-5 sentence factual summary of the borrower and the facilities requested",
  "riskNarrative": "Executive summary in MARKDOWN. Open with 1-2 sentences of prose stating the overall verdict and the core reason. Then a line '**Key concerns**' and 3-5 bullets (each starting '- '), where each bullet begins with a **bolded 2-4 word risk label**, then a colon and the specific consequence WITH the real figure. Then a line '**Mitigants & what to probe**' and 2-4 bullets. Plain English, real figures, tight. Must stay consistent with the riskTable.",
  "riskTable": [
    {
      "segment": "one of: management | cash_flow | asset_quality | market_industry | operational_project | fraud_integrity | related_party | legal_recovery",
      "indicator": "one of: high | probe | low",
      "confidence": "integer 0-100 — how strong the evidence is: high when a retrieved case closely matches AND the application data is explicit; low when speculative or data is thin",
      "headline": "<=16-word plain-English flag in the form 'condition — impact': the specific condition or clause in THIS application that triggers the risk, then its consequence. Name the RISK, not raw figures (e.g. 'Operating cash-flow deficit from debtor build-up — acute liquidity strain', 'Refusing contract-financing ring-fence — cash diversion exposure'). For a no-concern dimension, say so plainly.",
      "finding": "Observation first, then (only if a case genuinely fits): This mirrors [Case XX] logic, which warns that ... — otherwise just the observation + 'No close historical precedent.'",
      "traceReference": "EXACT case title from AVAILABLE REFERENCES, or \"\" if none genuinely fits",
      "traceExcerpt": "2-3 sentence quote of the actual lesson from that case, or \"\" if no case cited",
      "applicationQuote": "A VERBATIM sentence or phrase copied CHARACTER-FOR-CHARACTER from the CREDIT APPLICATION text above that is the primary evidence for this observation. Do NOT paraphrase — copy it exactly so it can be located and highlighted in the source PDF.",
      "matchTerms": ["3-6 short key terms/figures that appear in BOTH the application and the case lesson and establish the parallel — e.g. \"RM73.3 million\", \"over-concentration\", \"related company\". These will be highlighted on both sides."]
    }
  ],
  "policyAlerts": [
    { "status": "pass | fail | probe", "reference": "policy / credit-note reference", "description": "what the application does and why it is flagged" }
  ],
  "edgeCases": { "assumptions": ["..."], "ambiguities": ["..."] },
  "probeQuestions": ["3-5 targeted questions for the CD Manager"],
  "referencesUsed": ["every case title cited above"],
  "overallRisk": "high | probe | low"
}
Output EXACTLY one riskTable row per segment — all 8 segments, in the order listed above.`;

/**
 * Pass 1 of the retrieval-grounded flow: pull the borrower's salient RISK
 * SIGNALS out of the application as short search phrases. These are embedded
 * and used to retrieve the genuinely most-similar historical cases, so the
 * analyzer cites cases selected by similarity — not free-associated.
 */
export async function extractCreditRiskRetrievalQueries(
  applicationText: string,
): Promise<{ queries: string[]; usage: TokenUsage }> {
  const prompt = `You are screening a credit application for risk. List 6-10 SHORT search phrases (5-14 words each) capturing the borrower's most notable RISK SIGNALS — the specific things a credit analyst would look for historical precedent on (e.g. cash-flow deficit & debtor build-up, related-party / single-debtor concentration, keyman or shareholding change, sector/margin pressure for the borrower's industry, facility-structure or working-capital policy deviations, guarantee/security gaps, overbanking). Be concrete to THIS borrower. Output ONLY JSON: {"queries":["phrase", "phrase", ...]}.

## CREDIT APPLICATION
${applicationText.slice(0, 60000)}`;

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 1024 },
    },
    { tier: "fast" },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.filter((q: unknown) => typeof q === "string" && (q as string).trim()).slice(0, 10)
    : [];
  return { queries, usage };
}

/**
 * Backfill "condition — impact" headlines for findings that don't have one
 * (e.g. reports analyzed before the field existed), without re-running the
 * whole analysis. Returns a map of segment → headline.
 */
export async function generateCreditHeadlines(
  items: { segment: string; finding: string }[],
): Promise<Record<string, string>> {
  if (!items.length) return {};
  const list = items.map((it, i) => `${i + 1}. [${it.segment}] ${it.finding}`).join("\n");
  const prompt = `For each credit-risk finding below, write a HEADLINE: a <=16-word plain-English flag in the form "condition — impact". State the specific condition or clause in the application that triggers the risk, then its consequence. Name the RISK, not raw figures. If a finding is "no concern / no precedent", say so plainly.
Return ONLY JSON: {"headlines":[{"segment":"<segment key>","headline":"..."}]}.

FINDINGS:
${list}`;

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 2048 },
    },
    { tier: "fast" },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }
  const out: Record<string, string> = {};
  for (const h of Array.isArray(parsed.headlines) ? parsed.headlines : []) {
    if (h?.segment && typeof h.headline === "string" && h.headline.trim()) out[h.segment] = h.headline.trim();
  }
  return out;
}

const CREDIT_NARRATIVE_GUIDE = `Write a credit-risk EXECUTIVE SUMMARY in GitHub-flavoured MARKDOWN for a reviewer:
- Open with 1-2 sentences of prose: the overall verdict and the core reason.
- Then a line "**Key concerns**" followed by 3-5 bullets (each starting "- "). Begin each bullet with a **bolded 2-4 word risk label**, then a colon and the specific consequence WITH the real figure.
- Then a line "**Mitigants & what to probe**" followed by 2-4 bullets ("- ").
Plain English, real figures, tight. Bold only the key label of each bullet (and the verdict word). No '#' headings, no tables.`;

/**
 * Regenerate just the executive-summary narrative (as markdown) from existing
 * findings — used to upgrade reports whose narrative predates the markdown format,
 * without re-running the whole analysis.
 */
export async function generateCreditNarrative(args: {
  borrowerName: string;
  overallRisk: string;
  applicationSummary?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findings: { segment: string; indicator: string; headline?: string; finding: string; traceReference?: string }[];
}): Promise<string> {
  const findingsBlock = args.findings
    .map(
      (f) =>
        `- ${f.segment} [${f.indicator}]${f.traceReference ? ` (mirrors ${f.traceReference})` : ""}: ${f.headline ?? ""} — ${f.finding}`,
    )
    .join("\n");
  const prompt = `${CREDIT_NARRATIVE_GUIDE}

BORROWER: ${args.borrowerName}
OVERALL RISK: ${args.overallRisk}
${args.applicationSummary ? `\nAPPLICATION SUMMARY:\n${args.applicationSummary}\n` : ""}
FINDINGS:
${findingsBlock}

Output ONLY the markdown summary (no JSON, no code fence).`;

  const response = await generateWithFallback(
    // Generous cap: the quality tier "thinks", which consumes the output budget —
    // too low and the visible markdown gets truncated mid-bullet.
    { contents: [{ role: "user", parts: [{ text: prompt }] }], config: { maxOutputTokens: 8192 } },
    { tier: "quality" },
  );
  return (response.text ?? "").replace(/^```(?:markdown)?\s*|\s*```$/g, "").trim();
}

/**
 * Generate recommended mitigation actions for the flagged risks (high/probe).
 * Prefers measures grounded in the cited cases' "Lessons learnt & recommendations";
 * falls back to industry best practice when the KB offers nothing specific.
 * Returns a map of segment → mitigations.
 */
export async function generateCreditMitigations(args: {
  borrowerName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findings: { segment: string; indicator: string; finding: string; traceReference?: string }[];
  kbContext: string;
}): Promise<Record<string, CreditMitigation[]>> {
  const flagged = args.findings.filter((f) => f.indicator !== "low");
  if (!flagged.length) return {};
  const findingsBlock = flagged
    .map(
      (f, i) =>
        `${i + 1}. [${f.segment}] (${f.indicator})${f.traceReference ? ` — mirrors ${f.traceReference}` : ""}: ${f.finding}`,
    )
    .join("\n");

  const prompt = `You are a credit-risk mitigation advisor. For EACH risk finding below, propose 1-3 CONCRETE, actionable measures the bank could impose to mitigate it (e.g. covenants, security/charge, facility structure, conditions precedent, monitoring, guarantees).
RULES:
- PREFER measures grounded in the knowledge base's "Lessons learnt and recommendations" for the cited case → set "source":"case" and "reference" to the EXACT case title.
- If an internal credit policy/note clearly applies → "source":"policy" with its reference.
- If the knowledge base offers nothing specific → give a sound INDUSTRY BEST PRACTICE → "source":"best_practice" (no reference).
- Be specific to THIS borrower and risk. No generic filler. Each action ≤ 30 words.

Return ONLY JSON: {"mitigations":[{"segment":"<segment key>","items":[{"action":"...","source":"case|policy|best_practice","reference":"..."}]}]}.

BORROWER: ${args.borrowerName}

RISK FINDINGS:
${findingsBlock}

KNOWLEDGE BASE (historical cases incl. their recommendations):
${args.kbContext.slice(0, 120000)}`;

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    },
    { tier: "quality" },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }
  const VALID_SRC = ["case", "policy", "best_practice"];
  const out: Record<string, CreditMitigation[]> = {};
  for (const row of Array.isArray(parsed.mitigations) ? parsed.mitigations : []) {
    if (!row?.segment || !Array.isArray(row.items)) continue;
    const items: CreditMitigation[] = [];
    for (const it of row.items) {
      if (!it || typeof it.action !== "string" || !it.action.trim()) continue;
      items.push({
        action: it.action.trim(),
        source: VALID_SRC.includes(it.source) ? it.source : "best_practice",
        reference: typeof it.reference === "string" && it.reference.trim() ? it.reference.trim() : undefined,
      });
    }
    if (items.length) out[row.segment] = items.slice(0, 3);
  }
  return out;
}

/**
 * Forensic financial pass: flag inconsistencies and anomalies in the
 * application's financial statements (spikes, tax oddities, off-norm activity
 * ratios, reconciliation gaps, management-vs-audited discrepancies).
 */
export async function detectFinancialAnomalies(args: {
  borrowerName: string;
  applicationText: string;
}): Promise<{ anomalies: FinancialAnomaly[]; usage: TokenUsage }> {
  const prompt = `You are a forensic credit analyst reviewing the financial statements in a credit application. Flag INCONSISTENCIES and ANOMALIES in the numbers — be specific and cite the ACTUAL figures. Look for:
- Sudden spikes/drops year-on-year (revenue, PBT/PAT, trade debtors, borrowings, inventory, NTA).
- Unusual tax patterns (effective tax rate far from statutory, little/no tax despite high profit, deferred-tax oddities).
- Activity ratios out of norm (debtor days, creditor days, inventory days, working-capital cycle, asset turnover, gearing).
- Reconciliation gaps (paper profit vs operating cash flow, revenue vs receivables growth, equity vs retained earnings, related-party balances that don't tie).
- Management-account vs audited discrepancies; unfinalised or "pending adjustment" figures.

For EACH anomaly return: "label" (≤8 words), "category" (spike|tax|ratio|reconciliation|liquidity|other), "severity" (high|medium|low), "detail" (1-2 sentences WITH the figures). Order most-severe first. If the statements genuinely look clean, return an empty array.

Return ONLY JSON: {"anomalies":[{"label":"...","category":"...","severity":"...","detail":"..."}]}.

BORROWER: ${args.borrowerName}
CREDIT APPLICATION (financial statements within):
${args.applicationText.slice(0, 120000)}`;

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    },
    { tier: "quality" },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }
  const CATS = ["spike", "tax", "ratio", "reconciliation", "liquidity", "other"];
  const SEV = ["high", "medium", "low"];
  const anomalies: FinancialAnomaly[] = (Array.isArray(parsed.anomalies) ? parsed.anomalies : [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((a: any) => a && typeof a.label === "string" && typeof a.detail === "string")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((a: any) => ({
      label: a.label.trim(),
      category: CATS.includes(a.category) ? a.category : "other",
      severity: SEV.includes(a.severity) ? a.severity : "medium",
      detail: a.detail.trim(),
    }))
    .slice(0, 10);
  return { anomalies, usage };
}

/**
 * External adverse-news / negative screening via Gemini's Google Search
 * grounding. Searches the borrower + key entities for litigation, insolvency,
 * fraud, regulatory action, and negative press; returns a grounded briefing
 * with source links. Uses the existing Gemini key (no separate search API).
 */
export async function searchAdverseNews(args: {
  borrowerName: string;
  entities?: string[];
  context?: string;
}): Promise<{ result: AdverseNewsResult; usage: TokenUsage }> {
  const targets = [args.borrowerName, ...(args.entities ?? [])].map((t) => t.trim()).filter(Boolean);
  const prompt = `You are a credit-risk analyst running an ADVERSE-NEWS / negative screening check. Using web search, look for MATERIAL adverse information about these entities and their key people:
${targets.map((t) => `- ${t}`).join("\n")}
${args.context ? `\nContext (to identify the right entities/people): ${args.context}\n` : ""}
Search specifically for: litigation / lawsuits, winding-up / insolvency / default, fraud or financial crime, regulatory or enforcement action, criminal charges, major operational failures, or significant negative press bearing on creditworthiness.

Write a concise MARKDOWN briefing:
- First line: the overall finding — exactly one of "Material adverse news found", "No material adverse news found", or "Inconclusive".
- Then 0-6 bullets, each: **entity** — what was found, the date, and why it matters to credit risk.
- Only CREDIBLE, on-point items — no speculation or padding. If nothing material is found, say so and note what was checked.`;

  const models = ["gemini-3.5-flash", "gemini-2.5-flash"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastErr: any;
  for (const model of models) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { tools: [{ googleSearch: {} }], maxOutputTokens: 2048 },
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!response) throw lastErr ?? new Error("Adverse-news search failed");

  const summary = (response.text ?? "").trim();
  const sources: { title: string; uri: string }[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) as any[]) {
    const uri = c?.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ title: String(c?.web?.title ?? uri), uri: String(uri) });
    }
  }
  const foundConcerns = /material adverse news found/i.test(summary) && !/no material adverse/i.test(summary);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  return { result: { summary, sources, foundConcerns }, usage };
}

/**
 * Conversational Q&A over a single credit risk report. The caller assembles a
 * grounded context block (the report's analysis + KB excerpts retrieved for the
 * question); this turns it into a constrained chat answer.
 */
export async function chatCreditRisk(args: {
  contextBlock: string;
  history: { role: "user" | "assistant"; content: string }[];
  question: string;
}): Promise<{ answer: string; usage: TokenUsage }> {
  const system = `You are a credit-risk analyst assistant helping a reviewer interrogate ONE credit risk report. Answer the reviewer's question using ONLY the report analysis and knowledge-base excerpts provided below. Rules:
- Never invent facts, figures, or case names. If something is not in the materials, say so plainly.
- Cite supporting cases by their EXACT title (e.g. "Case 48").
- Be concise, specific, and practical — a few sentences or tight bullets. Quote real figures from the analysis where relevant.
- This is risk highlighting, not an approve/reject decision.

=== REPORT CONTEXT ===
${args.contextBlock}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = [
    { role: "user", parts: [{ text: system }] },
    { role: "model", parts: [{ text: "Understood — I'll answer only from this report and its cited cases." }] },
  ];
  for (const h of args.history.slice(-10)) {
    contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] });
  }
  contents.push({ role: "user", parts: [{ text: args.question }] });

  const response = await generateWithFallback({ contents, config: { maxOutputTokens: 1200 } }, { tier: "fast" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  return {
    answer: (response.text ?? "").trim(),
    usage: {
      inputTokens: m.promptTokenCount ?? 0,
      outputTokens: m.candidatesTokenCount ?? 0,
      thinkingTokens: m.thoughtsTokenCount ?? 0,
      calls: 1,
    },
  };
}

/**
 * Analyze a credit application against the KB of historical "Cases".
 * Faithful port of the WCO analyze-credit edge function onto this app's stack.
 */
export async function analyzeCreditRisk(args: {
  borrowerName: string;
  applicationText: string;
  kbContext: string;     // concatenated KB case excerpts, each prefixed with [Case Title]
  availableRefs: string; // newline list of the EXACT case titles the model may cite
  guidance?: string | null;
}): Promise<{ analysis: CreditRiskAnalysis; usage: TokenUsage }> {
  const guidanceBlock = args.guidance?.trim()
    ? `\n## ADDITIONAL ANALYST GUIDANCE (apply this emphasis)\n${args.guidance.trim()}\n`
    : "";

  const userPrompt = `## CREDIT APPLICATION
Borrower: ${args.borrowerName}

${args.applicationText}

## KNOWLEDGE BASE (historical post-mortem cases & credit risk notes)
When citing these, traceReference MUST be the EXACT case title from the AVAILABLE REFERENCES list below.
${args.kbContext || "No knowledge base documents available."}

## AVAILABLE REFERENCES (use these EXACT titles in traceReference — do NOT append any extra text)
${args.availableRefs || "None"}
${guidanceBlock}
Analyze this credit application now. Output ALL 8 risk segments. Every riskTable row's traceReference MUST be an EXACT title from AVAILABLE REFERENCES. Return ONLY the JSON object.`;

  const response = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: `${CREDIT_RISK_SYSTEM}\n\n${userPrompt}` }] }],
    config: { responseMimeType: "application/json", maxOutputTokens: 24576 },
  }, { tier: "quality" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };

  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }

  const VALID: CreditRiskIndicator[] = ["high", "probe", "low"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawRows: any[] = Array.isArray(parsed.riskTable) ? parsed.riskTable : [];
  const analysis: CreditRiskAnalysis = {
    applicationSummary: typeof parsed.applicationSummary === "string" ? parsed.applicationSummary : "",
    riskNarrative: typeof parsed.riskNarrative === "string" ? parsed.riskNarrative : "",
    riskTable: rawRows.map((r) => ({
      segment: r.segment,
      indicator: VALID.includes(r.indicator) ? r.indicator : "low",
      confidence:
        typeof r.confidence === "number" && isFinite(r.confidence)
          ? Math.max(0, Math.min(100, Math.round(r.confidence)))
          : undefined,
      headline: typeof r.headline === "string" && r.headline.trim() ? r.headline.trim() : undefined,
      finding: typeof r.finding === "string" ? r.finding : "",
      traceReference: typeof r.traceReference === "string" ? r.traceReference : "",
      traceExcerpt: typeof r.traceExcerpt === "string" ? r.traceExcerpt : "",
      applicationQuote: typeof r.applicationQuote === "string" ? r.applicationQuote : "",
      matchTerms: Array.isArray(r.matchTerms)
        ? r.matchTerms.filter((t: unknown) => typeof t === "string" && (t as string).trim()).slice(0, 8)
        : [],
    })) as CreditRiskFinding[],
    policyAlerts: Array.isArray(parsed.policyAlerts) ? parsed.policyAlerts : [],
    edgeCases: {
      assumptions: Array.isArray(parsed.edgeCases?.assumptions) ? parsed.edgeCases.assumptions : [],
      ambiguities: Array.isArray(parsed.edgeCases?.ambiguities) ? parsed.edgeCases.ambiguities : [],
    },
    probeQuestions: Array.isArray(parsed.probeQuestions) ? parsed.probeQuestions : [],
    referencesUsed: Array.isArray(parsed.referencesUsed) ? parsed.referencesUsed : [],
    overallRisk: VALID.includes(parsed.overallRisk) ? parsed.overallRisk : "probe",
  };

  return { analysis, usage };
}
