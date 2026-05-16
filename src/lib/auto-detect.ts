// Pure client-safe heuristic auto-detection of uploaded compliance docs.
// Returns metadata to pre-fill upload forms and to drive tag-based KB filtering.

export type DetectedDocType =
  | "rmit_reg"   // RMiT-style technology / cyber regulation
  | "fatf"       // AML/CFT regulation
  | "circular"   // Regulator circular
  | "it_policy"  // Internal IT policy
  | "policy"     // Generic
  | "sop";       // Internal SOP

export interface DetectedMeta {
  title: string;
  doc_type: DetectedDocType;
  version: string;
  summary: string;
  tags: string[];
}

const RULES: Array<{
  test: RegExp;
  doc_type: DetectedDocType;
  tags: string[];
  summary: string;
}> = [
  {
    test: /\b(rmit|bnm|kill\s*switch|cyber\s*resilience)\b/i,
    doc_type: "rmit_reg",
    tags: ["Tech", "Cyber", "BNM", "RMiT"],
    summary:
      "Technology risk regulation covering cyber resilience, outsourcing, cloud and operational continuity controls.",
  },
  {
    test: /\b(fatf|aml|cft|kyc|money\s*laundering|sanctions)\b/i,
    doc_type: "fatf",
    tags: ["AML", "CFT", "KYC", "FATF"],
    summary:
      "Anti-money-laundering / counter-financing-of-terrorism guidance covering customer due diligence and reporting obligations.",
  },
  {
    test: /\bcircular\b/i,
    doc_type: "circular",
    tags: ["Circular", "Regulator"],
    summary:
      "Regulator circular communicating clarifications, supervisory expectations, or thematic findings.",
  },
  {
    test: /\b(it[\s_-]*policy|itp|information\s*technology|infosec|cybersec)\b/i,
    doc_type: "it_policy",
    tags: ["Tech", "IT", "InfoSec"],
    summary:
      "Internal IT / information-security policy covering systems governance and operational controls.",
  },
  {
    test: /\bsop\b/i,
    doc_type: "sop",
    tags: ["SOP"],
    summary: "Internal Standard Operating Procedure.",
  },
];

function deriveTitle(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  // Replace separators with spaces, collapse whitespace, leave casing alone.
  return base.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim() || filename;
}

function deriveVersion(filename: string): string {
  const m =
    filename.match(/v\s*([\d]+(?:\.[\d]+){0,2})/i) ||
    filename.match(/\b(20\d{2})\b/);
  return m ? m[1] : "1.0";
}

export function autoDetectDocMeta(filename: string): DetectedMeta {
  const title = deriveTitle(filename);
  const version = deriveVersion(filename);

  for (const rule of RULES) {
    if (rule.test.test(filename)) {
      return {
        title,
        doc_type: rule.doc_type,
        version,
        summary: rule.summary,
        tags: rule.tags,
      };
    }
  }

  return {
    title,
    doc_type: "policy",
    version,
    summary: "Compliance / policy document.",
    tags: ["Policy"],
  };
}

export const DOC_TYPE_LABEL: Record<DetectedDocType, string> = {
  rmit_reg: "RMiT / Tech Regulation",
  fatf: "FATF / AML",
  circular: "Regulator Circular",
  it_policy: "IT Policy",
  policy: "Policy",
  sop: "Internal SOP",
};
