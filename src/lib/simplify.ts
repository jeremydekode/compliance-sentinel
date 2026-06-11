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

/** A verified action with confidence at or above this is auto-accepted. */
export const AUTO_ACCEPT_MIN_CONFIDENCE = 90;

/**
 * The starting Accept/Reject decision for a freshly verified action:
 *  - `rejected`  — the verifier quarantined it (not in the document). Never applied.
 *  - `accepted`  — verified AND confidence ≥ 90: trustworthy on both axes, auto-accepted.
 *  - `pending`   — verified-but-lower-confidence, or `review`: a human must decide.
 * Auto-accept deliberately requires the deterministic `verified` status, not just
 * the AI's self-reported confidence — a confident-sounding invention must never apply.
 */
export function initialDecision(action: VerifiedAction): ActionDecision {
  if (action.verification.status === "rejected") return "rejected";
  if (
    action.verification.status === "verified" &&
    (action.confidence ?? 0) >= AUTO_ACCEPT_MIN_CONFIDENCE
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
    (action.confidence ?? 0) >= AUTO_ACCEPT_MIN_CONFIDENCE
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
export const DEFAULT_SIMPLIFY_GUIDANCE = `DOCUMENT SIMPLIFICATION — RHB HOUSE RULES (applied on top of the built-in rules)

# THOROUGHNESS — work the WHOLE section, top to bottom
- Go section by section. Do NOT skip a section because its heading sounds administrative ("Applicability", "Objectives", "Overview", "Declaration", "Purpose", "Scope"). In bank documents those sections are usually the most verbose and the highest-value to simplify.
- For each section, actively scan for 3-6 simplification candidates before moving on. If after honest review a section is genuinely clean, return zero edits for it — but only after you've checked.
- Don't pre-filter for "important parts". Simplification value is highest in dense, bureaucratic prose, which usually lives in the boilerplate at the top and bottom of the document.

# COMMON VERBOSITY PATTERNS — actively hunt for every one of these
1. Nominalisations → plain verbs.
   - "make a decision" → "decide"
   - "carry out a review of" → "review"
   - "provide assistance to" → "help"
   - "have an obligation to" → "must"
2. Passive voice with weak subjects → active voice.
   - "approval is to be obtained from X" → "obtain approval from X"
   - "the manual is to be reviewed by the Document Owner" → "the Document Owner reviews the manual"
3. Filler phrases → drop or shorten.
   - "in order to" → "to"
   - "for the purpose of" → "to"
   - "with respect to" / "in relation to" → "for" / "about"
   - "in the event that" → "if"
   - "is in the process of" → "is"
4. Doublets → pick the more specific one.
   - "rules and regulations" → "rules" (or "regulations" if that's what's meant)
   - "terms and conditions" → "terms"
   - "policies and procedures" → whichever applies
5. Modal stacks → tighten.
   - "shall be required to" → "must"
   - "may be considered to be" → "may be"
   - "shall be deemed to constitute" → "constitutes"
6. Redundant qualifiers → drop.
   - "absolutely necessary" → "necessary"; "completely eliminate" → "eliminate"
   - "advance planning" → "planning"; "end result" → "result"; "final outcome" → "outcome"
7. Long lists in prose → to_bullets.
   - Anything with 3+ commas describing parallel items is a candidate for bullet conversion.
8. Long cross-reference clauses → terse parenthetical.
   - "as outlined in Section 4 of this manual which sets out the procedures for X" → "(see Section 4)"
9. Sentences over 25 words → almost always shorten or split.
10. Definite-article inconsistency around defined terms.
    - Pick one form per document: either "the Document Owner" or "Document Owner". Standardise.

# STYLE — direction of every rewrite
- Active voice (named subject does the action).
- Short sentences (≤ 25 words). Split if there are 3+ clauses joined by "and".
- One idea per sentence.
- British English spelling (organise, prioritise, programme, authorise, behaviour, centre).
- Plain verbs over Latinate nominalisations.

# TERMINOLOGY — bring wording into line as you rephrase
Pick one canonical form per term and use it everywhere. Examples — extend with real RHB house glossary:
- "Document Owner" (never "doc owner", "owner of the document", "the owner")
- "Operations & Methods (O&M)" on first use; "O&M" thereafter
- Keep list order "Framework, Policy, Guideline, Manual and Circular" exactly when that list appears
- "Approving Authority" — treat as a defined term (capitalised, singular)
- "RHB Banking Group" — never just "the Group" outside clearly local context
- Preserve slash notation "Business/Functional Units" — do NOT normalise to "Business and Functional Units"
- Committee names verbatim: Board Risk Committee (BRC), Group Management Committee (GMC), etc.

# CONFIDENCE CALIBRATION — be honest, this drives auto-accept
- 100 — wording-only rewrite with no scope/number/term changes. Most plain_english + shorten edits.
- 95-99 — sentence restructured but every clause's meaning is preserved. Common for to_bullets, merge.
- 90-94 — one ambiguity in source you've resolved a particular way. Note the ambiguity in rationale.
- 80-89 — moderate rewrite where source could plausibly read another way. Honest "reviewer please check" signal.
- < 80 — DO NOT emit. Skip the action instead.

# LEAVE UNTOUCHED — non-negotiable
- Defined terms, role titles, committee names (BRC, GMC, MANCO, etc.), system names, product names.
- Numbers, thresholds, dates, percentages, monetary amounts, authority limits.
- Any wording whose change would alter the SCOPE of an obligation (e.g. "all staff" vs "all relevant staff" — leave as-is).
- Cross-reference numbering (Section 4.2.1, Appendix B) — don't renumber.
- Quoted regulatory citations — never paraphrase.

# TONE — bank policy register, NOT conversational
This is an official bank policy / operations document. The output must read like
formal institutional prose, NOT a user-facing how-to or website copy.

❌ FORBIDDEN — second-person address (NEVER introduce these, EVEN IF the source already uses them — replace with the appropriate institutional subject):
- "you", "your", "yours", "yourself"
- "you can", "you may", "you must", "you should", "you will", "you'll", "you'd"
- "we", "us", "our", "I", "my"

❌ FORBIDDEN — conversational filler:
- "you'll find that", "as you can see", "of course", "simply", "just", "kindly", "please note that"

❌ FORBIDDEN — marketing language:
- "seamless", "world-class", "best-in-class", "robust", "leverage", "empower", "streamline", "innovative"

✅ PREFERRED — institutional subjects (use one of these in place of "you/we"):
- "Staff", "Users", "the Document Owner", "the Bank", "RHB Banking Group", "the Group",
  "Operations & Methods (O&M)", "Approving Authority", "Business/Functional Units",
  "the [specific role/committee named in source]"
- Or use a passive/impersonal construction when no specific subject is implied.

REWRITE EXAMPLES:
| ❌ Wrong (informal)              | ✅ Right (policy register)                                       |
| -------------------------------- | ---------------------------------------------------------------- |
| "You can view this on My1Portal" | "This document is available on My1Portal." OR "Staff may view this document on My1Portal." |
| "You must obtain approval"       | "Approval must be obtained" OR "The Document Owner must obtain approval" |
| "You'll find details in Sec. 4"  | "Further details are in Section 4."                              |
| "We hereby confirm…"             | "The Document Owner confirms…"                                   |
| "Please ensure you submit…"      | "Submissions must be made…" OR "Staff must submit…"              |

- The source MAY use passive voice ("This document can be viewed…"). DO NOT switch
  passive to second-person — switch passive to active using an INSTITUTIONAL SUBJECT.
  Example: source "This document can be viewed…" → after "Staff may view this document…"
  (NOT "You can view this document…")
- Professional and instructional throughout.`;
