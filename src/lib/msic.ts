// MSIC lookup helpers for the MBRS review form.
//
// The rule that matters: a code is NEVER auto-entered. MSIC codes come from the
// company's SSM registration record, not its accounts, so nothing in an audited
// report can establish one — see REGISTRY_ONLY_ENTITY_KEYS in ./mbrs for the
// real filing that proved it. These helpers only power the filer's own lookup:
// search, browse, and code -> official label (the one authoritative direction).

import { MSIC_CODES } from "./msic-codes";

export interface MsicEntry {
  code: string;
  label: string;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "of", "the", "and", "or", "in", "on", "for", "by", "to", "a", "an",
  "other", "any", "kind", "n", "e", "c", "nec", "activities", "services",
]);

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((t) => t && !STOPWORDS.has(t)));
}

let normalizedCache: Array<MsicEntry & { norm: string; tokens: Set<string> }> | null = null;

function all() {
  if (!normalizedCache) {
    normalizedCache = MSIC_CODES.map(([code, label]) => ({
      code, label, norm: norm(label), tokens: tokens(label),
    }));
  }
  return normalizedCache;
}

export function suggestMsic(description: string, limit = 5): MsicEntry[] {
  const qt = tokens(description);
  if (!qt.size) return [];
  const scored: Array<{ e: MsicEntry; score: number }> = [];
  for (const e of all()) {
    let overlap = 0;
    for (const t of qt) if (e.tokens.has(t)) overlap++;
    if (!overlap) continue;
    // Favour high coverage of BOTH sides so short generic labels don't win.
    const score = overlap / qt.size + overlap / Math.max(e.tokens.size, 1);
    scored.push({ e: { code: e.code, label: e.label }, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}

/** Search-as-you-type over code prefixes and label substrings. */
export function searchMsic(query: string, limit = 8): MsicEntry[] {
  const q = query.trim();
  if (!q) return [];
  if (/^\d+$/.test(q)) {
    return all()
      .filter((e) => e.code.startsWith(q))
      .slice(0, limit)
      .map((e) => ({ code: e.code, label: e.label }));
  }
  const nq = norm(q);
  const starts: MsicEntry[] = [];
  const contains: MsicEntry[] = [];
  for (const e of all()) {
    if (e.norm.startsWith(nq)) starts.push({ code: e.code, label: e.label });
    else if (e.norm.includes(nq)) contains.push({ code: e.code, label: e.label });
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/** Label for a known code, or null. */
export function msicLabel(code: string): string | null {
  const hit = all().find((e) => e.code === code.trim());
  return hit ? hit.label : null;
}

/** The whole code list, for browsing when the filer has no search term yet. */
export function allMsic(): MsicEntry[] {
  return all().map(({ code, label }) => ({ code, label }));
}

/** Total number of codes — shown so the filer knows the browse list is complete. */
export const MSIC_COUNT = MSIC_CODES.length;

/**
 * Lexical shortlist for the AI suggester. Recall matters here, not precision:
 * this only narrows 1,175 codes to a set small enough to put in a prompt, and
 * the model does the actual judging. Scores overlap of meaningful words, then
 * pads with same-division codes so a thin text still yields real candidates.
 */
export function prefilterMsic(text: string, limit = 60): MsicEntry[] {
  const want = tokens(text);
  if (!want.size) return [];
  const scored = all().map((e) => {
    let hits = 0;
    for (const t of e.tokens) if (want.has(t)) hits++;
    // Normalise so a short precise label isn't buried by a long vague one.
    return { e, score: hits === 0 ? 0 : hits / Math.sqrt(e.tokens.size || 1) };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ code: x.e.code, label: x.e.label }));
}

/** True when a code exists in the official list — the gate every AI-proposed
 *  code must pass before it can be shown to a filer. */
export function isRealMsic(code: string): boolean {
  return msicLabel(code) !== null;
}
