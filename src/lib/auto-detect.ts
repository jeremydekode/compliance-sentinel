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
  // INTERNAL markers — checked FIRST so filenames like
  // "rmit_clean_demo_docs_MCB_Cyber_Resilience_Framework.pdf" don't get
  // misclassified as the regulator just because the workspace name leaks
  // into the filename. Order matters: most-specific internal markers first.
  {
    test: /\bSOP\b/i,
    doc_type: "sop",
    tags: ["SOP"],
    summary: "Internal Standard Operating Procedure.",
  },
  {
    test: /\b(MCB|internal_policy|internal[\s_-]*doc|company[\s_-]*policy)\b/i,
    doc_type: "sop",
    tags: ["Internal", "Policy"],
    summary: "Internal company policy or SOP.",
  },
  {
    test: /\b(it[\s_-]*policy|itp|information[\s_-]*technology|infosec|cybersec)\b/i,
    doc_type: "it_policy",
    tags: ["Tech", "IT", "InfoSec"],
    summary:
      "Internal IT / information-security policy covering systems governance and operational controls.",
  },

  // EXTERNAL regulator markers — checked AFTER internal so files like
  // "PD-RMiT-June2023.pdf" or "FATF-Plenary-Feb-2026.pdf" still get tagged
  // as the right regulator family.
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

// ─── Document role classification ────────────────────────────────────────────
// External regulations (these get COMPARED — old vs new — not amended)
export const REGULATION_DOC_TYPES = ["rmit_reg", "rmit", "fatf", "circular"] as const;

// Internal documents (these get AMENDED to comply with regulation changes)
export const INTERNAL_DOC_TYPES = ["sop", "it_policy", "policy"] as const;

// When a new regulation is uploaded, which doc_types should be searched in KB
// to find the previous version to compare against? (Handles legacy tag drift.)
export const REGULATION_FAMILIES: Record<string, string[]> = {
  rmit_reg: ["rmit_reg", "rmit"],   // BNM RMiT family
  rmit:     ["rmit_reg", "rmit"],
  fatf:     ["fatf"],                // FATF AML/CFT
  circular: ["circular"],            // Generic regulator circulars
};

export function isRegulation(docType: string | undefined | null): boolean {
  return !!docType && (REGULATION_DOC_TYPES as readonly string[]).includes(docType);
}

// Friendly regulator label (used in AI prompt for context-specific guidance)
export function regulatorContext(docType: string | undefined | null): "rmit" | "fatf" | "circular" | "generic" {
  if (docType === "rmit_reg" || docType === "rmit") return "rmit";
  if (docType === "fatf") return "fatf";
  if (docType === "circular") return "circular";
  return "generic";
}
