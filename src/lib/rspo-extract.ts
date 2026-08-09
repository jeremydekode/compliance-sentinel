// Certificate + Audit Report → typed extractions, via Gemini.
//
// Design rules, in order of importance:
//   1. Null over guess — a wrong value cross-checked against PRISMA produces a
//      false mismatch (or worse, a false pass); a null degrades one checklist
//      item to "missing/needs review". The prompts say this explicitly.
//   2. Every leaf carries the PAGE it was read from (`{v, p, q?}`), taken from
//      the `=== PAGE N ===` markers — the reviewer must be able to jump to the
//      evidence. Verbatim quotes only on fuzzy fields (names/addresses/scope)
//      to keep summary_json small.
//   3. Text-layer first: even the 162-page group report is ~50KB of text
//      (~13k tokens) versus ~42k image tokens as inlineData. OCR is the
//      fallback when >30% of pages have no text, and it is surfaced to the
//      cost tooltip, never silent.
//   4. One call per document, never one call per section — and certificate and
//      audit report are SEPARATE calls so a truncation in one can't poison the
//      other.

import { generateWithFallback } from "./gemini";
import { extractPdfPages, pagesToMarkedText } from "./pdf-pages";
import { type TokenUsage } from "./pricing";
import { type RspoCertType, CERT_TYPE_LABELS } from "./rspo-checklist";

/** value / page / quote. Everything the UI shows traces back to one of these. */
export interface Leaf {
  v: string | null;
  p?: number | null;
  q?: string;
}

export interface CertificateExtraction {
  certificationBodyName: Leaf;
  certifiedCompanyName: Leaf;
  address: Leaf;
  membershipNumber: Leaf;
  parentCompanyName: Leaf;
  certificateNumber: Leaf;
  certificateStartDate: Leaf;
  certificateEndDate: Leaf;
  firstCertificationDate: Leaf;
  supplyChainModel: Leaf;
  scopeOfCertification: Leaf;
  sites: Array<{ name: Leaf; address: Leaf; supplyChainModel: Leaf; activities: Leaf }>;
  groupMembers: Array<{ name: Leaf; address: Leaf; supplyChainModel: Leaf }>;
  extractionNotes: string[];
}

export interface AuditReportExtraction {
  sectionsFound: Array<{ section: string; title: string; pages: number[] }>;
  certificationBody: Leaf;
  organisation: { managementUnitName: Leaf; address: Leaf };
  membership: { number: Leaf; memberName: Leaf };
  certificateInfo: {
    certificateNumber: Leaf; tradingId: Leaf; scope: Leaf;
    supplyChainModel: Leaf; validityStart: Leaf; validityEnd: Leaf;
  };
  managementUnitDescription: {
    businessTypes: Leaf; productCategories: Leaf; modeOfAudit: Leaf; remoteJustification: Leaf;
  };
  sites: Array<{
    name: Leaf; address: Leaf; tradingId: Leaf; businessType: Leaf;
    supplyChainModel: Leaf; roles: Leaf; outsourcing: Leaf; audited: Leaf;
  }>;
  outsourcing: { details: Leaf };
  auditTeam: { leadAuditor: Leaf; auditors: Leaf; trainees: Leaf; translators: Leaf; observers: Leaf };
  closingMeetingDate: Leaf;
  findingsSummary: { totalNCs: number | null; breakdown: string | null; page: number | null };
  ncs: Array<{ ref: string; grade: string | null; status: string | null; page: number | null }>;
  conclusion: { sectionsMarked: boolean | null; missing: string[]; page: number | null };
  signOff: {
    signatures: Array<{ role: string; name: string | null; signedEvidence: string | null; page: number | null }>;
    page: number | null;
  };
  appendix1: { volumesCaptured: boolean | null; volumes: Array<{ product: string; model: string | null; volume: string | null }>; page: number | null };
  appendix3: { inputs: string[]; outputs: string[]; page: number | null };
  extractionNotes: string[];
}

/** Fraction of pages allowed to be textless before we fall back to OCR. */
const OCR_PAGE_RATIO = 0.3;
const MAX_TEXT_CHARS = 400_000;

const SHARED_RULES = `
ACCURACY RULES
- A wrong value is far worse than a null. These values are cross-checked against the PRISMA system and other documents; a misread creates a false discrepancy in a licence review. If you cannot read a value with confidence, use null and note it in "extractionNotes".
- Copy values VERBATIM as printed — do not normalise, translate, expand abbreviations, or reformat dates. Downstream code normalises.
- Every extracted field is an object {"v": <string|null>, "p": <page number|null>}. "p" is the page you read the value from, taken from the nearest "=== PAGE N ===" marker above it. For fields marked [QUOTE] add "q": the exact sentence/cell you read it from.
- Do not infer. If the document does not state a value, it is null — even when it seems deducible.
- Return ONLY the JSON object. No markdown fence, no commentary.`;

function certSchema(certType: RspoCertType): string {
  return `{
  "certificationBodyName": {"v","p"},        // the CB issuing the certificate (e.g. printed letterhead / accreditation text)
  "certifiedCompanyName": {"v","p","q"},     [QUOTE]
  "address": {"v","p","q"},                  [QUOTE] — the certified company's address as printed
  "membershipNumber": {"v","p"},             // RSPO membership number
  "parentCompanyName": {"v","p","q"},        [QUOTE] — null if no parent company is named
  "certificateNumber": {"v","p"},            // the certificate's own identifier as printed, e.g. "RSPO-SC 00217" or "CU-RSPO SCC-828058"
  "certificateStartDate": {"v","p"},         // as printed
  "certificateEndDate": {"v","p"},           // a.k.a. expiry
  "firstCertificationDate": {"v","p"},       // "original certification date" / "first issued" if printed
  "supplyChainModel": {"v","p"},             // e.g. "Mass Balance", "MB, SG"
  "scopeOfCertification": {"v","p","q"},     [QUOTE] — the scope/activities wording
  "sites": [ {"name":{"v","p"},"address":{"v","p"},"supplyChainModel":{"v","p"},"activities":{"v","p"}} ],
      // ${certType === "multi_site" ? "REQUIRED: the participating-sites annex — one entry per site listed" : "only if the certificate lists participating sites; else []"}
  "groupMembers": [ {"name":{"v","p"},"address":{"v","p"},"supplyChainModel":{"v","p"}} ],
      // ${certType === "group" ? "REQUIRED: the group-members annex — one entry per member listed, however many pages it spans" : "only if the certificate lists group members; else []"}
  "extractionNotes": ["<anything ambiguous or unreadable>"]
}`;
}

const AUDIT_SCHEMA = `{
  "sectionsFound": [ {"section": "<number as printed, e.g. '1.1', '3.3.1', 'APPENDIX 2'>", "title": "<heading text>", "pages": [<first page>]} ],
      // one entry for EVERY numbered section and appendix heading that appears in the report — this is how "section present" checks work
  "certificationBody": {"v","p"},            // the CB that performed the audit (usually section 1)
  "organisation": { "managementUnitName": {"v","p","q"} [QUOTE], "address": {"v","p","q"} [QUOTE] },   // §2.1
  "membership": { "number": {"v","p"}, "memberName": {"v","p","q"} [QUOTE] },                          // §2.2
  "certificateInfo": {                                                                                  // §2.3
    "certificateNumber": {"v","p"}, "tradingId": {"v","p"}, "scope": {"v","p","q"} [QUOTE],
    "supplyChainModel": {"v","p"}, "validityStart": {"v","p"}, "validityEnd": {"v","p"}
  },
  "managementUnitDescription": {                                                                        // §2.4
    "businessTypes": {"v","p"}, "productCategories": {"v","p"}, "modeOfAudit": {"v","p"},
    "remoteJustification": {"v","p"}
  },
  "sites": [ {"name":{"v","p"},"address":{"v","p"},"tradingId":{"v","p"},"businessType":{"v","p"},
              "supplyChainModel":{"v","p"},"roles":{"v","p"},"outsourcing":{"v","p"},"audited":{"v","p"}} ],
      // the §2.4 site/member table for multi-site or group reports — one entry per row, however long. [] for single site.
      // "audited": whether that site was audited/sampled in THIS audit, as printed (e.g. "Yes", "Sampled").
  "outsourcing": { "details": {"v","p","q"} [QUOTE] },                                                  // §2.5 — null v if none
  "auditTeam": {                                                                                        // §3.2
    "leadAuditor": {"v","p"}, "auditors": {"v","p"}, "trainees": {"v","p"},
    "translators": {"v","p"}, "observers": {"v","p"}
      // each v: the name(s) as printed, comma-joined; null when that role is not listed
  },
  "closingMeetingDate": {"v","p"},                                                                      // §3.3 audit plan
  "findingsSummary": { "totalNCs": <number|null>, "breakdown": "<e.g. '2 major, 1 minor'|null>", "page": <n|null> },  // §3.5
  "ncs": [ {"ref": "<NC id/number>", "grade": "<major/minor|null>", "status": "<closed/open/… as printed|null>", "page": <n>} ],
      // §3.6 register — every NC row. [] when the report states there were none.
  "conclusion": { "sectionsMarked": <true|false|null>, "missing": ["<unmarked item>"], "page": <n|null> },
      // §4: are the conclusion/recommendation checkboxes-style confirmations completed in text? null if not determinable from text.
  "signOff": { "signatures": [ {"role": "<e.g. Lead Auditor>", "name": "<name|null>", "signedEvidence": "<what the text shows, e.g. 'signature image', 'name+date printed'|null>", "page": <n>} ], "page": <n|null> },
      // §5. IMPORTANT: text extraction cannot see signature IMAGES — report what the TEXT shows and never claim a signature exists without textual evidence.
  "appendix1": { "volumesCaptured": <true|false|null>, "volumes": [ {"product": "", "model": "<MB/SG/IP|null>", "volume": "<as printed|null>"} ], "page": <n|null> },
  "appendix3": { "inputs": ["<product>"], "outputs": ["<product>"], "page": <n|null> },
  "extractionNotes": ["<anything ambiguous, unreadable, or structurally unusual>"]
}`;

interface RawParts {
  parts: Array<Record<string, unknown>>;
  ocrUsed: boolean;
}

async function buildParts(
  buffer: Buffer,
  mimeType: string,
  instruction: string,
): Promise<RawParts> {
  let pages: Array<{ page: number; text: string }> = [];
  try {
    pages = await extractPdfPages(buffer);
  } catch {
    pages = [];
  }
  const emptyish = pages.filter((p) => p.text.trim().length < 30).length;
  const ocrUsed = !pages.length || emptyish / pages.length > OCR_PAGE_RATIO;

  if (!ocrUsed) {
    const text = pagesToMarkedText(pages).slice(0, MAX_TEXT_CHARS);
    return {
      ocrUsed: false,
      parts: [{ text: instruction }, { text: `\nDOCUMENT (with page markers):\n\n${text}` }],
    };
  }
  return {
    ocrUsed: true,
    parts: [
      { text: instruction },
      { text: "\nThe document is attached as a scanned PDF. Read it with OCR. For \"p\" use the PRINTED page numbers where visible, else the PDF page index. Take particular care with identifiers and dates — misreads become false discrepancies." },
      { inlineData: { mimeType: mimeType || "application/pdf", data: buffer.toString("base64") } },
    ],
  };
}

function readUsage(response: unknown): { usage: TokenUsage; model: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = ((response as any).usageMetadata ?? {}) as any;
  return {
    usage: {
      inputTokens: m.promptTokenCount ?? 0,
      outputTokens: m.candidatesTokenCount ?? 0,
      thinkingTokens: m.thoughtsTokenCount ?? 0,
      calls: 1,
    },
    model: (response as { modelVersion?: string }).modelVersion ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJson(text: string | undefined): any {
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    const mm = (text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { return JSON.parse(mm[0]); } catch { /* fall through */ } }
    return {};
  }
}

/** Sanitize anything the model returned into a well-formed Leaf. */
function toLeaf(raw: unknown): Leaf {
  if (raw == null) return { v: null };
  if (typeof raw === "string" || typeof raw === "number") return { v: String(raw) };
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const v = o.v == null ? null : String(o.v).trim() || null;
    const p = typeof o.p === "number" && Number.isFinite(o.p) ? o.p : null;
    const q = typeof o.q === "string" && o.q.trim() ? o.q.trim().slice(0, 400) : undefined;
    return q ? { v, p, q } : { v, p };
  }
  return { v: null };
}

function toLeafRow<T extends Record<string, Leaf>>(raw: unknown, keys: (keyof T)[]): T {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as T;
  for (const k of keys) out[k] = toLeaf(o[k as string]) as T[keyof T];
  return out;
}

function toNotes(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, 40) : [];
}

export async function extractRspoCertificate(args: {
  buffer: Buffer;
  mimeType: string;
  certType: RspoCertType;
}): Promise<{ certificate: CertificateExtraction; usage: TokenUsage; model: string; ocrUsed: boolean }> {
  const instruction = [
    `You extract structured data from an RSPO Supply Chain certificate PDF (${CERT_TYPE_LABELS[args.certType]}) so it can be cross-checked against the PRISMA licensing system and the audit report.`,
    SHARED_RULES,
    "",
    "Return this JSON shape:",
    certSchema(args.certType),
  ].join("\n");

  const { parts, ocrUsed } = await buildParts(args.buffer, args.mimeType, instruction);

  // Rarely the model answers with an empty/unparseable object even though the
  // document is tiny and fully readable (observed on the 1-page sample cert).
  // One retry, both attempts billed. An empty CERTIFICATE extraction would
  // cascade into a dozen false "missing" checklist rows, so it's worth it.
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
  let model = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await generateWithFallback(
      { contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", maxOutputTokens: 65536, temperature: 0 } },
      { tier: "quality" },
    );
    const r = readUsage(response);
    usage = { inputTokens: usage.inputTokens + r.usage.inputTokens, outputTokens: usage.outputTokens + r.usage.outputTokens, thinkingTokens: usage.thinkingTokens + r.usage.thinkingTokens, calls: usage.calls + 1 };
    model = r.model || model;
    parsed = parseJson((response as { text?: string }).text);
    const empty = !toLeaf(parsed.certificateNumber).v && !toLeaf(parsed.certifiedCompanyName).v &&
      !(Array.isArray(parsed.sites) && parsed.sites.length) && !(Array.isArray(parsed.groupMembers) && parsed.groupMembers.length);
    if (!empty) break;
    if (attempt === 1) console.warn("Certificate extraction came back empty — retrying once");
  }

  const certificate: CertificateExtraction = {
    certificationBodyName: toLeaf(parsed.certificationBodyName),
    certifiedCompanyName: toLeaf(parsed.certifiedCompanyName),
    address: toLeaf(parsed.address),
    membershipNumber: toLeaf(parsed.membershipNumber),
    parentCompanyName: toLeaf(parsed.parentCompanyName),
    certificateNumber: toLeaf(parsed.certificateNumber),
    certificateStartDate: toLeaf(parsed.certificateStartDate),
    certificateEndDate: toLeaf(parsed.certificateEndDate),
    firstCertificationDate: toLeaf(parsed.firstCertificationDate),
    supplyChainModel: toLeaf(parsed.supplyChainModel),
    scopeOfCertification: toLeaf(parsed.scopeOfCertification),
    sites: (Array.isArray(parsed.sites) ? parsed.sites : []).slice(0, 500).map((s: unknown) =>
      toLeafRow<CertificateExtraction["sites"][number]>(s, ["name", "address", "supplyChainModel", "activities"])),
    groupMembers: (Array.isArray(parsed.groupMembers) ? parsed.groupMembers : []).slice(0, 500).map((s: unknown) =>
      toLeafRow<CertificateExtraction["groupMembers"][number]>(s, ["name", "address", "supplyChainModel"])),
    extractionNotes: toNotes(parsed.extractionNotes),
  };
  return { certificate, usage, model, ocrUsed };
}

export async function extractRspoAuditReport(args: {
  buffer: Buffer;
  mimeType: string;
  certType: RspoCertType;
}): Promise<{ audit: AuditReportExtraction; usage: TokenUsage; model: string; ocrUsed: boolean }> {
  const instruction = [
    `You extract structured data from an RSPO Supply Chain Certification AUDIT REPORT (${CERT_TYPE_LABELS[args.certType]}) so a licence reviewer can cross-check it against the certificate and the PRISMA system.`,
    "",
    "The report follows the RSPO SCC template: 1 Certification Body Background, 2 Organisation Details and Certification Scope (2.1 Organisational Overview, 2.2 RSPO Membership Information, 2.3 Certificate Information, 2.4 Description of the Management Unit, 2.5 Outsourcing Details), 3 Audit Programme (3.1 Methodology, 3.2 Audit Team, 3.3 Audit Plan, 3.4 Findings, 3.5 Summary of Audit Findings, 3.6 Nonconformities in this audit, 3.7 Nonconformities from the previous audit), 4 Audit Conclusion, 5 Sign-Off, and Appendices (1 Volume Summary, 2 History of Changes, 3 Certified input/output products). Headings may vary in wording between certification bodies — match sections by MEANING (e.g. an 'NCR register' or 'Audit Findings Log' is section 3.6), and record the heading actually printed.",
    "Extract ONLY the fields below; ignore all other content however long the report is.",
    SHARED_RULES,
    "",
    "Return this JSON shape:",
    AUDIT_SCHEMA,
  ].join("\n");

  const { parts, ocrUsed } = await buildParts(args.buffer, args.mimeType, instruction);

  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
  let model = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await generateWithFallback(
      { contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", maxOutputTokens: 65536, temperature: 0 } },
      { tier: "quality" },
    );
    const r = readUsage(response);
    usage = { inputTokens: usage.inputTokens + r.usage.inputTokens, outputTokens: usage.outputTokens + r.usage.outputTokens, thinkingTokens: usage.thinkingTokens + r.usage.thinkingTokens, calls: usage.calls + 1 };
    model = r.model || model;
    parsed = parseJson((response as { text?: string }).text);
    const empty = !(Array.isArray(parsed.sectionsFound) && parsed.sectionsFound.length) &&
      !toLeaf(parsed.organisation?.managementUnitName).v;
    if (!empty) break;
    if (attempt === 1) console.warn("Audit-report extraction came back empty — retrying once");
  }

  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const strOrNull = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

  const audit: AuditReportExtraction = {
    sectionsFound: (Array.isArray(parsed.sectionsFound) ? parsed.sectionsFound : [])
      .slice(0, 120)
      .map((s: Record<string, unknown>) => ({
        section: String(s?.section ?? "").trim(),
        title: String(s?.title ?? "").trim().slice(0, 160),
        pages: Array.isArray(s?.pages) ? (s.pages as unknown[]).filter((p): p is number => typeof p === "number") : [],
      }))
      .filter((s: { section: string }) => s.section),
    certificationBody: toLeaf(parsed.certificationBody),
    organisation: toLeafRow(parsed.organisation, ["managementUnitName", "address"]),
    membership: toLeafRow(parsed.membership, ["number", "memberName"]),
    certificateInfo: toLeafRow(parsed.certificateInfo, [
      "certificateNumber", "tradingId", "scope", "supplyChainModel", "validityStart", "validityEnd",
    ]),
    managementUnitDescription: toLeafRow(parsed.managementUnitDescription, [
      "businessTypes", "productCategories", "modeOfAudit", "remoteJustification",
    ]),
    sites: (Array.isArray(parsed.sites) ? parsed.sites : []).slice(0, 500).map((s: unknown) =>
      toLeafRow<AuditReportExtraction["sites"][number]>(s, [
        "name", "address", "tradingId", "businessType", "supplyChainModel", "roles", "outsourcing", "audited",
      ])),
    outsourcing: toLeafRow(parsed.outsourcing, ["details"]),
    auditTeam: toLeafRow(parsed.auditTeam, ["leadAuditor", "auditors", "trainees", "translators", "observers"]),
    closingMeetingDate: toLeaf(parsed.closingMeetingDate),
    findingsSummary: {
      totalNCs: num(parsed.findingsSummary?.totalNCs),
      breakdown: strOrNull(parsed.findingsSummary?.breakdown),
      page: num(parsed.findingsSummary?.page),
    },
    ncs: (Array.isArray(parsed.ncs) ? parsed.ncs : []).slice(0, 200).map((n: Record<string, unknown>) => ({
      ref: String(n?.ref ?? "").trim() || "(unnumbered)",
      grade: strOrNull(n?.grade),
      status: strOrNull(n?.status),
      page: num(n?.page),
    })),
    conclusion: {
      sectionsMarked: typeof parsed.conclusion?.sectionsMarked === "boolean" ? parsed.conclusion.sectionsMarked : null,
      missing: toNotes(parsed.conclusion?.missing),
      page: num(parsed.conclusion?.page),
    },
    signOff: {
      signatures: (Array.isArray(parsed.signOff?.signatures) ? parsed.signOff.signatures : [])
        .slice(0, 30)
        .map((s: Record<string, unknown>) => ({
          role: String(s?.role ?? "").trim() || "(role unknown)",
          name: strOrNull(s?.name),
          signedEvidence: strOrNull(s?.signedEvidence),
          page: num(s?.page),
        })),
      page: num(parsed.signOff?.page),
    },
    appendix1: {
      volumesCaptured: typeof parsed.appendix1?.volumesCaptured === "boolean" ? parsed.appendix1.volumesCaptured : null,
      volumes: (Array.isArray(parsed.appendix1?.volumes) ? parsed.appendix1.volumes : [])
        .slice(0, 100)
        .map((v: Record<string, unknown>) => ({
          product: String(v?.product ?? "").trim(),
          model: strOrNull(v?.model),
          volume: strOrNull(v?.volume),
        })),
      page: num(parsed.appendix1?.page),
    },
    appendix3: {
      inputs: toNotes(parsed.appendix3?.inputs),
      outputs: toNotes(parsed.appendix3?.outputs),
      page: num(parsed.appendix3?.page),
    },
    extractionNotes: toNotes(parsed.extractionNotes),
  };
  return { audit, usage, model, ocrUsed };
}
