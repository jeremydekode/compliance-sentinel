// AFS (audited financial statements) → MbrsExtraction, via Gemini.
//
// Two things make this different from the other extraction flows in this repo:
//
//  1. Audited reports are very often SCANNED — the sample used to build this
//     pipeline had a zero-length text layer on all 27 pages. So the PDF binary
//     is sent to Gemini for OCR whenever the text layer comes back thin, using
//     the same inlineData fallback the legal flow uses.
//  2. Several required figures live only in the NOTES, not on the face of the
//     statements (the payables breakdown, amounts due from/to the holding
//     company). The prompt calls those out explicitly, because a model reading
//     only the statements will silently return nulls for them.

import { generateWithFallback } from "./gemini";
import { extractPdfPages, pagesToMarkedText } from "./pdf-pages";
import { type TokenUsage } from "./pricing";
import {
  ENTITY_FIELDS, FINANCIAL_FIELDS, NARRATIVE_CONCEPTS,
  emptyExtraction, type MbrsExtraction,
  REGISTRY_ONLY_ENTITY_KEYS,
} from "./mbrs";

/** Below this many characters the text layer is treated as absent and the PDF
 *  is sent as an image for OCR instead. A 27-page scan yields 0; a real text
 *  layer for a full AFS yields tens of thousands. */
const TEXT_LAYER_MIN_CHARS = 500;
const MAX_TEXT_CHARS = 200_000;

function fieldCatalogue(): string {
  const ent = ENTITY_FIELDS.map(
    (f) => `  "${f.key}" — ${f.label}${f.hint ? ` (${f.hint})` : ""}`,
  ).join("\n");
  const fin = FINANCIAL_FIELDS.map(
    (f) => `  "${f.key}" — ${f.label}${f.hint ? ` (${f.hint})` : ""}`,
  ).join("\n");
  return `ENTITY / FILING FIELDS (strings; dates strictly yyyy-mm-dd):\n${ent}\n\nFINANCIAL LINE ITEMS (numbers, captured for BOTH periods):\n${fin}`;
}

const SYSTEM = `You extract structured data from Malaysian audited financial statements (AFS) so it can be converted into an SSM MBRS XBRL filing.

Accuracy matters more than completeness. A wrong number is far worse than a null: the filing is machine-validated by SSM and a mis-keyed figure produces a rejected submission or a materially false statutory filing. If you cannot read a value with confidence, return null and name the field in "missing".

RULES
- Return figures as plain numbers: no currency symbols, no thousands separators, no quotes.
- Malaysian statements show negatives in parentheses: "(6,788)" means -6788.
- Report EXPENSES as POSITIVE numbers (e.g. administrative expenses 56,705 → 56705). Signs are applied downstream.
- Cash flow signs: a "purchase of" / "proceeds from" line is the GROSS amount, so report it POSITIVE (purchase of PPE 48,923 → 48923). A NET subtotal keeps the sign as printed, so "net cash used in investing activities (48,923)" → -48923. Working-capital movements keep their printed sign.
- Do not attempt the "total adjustments" reconciliation subtotal in the cash flow statement — leave it null. It is computed from its components downstream.
- A dash "-" in a figures column means nil for that period. Use 0, not null: null means "I could not find this", which is a different fact.
- The statements show two columns. The LEFT/first is the CURRENT period, the RIGHT/second is the PREVIOUS (comparative) period. Map them to "current" and "previous" respectively — do not swap them.
- Do not compute or infer figures that are not printed. Do not force totals to balance by adjusting a component. If the printed numbers do not add up, report them as printed and say so in "extractionNotes".
- Several fields exist ONLY in the notes to the accounts, not on the face of the statements. You must read the notes to fill these:
    * receivablesDueFromHoldingCompany — from the receivables note
    * payablesDueToHoldingCompany, accruals, otherNontradePayables — from the "other payables and accruals" note; these must sum to the face amount
- Dates must be ISO yyyy-mm-dd. Convert "30th June, 2025" → "2025-06-30".
- The registration number has two forms: the 12-digit MyCoID (e.g. 202101011095) is "registrationNumber"; the older suffixed form (e.g. 1411394-T) is "oldRegistrationNumber".
- If the company declares only one business activity, leave activity 2 and 3 fields empty.
- "principalActivities": quote VERBATIM the sentence(s) describing the company's principal activities / nature of business, usually in the Directors' Report or note 1. Copy the wording exactly as printed — do not paraphrase, do not translate into industry-classification language, and do not invent one. Empty string if the report never states it.

OUTPUT
Return ONLY a JSON object of this shape — no markdown fence, no commentary:
{
  "entity": { "<field>": "<string>", ... },
  "current": { "<field>": <number|null>, ... },
  "previous": { "<field>": <number|null>, ... },
  "narratives": { "<concept>": "<html or plain text>", ... },
  "principalActivities": "<verbatim wording from the report, or empty string>",
  "missing": ["<field>", ...],
  "extractionNotes": ["<short note about anything ambiguous>", ...]
}`;

function narrativeBrief(): string {
  return `NARRATIVE DISCLOSURE BLOCKS
Reproduce the corresponding section of the report as faithful text for each key below, preserving headings and paragraph breaks. Use simple HTML (<p>, <ul>, <li>, <b>) or plain text with newlines. If a section genuinely does not appear in the document, use an empty string — never invent disclosure text.

Keys:
${NARRATIVE_CONCEPTS.map((c) => `  "${c}"`).join("\n")}`;
}

export interface MbrsExtractResult {
  extraction: MbrsExtraction;
  usage: TokenUsage;
  /** The model the API actually answered with — generateWithFallback may have
   *  fallen through the chain, and the rate differs per model, so the caller
   *  must price against this rather than assume the requested model. */
  model: string;
  /** True when the PDF had no usable text layer and OCR was used. */
  ocrUsed: boolean;
  /** The report's own principal-activities wording, verbatim. Evidence shown to
   *  the filer beside MSIC suggestions — never a value in its own right. */
  principalActivities: string;
}

function toNumberMap(raw: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!raw || typeof raw !== "object") return out;
  const valid = new Set(FINANCIAL_FIELDS.map((f) => f.key));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!valid.has(k)) continue;
    if (v === null || v === undefined || v === "") { out[k] = null; continue; }
    // Models occasionally return "1,234" or "(500)" despite the instruction.
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "").replace(/^RM\s*/i, "");
      const neg = /^\(.*\)$/.test(s);
      const n = Number(neg ? s.slice(1, -1) : s);
      out[k] = Number.isFinite(n) ? (neg ? -n : n) : null;
      continue;
    }
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

function toStringMap(raw: unknown, allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue;
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export async function extractMbrsFromAfs(
  file: { buffer: Buffer; mimeType: string },
): Promise<MbrsExtractResult> {
  // Prefer the text layer — cheaper, and far more reliable for exact digits
  // than reading them off a rasterised page.
  let textLayer = "";
  try {
    const pages = await extractPdfPages(file.buffer);
    textLayer = pagesToMarkedText(pages).slice(0, MAX_TEXT_CHARS);
  } catch {
    textLayer = "";
  }
  const ocrUsed = textLayer.replace(/=== PAGE \d+ ===/g, "").trim().length < TEXT_LAYER_MIN_CHARS;

  const instruction = [SYSTEM, "", fieldCatalogue(), "", narrativeBrief()].join("\n");
  const parts = ocrUsed
    ? [
        { text: instruction },
        { text: "\nThe audited report is attached as a scanned PDF. Read it with OCR. Take particular care with digits — verify each figure against the printed subtotals before returning it." },
        { inlineData: { mimeType: file.mimeType || "application/pdf", data: file.buffer.toString("base64") } },
      ]
    : [
        { text: instruction },
        { text: `\nAUDITED FINANCIAL STATEMENTS:\n\n${textLayer}` },
      ];

  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  }, { tier: "quality" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  // In OCR mode the whole PDF rides along as inlineData, so the pages' image
  // tokens are already inside promptTokenCount — there is no separate image
  // line to bill, and the input figure carries it.
  const model = (response as { modelVersion?: string }).modelVersion ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }

  const extraction: MbrsExtraction = {
    ...emptyExtraction(),
    entity: toStringMap(parsed.entity, new Set(ENTITY_FIELDS.map((f) => f.key))),
    current: toNumberMap(parsed.current),
    previous: toNumberMap(parsed.previous),
    narratives: toStringMap(parsed.narratives, new Set(NARRATIVE_CONCEPTS)),
    missing: Array.isArray(parsed.missing)
      ? parsed.missing.filter((s: unknown): s is string => typeof s === "string")
      : [],
    extractionNotes: Array.isArray(parsed.extractionNotes)
      ? parsed.extractionNotes.filter((s: unknown): s is string => typeof s === "string")
      : [],
  };

  // MSIC codes and their business descriptions belong to the SSM registration
  // record, not the accounts. Drop whatever the model offered and flag them for
  // the filer — see REGISTRY_ONLY_ENTITY_KEYS for the case that proved this.
  for (const k of REGISTRY_ONLY_ENTITY_KEYS) delete extraction.entity[k];
  extraction.missing = [...new Set([...extraction.missing, ...REGISTRY_ONLY_ENTITY_KEYS])];

  const principalActivities =
    typeof parsed.principalActivities === "string" ? parsed.principalActivities.trim() : "";

  return { extraction, usage, model, ocrUsed, principalActivities };
}
