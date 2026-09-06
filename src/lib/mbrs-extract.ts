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

/**
 * Fields whose only true source is a note to the accounts. The face of the
 * statements shows a combined line ("Trade and other receivables 1,409,083"),
 * so these can only be read from the note that itemises it.
 */
const NOTE_SOURCED = [
  "tradeReceivables", "otherReceivables", "receivablesDueFromHoldingCompany",
  "receivablesDueFromRelatedParties", "prepayments", "deposits", "inventories",
  "tradePayables", "otherPayablesAndAccruals", "accruals", "otherNontradePayables",
  "payablesDueToHoldingCompany", "payablesDueToRelatedParties",
  "buildings", "officeEquipment", "noncurrentBorrowings", "currentBorrowings",
  "deferredTaxLiabilities", "keyManagementCompensation", "auditorsRemuneration",
  "relatedPartyDividendIncome", "relatedPartyRentalExpense",
] as const;

/**
 * A second, narrow pass over the notes.
 *
 * The single whole-document pass reads the notes, but transcribes them
 * unreliably: on one filing it returned 74,543 for a non-trade receivable the
 * note prints as 747,493. The note itself carries the check — it prints its own
 * total, so components that do not sum to it are provably wrong — and a pass
 * with one job can be told to use it. Splitting this out costs about US$0.04
 * per filing and buys a self-verifying read of the numbers most likely to be
 * misread.
 */
const NOTES_SYSTEM = `You are reading ONLY the NOTES TO THE FINANCIAL STATEMENTS of a Malaysian audited report, to transcribe the note tables that break down the face-of-statement lines.

Work note by note. For each note listed below:
1. Find the note. Transcribe EVERY component line and its figure, for BOTH periods.
2. Read the note's own printed TOTAL.
3. ADD UP the components you transcribed and compare to that printed total.
4. If they do not agree, you misread a digit — go back and re-read the note before answering. Report any that still disagree in "noteChecks".

This arithmetic self-check is the point of this task. A component that does not reconcile to the note's printed total is wrong.

HOW THE RECEIVABLE AND PAYABLE FIELDS NEST. SSM's taxonomy is a hierarchy, not a flat list. Some fields are SUBTOTALS that contain others, so a figure can legitimately appear in two places — but only in the nesting below.

  tradeReceivables                  trade debtors only
  otherReceivables                  ALL non-trade amounts EXCEPT related parties — this SUBTOTAL INCLUDES deposits and prepayments
    deposits                        a component OF otherReceivables (report it as well, do not subtract it)
    prepayments                     a component OF otherReceivables (report it as well, do not subtract it)
  receivablesDueFromHoldingCompany  holding / parent company only
  receivablesDueFromRelatedParties  directors, subsidiaries, associates, common control

Before answering, run this reconciliation and fix it if it fails:
  tradeReceivables + otherReceivables + receivablesDueFromHoldingCompany + receivablesDueFromRelatedParties  =  the receivables note's printed total
(deposits and prepayments are NOT added again — they are already inside otherReceivables)

Worked example. A note reading: trade 616,290 / non-trade 747,493 / deposits 45,300 / total 1,409,083 gives
  tradeReceivables = 616290
  otherReceivables = 792793   (747,493 + 45,300 — the whole non-trade subtotal)
  deposits         = 45300    (its component, reported as well)
and 616,290 + 792,793 = 1,409,083, which agrees with the printed total.

Payables nest the same way:
  tradePayables + otherPayablesAndAccruals + payablesDueToHoldingCompany + payablesDueToRelatedParties = the payables note's printed total
with accruals and otherNontradePayables being components OF otherPayablesAndAccruals.

Report both reconciliations in "noteChecks" whether they agree or not.

CLASSIFICATION RULES — these decide which field a figure belongs to:
- "Trade receivables" / "Trade debtors" -> tradeReceivables. Anything labelled non-trade, other, sundry -> otherReceivables.
- "Deposits" -> deposits. "Prepayments" / "prepaid" / "accrued income" -> prepayments.
- Amounts owing BY directors / holding company / subsidiaries / associates / related companies -> receivablesDueFromHoldingCompany (holding/parent ONLY) or receivablesDueFromRelatedParties (directors, subsidiaries, associates, common control).
- The same split applies to payables: amounts owing TO those parties.
- "Trade payables" / "Trade creditors" -> tradePayables. Accruals -> accruals. Other/sundry payables -> otherNontradePayables.
- otherPayablesAndAccruals is the FACE line for other payables, EXCLUDING amounts owing to holding company / related parties.
- From the property, plant and equipment note take the CARRYING AMOUNT (not cost, not accumulated depreciation) for: buildings (incl. showroom/factory/shoplot) and officeEquipment (office equipment, furniture and fittings).
- Borrowings: split the current portion (currentBorrowings) from the non-current portion (noncurrentBorrowings), including bank loans, term loans, hire purchase and lease liabilities.
- keyManagementCompensation: directors' remuneration / key management personnel compensation from the related-party or directors' remuneration note.
- auditorsRemuneration: the auditors' remuneration figure, usually in the profit-before-tax note.

RULES
- Plain numbers only. Parentheses mean negative. A dash "-" means nil: use 0.
- Expenses POSITIVE.
- Two columns: LEFT/first = current period, RIGHT/second = previous. Do not swap.
- If a note does not exist in this report, leave its fields null. Never invent a figure.
- Report figures EXACTLY as printed. Do not round, rescale or adjust to make anything balance.

OUTPUT — JSON only, no fence:
{
  "current":  { "<field>": <number|null>, ... },
  "previous": { "<field>": <number|null>, ... },
  "noteChecks": ["<note name>: components 1,409,083 vs printed total 1,409,083 — agrees", ...]
}`;

function notesFieldList(): string {
  const specs = FINANCIAL_FIELDS.filter((f) => (NOTE_SOURCED as readonly string[]).includes(f.key));
  return `FIELDS TO RETURN (numbers, both periods):\n${specs
    .map((f) => `  "${f.key}" — ${f.label}${f.hint ? ` (${f.hint})` : ""}`)
    .join("\n")}`;
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

  // Second pass: re-read the note tables with the arithmetic self-check. Its
  // values win for note-sourced fields — it saw the itemised note with one job,
  // where the first pass saw 48 pages and a hundred fields.
  try {
    const notesParts = ocrUsed
      ? [
          { text: [NOTES_SYSTEM, "", notesFieldList()].join("\n") },
          { text: "\nThe report is attached as a scanned PDF. Read the notes with OCR, and check each note's components against its printed total before answering." },
          { inlineData: { mimeType: file.mimeType || "application/pdf", data: file.buffer.toString("base64") } },
        ]
      : [
          { text: [NOTES_SYSTEM, "", notesFieldList()].join("\n") },
          { text: `\nAUDITED FINANCIAL STATEMENTS:\n\n${textLayer}` },
        ];
    const nres = await generateWithFallback({
      contents: [{ role: "user", parts: notesParts }],
      config: { responseMimeType: "application/json", maxOutputTokens: 16384 },
    }, { tier: "quality" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nm = (nres.usageMetadata ?? {}) as any;
    usage.inputTokens += nm.promptTokenCount ?? 0;
    usage.outputTokens += nm.candidatesTokenCount ?? 0;
    usage.thinkingTokens += nm.thoughtsTokenCount ?? 0;
    usage.calls += 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let np: any = {};
    try { np = JSON.parse(nres.text ?? "{}"); }
    catch { const mm2 = (nres.text ?? "").match(/\{[\s\S]*\}/); if (mm2) { try { np = JSON.parse(mm2[0]); } catch { /* keep {} */ } } }

    const nc = toNumberMap(np.current), npv = toNumberMap(np.previous);
    for (const k of NOTE_SOURCED) {
      if (typeof nc[k] === "number") extraction.current[k] = nc[k];
      if (typeof npv[k] === "number") extraction.previous[k] = npv[k];
    }
    if (Array.isArray(np.noteChecks)) {
      extraction.extractionNotes = [
        ...(extraction.extractionNotes ?? []),
        ...np.noteChecks.filter((x: unknown): x is string => typeof x === "string").slice(0, 20),
      ];
    }
  } catch (err) {
    // Non-fatal by design: the first pass already produced a usable extraction,
    // and a filing without the refined note figures is better than no filing.
    console.warn("MBRS notes pass failed (non-fatal):", err);
  }

  return { extraction, usage, model, ocrUsed, principalActivities };
}
