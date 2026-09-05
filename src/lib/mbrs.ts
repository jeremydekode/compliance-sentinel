// MBRS (Malaysian Business Reporting System) — canonical extraction model.
//
// The pipeline is deliberately three-staged:
//   OCR/text  →  MbrsExtraction (this file)  →  XBRL instance (mbrs-xbrl.ts)
//
// The LLM only ever produces an MbrsExtraction. It never writes XBRL: concept
// names and context refs are schema-constrained, and a hallucinated tag is a
// silent SSM rejection rather than a visible error. Keeping a readable
// intermediate also means the correction UI edits plain labelled numbers.

// Deliberately imports the small generated narratives module rather than the
// full fact template: this file is imported by the review page, and pulling
// mbrs-template.ts in would ship ~120KB of taxonomy scaffolding to the browser.
import { NARRATIVE_CONCEPTS } from "./mbrs-narratives";

export { NARRATIVE_CONCEPTS };

export type Period = "current" | "previous";

export interface FieldSpec {
  key: string;
  label: string;
  /** Statement this line belongs to, for grouping in the review form. */
  group: "entity" | "sofp" | "pl" | "cf";
  type: "text" | "date" | "number" | "money";
  /** Money/number fields are captured per period; entity fields are not. */
  periodic: boolean;
  /** Shown under the field in the review form when the source is non-obvious. */
  hint?: string;
}

/** Company / filing metadata. Sourced from the cover pages, directors' report,
 *  statement by directors and the auditors' report — not the statements. */
export const ENTITY_FIELDS: FieldSpec[] = [
  { key: "entityName", label: "Company name", group: "entity", type: "text", periodic: false },
  { key: "registrationNumber", label: "Registration no. (new format)", group: "entity", type: "text", periodic: false, hint: "12-digit MyCoID, e.g. 202101011095" },
  { key: "oldRegistrationNumber", label: "Registration no. (old format)", group: "entity", type: "text", periodic: false, hint: "e.g. 1411394-T" },
  // SSM allows up to three declared business activities, each carrying its own
  // MSIC code and description on a separate NatureOfBusinessAxis member.
  { key: "msicCode1", label: "MSIC code (activity 1)", group: "entity", type: "text", periodic: false },
  { key: "businessDescription1", label: "Nature of business (activity 1)", group: "entity", type: "text", periodic: false },
  { key: "msicCode2", label: "MSIC code (activity 2)", group: "entity", type: "text", periodic: false, hint: "Leave blank if the company declares only one activity" },
  { key: "businessDescription2", label: "Nature of business (activity 2)", group: "entity", type: "text", periodic: false },
  { key: "msicCode3", label: "MSIC code (activity 3)", group: "entity", type: "text", periodic: false, hint: "Leave blank if unused" },
  { key: "businessDescription3", label: "Nature of business (activity 3)", group: "entity", type: "text", periodic: false },
  { key: "numberOfEmployees", label: "Number of employees", group: "entity", type: "number", periodic: false },
  { key: "currentPeriodStart", label: "Current FY start", group: "entity", type: "date", periodic: false },
  { key: "currentPeriodEnd", label: "Current FY end", group: "entity", type: "date", periodic: false },
  { key: "previousPeriodStart", label: "Previous FY start", group: "entity", type: "date", periodic: false },
  { key: "previousPeriodEnd", label: "Previous FY end", group: "entity", type: "date", periodic: false },
  { key: "director1Name", label: "First signing director", group: "entity", type: "text", periodic: false },
  { key: "director1Id", label: "First director ID no.", group: "entity", type: "text", periodic: false },
  { key: "director2Name", label: "Second signing director", group: "entity", type: "text", periodic: false },
  { key: "director2Id", label: "Second director ID no.", group: "entity", type: "text", periodic: false },
  { key: "directorsReportDate", label: "Directors' report date", group: "entity", type: "date", periodic: false },
  { key: "boardApprovalDate", label: "Date approved by the Board", group: "entity", type: "date", periodic: false, hint: "Statement by Directors / Directors' report signing date if not stated separately" },
  { key: "statutoryDeclarationDate", label: "Statutory declaration date", group: "entity", type: "date", periodic: false, hint: "Date the statutory declaration was signed before the Commissioner for Oaths" },
  { key: "circulationDate", label: "Date circulated to members", group: "entity", type: "date", periodic: false, hint: "Often stamped on the cover page — \"circulated on ...\"" },
  { key: "directorsOtherBenefits", label: "Directors received other benefits by contract?", group: "entity", type: "text", periodic: false, hint: "Yes or No, from the Directors' Report" },
  { key: "contingentLiabilityEnforceable", label: "Contingent liability enforceable within 12 months?", group: "entity", type: "text", periodic: false, hint: "Yes or No, from the Directors' Report" },
  { key: "materialUnusualEvents", label: "Substantial, material or unusual items/events?", group: "entity", type: "text", periodic: false, hint: "Yes or No, from the Directors' Report" },
  { key: "dividendStatus", label: "Status of dividend", group: "entity", type: "text", periodic: false, hint: "As stated in the Directors' Report — e.g. \"Not mentioned\" or \"Mentioned but not recommended\"" },
  { key: "auditorsOpinion", label: "Auditor's opinion", group: "entity", type: "text", periodic: false, hint: "e.g. Unmodified opinion" },
  { key: "auditorName", label: "Auditor name", group: "entity", type: "text", periodic: false },
  { key: "auditorLicenseNumber", label: "Auditor licence no.", group: "entity", type: "text", periodic: false },
  { key: "auditFirmName", label: "Audit firm", group: "entity", type: "text", periodic: false },
  { key: "auditFirmRegistrationNumber", label: "Audit firm AF no.", group: "entity", type: "text", periodic: false },
  { key: "auditFirmAddress", label: "Audit firm address", group: "entity", type: "text", periodic: false },
  { key: "auditFirmPostcode", label: "Audit firm postcode", group: "entity", type: "text", periodic: false },
  { key: "auditFirmTown", label: "Audit firm town", group: "entity", type: "text", periodic: false },
  { key: "auditFirmState", label: "Audit firm state", group: "entity", type: "text", periodic: false },
  { key: "auditorReportDate", label: "Auditor's report date", group: "entity", type: "date", periodic: false },
];

/** Statement of financial position. */
export const SOFP_FIELDS: FieldSpec[] = [
  { key: "propertyPlantAndEquipment", label: "Property, plant and equipment", group: "sofp", type: "money", periodic: true },
  { key: "totalNoncurrentAssets", label: "Total non-current assets", group: "sofp", type: "money", periodic: true },
  { key: "otherReceivables", label: "Other receivables, deposits and prepayments", group: "sofp", type: "money", periodic: true, hint: "EXCLUDING trade receivables and EXCLUDING amounts due from holding company or related parties. If the face shows one combined \"trade and other receivables\" line, take only the non-trade, non-related-party components from the note (deposits, prepayments, sundry receivables)." },
  { key: "receivablesDueFromHoldingCompany", label: "— of which due from holding company", group: "sofp", type: "money", periodic: true, hint: "Holding / parent company ONLY. Breakdown inside other receivables." },
  { key: "receivablesDueFromRelatedParties", label: "— of which due from other related parties", group: "sofp", type: "money", periodic: true, hint: "Directors, subsidiaries, associates, companies under common control — NOT the holding company. Breakdown inside other receivables." },
  { key: "cashAndCashEquivalents", label: "Cash and cash equivalents", group: "sofp", type: "money", periodic: true },
  { key: "totalCurrentAssets", label: "Total current assets", group: "sofp", type: "money", periodic: true },
  { key: "totalAssets", label: "Total assets", group: "sofp", type: "money", periodic: true },
  { key: "shareCapital", label: "Share capital", group: "sofp", type: "money", periodic: true },
  { key: "openingShareCapital", label: "Share capital at START of period", group: "sofp", type: "money", periodic: true, hint: "Opening balance row of the statement of changes in equity" },
  { key: "openingRetainedEarnings", label: "Retained earnings at START of period", group: "sofp", type: "money", periodic: true, hint: "Opening balance row of the statement of changes in equity" },
  { key: "openingTotalEquity", label: "Total equity at START of period", group: "sofp", type: "money", periodic: true, hint: "Opening balance row of the statement of changes in equity" },
  { key: "buildings", label: "— of which buildings", group: "sofp", type: "money", periodic: true, hint: "Carrying amount from the PPE note. Breakdown inside PPE, not additional to it." },
  { key: "numberOfShares", label: "Number of shares issued and fully paid", group: "sofp", type: "number", periodic: true },
  { key: "retainedEarnings", label: "Retained profit / (accumulated loss)", group: "sofp", type: "money", periodic: true },
  { key: "totalEquity", label: "Total equity", group: "sofp", type: "money", periodic: true },
  { key: "tradePayables", label: "Trade payables", group: "sofp", type: "money", periodic: true },
  { key: "otherPayablesAndAccruals", label: "Other payables and accruals", group: "sofp", type: "money", periodic: true },
  { key: "payablesDueToHoldingCompany", label: "— of which due to holding company", group: "sofp", type: "money", periodic: true, hint: "Holding / parent company ONLY. Breakdown inside other payables." },
  { key: "payablesDueToRelatedParties", label: "— of which due to other related parties", group: "sofp", type: "money", periodic: true, hint: "Directors, subsidiaries, associates, companies under common control — NOT the holding company. Breakdown inside other payables." },
  { key: "accruals", label: "— of which accruals", group: "sofp", type: "money", periodic: true, hint: "From the payables note" },
  { key: "prepayments", label: "Prepayments and accrued income", group: "sofp", type: "money", periodic: true, hint: "Breakdown from the receivables note — already inside other receivables, not additional to it" },
  { key: "deposits", label: "Deposits (non-trade)", group: "sofp", type: "money", periodic: true, hint: "Breakdown from the receivables note — already inside other receivables, not additional to it" },
  { key: "otherNontradePayables", label: "— of which other non-trade payables", group: "sofp", type: "money", periodic: true, hint: "From the payables note" },
  { key: "currentNontradePayables", label: "— non-trade payables subtotal", group: "sofp", type: "money", periodic: true, hint: "Accruals + other non-trade payables. Computed automatically if left blank." },
  { key: "currentTaxLiabilities", label: "Current tax liabilities", group: "sofp", type: "money", periodic: true },
  { key: "totalCurrentLiabilities", label: "Total current liabilities", group: "sofp", type: "money", periodic: true },
  { key: "totalLiabilities", label: "Total liabilities", group: "sofp", type: "money", periodic: true },
  { key: "totalEquityAndLiabilities", label: "Total equity and liabilities", group: "sofp", type: "money", periodic: true },
  // Added after the QSK / LS / Yee Fatt gap analysis: the original 20 lines were
  // modelled on a simple services company, so an investment or trading company
  // silently lost these balances (they were being FILED AS ZERO).
  { key: "investmentProperty", label: "Investment property", group: "sofp", type: "money", periodic: true },
  { key: "investmentsInAssociates", label: "Investments in associates", group: "sofp", type: "money", periodic: true },
  { key: "otherNoncurrentAssets", label: "Other non-current assets", group: "sofp", type: "money", periodic: true },
  { key: "inventories", label: "Inventories", group: "sofp", type: "money", periodic: true },
  { key: "tradeReceivables", label: "Trade receivables", group: "sofp", type: "money", periodic: true, hint: "Trade debtors only — other receivables have their own line" },
  { key: "totalNoncurrentLiabilities", label: "Total non-current liabilities", group: "sofp", type: "money", periodic: true },
  { key: "noncurrentBorrowings", label: "— of which borrowings (non-current)", group: "sofp", type: "money", periodic: true },
  { key: "deferredTaxLiabilities", label: "— of which deferred tax", group: "sofp", type: "money", periodic: true },
  { key: "currentBorrowings", label: "Borrowings (current)", group: "sofp", type: "money", periodic: true },
];

/** Statement of profit or loss / comprehensive income. */
export const PL_FIELDS: FieldSpec[] = [
  { key: "revenue", label: "Revenue", group: "pl", type: "money", periodic: true },
  { key: "revenueFromGoods", label: "— of which sale of goods", group: "pl", type: "money", periodic: true, hint: "Leave blank if the company sells services only" },
  { key: "revenueFromServices", label: "— of which rendering of services", group: "pl", type: "money", periodic: true, hint: "Leave blank if the company sells goods only" },
  { key: "grossProfit", label: "Gross profit", group: "pl", type: "money", periodic: true },
  { key: "administrativeExpenses", label: "Administrative expenses", group: "pl", type: "money", periodic: true, hint: "Positive number — sign is applied by the mapper" },
  { key: "profitBeforeTax", label: "Profit / (loss) before tax", group: "pl", type: "money", periodic: true },
  { key: "taxExpense", label: "Income tax expense", group: "pl", type: "money", periodic: true },
  { key: "profitAfterTax", label: "Profit / (loss) after tax", group: "pl", type: "money", periodic: true },
  // Without these, profit-before-tax never reconciles for a company whose
  // profit comes from anything but trading — QSK earned RM2.39m on RM66k of
  // revenue, essentially all of it other income.
  { key: "otherIncome", label: "Other income", group: "pl", type: "money", periodic: true },
  { key: "costOfSales", label: "Cost of sales", group: "pl", type: "money", periodic: true, hint: "Positive number — sign is applied by the mapper" },
  { key: "otherOperatingExpenses", label: "Other operating expenses", group: "pl", type: "money", periodic: true, hint: "Positive number — sign is applied by the mapper" },
  { key: "financeCosts", label: "Finance costs", group: "pl", type: "money", periodic: true, hint: "Positive number — sign is applied by the mapper" },
  { key: "auditorsRemuneration", label: "Auditors' remuneration", group: "pl", type: "money", periodic: true },
  { key: "keyManagementCompensation", label: "Key management personnel compensation", group: "pl", type: "money", periodic: true, hint: "Directors' remuneration and other key management pay, from the related-party note" },
  { key: "relatedPartyDividendIncome", label: "Dividend income from related parties", group: "pl", type: "money", periodic: true },
  { key: "relatedPartyRentalExpense", label: "Rental expense to related parties", group: "pl", type: "money", periodic: true },
];

/** Statement of cash flows (indirect method). */
export const CF_FIELDS: FieldSpec[] = [
  { key: "depreciation", label: "Depreciation adjustment", group: "cf", type: "money", periodic: true },
  { key: "cfChangeInTradeReceivables", label: "Change in trade receivables", group: "cf", type: "money", periodic: true, hint: "Trade debtors only; other receivables have their own line" },
  { key: "cfChangeInReceivables", label: "Change in OTHER receivables", group: "cf", type: "money", periodic: true, hint: "Other receivables, deposits and prepayments only — NOT trade debtors, which have their own line" },
  { key: "cfChangeInTradePayables", label: "Change in TRADE payables", group: "cf", type: "money", periodic: true, hint: "Trade creditors only — other payables have their own line" },
  { key: "cfChangeInOtherPayables", label: "Change in OTHER payables", group: "cf", type: "money", periodic: true, hint: "Other payables and accruals only — NOT trade creditors" },
  { key: "cfTotalAdjustments", label: "Total adjustments to reconcile profit", group: "cf", type: "money", periodic: true },
  { key: "cfFromOperations", label: "Cash flows from operations", group: "cf", type: "money", periodic: true },
  { key: "cfFromOperatingActivities", label: "Net cash from operating activities", group: "cf", type: "money", periodic: true },
  { key: "cfPurchaseOfPpe", label: "Purchase of property, plant and equipment", group: "cf", type: "money", periodic: true },
  { key: "cfFromInvestingActivities", label: "Net cash from investing activities", group: "cf", type: "money", periodic: true },
  { key: "incomeTaxPaid", label: "Income taxes paid", group: "cf", type: "money", periodic: true, hint: "Negative number as shown in the cash flow (an outflow)" },
  { key: "cfFromFinancingActivities", label: "Net cash from financing activities", group: "cf", type: "money", periodic: true },
  { key: "cfNetIncreaseInCash", label: "Net increase / (decrease) in cash", group: "cf", type: "money", periodic: true },
];

export const FINANCIAL_FIELDS: FieldSpec[] = [...SOFP_FIELDS, ...PL_FIELDS, ...CF_FIELDS];
export const ALL_FIELDS: FieldSpec[] = [...ENTITY_FIELDS, ...FINANCIAL_FIELDS];

export const GROUP_LABELS: Record<FieldSpec["group"], string> = {
  entity: "Company & filing details",
  sofp: "Statement of financial position",
  pl: "Statement of profit or loss",
  cf: "Statement of cash flows",
};

export type EntityValues = Record<string, string>;
export type PeriodValues = Record<string, number | null>;

export interface MbrsExtraction {
  entity: EntityValues;
  current: PeriodValues;
  previous: PeriodValues;
  /** Narrative disclosure blocks keyed by XBRL concept (…Explanatory). */
  narratives: Record<string, string>;
  /** Fields the model could not find, so the review form can prompt for them. */
  missing: string[];
  /** Fields the reviewer marked not-applicable — stays blank in the filing and
   *  stops appearing in the outstanding-work list. */
  na?: string[];
  /** Free-text notes from the extractor about anything ambiguous. */
  extractionNotes?: string[];
}

export function emptyExtraction(): MbrsExtraction {
  return { entity: {}, current: {}, previous: {}, narratives: {}, missing: [], na: [] };
}

/** Entity fields a filing cannot go out without — N/A is not offered here. */
export const REQUIRED_ENTITY_KEYS = [
  "entityName", "registrationNumber",
  "currentPeriodStart", "currentPeriodEnd",
  "previousPeriodStart", "previousPeriodEnd",
] as const;

/**
 * Fields that come from the company's SSM REGISTRATION record, not from its
 * audited accounts — so they must never be taken from the report, however
 * confidently an extractor offers them.
 *
 * Verified against a real filing: IOT Foresight's submitted XBRL declares
 * MSIC 71102 / 71109 / 62099 (engineering and IT services), while extraction
 * of its audited report produced "Retail sale of any kind of product over the
 * Internet" — a different industry entirely. Worse, that string is verbatim
 * MSIC 47912 vocabulary, so a label-match check "confirmed" it: the model had
 * echoed the taxonomy back, and matching against it was circular, not
 * corroborating. A wrong MSIC code on a statutory filing is materially worse
 * than a blank one the filer must fill, so these stay blank and flagged.
 *
 * `businessDescriptionN` is derived from the chosen code instead — in the real
 * filing each DescriptionOfBusiness is exactly the official MSIC label for the
 * code beside it, so code → label is authoritative rather than a guess.
 */
export const REGISTRY_ONLY_ENTITY_KEYS = [
  "msicCode1", "businessDescription1",
  "msicCode2", "businessDescription2",
  "msicCode3", "businessDescription3",
] as const;

/** Subtotals the taxonomy requires as their own facts but which sit between a
 *  note breakdown and a face amount, so nobody reads them off a statement.
 *
 *  These are recomputed from their components whenever any component is
 *  present, rather than merely filled when absent: an extractor will happily
 *  return a confident wrong value here (it reads "total adjustments" as the
 *  depreciation line, which is the only add-back with an obvious label). The
 *  components are what a reviewer can actually check against the page, so the
 *  components win. */
const DERIVED: Array<{
  key: string;
  from: string[];
  /** Subtracted from the `from` total. */
  minus?: string[];
  /** Only fill when the field is absent, instead of overwriting an extracted
   *  value. Used where the figure is normally read straight off the page and
   *  the derivation is just a fallback. */
  whenMissing?: boolean;
}> = [
  { key: "currentNontradePayables", from: ["accruals", "otherNontradePayables"] },
  // Total adjustments reconciling profit to operating cash flow. Models
  // reliably read this as "the depreciation line" because that is the only
  // add-back with an obvious label, so it is computed rather than trusted.
  {
    key: "cfTotalAdjustments",
    from: ["depreciation", "cfChangeInTradeReceivables", "cfChangeInReceivables", "cfChangeInTradePayables", "cfChangeInOtherPayables"],
  },
  // Recoverable arithmetically when the face of the statement shows only the
  // totals. QSK's RM607,211.94 of non-current liabilities was sitting derivable
  // in the extraction the whole time, while the filing declared zero.
  { key: "totalReceivables", from: ["tradeReceivables", "otherReceivables", "receivablesDueFromHoldingCompany", "receivablesDueFromRelatedParties"] },
  // SSM's "other current receivables" concept is other + every related-party
  // balance; the face line we extract excludes related parties.
  { key: "otherReceivablesInclRelated", from: ["otherReceivables", "receivablesDueFromHoldingCompany", "receivablesDueFromRelatedParties"] },
  { key: "totalPayables", from: ["tradePayables", "otherPayablesAndAccruals"] },
  {
    key: "totalNoncurrentLiabilities",
    from: ["totalLiabilities"],
    minus: ["totalCurrentLiabilities"],
    whenMissing: true,
  },
];

export const DERIVED_KEYS = new Set(DERIVED.map((d) => d.key));

function deriveInto(values: PeriodValues): PeriodValues {
  const out = { ...values };
  for (const d of DERIVED) {
    if (d.whenMissing && typeof out[d.key] === "number") continue;
    const parts = d.from.map((k) => out[k]);
    const subs = (d.minus ?? []).map((k) => out[k]);
    if (parts.every((p) => typeof p !== "number")) continue;
    // A subtraction is only meaningful with both sides present, otherwise the
    // "derived" figure would silently equal the gross total.
    if (d.minus && subs.some((p) => typeof p !== "number")) continue;
    const total = parts.reduce((a: number, p) => a + (typeof p === "number" ? p : 0), 0);
    out[d.key] = subs.reduce((a: number, p) => a - (typeof p === "number" ? p : 0), total);
  }
  return out;
}

/** Identifier fields SSM wants unpunctuated, but which are printed with
 *  separators on the page ("730516-08-5119", "AF : 1346"). Normalising here
 *  rather than in the prompt keeps it deterministic. */
function normalizeEntity(entity: EntityValues): EntityValues {
  const out = { ...entity };

  for (const k of ["director1Id", "director2Id"]) {
    const v = out[k];
    if (v) out[k] = v.replace(/\D/g, "");
  }

  const signing = ["director1Name", "director2Name"].filter((k) => (out[k] ?? "").trim()).length;
  if (signing > 0) out.numberOfDirectorsSigning = String(signing);

  const st = canonicalState(out.auditFirmState);
  if (st) out.auditFirmState = st;

  if (out.auditFirmRegistrationNumber) {
    // "AF : 1346" / "AF 1346" -> "AF1346"
    out.auditFirmRegistrationNumber = out.auditFirmRegistrationNumber
      .replace(/[\s:]+/g, "")
      .toUpperCase();
  }

  if (out.auditorLicenseNumber) {
    // Practising certificates print as "02144/04/2027 J"; the filing carries
    // only the membership number itself.
    const m = out.auditorLicenseNumber.match(/\d+/);
    if (m) out.auditorLicenseNumber = String(parseInt(m[0], 10));
  }

  if (out.registrationNumber) out.registrationNumber = out.registrationNumber.replace(/\D/g, "");

  return out;
}

/** Recomputes derived subtotals and normalises identifier formatting.
 *  Run before validating or generating XBRL. */
/**
 * SSM accepts only its own uppercase state names. Audited reports print the
 * honorific form ("Pahang Darul Makmur", "Penang"), which the validator
 * rejects, so fold them onto the controlled list.
 */
const STATE_CANON: Record<string, string> = {
  "pahang": "PAHANG", "pahang darul makmur": "PAHANG",
  "selangor": "SELANGOR", "selangor darul ehsan": "SELANGOR",
  "johor": "JOHOR", "johor darul takzim": "JOHOR", "johore": "JOHOR",
  "penang": "PULAU PINANG", "pulau pinang": "PULAU PINANG",
  "perak": "PERAK", "perak darul ridzuan": "PERAK",
  "kedah": "KEDAH", "kedah darul aman": "KEDAH",
  "kelantan": "KELANTAN", "kelantan darul naim": "KELANTAN",
  "melaka": "MELAKA", "malacca": "MELAKA",
  "negeri sembilan": "NEGERI SEMBILAN", "negeri sembilan darul khusus": "NEGERI SEMBILAN",
  "perlis": "PERLIS", "perlis indera kayangan": "PERLIS",
  "terengganu": "TERENGGANU", "terengganu darul iman": "TERENGGANU",
  "sabah": "SABAH", "sarawak": "SARAWAK",
  "kuala lumpur": "WILAYAH PERSEKUTUAN KUALA LUMPUR",
  "wilayah persekutuan kuala lumpur": "WILAYAH PERSEKUTUAN KUALA LUMPUR",
  "labuan": "WILAYAH PERSEKUTUAN LABUAN",
  "putrajaya": "WILAYAH PERSEKUTUAN PUTRAJAYA",
};

export function canonicalState(raw: string | undefined | null): string | null {
  if (!raw || !raw.trim()) return null;
  return STATE_CANON[raw.trim().toLowerCase()] ?? raw.trim().toUpperCase();
}

export function normalizeExtraction(x: MbrsExtraction): MbrsExtraction {
  const current = deriveInto(x.current ?? {});
  const previous = deriveInto(x.previous ?? {});
  return {
    ...x,
    entity: normalizeEntity(x.entity ?? {}),
    current: withEquityMovements(current, previous),
    // The comparative year's movement needs ITS opening balance, which only the
    // SOCE carries — so it is derived only when the extractor read it.
    previous: withEquityMovements(previous, {}),
  };
}

/**
 * The statement of changes in equity is a roll-forward: each column's movement
 * is closing minus opening. Deriving it that way is exact and survives
 * dividends and share issues, whereas assuming "movement = profit" silently
 * breaks for any company that distributed anything.
 *
 * Only the current year can be built this way — the comparative column would
 * need the balance from the year before last, which the accounts don't carry.
 */
function withEquityMovements(current: PeriodValues, previous: PeriodValues): PeriodValues {
  const out = { ...current };
  // The current year's opening balance IS last year's closing balance — fill
  // it from there when the extractor didn't read it off the SOCE directly.
  const openings: Array<[string, string]> = [
    ["openingShareCapital", "shareCapital"],
    ["openingRetainedEarnings", "retainedEarnings"],
    ["openingTotalEquity", "totalEquity"],
  ];
  for (const [opening, closing] of openings) {
    if (num(out[opening]) === null && num(previous[closing]) !== null) out[opening] = previous[closing]!;
  }
  const pairs: Array<[string, string, string]> = [
    ["equityMovementShareCapital", "shareCapital", "openingShareCapital"],
    ["equityMovementRetainedEarnings", "retainedEarnings", "openingRetainedEarnings"],
    ["equityMovementTotal", "totalEquity", "openingTotalEquity"],
  ];
  for (const [target, closing, opening] of pairs) {
    const c = num(out[closing]);
    const o = num(out[opening]);
    if (c !== null && o !== null) out[target] = c - o;
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Which review-form group to jump to. */
  group: FieldSpec["group"];
  period?: Period;
  message: string;
  /** Fields involved, so the form can highlight them. */
  fields: string[];
}

interface RollUp {
  total: string;
  parts: string[];
  label: string;
  group: FieldSpec["group"];
}

/** Arithmetic identities that must hold in any well-formed MPERS filing.
 *  These are what catch an OCR digit slip before it reaches SSM. */
const ROLLUPS: RollUp[] = [
  { total: "totalAssets", parts: ["totalNoncurrentAssets", "totalCurrentAssets"], label: "Total assets = non-current + current assets", group: "sofp" },
  { total: "totalNoncurrentAssets", parts: ["propertyPlantAndEquipment", "investmentProperty", "investmentsInAssociates", "otherNoncurrentAssets"], label: "Non-current assets = PPE + investment property + associates + other", group: "sofp" },
  { total: "totalCurrentAssets", parts: ["inventories", "tradeReceivables", "otherReceivables", "receivablesDueFromHoldingCompany", "receivablesDueFromRelatedParties", "cashAndCashEquivalents"], label: "Current assets = inventories + receivables + cash", group: "sofp" },
  { total: "totalLiabilities", parts: ["totalCurrentLiabilities", "totalNoncurrentLiabilities"], label: "Total liabilities = current + non-current", group: "sofp" },
  { total: "totalEquity", parts: ["shareCapital", "retainedEarnings"], label: "Equity = share capital + retained earnings", group: "sofp" },
  { total: "totalCurrentLiabilities", parts: ["tradePayables", "otherPayablesAndAccruals", "currentTaxLiabilities", "currentBorrowings"], label: "Current liabilities = trade + other payables + tax + borrowings", group: "sofp" },
  { total: "otherPayablesAndAccruals", parts: ["payablesDueToHoldingCompany", "payablesDueToRelatedParties", "accruals", "otherNontradePayables"], label: "Other payables note reconciles to the face amount", group: "sofp" },
  { total: "profitBeforeTax", parts: ["grossProfit", "otherIncome", "administrativeExpenses", "otherOperatingExpenses", "financeCosts"], label: "Profit before tax = gross profit + other income − expenses − finance costs", group: "pl" },
];

const NEGATED_PARTS = new Set(["administrativeExpenses", "otherOperatingExpenses", "financeCosts"]);

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Runs the arithmetic checks over one period's figures. */
function validatePeriod(values: PeriodValues, period: Period): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const r of ROLLUPS) {
    const total = num(values[r.total]);
    const parts = r.parts.map((p) => ({ key: p, v: num(values[p]) }));
    // Skip when the line genuinely isn't present — a company with no fixed
    // assets shouldn't be nagged. Only check when we have the total and at
    // least one component.
    if (total === null || parts.every((p) => p.v === null)) continue;
    const sum = parts.reduce(
      (a, p) => a + (p.v ?? 0) * (NEGATED_PARTS.has(p.key) ? -1 : 1),
      0,
    );
    if (Math.round(sum) !== Math.round(total)) {
      issues.push({
        severity: "error",
        group: r.group,
        period,
        message: `${r.label} — expected ${fmt(total)}, components total ${fmt(sum)} (out by ${fmt(Math.abs(total - sum))}).`,
        fields: [r.total, ...r.parts],
      });
    }
  }

  // The balance sheet must balance. This is the single most important check:
  // SSM's own validator rejects the submission outright when it fails.
  const assets = num(values.totalAssets);
  const eqLiab = num(values.totalEquityAndLiabilities);
  if (assets !== null && eqLiab !== null && Math.round(assets) !== Math.round(eqLiab)) {
    issues.push({
      severity: "error",
      group: "sofp",
      period,
      message: `Balance sheet does not balance — total assets ${fmt(assets)} vs total equity and liabilities ${fmt(eqLiab)}.`,
      fields: ["totalAssets", "totalEquityAndLiabilities"],
    });
  }

  const equity = num(values.totalEquity);
  const liabilities = num(values.totalLiabilities);
  if (assets !== null && equity !== null && liabilities !== null &&
      Math.round(equity + liabilities) !== Math.round(assets)) {
    issues.push({
      severity: "error",
      group: "sofp",
      period,
      message: `Equity ${fmt(equity)} + liabilities ${fmt(liabilities)} does not equal total assets ${fmt(assets)}.`,
      fields: ["totalEquity", "totalLiabilities", "totalAssets"],
    });
  }

  const pbt = num(values.profitBeforeTax);
  const tax = num(values.taxExpense);
  const pat = num(values.profitAfterTax);
  if (pbt !== null && tax !== null && pat !== null &&
      Math.round(pbt - tax) !== Math.round(pat)) {
    issues.push({
      severity: "error",
      group: "pl",
      period,
      message: `Profit after tax ${fmt(pat)} does not equal profit before tax ${fmt(pbt)} less tax ${fmt(tax)}.`,
      fields: ["profitBeforeTax", "taxExpense", "profitAfterTax"],
    });
  }

  return issues;
}

/** Full pre-generation check. Errors block XBRL generation; warnings don't. */
export function validateExtraction(x: MbrsExtraction): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const blank = REQUIRED_ENTITY_KEYS.filter((k) => !String(x.entity[k] ?? "").trim());
  if (blank.length) {
    issues.push({
      severity: "error",
      group: "entity",
      message: `Required filing details are missing: ${blank
        .map((k) => ENTITY_FIELDS.find((f) => f.key === k)?.label ?? k)
        .join(", ")}.`,
      fields: blank,
    });
  }

  for (const k of ["currentPeriodStart", "currentPeriodEnd", "previousPeriodStart", "previousPeriodEnd"]) {
    const v = String(x.entity[k] ?? "").trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      issues.push({
        severity: "error", group: "entity",
        message: `${ENTITY_FIELDS.find((f) => f.key === k)?.label ?? k} must be a yyyy-mm-dd date (got "${v}").`,
        fields: [k],
      });
    }
  }

  const cs = x.entity.currentPeriodStart, ce = x.entity.currentPeriodEnd;
  if (cs && ce && cs >= ce) {
    issues.push({
      severity: "error", group: "entity",
      message: "Current financial year start must fall before its end date.",
      fields: ["currentPeriodStart", "currentPeriodEnd"],
    });
  }

  const reg = String(x.entity.registrationNumber ?? "").trim();
  if (reg && !/^\d{12}$/.test(reg)) {
    issues.push({
      severity: "warning", group: "entity",
      message: `Registration number "${reg}" is not the expected 12-digit MyCoID format.`,
      fields: ["registrationNumber"],
    });
  }

  issues.push(...validatePeriod(x.current, "current"));
  issues.push(...validatePeriod(x.previous, "previous"));

  const missingNarratives = NARRATIVE_CONCEPTS.filter(
    (c) => !String(x.narratives?.[c] ?? "").trim(),
  );
  if (missingNarratives.length) {
    issues.push({
      severity: "warning",
      group: "entity",
      message: `${missingNarratives.length} of ${NARRATIVE_CONCEPTS.length} narrative disclosure blocks are empty and would be submitted blank.`,
      fields: [],
    });
  }

  return issues;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-MY", { maximumFractionDigits: 0 }).format(n);
}

export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
