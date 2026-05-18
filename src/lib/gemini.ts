import { GoogleGenAI } from "@google/genai";
import { extractPdfPages, pagesToMarkedText } from "./pdf-pages";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

// Two fallback chains keyed by call tier.
//
//  - "quality" (default): Pro-primary. Use for high-stakes reasoning:
//    UC1 find/replace, RMiT/FATF regulatory delta extraction + SOP mapping,
//    amended-document HTML generation.
//  - "fast": flash-lite-primary. Use for high-volume / low-stakes work:
//    chunking every doc at indexing time, extracting form header fields,
//    one-liner summaries.
//
// Both chains fall through older flash variants on quota / capacity errors.
const FALLBACK_CHAINS = {
  quality: ["gemini-3.1-pro", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  fast:    ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
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
    try {
      return await ai.models.generateContent({ ...params, model });
    } catch (e: any) {
      const msg: string = e?.message ?? "";
      // Only fall back on capacity / not-found errors, not on auth or bad-request errors
      if (msg.includes("high demand") || msg.includes("overloaded") || msg.includes("503") || msg.includes("NOT_FOUND") || msg.includes("not found")) {
        console.warn(`Model ${model} unavailable (${msg.slice(0, 80)}), trying next...`);
        lastError = e;
        continue;
      }
      throw e;
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
    return `
# REGULATOR CONTEXT: FATF (AML/CFT)
This document is from the Financial Action Task Force AML/CFT framework. Apply these FATF-specific rules:

## Structural references
- FATF uses **R.X** = Recommendation, **INR.X** = Interpretive Note, **IO.X** = Immediate Outcome (for Mutual Evaluation Methodology). Use the actual reference type in chapter_ref (e.g. "R.15", "INR.10", "IO.4").
- For FATF **Plenary Statements** (quarterly updates), use references like "Call for Action statement — Iran", "Increased Monitoring list — Kuwait", "Increased Monitoring list — Papua New Guinea".
- "Recommendations" are mandatory standards. "Interpretive Notes" explain HOW to implement them. Changes to INRs typically tighten the implementation bar even when the underlying Recommendation text is unchanged — flag these as material.

## Topic patterns to watch for
beneficial ownership transparency · PEP screening · virtual asset service providers (VASPs) · travel rule · NPO oversight · sanctions evasion · correspondent banking · wire-transfer information · customer due diligence (CDD) tiering · EDD triggers · suspicious transaction reporting (STR/SAR) thresholds · record-retention periods · beneficial-ownership registry obligations · **High-Risk Jurisdictions subject to a Call for Action** · **Jurisdictions under Increased Monitoring (Grey List)**.

## FATF PLENARY STATEMENT — REFERENCE TEMPLATE (use as a structural example only)
When analysing a Plenary Statement (which updates Call-for-Action and Increased-Monitoring lists), expect changes of these forms:

  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ EXAMPLE 1 — Country ADDED to Increased Monitoring                            │
  │   chapter_ref: "FATF Increased Monitoring list — [Country] (added)"          │
  │   title: "[Country] added to Increased Monitoring"                           │
  │   tone_shift: "Scope expansion — new jurisdiction subject to EDD"            │
  │   Internal SOP impact: country lists / risk-rating tables / EDD trigger     │
  │   sections must include the new jurisdiction.                                │
  │                                                                              │
  │ EXAMPLE 2 — Country REMOVED from Increased Monitoring                        │
  │   chapter_ref: "FATF Increased Monitoring list — [Country] (removed)"        │
  │   title: "[Country] removed from Increased Monitoring"                       │
  │   tone_shift: "Scope contraction — jurisdiction no longer requires EDD"      │
  │   Internal SOP impact: same country lists / EDD triggers — country exits.   │
  │                                                                              │
  │ EXAMPLE 3 — Countermeasures ESCALATED for Call-for-Action jurisdiction       │
  │   chapter_ref: "FATF Call for Action — [Country] (countermeasures enhanced)" │
  │   title: "Enhanced countermeasures for [Country]"                            │
  │   tone_shift: "Mandate strengthened — additional countermeasures required"   │
  │   Internal SOP impact: restricted-customer lists, prohibited-account rules. │
  │                                                                              │
  │ EXAMPLE 4 — Plenary date / list version reference                            │
  │   chapter_ref: "Plenary date reference"                                      │
  │   title: "Update plenary date reference"                                     │
  │   tone_shift: "Administrative — reference date refresh"                      │
  │   Internal SOP impact: any "Refer to FATF [Month Year] statement" lines.   │
  └──────────────────────────────────────────────────────────────────────────────┘

  These are EXAMPLES of the structural form. Your output must use the ACTUAL country names, dates, and references from the attached documents — not these placeholders.

## Common internal SOP sections that need updating after a Plenary Statement
For AML/CFT internal policies (e.g. Group AML/CFT/CPF Guidelines, Group AML/CFT/CPF Policy, division-level AML/CFT Guidelines), expect impacts in sections like:
- "High-risk country customer types" / "Restricted Customers" / "Prohibited Customers"
- "Jurisdiction Risk Table" / "EDD Trigger" / "Enhanced Due Diligence"
- "Jurisdiction Monitoring Procedures" / "Compliance-maintained list"
- "Document Header" / "Cover Page" version-bump on the SOP itself
Consolidate multi-country list updates into ONE impact per affected SOP section (e.g. one impact "update FATF risk-country list" rather than four separate per-country edits).

## Completeness
A typical FATF Plenary Statement update produces 4-8 distinct regulatory changes and touches 2-5 internal SOP sections. Re-scan the document if your output is materially smaller than that.`;
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

export async function extractRegulatoryChanges(
  newPolicy: PolicySource,
  oldPolicy?: PolicySource,
  regulatorCtx: RegulatorContext = "generic"
): Promise<RegulatoryDelta[]> {
  const prompt = `
# ROLE: CHIEF COMPLIANCE OFFICER — FORENSIC POLICY CHANGE DETECTOR

You are performing a forensic comparison of two versions of a regulatory document. Your mandate is to identify EVERY policy change that requires an organisation to update its internal procedures, SOPs, or controls.

${regulatorGuidance(regulatorCtx)}

${oldPolicy ? `# DOCUMENTS PROVIDED:
- DOCUMENT A (NEW/UPDATED POLICY): First attachment
- DOCUMENT B (LEGACY BASELINE): Second attachment

Compare Document A against Document B section by section.` : `# DOCUMENT PROVIDED:
- NEW POLICY: First attachment (treat as entirely new requirements)
`}

# WHAT CONSTITUTES A MATERIAL POLICY CHANGE (EXTRACT EVERY ONE OF THESE):

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

# COMPLETENESS REQUIREMENT:
Sweep the ENTIRE document including ALL appendices, interpretive notes, glossary entries, and best-practice annexes before finalising. Re-scan specifically for: (a) new appendices, (b) new sub-paragraphs and sub-sub-paragraphs, (c) softly-worded new obligations the AI tends to skip, (d) regulator-specific patterns listed in the REGULATOR CONTEXT block above. Refer to the typical revision-size estimate in that block — if your output is materially smaller than that range, do another pass.

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
  "new_requirement": "The new/changed obligation verbatim from the updated doc",
  "change_summary": "One sentence: what operationally changed",
  "tone_shift": "e.g. 'Guidance → Mandate', 'Relaxed → Prescriptive', 'New requirement'"
}]

Return ONLY material, actionable changes. Be thorough — missing a real change is a compliance risk.
There is NO upper limit on the number of changes you may return. List every material policy shift you can detect, even if it produces 20, 50, or more entries. Do not summarise multiple distinct obligations into a single entry.
  `;

  const parts: any[] = [{ text: prompt }];
  parts.push(...policyToParts("NEW POLICY DOCUMENT", newPolicy));
  if (oldPolicy) {
    parts.push(...policyToParts("LEGACY BASELINE POLICY DOCUMENT", oldPolicy));
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 32768 },
  });

  const text = response.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.changes ?? []);
  } catch (e) {
    console.error("Failed to parse regulatory changes:", text.slice(0, 500));
    return [];
  }
}

/**
 * SEMANTIC CHUNKING ENGINE
 * Extracts granular text pieces from a document for full-text indexing.
 */
export async function chunkDocument(
  doc: { name: string; buffer: Buffer; mimeType: string }
): Promise<Array<{ content: string; chapter_ref?: string; page_number?: number }>> {
  const isPdf = doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.name);

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
 * STAGE 2: TARGETED SOP GAP MAPPING
 * For a single regulatory change, finds the EXACT paragraph(s) in internal SOPs that need updating.
 * Runs independently per change so the model has full focus on one gap at a time.
 */
export async function mapChangeToSops(
  change: RegulatoryDelta,
  sops: ({ title: string; text: string } | { title: string; buffer: Buffer; mimeType: string })[]
): Promise<SopGap[]> {
  const prompt = `
# ROLE: COMPLIANCE GAP ANALYST — PRECISION SOP MAPPER

You have one specific REGULATORY CHANGE. Your task is to find the EXACT location(s) in our internal SOPs that need to be updated to comply with this change.

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
5. There is NO upper limit on the number of impacts you may return. If a single regulatory change affects 7 different internal SOPs (or 7 different paragraphs in the same SOP), return all 7 entries. Do NOT consolidate distinct affected paragraphs into a single entry.

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

# CRITICAL: For find_text, provide VERBATIM text from the SOP (at least 20 words of context) so it can be found programmatically. Do not paraphrase or shorten.

# ❗ ANTI-HALLUCINATION RULES — READ CAREFULLY:

## Rule A — find_text must come from the SOP, NEVER from the regulation
The "Old Requirement" and "New Requirement" fields above contain REGULATION text. They are PROVIDED FOR CONTEXT ONLY — to help you understand what change to look for.
You MUST NOT copy text from "Old Requirement" or "New Requirement" into the find_text field.
The find_text field is a verbatim quote from the BANK'S INTERNAL SOP PDF that you can see attached below — NOT from the regulation.
If the SOP does not contain matching anchor text, do NOT invent it from the regulation. Use change_type "insertion" with find_text="[end of {nearest existing section heading}]" pointing at the right SOP section, OR change_type "contextual" if the SOP topically owns the area but no precise insertion point exists.

## Rule B — Consolidate related edits
If a single regulatory change affects multiple closely-related items in the SAME SECTION of an SOP (e.g. "add Kuwait, Papua New Guinea, and update Myanmar" all in the same risk-country table), return ONE consolidated impact entry that updates the whole list/table at once, NOT one impact per item. Do not split a list update into N separate find/replace entries.

## Rule C — Page numbers
The page number MUST be the actual page where the find_text appears in the SOP PDF. If uncertain, set page to 0 — do NOT guess. A wrong page number is worse than no page number.

## Rule D — Section references
The paragraph reference MUST exist in the SOP. Do not invent section numbers like "Section 4.2" if the SOP only has sections 1-3. If the SOP only contains 30 pages, do NOT cite page 50.

## Rule E — sop_title must match the actual document title
Use the document title EXACTLY as it appears in the "--- INTERNAL DOCUMENT" header below (e.g., "R13 GL248"), NOT the long descriptive name from inside the document.

# OUTPUT FORMAT (JSON Array):
[{
  "sop_title": "Exact title of the internal SOP/policy document (short code from the document header, e.g. 'R13 GL248')",
  "paragraph": "Full section reference with name (e.g. 'Section C.14.1.4 · High-risk country customer types')",
  "action_description": "ONE-LINE imperative headline describing what changes. Examples: 'Plenary date reference — \\'June 2025\\' → \\'February 2026\\'', 'Add 2 new rows; update Myanmar row', 'Add cross-reference note after existing FATF reference clause', 'Myanmar countermeasure note — add after existing Iran / North Korea entry', 'Version bump after all changes applied'. Be specific and action-oriented.",
  "change_type": "find_replace" | "insertion" | "full_rewrite" | "new_section" | "contextual",
  "chapter": "${change.chapter_ref}",
  "find_text": "VERBATIM text from the SOP that anchors this edit. For find_replace: the exact text to be replaced. For insertion: the exact text the new content goes AFTER. If the anchor is a structural location with no concise verbatim text, use a descriptive marker in square brackets: '[end of existing monitoring procedures clause]', '[end of FATF / relevant authorities reference clause — no Feb 2026 note]', '[end of Call for Action prohibition clause referencing Compliance-maintained list]'.",
  "replace_text": "The full new text content. For find_replace: the replacement. For insertion: the new paragraphs/rows being added.",
  "page": <page number in the SOP document where this text appears, or 0 if unknown>,
  "line_range": "Best-effort line reference such as '~19056' (single line) or '~4378-4435' (range), or null if unknown"
}]

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
      parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" ---\n${sop.text}` });
    }
  }

  if (anyPdfWithPageMarkers) {
    parts.unshift({
      text: `\n# PAGE NUMBER RULE (PDF documents below):\nFor any internal document marked "(page-tagged text)", the lines "=== PAGE N ===" are GROUND TRUTH page boundaries. When emitting an impact's "page" field, you MUST use the number from the most recent "=== PAGE N ===" marker that precedes the find_text. Do NOT guess — use the markers.`,
    });
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 32768 },
  });

  const text = response.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`Failed to parse SOP mapping for ${change.chapter_ref}:`, text.slice(0, 300));
    return [];
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
