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
  otherReceivables                  non-trade amounts EXCEPT prepayments and EXCEPT related parties — this SUBTOTAL INCLUDES deposits
    deposits                        a component OF otherReceivables (report it as well, do not subtract it)
  prepayments                       prepayments and accrued income — a SIBLING of otherReceivables, NOT inside it
  receivablesDueFromHoldingCompany  holding / parent company only
  receivablesDueFromRelatedParties  directors, subsidiaries, associates, common control

Before answering, run this reconciliation and fix it if it fails:
  tradeReceivables + otherReceivables + prepayments + receivablesDueFromHoldingCompany + receivablesDueFromRelatedParties  =  the receivables note's printed total
(deposits are NOT added again — they are already inside otherReceivables; prepayments ARE added — they sit beside it)

Worked example. A note reading: trade 616,290 / non-trade 747,493 / deposits 45,300 / total 1,409,083 gives
  tradeReceivables = 616290
  otherReceivables = 792793   (747,493 + 45,300 — the whole non-trade subtotal)
  deposits         = 45300    (its component, reported as well)
and 616,290 + 792,793 = 1,409,083, which agrees with the printed total.

Payables nest the same way:
  tradePayables + otherPayablesAndAccruals + payablesDueToHoldingCompany + payablesDueToRelatedParties = the payables note's printed total
with accruals and otherNontradePayables being components OF otherPayablesAndAccruals.
"Deposits received" / "customer deposits" is INSIDE otherNontradePayables (it nests exactly as deposits nest inside non-trade receivables) — include it there, do not drop it.

Report both reconciliations in "noteChecks" whether they agree or not.

CLASSIFICATION RULES — these decide which field a figure belongs to:
- "Trade receivables" / "Trade debtors" -> tradeReceivables. Anything labelled non-trade, other, sundry -> otherReceivables.
- "Deposits" -> deposits. "Prepayments" / "prepaid" / "accrued income" -> prepayments.
- RELATED PARTIES — two very different things appear in these notes, and only one belongs in the related-party fields:
    (a) A SEPARATE line on the face of the statement or in its own note — "Amount owing by directors", "Amount owing by related parties", "Amount due from holding company". THIS is receivablesDueFromHoldingCompany (holding/parent only) or receivablesDueFromRelatedParties (directors, subsidiaries, associates, common control).
    (b) A disclosure INSIDE the receivables note that reads "Included in the above are the following related party balances: ...". Those amounts are ALREADY COUNTED inside tradeReceivables / otherReceivables. Do NOT report them in the related-party fields — doing so counts the money twice.
  Apply exactly the same distinction to payables ("Amount owing to directors" is (a); "included in the above" is (b)).
  IF THERE IS NO (a) LINE, THE RELATED-PARTY FIELD IS 0. Never fall back to the (b) disclosure to fill it — a filing whose only related-party mention is "included in the above" has NO separate related-party balance, and reporting the inclusion would count that money twice.
  WHERE TO LOOK FOR THE (a) LINE: it is usually on the FACE of the Statement of Financial Position itself — a line such as "Amount owing by directors  9  669,885" with its own note number — because that note often carries no table, only wording like "unsecured, interest-free and repayable on demand". So for these related-party fields specifically, check the Statement of Financial Position face as well as the notes. A separate face line is an (a) line even when its note has no figures.
- The same split applies to payables: amounts owing TO those parties.
- "Trade payables" / "Trade creditors" -> tradePayables. Accruals -> accruals. Other/sundry payables -> otherNontradePayables.
- otherPayablesAndAccruals is the FACE line for other payables, EXCLUDING amounts owing to holding company / related parties.
- From the property, plant and equipment note take the CARRYING AMOUNT (not cost, not accumulated depreciation) for: buildings (incl. showroom, factory, shoplot, land and buildings) and officeEquipment — which is the SUM of office equipment + furniture and fittings + renovation / fixtures (SSM classes renovation here).
- Borrowings, two levels:
    currentBorrowings / noncurrentBorrowings = ALL borrowings for that portion, including bank loans, term loans, hire purchase and lease liabilities.
    currentBankLoans / noncurrentBankLoans  = bank and term loans ONLY for that portion — exclude hire purchase and lease liabilities. Read them from the bank-borrowings note, not the lease note.
- keyManagementCompensation: directors' remuneration / key management personnel compensation from the related-party or directors' remuneration note.
- OTHER INCOME nests like the receivables note. otherIncome is the TOTAL; rentalIncome, dividendIncome, interestIncome and gainsOnDisposal are components INSIDE it — report each as well, and do not subtract them from the total. Read them from the other-income note, which itemises them. For a company whose profit comes mostly from investments this note carries the bulk of the profit, so it is worth finding.
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

/**
 * A third pass for the narrative disclosures alone.
 *
 * Measured against the accepted filings, 42 of 75 disclosures came back under
 * HALF the original length — one accounting policy printed 8,100 characters
 * and we captured 183. Meaning was fine (average embedding similarity 0.911);
 * the model was SUMMARISING because it was also juggling a hundred numeric
 * fields in the same call. Given the single job of transcription, and its own
 * output budget, it has room to copy the text out in full.
 */
const NARRATIVE_SYSTEM = `You are TRANSCRIBING sections of a Malaysian audited report into an SSM MBRS filing. You are NOT summarising.

THE ONE RULE: reproduce each section IN FULL, word for word, exactly as printed. These are statutory disclosures — SSM receives what you return, and an abbreviated accounting policy is a deficient filing. If a policy note runs eight paragraphs, return eight paragraphs. Never condense, paraphrase, shorten, or write "..." / "and so on" / "[continues]".

- Copy every paragraph of the section, including sub-headings and numbered or lettered sub-paragraphs.
- Where a note runs across several pages, follow it to its end.
- Keep the wording verbatim, including any spelling the report itself uses.
- Simple HTML only: <p>, <b>, <ul>, <li>. One <p> per paragraph.
- Do not include the figures TABLE inside a note — the numbers are captured separately. Do include the words around it.
- If a section genuinely does not appear anywhere in the report, return an empty string for that key. Never invent disclosure text, and never substitute a generic policy.

EACH KEY COVERS ITS OWN SECTION ONLY — never the whole chapter it sits in. The same text must not appear under two keys.
- "DisclosureOfSignificantAccountingPoliciesExplanatory" is ONLY the short introductory paragraph that opens the accounting-policies note (typically one or two sentences, e.g. that the policies below have been applied consistently). It is NOT the policies themselves.
- Each individual policy goes under its OWN key: "DescriptionOfAccountingPolicyForPropertyPlantAndEquipmentExplanatory", "...ForIncomeTaxExplanatory", "...ForRecognitionOfRevenue", and so on. Put each policy under the key that names it, and nowhere else.
- Likewise "DisclosureOfOtherNotesToAccountsExplanatory" is for notes that have no key of their own — not a dumping ground for notes that do.
A returned section running to many thousands of characters is a sign you have swept in neighbouring sections; re-read and return only the section the key names.

OUTPUT — JSON only, no fence:
{ "narratives": { "<concept>": "<full text>", ... } }`;

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
    config: { responseMimeType: "application/json", maxOutputTokens: 65536, temperature: 0 },
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
      config: { responseMimeType: "application/json", maxOutputTokens: 16384, temperature: 0 },
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

  // Third pass: the narrative disclosures, transcribed in full. Kept only when
  // it returns MORE text than the first pass — a shorter answer means this pass
  // summarised too, and the fuller text is the better filing either way.
  try {
    const narrParts = ocrUsed
      ? [
          { text: [NARRATIVE_SYSTEM, "", narrativeBrief()].join("\n") },
          { text: "\nThe report is attached as a scanned PDF. Read it with OCR and transcribe each section in full." },
          { inlineData: { mimeType: file.mimeType || "application/pdf", data: file.buffer.toString("base64") } },
        ]
      : [
          { text: [NARRATIVE_SYSTEM, "", narrativeBrief()].join("\n") },
          { text: `\nAUDITED FINANCIAL STATEMENTS:\n\n${textLayer}` },
        ];
    const rres = await generateWithFallback({
      contents: [{ role: "user", parts: narrParts }],
      config: { responseMimeType: "application/json", maxOutputTokens: 65536, temperature: 0 },
    }, { tier: "quality" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rm = (rres.usageMetadata ?? {}) as any;
    usage.inputTokens += rm.promptTokenCount ?? 0;
    usage.outputTokens += rm.candidatesTokenCount ?? 0;
    usage.thinkingTokens += rm.thoughtsTokenCount ?? 0;
    usage.calls += 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rp: any = {};
    try { rp = JSON.parse(rres.text ?? "{}"); }
    catch { const m3 = (rres.text ?? "").match(/\{[\s\S]*\}/); if (m3) { try { rp = JSON.parse(m3[0]); } catch { /* keep {} */ } } }

    const fuller = toStringMap(rp.narratives, new Set(NARRATIVE_CONCEPTS));
    let improved = 0;
    for (const [k, v] of Object.entries(fuller)) {
      if (typeof v === "string" && v.trim().length > (extraction.narratives[k] ?? "").length) {
        extraction.narratives[k] = v;
        improved += 1;
      }
    }
    if (improved) {
      extraction.extractionNotes = [
        ...(extraction.extractionNotes ?? []),
        `Narrative pass returned fuller text for ${improved} disclosure(s).`,
      ];
    }
  } catch (err) {
    console.warn("MBRS narrative pass failed (non-fatal):", err);
  }

  return { extraction, usage, model, ocrUsed, principalActivities };
}


// ── consensus extraction ─────────────────────────────────────────────────────

export type AgreementLevel = "unanimous" | "majority" | "disputed";

export interface FieldAgreement {
  level: AgreementLevel;
  /** Every run's reading, in run order, so a reviewer can see what disagreed. */
  candidates: Array<number | string | null>;
}

export interface MbrsConsensusResult extends MbrsExtractResult {
  /** How many runs were merged. */
  runs: number;
  /** Per-field agreement, keyed "current.revenue" / "previous.revenue" / "entity.auditorName". */
  agreement: Record<string, FieldAgreement>;
  /** The individual runs, for evaluation. Not for persistence — they are heavy. */
  individual: MbrsExtraction[];
}

function voteNumbers(vals: Array<number | null | undefined>): { value: number | null; agreement: FieldAgreement } {
  const cands = vals.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const present = cands.filter((v): v is number => v !== null);
  if (present.length === 0) return { value: null, agreement: { level: "unanimous", candidates: cands } };
  // Group to the cent so 1234.5 and 1234.50 are one reading.
  const groups = new Map<string, { value: number; n: number }>();
  for (const v of present) {
    const k = v.toFixed(2);
    const g = groups.get(k);
    if (g) g.n += 1; else groups.set(k, { value: v, n: 1 });
  }
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  const n = cands.length;
  if (best.n === n) return { value: best.value, agreement: { level: "unanimous", candidates: cands } };
  if (best.n > n / 2) return { value: best.value, agreement: { level: "majority", candidates: cands } };
  // No reading commands a majority. A statutory figure the runs cannot agree on
  // is not filed — it is handed to the reviewer with every candidate shown.
  return { value: null, agreement: { level: "disputed", candidates: cands } };
}

function voteStrings(vals: Array<string | undefined>): { value: string | undefined; agreement: FieldAgreement } {
  const cands = vals.map((v) => (typeof v === "string" && v.trim() ? v.trim() : null));
  const present = cands.filter((v): v is string => v !== null);
  if (present.length === 0) return { value: undefined, agreement: { level: "unanimous", candidates: cands } };
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").replace(/[.,]/g, "");
  const groups = new Map<string, { value: string; n: number }>();
  for (const v of present) {
    const k = norm(v);
    const g = groups.get(k);
    if (g) g.n += 1; else groups.set(k, { value: v, n: 1 });
  }
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  const n = cands.length;
  if (best.n === n) return { value: best.value, agreement: { level: "unanimous", candidates: cands } };
  if (best.n > n / 2) return { value: best.value, agreement: { level: "majority", candidates: cands } };
  return { value: undefined, agreement: { level: "disputed", candidates: cands } };
}

/**
 * Runs the extraction `runs` times in parallel and keeps, per field, the reading
 * a majority of runs agree on.
 *
 * WHY: at temperature 0 the model is still not deterministic on a 48-page
 * scan, and a single run's misread (74,543 for a printed 747,493) is
 * indistinguishable from a correct read. Three runs make a misread visible: it
 * becomes the minority. Fields with no majority are returned as null and
 * surfaced to the reviewer with every candidate, rather than filed.
 *
 * COST: linear in `runs` (three runs ≈ RM1.30 per filing at 2026 promo rates)
 * — negligible against the labour of a rejected statutory filing, and the
 * disagreement list tells the reviewer exactly which figures to check instead
 * of all of them.
 */
export async function extractMbrsConsensus(
  file: { buffer: Buffer; mimeType: string },
  runs = 3,
): Promise<MbrsConsensusResult> {
  const n = Math.max(1, Math.floor(runs));
  const results = await Promise.all(Array.from({ length: n }, () => extractMbrsFromAfs(file)));
  const base = results[0];
  if (n === 1) {
    return { ...base, runs: 1, agreement: {}, individual: [base.extraction] };
  }

  const usage: TokenUsage = results.reduce(
    (a, r) => ({
      inputTokens: a.inputTokens + r.usage.inputTokens,
      outputTokens: a.outputTokens + r.usage.outputTokens,
      thinkingTokens: a.thinkingTokens + r.usage.thinkingTokens,
      calls: a.calls + r.usage.calls,
    }),
    { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 },
  );

  const agreement: Record<string, FieldAgreement> = {};
  const merged: MbrsExtraction = { ...emptyExtraction(), narratives: { ...base.extraction.narratives } };

  const numericKeys = new Set(FINANCIAL_FIELDS.map((f) => f.key));
  for (const period of ["current", "previous"] as const) {
    for (const k of numericKeys) {
      const { value, agreement: ag } = voteNumbers(results.map((r) => r.extraction[period][k]));
      if (value !== null) merged[period][k] = value;
      if (ag.level !== "unanimous") agreement[`${period}.${k}`] = ag;
    }
  }
  for (const f of ENTITY_FIELDS) {
    const { value, agreement: ag } = voteStrings(results.map((r) => r.extraction.entity[f.key]));
    if (value !== undefined) merged.entity[f.key] = value;
    if (ag.level !== "unanimous") agreement[`entity.${f.key}`] = ag;
  }

  // Missing = still null after voting. Disputed fields join it, since nothing
  // was filed for them.
  const stillMissing = new Set<string>();
  for (const r of results) for (const m of r.extraction.missing) stillMissing.add(m);
  for (const k of numericKeys) {
    if (typeof merged.current[k] !== "number" && typeof merged.previous[k] !== "number") stillMissing.add(k);
    else stillMissing.delete(k);
  }
  for (const f of ENTITY_FIELDS) {
    if (merged.entity[f.key]) stillMissing.delete(f.key); else if (results.some((r) => r.extraction.missing.includes(f.key))) stillMissing.add(f.key);
  }
  merged.missing = [...stillMissing];
  merged.extractionNotes = [...new Set(results.flatMap((r) => r.extraction.extractionNotes ?? []))].slice(0, 40);
  merged.agreement = agreement;

  return {
    extraction: merged,
    usage,
    model: base.model,
    ocrUsed: results.some((r) => r.ocrUsed),
    principalActivities: base.principalActivities,
    runs: n,
    agreement,
    individual: results.map((r) => r.extraction),
  };
}
