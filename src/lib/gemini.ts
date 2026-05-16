import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

// Fallback chain: try each model in order until one succeeds.
const MODEL_FALLBACKS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

type GenerateParams = Omit<Parameters<typeof ai.models.generateContent>[0], "model">;

async function generateWithFallback(params: GenerateParams): Promise<Awaited<ReturnType<typeof ai.models.generateContent>>> {
  let lastError: unknown;
  for (const model of MODEL_FALLBACKS) {
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
}

/**
 * STAGE 1: TWO-POLICY FORENSIC DELTA EXTRACTION
 * Compares old vs new policy directly to extract all material regulatory changes.
 */
export async function extractRegulatoryChanges(
  newPolicy: { name: string; buffer: Buffer; mimeType: string },
  oldPolicy?: { name: string; buffer: Buffer; mimeType: string }
): Promise<RegulatoryDelta[]> {
  const prompt = `
# ROLE: CHIEF COMPLIANCE OFFICER — FORENSIC POLICY CHANGE DETECTOR

You are performing a forensic comparison of two versions of a regulatory document. Your mandate is to identify EVERY policy change that requires an organisation to update its internal procedures, SOPs, or controls.

${oldPolicy ? `# DOCUMENTS PROVIDED:
- DOCUMENT A (NEW/UPDATED POLICY): First attachment
- DOCUMENT B (LEGACY BASELINE): Second attachment

Compare Document A against Document B section by section.` : `# DOCUMENT PROVIDED:
- NEW POLICY: First attachment (treat as entirely new requirements)
`}

# WHAT CONSTITUTES A MATERIAL POLICY CHANGE (EXTRACT THESE):
- A reporting/notification deadline changed (e.g. "24 hours" → "6 hours", "annual" → "semi-annual")
- A monetary or quantitative threshold changed (e.g. "RM 10 million" → "RM 5 million")
- A new mandatory control, capability, or system is introduced (e.g. kill-switch, session recording, BCP testing frequency)
- A requirement scope expanded or contracted (e.g. now applies to third-party arrangements, or intra-group transactions)
- A "should" or "may" became a "shall" or "must" (guidance hardened into mandate)
- An entirely new section or chapter was added with substantive obligations
- A compliance review/audit frequency changed
- A new definition was added that changes the scope of who is regulated
- An exemption was removed or a new exemption was added

# WHAT IS NOT A MATERIAL CHANGE (DO NOT INCLUDE):
- Rewording the same meaning without changing the obligation
- Renumbering or reformatting lists or appendices
- Grammar, punctuation, or typographical corrections
- Adding a cross-reference or footnote without changing the obligation
- Cosmetic restructuring of the same content into sub-paragraphs

# SELF-CHECK BEFORE EACH ENTRY:
"Would the Head of Compliance need to commission a project to update internal SOPs, controls, or staff training because of this change?" If NO → skip it.

# OUTPUT FORMAT (JSON Array):
[{
  "chapter_ref": "Specific chapter/paragraph/section reference from the NEW document (e.g. 'Paragraph 10.31(a)')",
  "pages": "",
  "legal_refs": ["Statutory or regulatory references cited"],
  "related_instruments": ["Related guidelines or instruments mentioned"],
  "impact": "high" | "medium" | "low",
  "old_requirement": "The previous obligation verbatim from the legacy doc, or 'N/A - new requirement'",
  "new_requirement": "The new/changed obligation verbatim from the updated doc",
  "change_summary": "One sentence: what operationally changed",
  "tone_shift": "e.g. 'Guidance → Mandate', 'Relaxed → Prescriptive'"
}]

Return ONLY material, actionable changes. Be thorough — missing a real change is a compliance risk.
  `;

  const parts: any[] = [
    { text: prompt },
    { inlineData: { data: newPolicy.buffer.toString("base64"), mimeType: newPolicy.mimeType } },
  ];
  if (oldPolicy) {
    parts.push({ text: "--- LEGACY BASELINE POLICY DOCUMENT ---" });
    parts.push({ inlineData: { data: oldPolicy.buffer.toString("base64"), mimeType: oldPolicy.mimeType } });
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json" },
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
  const prompt = `
# ROLE: DOCUMENT PARSER & SEMANTIC CHUNKER

Extract the FULL text of this compliance document and split it into semantic chunks for indexing.

# CHUNKING RULES:
- Split by logical unit: Chapter, Clause, Paragraph, or Sub-paragraph.
- Each chunk: 300–800 characters. Split long sections into multiple parts.
- Preserve the exact Chapter/Section reference and Page Number for every chunk.
- Include the complete text of each unit — do not truncate or summarise.

# OUTPUT FORMAT (JSON Array):
[{
  "content": "Full verbatim text of the chunk",
  "chapter_ref": "e.g. 'Paragraph 10.31(a)' or 'Section 4.2'",
  "page_number": 12
}]
  `;

  const response = await generateWithFallback({
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { data: doc.buffer.toString("base64"), mimeType: doc.mimeType } },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });

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
1. Scan ALL provided internal SOPs and policies.
2. Find sections, paragraphs, or clauses that:
   a) Reference the old requirement directly (use exact text matching where possible), OR
   b) Cover the same topic/process that is now affected by the new requirement, OR
   c) Would be non-compliant with the new requirement if left unchanged.
3. For each affected location:
   - Identify the EXACT current text that needs to change.
   - Propose precise replacement text that satisfies the new regulatory requirement.
   - Be specific — use the same professional regulatory tone as the original SOP.
4. If no SOP is affected by this change, return an empty array [].
5. Prefer "find_replace" when you can identify exact text. Use "insertion" for new clauses. Use "new_section" only if an entirely new section must be created.

# CRITICAL: For find_text, provide VERBATIM text from the SOP (at least 20 words of context) so it can be found programmatically. Do not paraphrase or shorten.

# OUTPUT FORMAT (JSON Array):
[{
  "sop_title": "Exact title of the internal SOP/policy document",
  "paragraph": "Section heading or paragraph reference within the SOP",
  "change_type": "find_replace" | "insertion" | "full_rewrite" | "new_section" | "contextual",
  "chapter": "${change.chapter_ref}",
  "find_text": "VERBATIM current text from the SOP to be replaced (empty string if insertion/new_section)",
  "replace_text": "New compliant text that should replace or be inserted",
  "page": <page number in the SOP document where this text appears, or 0 if the document has no page numbers>
}]
  `;

  const parts: any[] = [{ text: prompt }];
  for (const sop of sops) {
    if ("buffer" in sop) {
      parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" ---` });
      parts.push({ inlineData: { data: sop.buffer.toString("base64"), mimeType: sop.mimeType } });
    } else {
      parts.push({ text: `\n--- INTERNAL DOCUMENT: "${sop.title}" ---\n${sop.text}` });
    }
  }

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json" },
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
  newPolicyData: { name: string; buffer: Buffer; mimeType: string },
  oldPolicyData?: { name: string; buffer: Buffer; mimeType: string },
  sops?: ({ title: string; text: string } | { title: string; buffer: Buffer; mimeType: string })[]
): Promise<AnalysisResult> {
  const changes = await extractRegulatoryChanges(newPolicyData, oldPolicyData);

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
  "executive": "150-200 word strategic summary of the compliance paradigm shift and key operational impacts",
  "effective_date": "Enforcement date from the policy, or 'Refer to policy document'",
  "before_count": ${changes.length},
  "after_count": ${changes.length},
  "immediate_actions": ["4 specific, actionable directives for the compliance team"],
  "structural": { "added": [], "renamed": [], "restructured": [] },
  "timeline": []
}
  `;

  const summaryResponse = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
    config: { responseMimeType: "application/json" },
  });

  const summary = JSON.parse(summaryResponse.text ?? "{}");
  return { changes, impacts: allImpacts, summary };
}
