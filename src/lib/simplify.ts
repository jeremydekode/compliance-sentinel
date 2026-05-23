// UC4 — Document Simplification: deterministic verification.
//
// The AI (simplifyDocument in gemini.ts) PROPOSES simplification edits. This
// module is the trust boundary: every action's `before` span is checked,
// without any AI, against the real document. An invented, hallucinated or
// silently-paraphrased clause is caught and quarantined here before a human
// ever sees it presented as a genuine "original". The verification result IS
// the audit trail — the actual deliverable of the verifiable-redline tool.

import type { SimplificationAction } from "./gemini";

// ── Text normalisation ───────────────────────────────────────────────────────

/** Decodes the HTML entities mammoth emits, without otherwise altering words. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCharCode(code) : " ";
    })
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Normalises text for anchor matching: strips HTML tags, decodes entities and
 * unifies the *encoding noise* — smart quotes, dashes, non-breaking spaces —
 * that legitimately differs between what a model copies and what mammoth
 * emits. It changes punctuation glyphs and whitespace ONLY; it never adds,
 * drops or reorders words, so a match here is a real match.
 */
export function normalizeForMatch(s: string): string {
  return decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " "))
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2007\u202F\u200B\u2060\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Words-only form — drops ALL punctuation. A span that matches here but not
 *  exactly is still genuinely in the document (a punctuation-only variant). */
export function wordsOnly(s: string): string {
  return normalizeForMatch(s)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Verification model ───────────────────────────────────────────────────────

export type VerificationStatus = "verified" | "review" | "rejected";

/** Whether a verified action will be written into the amended copy.
 *  - accepted : applied. Auto-set for high-confidence verified actions.
 *  - pending  : awaits a human Accept/Reject (the "Needs review" group).
 *  - rejected : not applied (a quarantined hallucination, or a human reject). */
export type ActionDecision = "accepted" | "rejected" | "pending";

export interface ActionVerification {
  status: VerificationStatus;
  /** 1 = the span is in the document; 0..1 = best fuzzy word-overlap. */
  matchScore: number;
  reason: string;
}

export interface VerifiedAction extends SimplificationAction {
  verification: ActionVerification;
  /** Apply decision — set on the stored report, mutated by the review UI. */
  decision?: ActionDecision;
}

export interface VerificationSummary {
  total: number;
  verified: number;
  review: number;
  rejected: number;
  actions: VerifiedAction[];
}

/** Below this fuzzy word-overlap, a `before` is treated as not in the document
 *  — i.e. the AI invented it. Real near-misses score ~0.9+; inventions ~0.2-0.5,
 *  so the threshold sits in a wide empty gap. */
const FUZZY_REVIEW_THRESHOLD = 0.85;

// ── Fuzzy locator ────────────────────────────────────────────────────────────

/** Index of word -> positions, so fuzzy search only scans plausible starts. */
function buildWordIndex(words: string[]): Map<string, number[]> {
  const idx = new Map<string, number[]>();
  for (let i = 0; i < words.length; i++) {
    const at = idx.get(words[i]);
    if (at) at.push(i);
    else idx.set(words[i], [i]);
  }
  return idx;
}

/**
 * Best LOCALISED word-overlap of `before` against the document — tolerant of
 * the model inserting, dropping or reordering a few words. Anchors on `before`'s
 * rarest word (so a changed first word doesn't blind the search), then measures,
 * in a window around each occurrence of that anchor, how many of `before`'s
 * distinct words are co-located. Returns 0..1.
 *
 * A genuine span the model lightly paraphrased scores ~0.9+; invented text —
 * whose words are simply not co-located anywhere in the document — scores far
 * lower, leaving a wide gap for the review/reject threshold to sit in.
 */
function bestFuzzyScore(
  beforeWords: string[],
  docWords: string[],
  wordIndex: Map<string, number[]>,
): number {
  const distinct = [...new Set(beforeWords)];
  if (distinct.length === 0) return 0;

  // Anchor on the rarest `before` word that occurs in the document at all.
  let anchor = "";
  let anchorCount = Infinity;
  for (const w of distinct) {
    const positions = wordIndex.get(w);
    if (positions && positions.length < anchorCount) {
      anchor = w;
      anchorCount = positions.length;
    }
  }
  if (!anchor) return 0; // not one `before` word appears anywhere — fully invented

  const wanted = new Set(distinct);
  const radius = beforeWords.length; // anchor may sit anywhere within the span
  let best = 0;
  for (const at of wordIndex.get(anchor)!) {
    const lo = Math.max(0, at - radius);
    const hi = Math.min(docWords.length, at + radius);
    const seen = new Set<string>();
    for (let i = lo; i < hi; i++) {
      if (wanted.has(docWords[i])) seen.add(docWords[i]);
    }
    const score = seen.size / wanted.size;
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks every proposed action's `before` span against the real document.
 *  - verified : the span is in the document (exact, or punctuation-only variant).
 *  - review   : a close fuzzy match — the model dropped/altered a few words, or
 *               the action is a `table_restructure` whose `before` may name a
 *               table rather than quote it. A human must confirm.
 *  - rejected : the span is NOT in the document — the AI invented it. Quarantined.
 *
 * No AI is involved; this is purely deterministic string matching.
 */
export function verifyActions(
  actions: SimplificationAction[],
  docHtml: string,
): VerificationSummary {
  const docNorm = normalizeForMatch(docHtml);
  const docWords = wordsOnly(docHtml).split(" ").filter(Boolean);
  const docWordsJoined = docWords.join(" ");
  const wordIndex = buildWordIndex(docWords);

  const verified: VerifiedAction[] = actions.map((action) => ({
    ...action,
    verification: classifyAction(action, docNorm, docWordsJoined, docWords, wordIndex),
  }));

  return {
    total: verified.length,
    verified: verified.filter((a) => a.verification.status === "verified").length,
    review: verified.filter((a) => a.verification.status === "review").length,
    rejected: verified.filter((a) => a.verification.status === "rejected").length,
    actions: verified,
  };
}

function classifyAction(
  action: SimplificationAction,
  docNorm: string,
  docWordsJoined: string,
  docWords: string[],
  wordIndex: Map<string, number[]>,
): ActionVerification {
  const beforeNorm = normalizeForMatch(action.before);
  if (!beforeNorm) {
    return {
      status: "rejected",
      matchScore: 0,
      reason: "Empty `before` — nothing to anchor against the document.",
    };
  }

  const isTable = action.type === "table_restructure";

  // Exact (encoding-normalised) substring — the strongest anchor.
  if (docNorm.includes(beforeNorm)) {
    return isTable
      ? {
          status: "review",
          matchScore: 1,
          reason: "Anchored exactly; a table layout change still needs human review.",
        }
      : { status: "verified", matchScore: 1, reason: "`before` found verbatim in the document." };
  }

  // Punctuation-only variant — words match exactly and in order; still genuine.
  const beforeWordsStr = wordsOnly(action.before);
  if (beforeWordsStr && docWordsJoined.includes(beforeWordsStr)) {
    return isTable
      ? {
          status: "review",
          matchScore: 1,
          reason: "Anchored (punctuation variant); table layout change needs human review.",
        }
      : {
          status: "verified",
          matchScore: 1,
          reason: "`before` found in the document (punctuation differs only).",
        };
  }

  // Fuzzy — how much of `before` actually exists in the document.
  const beforeWords = beforeWordsStr.split(" ").filter(Boolean);
  const score = bestFuzzyScore(beforeWords, docWords, wordIndex);

  if (score >= FUZZY_REVIEW_THRESHOLD) {
    return {
      status: "review",
      matchScore: score,
      reason: `Close match (${Math.round(score * 100)}% of words found) — the model altered a few words; confirm before applying.`,
    };
  }

  if (isTable && score > 0) {
    return {
      status: "review",
      matchScore: score,
      reason:
        "Table restructure — `before` does not quote a span verbatim; review the named table directly.",
    };
  }

  return {
    status: "rejected",
    matchScore: score,
    reason: `Not found in the document (only ${Math.round(score * 100)}% of words match) — the AI likely invented this. Quarantined.`,
  };
}

// ── Document structure ───────────────────────────────────────────────────────

export interface DocSection {
  /** Heading level, 1-6. */
  level: number;
  /** Visible heading text, whitespace-normalised. */
  heading: string;
  /** 0-based position in document order. */
  order: number;
}

export interface DocStructure {
  sections: DocSection[];
  tableCount: number;
  wordCount: number;
}

/** Strips HTML tags + entities to plain visible text (keeps case & punctuation). */
function visibleText(html: string): string {
  return decodeEntities(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses a document's HTML into its heading index, table count and word count.
 * Feeds the provenance header and the section cross-check.
 */
export function analyzeStructure(html: string): DocStructure {
  const sections: DocSection[] = [];
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = headingRe.exec(html)) !== null) {
    const heading = visibleText(m[2]);
    if (heading) sections.push({ level: Number(m[1]), heading, order: order++ });
  }
  return {
    sections,
    tableCount: (html.match(/<table\b/gi) ?? []).length,
    wordCount: visibleText(html).split(/\s+/).filter(Boolean).length,
  };
}

export interface SectionCrossCheck {
  /** Distinct real headings that at least one non-rejected action refers to. */
  sectionsTouched: number;
  /** `section` labels used by non-rejected actions that match NO real heading —
   *  a heading the AI may have invented even where its `before` did anchor. */
  unmatchedLabels: string[];
}

/**
 * Cross-checks each non-rejected action's claimed `section` against the
 * document's real heading index — a second, independent hallucination signal
 * alongside the `before`-anchor check. An action whose `before` is genuine but
 * whose `section` matches no heading is surfaced for review.
 */
export function crossCheckSections(
  actions: VerifiedAction[],
  structure: DocStructure,
): SectionCrossCheck {
  const headings = structure.sections.map((s) => normalizeForMatch(s.heading)).filter(Boolean);
  const touched = new Set<string>();
  const unmatched = new Set<string>();
  for (const a of actions) {
    if (a.verification.status === "rejected") continue;
    const label = normalizeForMatch(a.section);
    if (!label) continue;
    const hit = headings.find((h) => h === label || h.includes(label) || label.includes(h));
    if (hit) touched.add(hit);
    else unmatched.add(String(a.section ?? "").trim());
  }
  return { sectionsTouched: touched.size, unmatchedLabels: [...unmatched] };
}

// ── Apply decisions ──────────────────────────────────────────────────────────

/** A verified action with confidence strictly above this is auto-accepted. */
export const AUTO_ACCEPT_MIN_CONFIDENCE = 90;

/**
 * The starting Accept/Reject decision for a freshly verified action:
 *  - `rejected`  — the verifier quarantined it (not in the document). Never applied.
 *  - `accepted`  — verified AND confidence > 90: trustworthy on both axes, auto-accepted.
 *  - `pending`   — verified-but-lower-confidence, or `review`: a human must decide.
 * Auto-accept deliberately requires the deterministic `verified` status, not just
 * the AI's self-reported confidence — a confident-sounding invention must never apply.
 */
export function initialDecision(action: VerifiedAction): ActionDecision {
  if (action.verification.status === "rejected") return "rejected";
  if (
    action.verification.status === "verified" &&
    (action.confidence ?? 0) > AUTO_ACCEPT_MIN_CONFIDENCE
  ) {
    return "accepted";
  }
  return "pending";
}

/** Which review group an action belongs to in the UI. */
export type ReviewGroup = "auto" | "review" | "quarantined";

/** Fixed partition of an action by its verifier verdict + confidence (independent
 *  of the mutable `decision`): auto-accepted, needs-review, or quarantined. */
export function reviewGroup(action: VerifiedAction): ReviewGroup {
  if (action.verification.status === "rejected") return "quarantined";
  if (
    action.verification.status === "verified" &&
    (action.confidence ?? 0) > AUTO_ACCEPT_MIN_CONFIDENCE
  ) {
    return "auto";
  }
  return "review";
}

// ── Default simplification guidance ──────────────────────────────────────────

/**
 * Starter "house rules" for the Document Simplification workspace. It is the
 * EDITABLE, tunable layer — shown pre-filled in Settings → Analysis Guidance and
 * used as the fallback when nothing has been saved. The structural prompt (the
 * six action types, the JSON contract, the verbatim-anchor rule) stays in code;
 * this only refines emphasis, terminology and tone, and can be freely edited.
 */
export const DEFAULT_SIMPLIFY_GUIDANCE = `DOCUMENT SIMPLIFICATION — HOUSE RULES
Edit this to match RHB conventions. It is applied on top of the built-in rules.

EMPHASIS
- Don't stop at sentence-level rewording. Actively merge overlapping points and turn dense prose into bullet lists — those changes add the most clarity.
- Target short sentences (aim for 25 words or fewer) and active voice: "the Document Owner reviews the manual", not "the manual is to be reviewed by the Document Owner".
- Prefer plain verbs over nominalisations: "decide" not "make a decision"; "review" not "carry out a review of".

TERMINOLOGY — keep it consistent
- When you rephrase a sentence, also bring its wording in line with the house glossary. Use one term throughout, for example:
  - "Document Owner" — not "doc owner" or "owner of the document".
  - "Operations & Methods (O&M)" on first use, then "O&M".
  - Keep the order "Framework, Policy, Guideline, Manual and Circular" wherever that list appears.
- Use British English spelling (organise, prioritise, programme, authorise).
(Extend this glossary with your real RHB house terms.)

LEAVE UNTOUCHED
- Defined terms, role titles, committee names and system names — never reword these.
- Numbers, thresholds, dates, percentages, monetary amounts and authority limits.
- Any wording whose change would alter the scope of an obligation.

TONE
- Professional and instructional, suitable for a bank operations manual. No marketing language.`;
