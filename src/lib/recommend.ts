// ============================================================================
// SIMPLIFY V2 — DOCUMENT QUALITY AUDIT + SAFE RESTRUCTURE PIPELINES
// ----------------------------------------------------------------------------
// Powers the "Recommendation" and "Recommend & Edit" modes of the Simplify v2
// workspace. Reads a WHOLE document and reports quality defects (gaps,
// contradictions, incomplete steps, …) with verbatim evidence; optionally
// generates a restructured version that fixes accepted findings while
// PRESERVING every substantive claim (verified by a bidirectional coverage
// check, not by trust).
//
// Architecture follows the multi-pass shape that works on long documents
// (single-pass "find contradictions" prompting is near-random — ContraDoc):
//   1. structure        — deterministic (analyzeStructure, reused)
//   2. claim extraction — per-unit atomic obligations/steps/thresholds/roles
//   3. clustering       — group claims about the SAME topic across sections
//   4. consistency      — LLM judges each cluster; verbatim quotes required
//   5. completeness     — section-grouped scan for gaps/sequencing/structure
//   6. verification     — dual gate: deterministic quote matching (fuzzy ≥.85,
//                         same threshold as verifyActions) + evidence-only LLM
//                         re-check. Unverified findings are quarantined.
// Deterministic checks (stale cross-refs, undefined acronyms) are plain code.
// ============================================================================

import {
  generateWithFallback,
  parseJsonArrayLoose,
  chunkText,
  mapLimit,
  guidanceBlock,
} from "./gemini";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "./pricing";
import { wordsOnly, buildWordIndex, bestFuzzyScore, type DocStructure } from "./simplify";
import type { StructuredUnit } from "./docx-editor";

// ── Types ────────────────────────────────────────────────────────────────────

export type FindingCategory =
  | "contradiction"
  | "incompleteness"
  | "ambiguous_actor"
  | "undefined_term"
  | "stale_reference"
  | "redundancy"
  | "sequencing"
  | "structural"
  | "non_verifiable"
  // Not an audit defect — a reviewer's ad-hoc "Edit with AI" request, kept in
  // its own category so it never reads as a discovered risk in the dashboard.
  | "user_requested";

export type FindingSeverity = "critical" | "high" | "medium" | "info";

export const FINDING_CATEGORY_META: Record<FindingCategory, { label: string; hint: string }> = {
  contradiction:   { label: "Contradiction",        hint: "Two places state conflicting requirements" },
  incompleteness:  { label: "Incomplete",           hint: "Missing steps, prerequisites, escalation or exception paths" },
  ambiguous_actor: { label: "Ambiguous actor",      hint: "Unclear who is responsible for an action" },
  undefined_term:  { label: "Undefined term",       hint: "Acronym or defined term used without definition" },
  stale_reference: { label: "Stale reference",      hint: "Cross-reference to a section that doesn't exist" },
  redundancy:      { label: "Duplication",          hint: "Same content stated in multiple diverging places" },
  sequencing:      { label: "Sequencing",           hint: "Steps out of order or forward-referencing" },
  structural:      { label: "Structure",            hint: "Numbering, heading or formatting decay" },
  non_verifiable:  { label: "Non-verifiable",       hint: "Obligation with no measurable criterion" },
  user_requested:  { label: "Requested edit",       hint: "Change requested directly by a reviewer" },
};

export interface ClaimUnit {
  id: string; // "C-0042"
  kind: "obligation" | "step" | "threshold" | "role" | "definition" | "escalation";
  actor: string;
  action: string;
  condition?: string;
  section: string;
  quote: string; // verbatim from the document
}

export interface FindingEvidence {
  section: string;
  quote: string; // verbatim
}

export interface Finding {
  id: string; // "F-001"
  category: FindingCategory;
  severity: FindingSeverity;
  title: string; // one-line issue statement
  description: string;
  evidence: FindingEvidence[]; // 1 for most; 2+ for contradiction/redundancy
  suggestedFix: string;
  confidence: number; // 0-100
  source: "llm" | "deterministic";
  verification: { status: "verified" | "review" | "rejected"; note?: string };
  decision: "accepted" | "dismissed" | "pending";
}

export interface AuditCounts {
  bySeverity: Record<FindingSeverity, number>;
  byCategory: Partial<Record<FindingCategory, number>>;
}

export interface AuditResult {
  claims: ClaimUnit[];
  findings: Finding[];
  clusterCount: number;
  usage: TokenUsage;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 };

// ── Default guidance (editable in Settings under "simplify_v2_recommend") ────

export const DEFAULT_RECOMMEND_GUIDANCE = `DOCUMENT QUALITY AUDIT — RHB HOUSE RULES

# ROLE
You are a senior process-quality auditor reviewing bank SOP / policy / operations
manuals that have degraded through years of layered edits. Your job is to find
DEFECTS IN THE DOCUMENT ITSELF — not to critique the underlying policy choices.

# DEFECT CATEGORIES — the only nine you may report
1. contradiction — two places impose conflicting requirements.
   e.g. "Section 4.2 requires escalation after 2 failed matches; Section 7.1 says after 3."
2. incompleteness — a procedure is missing steps, prerequisites, inputs,
   exception handling, or an escalation path.
   e.g. "Step 5 references the completed Form CD-11 but no step produces it."
   e.g. "The rejection branch says 'refer for review' with no named recipient or SLA."
3. ambiguous_actor — an obligation with no clear owner.
   e.g. "'The officer shall verify the signature' where three officer roles are defined."
4. undefined_term — an acronym or capitalised defined term used but never defined.
5. stale_reference — a cross-reference to a section/appendix that does not exist.
6. redundancy — the same rule stated in multiple places, especially DIVERGENT
   copies (the most dangerous decay: two versions of one rule drifting apart).
7. sequencing — steps presented out of execution order, or a step consuming an
   output produced only in a later step.
8. structural — numbering gaps, orphan headings, inconsistent list/format
   conventions that impede navigation.
9. non_verifiable — an obligation with no measurable criterion.
   e.g. "'reviews must be performed regularly' — no frequency stated."

# SEVERITY CALIBRATION — be honest; this drives triage
- critical — contradictory obligations, or a missing escalation/exception path
  with regulatory or financial exposure. A person following the document could
  act wrongly.
- high     — execution-blocking: a missing prerequisite/step, or actor ambiguity
  on a control activity. A person following the document gets stuck or guesses.
- medium   — undefined terms, stale references, divergent duplicates, sequencing
  problems. Causes confusion and rework but a careful reader can recover.
- info     — structural/format decay and style-level observations.

# EVIDENCE RULES — non-negotiable
- Every finding MUST quote the document VERBATIM (no paraphrase) with its section.
- contradiction and redundancy findings MUST quote BOTH locations.
- Keep each quote under 60 words — the shortest span that proves the issue.
- If you cannot quote it, do not report it.

# WHAT NOT TO REPORT
- Policy disagreements ("2 approvals should be 3") — out of scope.
- Prose style/verbosity — the separate simplification pass owns that.
- Anything a quoted span cannot prove.

# CONFIDENCE
- 90-100: the quotes alone prove the defect to any reader.
- 75-89: the defect is real but requires reading the surrounding context.
- below 75: DO NOT emit the finding.`;

// ── Shared helpers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageOf(response: any): TokenUsage {
  const meta = (response?.usageMetadata ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    thinkingTokens: meta.thoughtsTokenCount ?? 0,
    calls: 1,
  };
}

/** generateWithFallback + transient retry, JSON response, one place. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function askJson(prompt: string, tier: "fast" | "quality", maxOutputTokens = 65536): Promise<{ items: any[]; usage: TokenUsage }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any = null;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await generateWithFallback({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", maxOutputTokens },
      }, { tier });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { items: parseJsonArrayLoose(response.text), usage: usageOf(response) };
}

function severityOf(raw: unknown): FindingSeverity {
  return raw === "critical" || raw === "high" || raw === "medium" || raw === "info" ? raw : "medium";
}

const CATEGORY_SET = new Set<FindingCategory>([
  "contradiction", "incompleteness", "ambiguous_actor", "undefined_term",
  "stale_reference", "redundancy", "sequencing", "structural", "non_verifiable",
]);

// ── Deterministic checks (plain code, auto-verified) ────────────────────────

/** Section numbers like "4.2.1" (and appendix letters) present in headings. */
function harvestSectionNumbers(structure: DocStructure): { numbers: Set<string>; appendices: Set<string> } {
  const numbers = new Set<string>();
  const appendices = new Set<string>();
  for (const s of structure.sections ?? []) {
    const text = String(s.heading ?? "");
    const num = text.match(/^\s*(\d+(?:\.\d+)*)/);
    if (num) {
      // "4.2.1" implies 4 and 4.2 exist too.
      const parts = num[1].split(".");
      for (let i = 1; i <= parts.length; i++) numbers.add(parts.slice(0, i).join("."));
    }
    const app = text.match(/^\s*append(?:ix|ices)\s+([A-Z0-9]+)/i);
    if (app) appendices.add(app[1].toUpperCase());
  }
  return { numbers, appendices };
}

/** Cross-references pointing at sections/appendices that don't exist. */
export function detectStaleCrossRefs(
  units: { text: string; section: string }[],
  structure: DocStructure,
): Finding[] {
  const { numbers, appendices } = harvestSectionNumbers(structure);
  // Without numbered headings we can't judge refs — stay silent, don't guess.
  if (numbers.size === 0 && appendices.size === 0) return [];

  const findings: Finding[] = [];
  const seen = new Set<string>();
  const refRe = /\b(section|clause|para(?:graph)?|appendix|annex(?:ure)?)\s+(\d+(?:\.\d+)*|[A-Z]\b)/gi;

  for (const u of units) {
    for (const m of u.text.matchAll(refRe)) {
      const kind = m[1].toLowerCase();
      const target = m[2];
      const isAppendix = kind.startsWith("append") || kind.startsWith("annex");
      // Each branch stays silent when ITS namespace is empty (unnumbered
      // headings must not turn every "Section 4.2" into a false positive
      // just because one "Appendix A" heading exists).
      const ok = isAppendix
        ? appendices.has(target.toUpperCase()) || appendices.size === 0
        : numbers.has(target) || numbers.size === 0 || /^[A-Z]$/.test(target);
      if (ok) continue;
      const key = `${kind} ${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: "", // assigned later
        category: "stale_reference",
        severity: "medium",
        title: `Reference to non-existent ${kind} ${target}`,
        description: `The document refers to "${kind} ${target}", but no heading with that number exists. Likely left behind by a renumbering or deletion in a past edit.`,
        evidence: [{ section: u.section || "—", quote: contextAround(u.text, m.index ?? 0, 160) }],
        suggestedFix: `Update or remove the reference to "${kind} ${target}" — point it at the current section that holds this content.`,
        confidence: 92,
        source: "deterministic",
        verification: { status: "verified", note: "Ref target absent from document headings (exact scan)." },
        decision: "pending",
      });
    }
  }
  return findings.slice(0, 20);
}

function contextAround(text: string, at: number, span: number): string {
  const lo = Math.max(0, at - Math.floor(span / 3));
  return text.slice(lo, lo + span).trim();
}

const ACRONYM_STOPLIST = new Set([
  "THE", "AND", "FOR", "NOT", "ALL", "ANY", "MAY", "MUST", "SHALL", "WILL",
  "N/A", "NA", "OK", "NO", "TO", "OF", "ON", "IN", "IT", "IS", "BE", "AS",
  "AT", "BY", "OR", "AN", "WE", "US", "IF", "DO", "SO", "UP", "PER", "VIA",
  "PDF", "DOCX", "DOC", "XLS", "XLSX", "URL", "FAQ", "PIC", "NOTE", "STEP",
  "RHB", "SOP", "SOPS", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI",
]);

/** Acronyms used repeatedly but never expanded and absent from any glossary. */
export function detectUndefinedAcronyms(
  text: string,
  units: { text: string; section: string }[],
): Finding[] {
  // Region of the doc that counts as a definitions/glossary section.
  const glossaryText = units
    .filter((u) => /definitions|glossary|abbreviation|acronym/i.test(u.section))
    .map((u) => u.text)
    .join("\n");

  const counts = new Map<string, { n: number; firstUnit: { text: string; section: string } }>();
  for (const u of units) {
    // Headings are ALL-CAPS by house style, so every short word in one looks
    // like an acronym ("CASH", "POLICY"). Count usage from body units only —
    // a real acronym always also appears in body text.
    if (u.text === u.section) continue;
    for (const m of u.text.matchAll(/\b([A-Z][A-Z0-9&]{1,5})s?\b/g)) {
      const acr = m[1];
      if (ACRONYM_STOPLIST.has(acr) || /^\d+$/.test(acr)) continue;
      const cur = counts.get(acr);
      if (cur) cur.n++;
      else counts.set(acr, { n: 1, firstUnit: u });
    }
  }

  const findings: Finding[] = [];
  for (const [acr, { n, firstUnit }] of counts) {
    if (n < 2) continue; // one-off tokens are more likely codes than acronyms
    // Defined if "Long Form (ACR)" appears anywhere, or it's in the glossary.
    const expanded = new RegExp(`\\([\\s]*${acr}[\\s]*\\)`).test(text);
    const inGlossary = glossaryText.includes(acr);
    if (expanded || inGlossary) continue;
    findings.push({
      id: "",
      category: "undefined_term",
      severity: "medium",
      title: `Acronym "${acr}" is never defined`,
      description: `"${acr}" is used ${n} time(s) but is never expanded at first use and does not appear in a definitions/glossary section.`,
      evidence: [{ section: firstUnit.section || "—", quote: contextAround(firstUnit.text, firstUnit.text.indexOf(acr), 160) }],
      suggestedFix: `Expand at first use — "Full Name (${acr})" — or add "${acr}" to the definitions section.`,
      confidence: 85,
      source: "deterministic",
      verification: { status: "verified", note: `No parenthesised expansion or glossary entry found (${n} uses).` },
      decision: "pending",
    });
  }
  return findings
    .sort((a, b) => Number(b.description.match(/used (\d+)/)?.[1] ?? 0) - Number(a.description.match(/used (\d+)/)?.[1] ?? 0))
    .slice(0, 15);
}

/** Binding duties assigned to a vague role ("the relevant officer shall…").
 *  Cluster consistency only sees these when a counterpart claim happens to
 *  cluster with them, so a STANDALONE vague-actor sentence was structurally
 *  invisible — this exact scan closes that gap for free. */
const VAGUE_ACTOR_RE =
  /\b(?:the\s+)?(relevant|responsible|appropriate|designated|concerned)\s+(officers?|personnel|staff|persons?|part(?:y|ies)|employees?|team|unit|department)\b/gi;
const BINDING_MODAL_RE = /\b(shall|must|is required|are required|is responsible|are responsible)\b/i;

export function detectVagueActors(
  units: { text: string; section: string }[],
): Finding[] {
  // A phrase that appears in a definitions/glossary section is a DEFINED role
  // ("Responsible Officer" can be a term of art) — don't flag it anywhere.
  const glossaryText = units
    .filter((u) => /definitions|glossary/i.test(u.section))
    .map((u) => u.text)
    .join("\n")
    .toLowerCase();

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    if (u.text === u.section) continue; // headings
    for (const m of u.text.matchAll(VAGUE_ACTOR_RE)) {
      const phrase = m[0].replace(/^the\s+/i, "").toLowerCase();
      if (seen.has(phrase) || glossaryText.includes(phrase)) continue;
      // Only a binding duty is a defect — descriptive mentions are fine.
      const sentence = sentenceAround(u.text, m.index ?? 0);
      if (!BINDING_MODAL_RE.test(sentence)) continue;
      seen.add(phrase);
      findings.push({
        id: "",
        category: "ambiguous_actor",
        severity: "medium",
        title: `Duty assigned to a vague role: "${m[0]}"`,
        description: `A binding obligation is assigned to "${m[0]}" — no named role or position owns it, so it is unenforceable and unauditable as written.`,
        evidence: [{ section: u.section || "—", quote: sentence.slice(0, 240) }],
        suggestedFix: `Replace "${m[0]}" with the specific role that owns this duty (e.g. a named position from the roles section).`,
        confidence: 85,
        source: "deterministic",
        verification: { status: "verified", note: "Vague role phrase with a binding modal verb (exact scan)." },
        decision: "pending",
      });
    }
  }
  return findings.slice(0, 8);
}

/** Verbatim paragraph duplicated across different sections. The LLM cluster
 *  pass covers DIVERGING near-copies; byte-identical copies are cheaper and
 *  safer to find exactly. ≥120 chars skips boilerplate lines; requiring
 *  distinct sections skips legitimate within-table repetition. */
export function detectDuplicateParagraphs(
  units: { text: string; section: string }[],
): Finding[] {
  const byNorm = new Map<string, { text: string; section: string }[]>();
  for (const u of units) {
    if (u.text === u.section || u.text.trim().length < 120) continue;
    const norm = u.text.toLowerCase().replace(/\s+/g, " ").trim();
    const list = byNorm.get(norm) ?? [];
    list.push(u);
    byNorm.set(norm, list);
  }
  const findings: Finding[] = [];
  for (const occ of byNorm.values()) {
    const sections = [...new Set(occ.map((o) => o.section))];
    if (occ.length < 2 || sections.length < 2) continue;
    findings.push({
      id: "",
      category: "redundancy",
      severity: "medium",
      title: `Identical paragraph appears in ${sections.length} sections`,
      description: `The same paragraph is repeated verbatim in ${sections.map((s) => `"${s}"`).join(" and ")}. Duplicated text is a maintenance hazard — a future edit will change one copy and miss the other.`,
      evidence: occ.slice(0, 2).map((o) => ({ section: o.section || "—", quote: o.text.slice(0, 240) })),
      suggestedFix: `Keep the paragraph in the section that owns the rule and replace the other occurrence with a cross-reference to it.`,
      confidence: 95,
      source: "deterministic",
      verification: { status: "verified", note: "Byte-identical paragraph found in multiple sections (exact scan)." },
      decision: "pending",
    });
  }
  return findings.slice(0, 8);
}

/** The sentence containing offset `at` (bounded, for evidence quotes). */
function sentenceAround(text: string, at: number): string {
  const lo = text.lastIndexOf(".", at - 1) + 1;
  let hi = text.indexOf(".", at);
  if (hi < 0) hi = text.length;
  return text.slice(lo, hi + 1).trim();
}

// ── Pass 2: claim extraction ─────────────────────────────────────────────────

async function extractClaims(
  title: string,
  units: { text: string; section: string }[],
  opts?: { guidance?: string | null },
): Promise<{ claims: ClaimUnit[]; usage: TokenUsage }> {
  const candidates = units.filter((u) => u.text.trim().length >= 20);
  if (candidates.length === 0) return { claims: [], usage: EMPTY_USAGE };

  const BATCH = 50;
  const batches: { text: string; section: string }[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));

  let counter = 0;
  const results = await mapLimit(batches, 4, async (batch) => {
    const numbered = batch.map((u, i) => `${i + 1}. [${u.section || "—"}] ${u.text}`).join("\n\n");
    const prompt = `# ROLE: ATOMIC CLAIM EXTRACTION from the bank document "${title}"
You are given NUMBERED units (paragraphs/table cells), each prefixed with its [section].
Extract every ATOMIC claim — one obligation, process step, threshold/limit, role assignment, definition, or escalation rule per object. Skip units that contain none (headings, boilerplate, page furniture).

# RULES
- "quote" must be a VERBATIM substring of the unit (max 40 words) — the span that carries the claim.
- "actor" = who performs/owns it ("Document Owner", "Branch Manager", "unspecified" if the text names no one).
- "kind": obligation | step | threshold | role | definition | escalation.
- "condition" only if the claim applies conditionally ("if the amount exceeds RM50,000").
- One unit can yield multiple claims. Do not invent anything not in the text.
${guidanceBlock(opts?.guidance)}
# OUTPUT — ONLY a JSON array:
[{ "i": <unit number>, "kind": "...", "actor": "...", "action": "<one line>", "condition": "<optional>", "quote": "<verbatim>" }]

# UNITS:
${numbered}
`;
    try {
      const { items, usage } = await askJson(prompt, "fast");
      const claims: ClaimUnit[] = [];
      for (const r of items) {
        const idx = Number(r?.i) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
        const quote = typeof r?.quote === "string" ? r.quote.trim() : "";
        if (!quote) continue;
        claims.push({
          id: `C-${String(++counter).padStart(4, "0")}`,
          kind: (["obligation", "step", "threshold", "role", "definition", "escalation"].includes(r?.kind) ? r.kind : "obligation") as ClaimUnit["kind"],
          actor: typeof r?.actor === "string" && r.actor.trim() ? r.actor.trim() : "unspecified",
          action: typeof r?.action === "string" ? r.action.trim() : quote.slice(0, 100),
          condition: typeof r?.condition === "string" && r.condition.trim() ? r.condition.trim() : undefined,
          section: batch[idx].section || "—",
          quote,
        });
      }
      return { claims, usage };
    } catch (e) {
      console.warn("extractClaims: batch failed:", (e as Error)?.message?.slice(0, 100));
      return { claims: [] as ClaimUnit[], usage: EMPTY_USAGE };
    }
  });

  return {
    claims: results.flatMap((r) => r.claims),
    usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE),
  };
}

// ── Pass 3: cross-section clustering ─────────────────────────────────────────

async function clusterClaims(
  claims: ClaimUnit[],
): Promise<{ clusters: ClaimUnit[][]; usage: TokenUsage }> {
  if (claims.length < 2) return { clusters: [], usage: EMPTY_USAGE };

  // Compact one-line index — id | kind | actor | action. Cheap enough to send
  // in ONE quality call even for ~1500 claims.
  const index = claims
    .map((c) => `${c.id} | ${c.kind} | ${c.actor} | [${c.section}] ${c.action.slice(0, 120)}`)
    .join("\n");

  const prompt = `# ROLE: TOPIC CLUSTERING of claims extracted from one bank SOP.
Below is an index of atomic claims (id | kind | actor | [section] action).
Group claims that concern the SAME topic, entity, process, threshold or role — ESPECIALLY when they appear in DIFFERENT sections (cross-section duplicates and contradictions hide there). A claim may appear in at most one cluster. Omit singletons.

# OUTPUT — ONLY a JSON array:
[{ "topic": "<short label>", "ids": ["C-0001","C-0042", ...] }]

# CLAIM INDEX:
${index}
`;
  try {
    const { items, usage } = await askJson(prompt, "quality");
    const byId = new Map(claims.map((c) => [c.id, c]));
    const used = new Set<string>();
    const clusters: ClaimUnit[][] = [];
    for (const r of items) {
      const ids: string[] = Array.isArray(r?.ids) ? r.ids : [];
      const members = ids
        .filter((id) => byId.has(id) && !used.has(id))
        .slice(0, 40)
        .map((id) => { used.add(id); return byId.get(id)!; });
      if (members.length >= 2) clusters.push(members);
    }
    return { clusters, usage };
  } catch (e) {
    console.warn("clusterClaims failed:", (e as Error)?.message?.slice(0, 100));
    return { clusters: [], usage: EMPTY_USAGE };
  }
}

// ── Pass 4: per-cluster consistency check ────────────────────────────────────

async function checkClusterConsistency(
  title: string,
  clusters: ClaimUnit[][],
  opts?: { guidance?: string | null },
): Promise<{ findings: Finding[]; usage: TokenUsage }> {
  if (clusters.length === 0) return { findings: [], usage: EMPTY_USAGE };

  const results = await mapLimit(clusters, 4, async (cluster) => {
    const block = cluster
      .map((c) => `- (${c.id}) [${c.section}] ${c.kind}, actor: ${c.actor}${c.condition ? `, condition: ${c.condition}` : ""}\n  QUOTE: "${c.quote}"`)
      .join("\n");
    const prompt = `# ROLE: CONSISTENCY AUDIT of related claims from the bank document "${title}"
The claims below were extracted from DIFFERENT parts of the document but concern the same topic. Judge them AGAINST EACH OTHER for:
- contradiction — conflicting numbers, timeframes, actors, or directions for the same rule
- redundancy — the same rule restated in more than one section with DIFFERENT wording (paraphrased or diverging copies; byte-identical duplicates are already caught by code — skip those)
- ambiguous_actor — the same duty assigned vaguely or to different owners
- non_verifiable — an obligation among them with no measurable criterion

# RULES
- Base EVERYTHING on the quotes. If the quotes don't prove it, don't report it.
- Every finding needs evidence quotes from EVERY location involved (verbatim, from the QUOTE lines).
- No findings is a perfectly good answer — return [] rather than stretch.
${guidanceBlock(opts?.guidance)}
# OUTPUT — ONLY a JSON array:
[{ "category": "contradiction|redundancy|ambiguous_actor|non_verifiable", "severity": "critical|high|medium|info", "title": "<one line>", "description": "<2-3 sentences>", "evidence": [{"section":"...","quote":"<verbatim>"}], "suggestedFix": "<concrete edit>", "confidence": <75-100> }]

# CLAIMS:
${block}
`;
    try {
      const { items, usage } = await askJson(prompt, "quality");
      return { items, usage };
    } catch (e) {
      console.warn("checkClusterConsistency: cluster failed:", (e as Error)?.message?.slice(0, 100));
      return { items: [] as unknown[], usage: EMPTY_USAGE };
    }
  });

  const findings: Finding[] = [];
  for (const r of results) {
    for (const raw of r.items as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const f = coerceLlmFinding(raw);
      if (f) findings.push(f);
    }
  }
  return { findings, usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE) };
}

// ── Pass 5: completeness / sequencing / structure ────────────────────────────

async function checkCompleteness(
  title: string,
  text: string,
  opts?: { guidance?: string | null },
): Promise<{ findings: Finding[]; usage: TokenUsage }> {
  const chunks = chunkText(text, 80_000);
  const results = await mapLimit(chunks, 3, async (chunk, ) => {
    const prompt = `# ROLE: COMPLETENESS & FLOW AUDIT of a portion of the bank document "${title}"
Read the excerpt below END TO END and report defects of these kinds ONLY:
- incompleteness — a procedure missing steps, prerequisites, inputs, exception handling, or an escalation path (e.g. a rejection branch that goes nowhere; a form referenced but never produced; "refer for review" with no recipient)
- sequencing — steps out of execution order, or a step consuming something produced only later
- structural — numbering gaps, orphan headings, inconsistent list conventions that impede navigation

# RULES
- Every finding MUST include a VERBATIM quote (max 60 words) from the excerpt proving it.
- Judge only what this excerpt shows — if a step may be defined elsewhere in the document, lower the confidence accordingly (below 75 = don't report).
- Return [] when the excerpt is genuinely clean.
${guidanceBlock(opts?.guidance)}
# OUTPUT — ONLY a JSON array:
[{ "category": "incompleteness|sequencing|structural", "severity": "critical|high|medium|info", "title": "<one line>", "description": "<2-3 sentences>", "evidence": [{"section":"<nearest heading in the excerpt>","quote":"<verbatim>"}], "suggestedFix": "<concrete edit>", "confidence": <75-100> }]

# EXCERPT:
${chunk}
`;
    try {
      const { items, usage } = await askJson(prompt, "quality");
      return { items, usage };
    } catch (e) {
      console.warn("checkCompleteness: chunk failed:", (e as Error)?.message?.slice(0, 100));
      return { items: [] as unknown[], usage: EMPTY_USAGE };
    }
  });

  const findings: Finding[] = [];
  for (const r of results) {
    for (const raw of r.items as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const f = coerceLlmFinding(raw);
      if (f) findings.push(f);
    }
  }
  return { findings, usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceLlmFinding(raw: any): Finding | null {
  if (!raw || !CATEGORY_SET.has(raw.category)) return null;
  const evidence: FindingEvidence[] = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter((e: any) => typeof e?.quote === "string" && e.quote.trim()) // eslint-disable-line @typescript-eslint/no-explicit-any
        .map((e: any) => ({ section: String(e.section ?? "—"), quote: String(e.quote).trim() })) // eslint-disable-line @typescript-eslint/no-explicit-any
    : [];
  if (evidence.length === 0) return null;
  if ((raw.category === "contradiction" || raw.category === "redundancy") && evidence.length < 2) return null;
  const confidence = typeof raw.confidence === "number" ? raw.confidence : 75;
  if (confidence < 75) return null;
  return {
    id: "",
    category: raw.category as FindingCategory,
    severity: severityOf(raw.severity),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled finding",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    evidence,
    suggestedFix: typeof raw.suggestedFix === "string" ? raw.suggestedFix.trim() : "",
    confidence,
    source: "llm",
    verification: { status: "review" },
    decision: "pending",
  };
}

// ── Pass 6: verification (deterministic + evidence-only LLM re-check) ───────

export async function verifyFindings(
  findings: Finding[],
  docText: string,
): Promise<{ findings: Finding[]; usage: TokenUsage }> {
  const docWords = wordsOnly(docText).split(" ");
  const wordIndex = buildWordIndex(docWords);

  // Gate 1 — every evidence quote must actually be in the document.
  for (const f of findings) {
    if (f.source === "deterministic") continue; // already grounded by code
    const scores = f.evidence.map((e) => bestFuzzyScore(wordsOnly(e.quote).split(" "), docWords, wordIndex));
    const worst = Math.min(...scores);
    if (worst < 0.85) {
      f.verification = { status: "rejected", note: `Evidence quote not found in document (match ${(worst * 100).toFixed(0)}%).` };
      f.decision = "dismissed";
    }
  }

  // Gate 2 — evidence-only LLM re-check for the survivors.
  const toCheck = findings.filter((f) => f.source === "llm" && f.verification.status !== "rejected");
  const BATCH = 10;
  const batches: Finding[][] = [];
  for (let i = 0; i < toCheck.length; i += BATCH) batches.push(toCheck.slice(i, i + BATCH));

  const results = await mapLimit(batches, 4, async (batch) => {
    const block = batch
      .map((f, i) => `${i + 1}. [${f.category}/${f.severity}] ${f.title}\n   ${f.description}\n${f.evidence.map((e) => `   EVIDENCE [${e.section}]: "${e.quote}"`).join("\n")}`)
      .join("\n\n");
    const prompt = `# ROLE: FINDING VERIFICATION — judge each finding ONLY against its own quoted evidence.
For each numbered finding: do the quotes ALONE prove the stated defect?
- "confirm" — yes, the quotes prove it.
- "reject" — the quotes do not support the claim (wrong reading, stretch, or policy critique).
- Optionally correct the severity if miscalibrated.

# OUTPUT — ONLY a JSON array: [{ "i": <number>, "verdict": "confirm|reject", "severity": "<optional corrected>", "note": "<one line, only for reject>" }]

# FINDINGS:
${block}
`;
    try {
      const { items, usage } = await askJson(prompt, "fast", 16384);
      return { batch, items, usage };
    } catch (e) {
      console.warn("verifyFindings: batch failed:", (e as Error)?.message?.slice(0, 100));
      return { batch, items: [] as unknown[], usage: EMPTY_USAGE };
    }
  });

  for (const { batch, items } of results) {
    const verdictByIdx = new Map<number, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const r of items as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const idx = Number(r?.i) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) verdictByIdx.set(idx, r);
    }
    batch.forEach((f, i) => {
      const v = verdictByIdx.get(i);
      if (!v) {
        f.verification = { status: "review", note: "Re-check did not return a verdict — needs human review." };
        return;
      }
      if (v.verdict === "confirm") {
        f.verification = { status: "verified" };
        if (v.severity && SEVERITY_ORDER[severityOf(v.severity)] !== undefined) f.severity = severityOf(v.severity);
      } else {
        f.verification = { status: "rejected", note: typeof v.note === "string" ? v.note : "Rejected on evidence re-check." };
        f.decision = "dismissed";
      }
    });
  }

  return { findings, usage: results.reduce((acc, r) => addUsage(acc, r.usage), EMPTY_USAGE) };
}

// ── Reviewer-requested targeted edits ────────────────────────────────────────

export interface TargetedEditCandidate {
  section: string;
  quote: string; // verbatim from the document — the passage to change
  suggestion: string; // the proposed replacement text
  rationale: string; // why this passage matches the user's request
  confidence: number; // 0-100
}

export async function proposeTargetedEdits(
  title: string,
  text: string,
  instruction: string,
): Promise<{ candidates: TargetedEditCandidate[]; usage: TokenUsage }> {
  const prompt = `# ROLE: TARGETED EDIT ASSISTANT
A reviewer is reading "${title}" and has asked for a specific change. Scan the ENTIRE document below and find every passage that's actually relevant to their request — do not invent passages that aren't there.

# REVIEWER'S REQUEST
${instruction}

# DOCUMENT
${text.slice(0, 400_000)}

# OUTPUT — ONLY a JSON array, 1 to 5 items, ordered by relevance:
[{
  "section": "the heading/section this passage is under",
  "quote": "the EXACT verbatim passage to change — copied character-for-character from the document, no paraphrase, under 60 words",
  "suggestion": "the proposed replacement text, ready to insert as-is",
  "rationale": "one sentence: why this passage matches the request",
  "confidence": 0-100
}]
If nothing in the document is actually relevant to the request, return an empty array — never invent a passage.`;

  const { items, usage } = await askJson(prompt, "quality", 16384);
  const candidates: TargetedEditCandidate[] = (items as any[]) // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter((it) => it && typeof it.quote === "string" && typeof it.suggestion === "string")
    .map((it) => ({
      section: String(it.section ?? ""),
      quote: String(it.quote),
      suggestion: String(it.suggestion),
      rationale: String(it.rationale ?? ""),
      confidence: Number.isFinite(it.confidence) ? Math.max(0, Math.min(100, it.confidence)) : 60,
    }));
  return { candidates, usage };
}

// ── Concrete edit derivation (final document) ────────────────────────────────

export interface ConcreteEdit {
  findingId: string;
  find_text: string;
  replace_text: string;
  rationale: string;
}

/**
 * Turns accepted findings (+ the reviewer's decision values) into VERBATIM
 * find→replace pairs against the source document. Unlike the whole-document
 * rewrite, each pair is independently verifiable: find_text either anchors in
 * the source or the edit is reported as unresolved — nothing silently skipped.
 */
export async function deriveConcreteEdits(
  title: string,
  text: string,
  findings: Finding[],
  inputs: Record<string, string>,
): Promise<{ edits: ConcreteEdit[]; unresolved: { findingId: string; title: string; reason: string }[]; usage: TokenUsage }> {
  const unresolved: { findingId: string; title: string; reason: string }[] = [];
  const workable = findings.filter((f) => {
    if (!f.evidence?.[0]?.quote?.trim()) {
      unresolved.push({ findingId: f.id, title: f.title, reason: "No quoted passage to anchor the edit" });
      return false;
    }
    return true;
  });
  if (!workable.length) return { edits: [], unresolved, usage: EMPTY_USAGE };

  const findingBlocks = workable.map((f) => {
    const ui = inputs[f.id]?.trim();
    return [
      `## ${f.id} — ${f.title}`,
      `Passage (verbatim from document): "${f.evidence[0].quote}"`,
      `Problem: ${f.description}`,
      `Fix instruction: ${f.suggestedFix}`,
      ui ? `REVIEWER-PROVIDED VALUE: "${ui}" — incorporate this EXACT value/wording; do not invent a different one.` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const prompt = `# ROLE: PRECISION DOCUMENT EDITOR
"${title}" has been audited. For EACH finding below, produce ONE concrete edit that fixes it — as an exact find→replace pair against the document.

# HARD RULES
1. "find_text" MUST be copied CHARACTER-FOR-CHARACTER from the document (the flagged passage, or the smallest span that must change). Never paraphrase it.
2. "replace_text" is the corrected passage: the SAME text with ONLY the fix applied. Keep everything else identical — same terminology, same tone, no gratuitous rewriting.
3. Where a REVIEWER-PROVIDED VALUE is given, use it verbatim in replace_text.
4. Single passage only — no new paragraphs, headings or lists. If the fix genuinely needs new standalone content, append the new sentence(s) to the end of the flagged passage inside replace_text.
5. If a finding cannot be fixed by replacing one passage, put it in "unresolved" with a one-sentence reason. Never force a bad edit.

# FINDINGS
${findingBlocks}

# DOCUMENT
${text.slice(0, 400_000)}

# OUTPUT — ONLY JSON:
{"edits": [{"findingId": "F-001", "find_text": "…", "replace_text": "…", "rationale": "one sentence"}],
 "unresolved": [{"findingId": "F-00X", "reason": "…"}]}`;

  const { items, usage } = await askJson(prompt, "quality", 32768);
  // askJson returns an array OR the parsed object wrapped — normalise both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root: any = Array.isArray(items) ? (items[0] ?? {}) : items;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawEdits: any[] = Array.isArray(root?.edits) ? root.edits : (Array.isArray(items) && items.length && items[0]?.find_text ? items : []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawUnresolved: any[] = Array.isArray(root?.unresolved) ? root.unresolved : [];

  const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase();
  // Validate at PARAGRAPH granularity — the apply engine anchors per paragraph,
  // so a find_text spanning paragraphs would pass a flat-text check here and
  // then silently fail downstream.
  const paraNorms = text.split(/\n+/).map(norm).filter(Boolean);
  const byId = new Map(workable.map((f) => [f.id, f]));
  const edits: ConcreteEdit[] = [];

  for (const e of rawEdits) {
    const id = String(e?.findingId ?? "");
    const f = byId.get(id);
    const find = String(e?.find_text ?? "").trim();
    const replace = String(e?.replace_text ?? "").trim();
    if (!f || !find || !replace) continue;
    // Deterministic anchor check — a claimed edit must actually locate.
    const fNorm = norm(find);
    if (!paraNorms.some((p) => p.includes(fNorm))) {
      unresolved.push({
        findingId: id,
        title: f.title,
        reason: paraNorms.length && norm(text).includes(fNorm)
          ? "Passage spans a paragraph boundary — needs a manual edit"
          : "Proposed passage not found verbatim in the document",
      });
      continue;
    }
    edits.push({ findingId: id, find_text: find, replace_text: replace, rationale: String(e?.rationale ?? f.title) });
    byId.delete(id);
  }
  for (const u of rawUnresolved) {
    const id = String(u?.findingId ?? "");
    const f = byId.get(id);
    if (f) { unresolved.push({ findingId: id, title: f.title, reason: String(u?.reason ?? "Model could not derive a single-passage edit") }); byId.delete(id); }
  }
  for (const f of byId.values()) {
    unresolved.push({ findingId: f.id, title: f.title, reason: "No edit returned for this finding" });
  }
  return { edits, unresolved, usage };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export function countFindings(findings: Finding[]): AuditCounts {
  const bySeverity: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  const byCategory: Partial<Record<FindingCategory, number>> = {};
  for (const f of findings) {
    if (f.verification.status === "rejected") continue; // honest counts: quarantined excluded
    bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  return { bySeverity, byCategory };
}

export async function runAuditPipeline(
  title: string,
  text: string,
  units: { text: string; section: string }[],
  structure: DocStructure,
  guidance: string,
): Promise<AuditResult> {
  let usage = EMPTY_USAGE;

  // Deterministic findings first — free, grounded, auto-verified.
  const deterministic = [
    ...detectStaleCrossRefs(units, structure),
    ...detectUndefinedAcronyms(text, units),
    ...detectVagueActors(units),
    ...detectDuplicateParagraphs(units),
  ];

  // Pass 2 — claims.
  const claimsRes = await extractClaims(title, units, { guidance });
  usage = addUsage(usage, claimsRes.usage);

  // Passes 3+4 (consistency) and 5 (completeness) are independent — overlap them.
  const consistencyPromise = (async () => {
    const clustersRes = await clusterClaims(claimsRes.claims);
    const res = await checkClusterConsistency(title, clustersRes.clusters, { guidance });
    return { clusters: clustersRes.clusters, findings: res.findings, usage: addUsage(clustersRes.usage, res.usage) };
  })();
  const completenessPromise = checkCompleteness(title, text, { guidance });

  const [consistency, completeness] = await Promise.all([consistencyPromise, completenessPromise]);
  usage = addUsage(usage, consistency.usage);
  usage = addUsage(usage, completeness.usage);

  // Pass 6 — verification over every LLM finding.
  const verifyRes = await verifyFindings([...consistency.findings, ...completeness.findings], text);
  usage = addUsage(usage, verifyRes.usage);

  const all = [...deterministic, ...verifyRes.findings];

  // Initial decision: deterministic verified findings are safe to pre-accept —
  // EXCEPT ambiguous_actor: naming the right owner is a human decision (the
  // redraft chain implements accepted fixes, and it must never invent a role).
  // Everything else is a judgment call for the reviewer.
  for (const f of all) {
    if (f.source === "deterministic" && f.verification.status === "verified" && f.category !== "ambiguous_actor") {
      f.decision = "accepted";
    }
  }

  // Stable ordering (severity, then category) + ids.
  all.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.category.localeCompare(b.category));
  all.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(3, "0")}`; });

  return { claims: claimsRes.claims, findings: all, clusterCount: consistency.clusters.length, usage };
}

// ============================================================================
// RESTRUCTURE PIPELINE — Recommend & Edit stage 2
// ============================================================================

export interface RestructureBlock {
  type: "para" | "bullets" | "table" | "figure";
  text?: string;       // para
  items?: string[];    // bullets
  /** bullets — render as a NUMBERED list rather than bulleted. */
  ordered?: boolean;
  rows?: string[][];   // table (first row = header)
  /** Verbatim XML passed straight through to the rebuild (never model-generated):
   *  for a "figure" block the source paragraph (logo/flowchart/diagram); for a
   *  "table" block the source <w:tbl> when the redraft reproduced it UNCHANGED,
   *  so its exact shading/widths/borders survive instead of a generic rebuild. */
  xml?: string;
}

export interface RestructuredSection {
  heading: string;
  level: 1 | 2 | 3;
  blocks: RestructureBlock[];
}

export interface ChangeReportEntry {
  findingId: string;
  section: string;
  summary: string;
  before: string;
  after: string;
}

export interface PreservationReport {
  sourceClaims: number;
  preserved: number;
  repairIterations: number;
  lost: { claimId: string; section: string; quote: string }[];
  invented: { section: string; quote: string }[];
}

export interface RestructureResult {
  sections: RestructuredSection[];
  changeReport: ChangeReportEntry[];
  preservation: PreservationReport;
  usage: TokenUsage;
}

interface OutlinePlanSection {
  heading: string;
  level: 1 | 2 | 3;
  sourceSections: string[];
  findingIds: string[];
}

async function planOutline(
  title: string,
  sourceSections: string[],
  findings: Finding[],
): Promise<{ outline: OutlinePlanSection[]; usage: TokenUsage }> {
  const findingIndex = findings
    .map((f) => `${f.id} [${f.category}/${f.severity}] ${f.title} — fix: ${f.suggestedFix.slice(0, 140)} (evidence in: ${f.evidence.map((e) => e.section).join("; ")})`)
    .join("\n");
  const prompt = `# ROLE: DOCUMENT RESTRUCTURE PLANNING for the bank document "${title}"
Design the target outline for a restructured version. Merge fragmented/duplicated source sections, fix ordering, and assign every accepted finding to the ONE target section whose rewrite will resolve it.

# HARD RULES
- EVERY source section must appear in exactly one target section's "sourceSections" — content is never dropped at the planning stage.
- Keep the document's overall purpose and register; this is a repair, not a rewrite from taste.
- Prefer the source's existing order unless a finding says otherwise.

# SOURCE SECTIONS (in order):
${sourceSections.map((s, i) => `${i + 1}. ${s}`).join("\n")}

# ACCEPTED FINDINGS TO RESOLVE:
${findingIndex || "(none — restructure for clarity only)"}

# OUTPUT — ONLY a JSON array, in final document order:
[{ "heading": "<target heading>", "level": 1|2|3, "sourceSections": ["<exact source section names>"], "findingIds": ["F-001", ...] }]
`;
  const { items, usage } = await askJson(prompt, "quality", 16384);
  const outline: OutlinePlanSection[] = [];
  const seenSource = new Set<string>();
  for (const r of items as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof r?.heading !== "string" || !r.heading.trim()) continue;
    const level = r.level === 2 || r.level === 3 ? r.level : 1;
    const src = Array.isArray(r.sourceSections) ? r.sourceSections.map(String) : [];
    src.forEach((s: string) => seenSource.add(s));
    outline.push({
      heading: r.heading.trim(),
      level,
      sourceSections: src,
      findingIds: Array.isArray(r.findingIds) ? r.findingIds.map(String) : [],
    });
  }
  // Safety net: any source section the plan forgot gets its own passthrough
  // target section, so content cannot be dropped by a planning miss.
  for (const s of sourceSections) {
    if (!seenSource.has(s)) outline.push({ heading: s, level: 1, sourceSections: [s], findingIds: [] });
  }
  return { outline, usage };
}

/** Normalised signature of a table's header row — used to tell whether the LLM
 *  reproduced a given source table, so a dropped one can be re-appended without
 *  duplicating a kept one. */
function tableSignature(rows: string[][]): string {
  return (rows[0] ?? []).map((c) => c.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}

/** Keep a source table's ORIGINAL xml (its exact shading/widths) only when it
 *  already fills the page AND carries no floating text box. Otherwise it is
 *  rebuilt full-width: a narrow table stretches to the page column, and a
 *  floating "Note" callout is pulled inline instead of overlapping the cells. */
function keepVerbatim(xml?: string): boolean {
  if (!xml) return false;
  if (/<w:txbxContent>/.test(xml)) return false; // floating note → rebuild inline
  const total = [...xml.matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"/g)]
    .map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
  return total >= 7600; // ~84% of the 9026-twip text column → already full-width
}

/** Whole-table content equality (whitespace/case-insensitive) — tells whether a
 *  model-reproduced table is byte-for-byte the source's, so it can be re-emitted
 *  with its original styling rather than a rebuilt grid. */
function tablesEqual(a: string[][], b: string[][]): boolean {
  const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i]?.length ?? 0) !== (b[i]?.length ?? 0)) return false;
    for (let j = 0; j < a[i].length; j++) if (norm(a[i][j]) !== norm(b[i][j])) return false;
  }
  return true;
}

/** Does resolving this finding require a VALUE only the organisation can supply
 *  (an acronym's full form, a responsible owner/role, a timeline)? Such findings
 *  are surfaced for a decision BEFORE the redraft is generated. */
export function findingNeedsInput(f: Finding): boolean {
  const t = `${f.title} ${f.suggestedFix ?? ""}`.toLowerCase();
  return /never defined|not defined|undefined|acronym|abbreviation|unspecified|ambiguous|unclear (owner|actor|role|party)|missing (an?|the)?\s*(owner|actor|role|timeline|deadline|value|threshold|date)|no (defined |clear )?(owner|actor|role|timeline|deadline)|assign (a |an )?(clear )?(owner|actor|role|party)|specify (a |an |the )?(owner|actor|role|timeline|deadline|value)|expand at first use|define the (acronym|term)/i.test(t);
}

/** A short label for the input this finding needs (e.g. `Full form of "OM"`). */
export function findingInputLabel(f: Finding): string {
  const acr = f.title.match(/\b([A-Z]{2,6})\b/) || (f.suggestedFix ?? "").match(/\(([A-Z]{2,6})\)/);
  if (/acronym|abbreviation|never defined|not defined|undefined|define the/i.test(f.title) && acr) return `Full form of "${acr[1]}"`;
  if (/actor|owner|responsib|party|role/i.test(f.title)) return "Responsible role / owner";
  if (/timeline|deadline|date|frequency/i.test(f.title)) return "Timeline / deadline";
  return "Your value";
}

/** The AI's own suggested value, if it put one in the fix (e.g. an "e.g. 'X'"). */
export function findingInputSuggestion(f: Finding): string {
  const fix = f.suggestedFix ?? "";
  // Explicit example phrasings first ("such as: '…'", "e.g. '…'"), then any
  // quoted span. Fix suggestions often quote a full replacement sentence, so
  // allow long spans — the decision box wraps.
  const m = fix.match(/(?:such as|e\.g\.|for example|for instance)[:,]?\s*['"“‘]([^'"”’]{2,400})['"”’]/i)
    || fix.match(/\b(?:to|as)\s+['"“‘]([^'"”’]{2,400})['"”’]/i)
    || fix.match(/['"“‘]([^'"”’]{2,400})['"”’]/);
  const v = (m?.[1] ?? "").trim();
  // Skip placeholder-ish suggestions like "Full Name (OM)".
  return /full name|full form|<|>/i.test(v) ? "" : v;
}

async function generateSection(
  title: string,
  plan: OutlinePlanSection,
  sourceUnits: StructuredUnit[],
  findings: Finding[],
  simplifyGuidance: string,
  mustPreserve?: string[],
  userInputs?: Record<string, string>,
): Promise<{ section: RestructuredSection; changes: ChangeReportEntry[]; usage: TokenUsage }> {
  // Figures are never sent to the model — they carry no rewritable text and
  // must come through byte-identical — so they are held aside and re-attached
  // to the section after generation.
  const figures = sourceUnits.filter((u) => u.figureXml).map((u) => u.figureXml!);
  const textUnits = sourceUnits.filter((u) => !u.figureXml);

  // Render the source so the model SEES structure: tables as fenced pipe-tables
  // it must reproduce, and list items with their marker ("• " bullet, "N. "
  // numbered) so it re-emits them as a list instead of flattening to prose.
  let numCounter = 0;
  const source = textUnits
    .map((u) => {
      if (u.table) { numCounter = 0; return `[TABLE]\n${u.table.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n[/TABLE]`; }
      if (u.list === "bullet") { numCounter = 0; return `• ${u.text}`; }
      if (u.list === "number") { numCounter++; return `${numCounter}. ${u.text}`; }
      numCounter = 0; return u.text;
    })
    .join("\n\n");
  // Source tables with their verbatim XML — so a table reproduced UNCHANGED can
  // be re-emitted with exact styling (matched later by header signature).
  const sourceTables = textUnits
    .filter((u) => u.table && u.table.length > 0)
    .map((u) => ({ rows: u.table!, xml: u.tableXml, sig: tableSignature(u.table!) }));
  const findingBlock = findings
    .map((f) => {
      const ui = userInputs?.[f.id]?.trim();
      const uiLine = ui
        ? `\n  USER-PROVIDED VALUE — use this EXACT value in the rewritten sentence and do NOT wrap it in [CONFIRM]: "${ui}"`
        : "";
      return `${f.id} [${f.category}] ${f.title}\n  Problem: ${f.description}\n  Required fix: ${f.suggestedFix}${uiLine}\n${f.evidence.map((e) => `  Evidence [${e.section}]: "${e.quote}"`).join("\n")}`;
    })
    .join("\n\n");
  const prompt = `# ROLE: SECTION REGENERATION for the corrected bank document "${title}"
You are producing the CORRECTED version of the target section "${plan.heading}". Two jobs, in order: (1) APPLY every assigned finding's fix by REWRITING the flagged text; (2) preserve everything else faithfully.

# JOB 1 — APPLY THE FIXES (your primary job — the whole point of this task)
For EACH assigned finding: find its evidence quote in the source and REWRITE that exact passage so the fix is implemented IN THE TEXT. The corrected sentence REPLACES the original — the flagged wording must come out CHANGED.
- A finding is resolved ONLY when its flagged sentence is now DIFFERENT and contains the fix. Leaving the sentence unchanged and merely noting the fix in "changes" is a FAILURE — a redraft produces a corrected document, not a to-do list.
- "Required fix" below is ADVICE describing what to do. IMPLEMENT it in concrete wording — do NOT copy the advice into the document:
  • "assign/specify an owner or actor" → name the role the surrounding process implies and rewrite the sentence around it. e.g. "Invoices shall be prepared and forwarded…" → "The [CONFIRM: Trust Operations Officer] shall prepare and forward the invoices…"
  • "define/expand an acronym" → write the full form inline. e.g. "OM" → "Operations Manual (OM)" (infer it — this document IS the "…Operations Manual").
  • "consolidate redundant/divergent rules" → MERGE them into ONE clause and delete the duplicate.
  • "specify a timeline/threshold" → state a concrete one, e.g. "within [CONFIRM: 2 business days]".
- Applying a fix is NOT "inventing" — it resolves a flagged DEFECT and is REQUIRED. Wrap ONLY a value you genuinely had to assume (a human should verify) in [CONFIRM: …]; everything around it must read as finished, committed text.
- WORKED EXAMPLE — finding "Unspecified actor for invoice preparation":
   ✗ WRONG (leaves it): block text "Invoices shall be prepared and forwarded…"; change.after "Assign a clear owner."
   ✓ RIGHT (applies it): block text "The [CONFIRM: Trust Operations Officer] shall prepare and forward the invoices…"; change.after copies that exact new sentence.

# JOB 2 — PRESERVE everything the findings do NOT touch
- Keep every unique obligation, control, number, threshold, date, %, monetary amount, authority limit, role title, committee name, defined term and cross-reference. Restructure/rephrase freely — never DROP a fact. (Applying an assigned fix is required and never counts as a violation here.)
- TABLES: content between [TABLE] … [/TABLE] is a real table. Reproduce EACH as a {"type":"table","rows":[...]} block, every row/column and the header. Edit a cell only when a finding requires it; NEVER flatten a table to paragraphs/bullets or drop rows/columns. An unchanged table is re-emitted with its exact original styling.
- LISTS: a line beginning "• " is a BULLET item — group consecutive items into ONE {"type":"bullets","items":[…]} block. Lines "1. ", "2. " … are a NUMBERED list — {"type":"bullets","ordered":true,"items":[…]} (omit the numbers). Keep every item; never merge a list into a paragraph.
- Log each applied change in "changes" with the LITERAL new wording in "after" (a copyable phrase from your rewritten text, NOT an instruction).
- If two source passages conflict and NO finding covers it, keep both verbatim.
${mustPreserve && mustPreserve.length > 0 ? `\n# MUST PRESERVE — these spans were LOST in a previous draft; each one MUST be represented in your output:\n${mustPreserve.map((q) => `- "${q}"`).join("\n")}\n` : ""}
# STYLE (apply while rewriting)
${guidanceBlock(simplifyGuidance) || "- Plain, active, formal bank-policy register."}
# ASSIGNED FINDINGS TO IMPLEMENT (rewrite each one's evidence into a corrected sentence):
${findingBlock || "(none — restructure/simplify only)"}

# SOURCE CONTENT (verbatim units):
${source}

# OUTPUT — ONLY one JSON object:
{ "blocks": [ {"type":"para","text":"..."} | {"type":"bullets","items":["..."]} | {"type":"bullets","ordered":true,"items":["..."]} | {"type":"table","rows":[["h1","h2"],["a","b"]]} ], "changes": [ {"findingId":"F-001","summary":"<WHY this was changed>","before":"<short verbatim source quote you replaced>","after":"<the LITERAL new wording as it now appears in a block above — a copyable phrase from your output, NOT an instruction like 'expand at first use'>"} ] }
`;
  const { items, usage } = await askJson(prompt, "quality");
  // askJson returns an array; a single object comes back as [obj].
  const obj = (items[0] ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  // When the model reproduces a source table UNCHANGED, re-emit its original XML
  // (exact shading/widths/borders) instead of a generic rebuild; an edited table
  // falls back to the row grid.
  const tableXmlFor = (rows: string[][]): string | undefined => {
    const src = sourceTables.find((t) => t.sig === tableSignature(rows));
    if (!src || !src.xml || !tablesEqual(src.rows, rows)) return undefined;
    // Reproduce verbatim only when the table already fills the page and has no
    // floating note; otherwise rebuild it full-width (see keepVerbatim).
    return keepVerbatim(src.xml) ? src.xml : undefined;
  };
  const blocks: RestructureBlock[] = [];
  for (const b of Array.isArray(obj.blocks) ? obj.blocks : []) {
    if (b?.type === "para" && typeof b.text === "string" && b.text.trim()) blocks.push({ type: "para", text: b.text.trim() });
    else if (b?.type === "bullets" && Array.isArray(b.items)) blocks.push({ type: "bullets", ordered: !!b.ordered, items: b.items.map(String).filter(Boolean) });
    else if (b?.type === "table" && Array.isArray(b.rows)) {
      const rows = b.rows.map((row: unknown[]) => (Array.isArray(row) ? row.map(String) : []));
      const xml = tableXmlFor(rows);
      blocks.push(xml ? { type: "table", rows, xml } : { type: "table", rows });
    }
  }
  // A generation that produced nothing keeps the source verbatim — content
  // survival beats aesthetics (tables stay tables, lists stay lists).
  if (blocks.length === 0) {
    for (const u of textUnits) {
      blocks.push(
        u.table ? { type: "table", rows: u.table, ...(keepVerbatim(u.tableXml) ? { xml: u.tableXml } : {}) }
          : u.list ? { type: "bullets", ordered: u.list === "number", items: [u.text] }
          : { type: "para", text: u.text },
      );
    }
  }
  // Table safety-net: if the model dropped a source table (flattened it into
  // prose or omitted it), re-append it VERBATIM so no table — nor its styling —
  // is ever lost. Match by header signature so a reproduced table isn't dupli-
  // cated.
  if (sourceTables.length > 0) {
    const emitted = new Set(blocks.filter((b) => b.type === "table" && b.rows).map((b) => tableSignature(b.rows!)));
    for (const t of sourceTables) {
      if (emitted.has(t.sig)) continue;
      const xml = keepVerbatim(t.xml) ? t.xml : undefined; // rebuild narrow / floating-note tables full-width
      blocks.push(xml ? { type: "table", rows: t.rows, xml } : { type: "table", rows: t.rows });
    }
  }
  // Re-attach this section's figures verbatim. They sit at the end of the
  // section rather than their exact original offset — the rewrite moves text
  // around, so there is no honest anchor — but the logo and every process
  // diagram survive, which beats silently dropping them.
  for (const xml of figures) blocks.push({ type: "figure", xml });
  const changes: ChangeReportEntry[] = (Array.isArray(obj.changes) ? obj.changes : [])
    .filter((c: any) => typeof c?.findingId === "string") // eslint-disable-line @typescript-eslint/no-explicit-any
    .map((c: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      findingId: c.findingId,
      section: plan.heading,
      summary: String(c.summary ?? ""),
      before: String(c.before ?? ""),
      after: String(c.after ?? ""),
    }));
  // Annotation fallback: if the model resolved findings but logged no "changes",
  // synthesise one entry per assigned finding so the annotated copy still gets a
  // Word comment naming what this section was meant to fix (fixes the previously
  // comment-less "annotated" export).
  if (changes.length === 0 && findings.length > 0) {
    for (const f of findings) {
      changes.push({
        findingId: f.id,
        section: plan.heading,
        summary: f.title,
        before: f.evidence[0]?.quote ?? "",
        after: f.suggestedFix,
      });
    }
  }
  return { section: { heading: plan.heading, level: plan.level, blocks }, changes, usage };
}

function sectionPlainText(s: RestructuredSection): string {
  const parts: string[] = [s.heading];
  for (const b of s.blocks) {
    if (b.type === "para" && b.text) parts.push(b.text);
    else if (b.type === "bullets" && b.items) parts.push(...b.items);
    else if (b.type === "table" && b.rows) parts.push(...b.rows.map((r) => r.join(" ")));
  }
  return parts.join("\n");
}

/** Bidirectional content-preservation check + repair loop (max 2 iterations). */
export async function generateRestructured(
  title: string,
  sourceUnits: StructuredUnit[],
  sourceClaims: ClaimUnit[],
  acceptedFindings: Finding[],
  simplifyGuidance: string,
  userInputs?: Record<string, string>,
): Promise<RestructureResult> {
  let usage = EMPTY_USAGE;

  // Ordered distinct source sections.
  const sourceSections: string[] = [];
  for (const u of sourceUnits) {
    const s = u.section || "—";
    if (sourceSections[sourceSections.length - 1] !== s && !sourceSections.includes(s)) sourceSections.push(s);
  }

  const { outline, usage: outlineUsage } = await planOutline(title, sourceSections, acceptedFindings);
  usage = addUsage(usage, outlineUsage);

  const findingById = new Map(acceptedFindings.map((f) => [f.id, f]));
  const unitsBySection = new Map<string, StructuredUnit[]>();
  for (const u of sourceUnits) {
    const key = u.section || "—";
    const arr = unitsBySection.get(key) ?? [];
    arr.push(u);
    unitsBySection.set(key, arr);
  }

  // Initial generation.
  const generated = await mapLimit(outline, 3, async (plan) => {
    const units = plan.sourceSections.flatMap((s) => unitsBySection.get(s) ?? []);
    const findings = plan.findingIds.map((id) => findingById.get(id)).filter(Boolean) as Finding[];
    return generateSection(title, plan, units, findings, simplifyGuidance, undefined, userInputs).catch((e) => {
      console.warn(`generateSection "${plan.heading}" failed:`, (e as Error)?.message?.slice(0, 100));
      // Verbatim passthrough on failure — never drop content (tables stay tables).
      return {
        section: {
          heading: plan.heading,
          level: plan.level,
          blocks: units.map((u): RestructureBlock =>
            u.figureXml ? { type: "figure", xml: u.figureXml }
              : u.table ? { type: "table", rows: u.table, ...(keepVerbatim(u.tableXml) ? { xml: u.tableXml } : {}) }
              : u.list ? { type: "bullets", ordered: u.list === "number", items: [u.text] }
              : { type: "para", text: u.text }),
        },
        changes: [] as ChangeReportEntry[],
        usage: EMPTY_USAGE,
      };
    });
  });
  let sections = generated.map((g) => g.section);
  const changeReport = generated.flatMap((g) => g.changes);
  usage = generated.reduce((acc, g) => addUsage(acc, g.usage), usage);

  // Which outline section owns each source section (for repair targeting).
  const ownerOfSource = new Map<string, number>();
  outline.forEach((p, i) => p.sourceSections.forEach((s) => ownerOfSource.set(s, i)));

  // ── Preservation check + repair loop ──
  let repairIterations = 0;
  let lost: PreservationReport["lost"] = [];
  for (let iter = 0; iter <= 2; iter++) {
    const outputText = sections.map(sectionPlainText).join("\n\n");
    const outWords = wordsOnly(outputText).split(" ");
    const outIndex = buildWordIndex(outWords);

    lost = [];
    for (const c of sourceClaims) {
      const score = bestFuzzyScore(wordsOnly(c.quote).split(" "), outWords, outIndex);
      if (score < 0.8) lost.push({ claimId: c.id, section: c.section, quote: c.quote });
    }
    if (lost.length === 0 || iter === 2) break;

    // Repair: regenerate only the sections owning lost content, with the lost
    // quotes injected as MUST PRESERVE.
    repairIterations++;
    const lostByOwner = new Map<number, string[]>();
    for (const l of lost) {
      const owner = ownerOfSource.get(l.section);
      if (owner === undefined) continue;
      const arr = lostByOwner.get(owner) ?? [];
      arr.push(l.quote);
      lostByOwner.set(owner, arr);
    }
    if (lostByOwner.size === 0) break;

    const repairs = await mapLimit([...lostByOwner.entries()], 3, async ([ownerIdx, quotes]) => {
      const plan = outline[ownerIdx];
      const units = plan.sourceSections.flatMap((s) => unitsBySection.get(s) ?? []);
      const findings = plan.findingIds.map((id) => findingById.get(id)).filter(Boolean) as Finding[];
      const res = await generateSection(title, plan, units, findings, simplifyGuidance, quotes, userInputs).catch(() => null);
      return { ownerIdx, res };
    });
    for (const { ownerIdx, res } of repairs) {
      if (res) {
        sections[ownerIdx] = res.section;
        usage = addUsage(usage, res.usage);
      }
    }
  }

  // Invented-content check (reverse direction): claims in the OUTPUT that are
  // grounded neither in the source nor in an accepted finding's fix.
  const srcWords = wordsOnly(sourceUnits.map((u) => u.text).join("\n")).split(" ");
  const srcIndex = buildWordIndex(srcWords);
  const outClaimsRes = await extractClaims(
    title,
    sections.flatMap((s) => s.blocks.map((b) => ({
      text: b.type === "para" ? (b.text ?? "") : b.type === "bullets" ? (b.items ?? []).join(" ") : (b.rows ?? []).map((r) => r.join(" ")).join(" "),
      section: s.heading,
    }))).filter((u) => u.text.trim().length >= 20),
  );
  usage = addUsage(usage, outClaimsRes.usage);
  const fixTexts = wordsOnly(acceptedFindings.map((f) => `${f.suggestedFix} ${f.title}`).join(" ")).split(" ");
  const fixIndex = buildWordIndex(fixTexts);
  const invented: PreservationReport["invented"] = [];
  for (const c of outClaimsRes.claims) {
    const w = wordsOnly(c.quote).split(" ");
    const inSource = bestFuzzyScore(w, srcWords, srcIndex) >= 0.7;
    const fromFix = bestFuzzyScore(w, fixTexts, fixIndex) >= 0.7;
    if (!inSource && !fromFix) invented.push({ section: c.section, quote: c.quote });
  }

  return {
    sections,
    changeReport,
    preservation: {
      sourceClaims: sourceClaims.length,
      preserved: sourceClaims.length - lost.length,
      repairIterations,
      lost,
      invented: invented.slice(0, 30),
    },
    usage,
  };
}

// ============================================================================
// CREATE-FROM-BRIEF — drafts a brand-new document in the bank's house
// structure. The output sections feed rebuildDocxBody with a DONOR document's
// package, so the draft comes out wearing the organisation's real template
// (logo, headers, styles) rather than a generic file.
// ============================================================================

const HOUSE_SKELETON = [
  "Purpose",
  "Scope",
  "Definitions",
  "Policy Statements",
  "Roles & Responsibilities",
  "Procedures",
  "Escalation & Exceptions",
  "Review Cycle",
  "Appendices",
];

export async function generateDocumentFromBrief(
  title: string,
  docType: string,
  brief: string,
  guidance: string,
): Promise<{ sections: RestructuredSection[]; usage: TokenUsage }> {
  let usage = EMPTY_USAGE;

  // 1 — outline: adapt the house skeleton to this brief (drop/add sections).
  const outlinePrompt = `# ROLE: DOCUMENT PLANNING for a new bank ${docType} titled "${title}".
Design the section outline. START from the bank's house skeleton and adapt it to the brief — drop sections that don't apply, add ones the brief demands, keep the institutional order.

# HOUSE SKELETON (the default shape of a ${docType}):
${HOUSE_SKELETON.map((s, i) => `${i + 1}. ${s}`).join("\n")}

# BRIEF FROM THE REQUESTOR:
${brief}

# OUTPUT — ONLY a JSON array in final order:
[{ "heading": "<section heading>", "level": 1|2, "notes": "<one line: what this section must cover for THIS brief>" }]
`;
  const outlineRes = await askJson(outlinePrompt, "quality", 8192);
  usage = addUsage(usage, outlineRes.usage);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outline = (outlineRes.items as any[])
    .filter((r) => typeof r?.heading === "string" && r.heading.trim())
    .map((r) => ({
      heading: String(r.heading).trim(),
      level: (r.level === 2 ? 2 : 1) as 1 | 2,
      notes: typeof r?.notes === "string" ? r.notes : "",
    }));
  if (outline.length === 0) throw new Error("Could not plan the document outline — try a more specific brief.");

  // 2 — section generation.
  const outlineIndex = outline.map((s) => `${s.heading}: ${s.notes}`).join("\n");
  const results = await mapLimit(outline, 3, async (plan) => {
    const prompt = `# ROLE: SECTION DRAFTING for the new bank ${docType} "${title}".
Draft the section "${plan.heading}". Coverage required: ${plan.notes || "per the brief"}.

# THE WHOLE DOCUMENT'S OUTLINE (for context — do NOT repeat other sections' content):
${outlineIndex}

# BRIEF:
${brief}

# RULES
- Formal bank-policy register: institutional subjects, active voice, no second person, no marketing language.
- This is a FIRST DRAFT for humans to complete: where a real value is unknown (a threshold, a committee name, a system), write a clearly-marked placeholder like [OWNER TO CONFIRM: approval threshold] — NEVER invent specific numbers, names or system identifiers.
- Definitions section: define only terms actually used in this document.
- Keep it tight — quality over volume.
${guidanceBlock(guidance)}
# OUTPUT — ONLY one JSON object:
{ "blocks": [ {"type":"para","text":"..."} | {"type":"bullets","items":["..."]} | {"type":"table","rows":[["h1","h2"],["a","b"]]} ] }
`;
    try {
      const { items, usage: u } = await askJson(prompt, "quality");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = (items[0] ?? {}) as any;
      const blocks: RestructureBlock[] = [];
      for (const b of Array.isArray(obj.blocks) ? obj.blocks : []) {
        if (b?.type === "para" && typeof b.text === "string" && b.text.trim()) blocks.push({ type: "para", text: b.text.trim() });
        else if (b?.type === "bullets" && Array.isArray(b.items)) blocks.push({ type: "bullets", items: b.items.map(String).filter(Boolean) });
        else if (b?.type === "table" && Array.isArray(b.rows)) blocks.push({ type: "table", rows: b.rows.map((row: unknown[]) => (Array.isArray(row) ? row.map(String) : [])) });
      }
      if (blocks.length === 0) blocks.push({ type: "para", text: `[DRAFTING NOTE: content for "${plan.heading}" could not be generated — please draft manually.]` });
      return { section: { heading: plan.heading, level: plan.level, blocks } as RestructuredSection, usage: u };
    } catch (e) {
      console.warn(`generateDocumentFromBrief: section "${plan.heading}" failed:`, (e as Error)?.message?.slice(0, 100));
      return {
        section: { heading: plan.heading, level: plan.level, blocks: [{ type: "para" as const, text: `[DRAFTING NOTE: content for "${plan.heading}" could not be generated — please draft manually.]` }] } as RestructuredSection,
        usage: EMPTY_USAGE,
      };
    }
  });

  return {
    sections: results.map((r) => r.section),
    usage: results.reduce((acc, r) => addUsage(acc, r.usage), usage),
  };
}
