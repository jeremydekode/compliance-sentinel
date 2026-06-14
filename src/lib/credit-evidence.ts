// ============================================================================
// Credit Risk Alert — source evidence locator
// ----------------------------------------------------------------------------
// After the analyzer returns findings (each with a verbatim `applicationQuote`
// and a `traceExcerpt` from a KB case), this locates WHERE those quotes live:
//  • applicationQuote → which page of the credit application PDF
//  • traceExcerpt     → which KB case doc + which page/chapter chunk
// so the report's evidence viewer can deep-link both PDFs to the right page and
// highlight the cited text. Pure functions — safe in node and the browser.
// ============================================================================

import type { CreditRiskFinding } from "./gemini";

export interface EvidencePage {
  page: number;
  text: string;
}
export interface EvidenceChunk {
  content: string;
  page_number: number | null;
  chapter_ref: string | null;
}
export interface EvidenceCaseDoc {
  id: string;
  title: string;
  file_url: string | null;
}
export interface EvidenceContext {
  appPages: EvidencePage[];
  applicationFileUrl?: string | null;
  caseDocs: EvidenceCaseDoc[];
  chunksByCase: Map<string, EvidenceChunk[]>;
}

function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'") // smart quotes → '
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(norm: string): string[] {
  return norm.split(" ").filter((t) => t.length > 3);
}

/** Find the 1-based page whose text best contains `quote`. Tries exact-prefix
 *  substring first, then falls back to token overlap. Returns undefined if no
 *  page is a confident match. */
export function locatePage(quote: string, pages: EvidencePage[]): number | undefined {
  const nq = normalize(quote);
  if (nq.length < 12 || pages.length === 0) {
    return tokenOverlapPage(quote, pages);
  }
  for (const len of [Math.min(nq.length, 110), 70, 45, 25]) {
    if (len < 12) continue;
    const needle = nq.slice(0, len);
    for (const p of pages) {
      if (normalize(p.text).includes(needle)) return p.page;
    }
  }
  return tokenOverlapPage(quote, pages);
}

function tokenOverlapPage(quote: string, pages: EvidencePage[]): number | undefined {
  const qTokens = new Set(tokens(normalize(quote)));
  if (qTokens.size === 0) return undefined;
  let best: { page: number | undefined; score: number } = { page: undefined, score: 0 };
  for (const p of pages) {
    const pt = normalize(p.text);
    let score = 0;
    for (const t of qTokens) if (pt.includes(t)) score++;
    if (score > best.score) best = { page: p.page, score };
  }
  return best.score >= Math.max(2, Math.ceil(qTokens.size * 0.5)) ? best.page : undefined;
}

/** Normalize a string AND keep a map from each normalized-char index back to its
 *  raw index, so we can locate a quote in normalized space then slice raw text. */
function normWithMap(raw: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i].toLowerCase();
    const alnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (alnum) {
      norm += ch;
      map.push(i);
      prevSpace = false;
    } else if (!prevSpace) {
      norm += " ";
      map.push(i);
      prevSpace = true;
    }
  }
  while (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/**
 * Ground a model-produced quote in the real source text: anchor on the quote's
 * opening words, then return a VERBATIM contiguous passage from `sourceRaw`
 * (snapped to a sentence boundary). Returns null if the anchor isn't found —
 * callers keep the model's text in that case. This kills the "…paraphrased
 * tail" problem where the model stitches a fabricated continuation after an
 * ellipsis and presents it inside quotation marks.
 */
export function groundQuote(modelQuote: string, sourceRaw: string, maxLen = 340): string | null {
  if (!modelQuote || !sourceRaw) return null;
  const { norm: nSrc, map } = normWithMap(sourceRaw);
  const nq = normWithMap(modelQuote).norm;
  if (nq.length < 16) return null;
  let at = nSrc.indexOf(nq.slice(0, 40));
  if (at < 0) at = nSrc.indexOf(nq.slice(0, 24));
  if (at < 0) return null;
  const rawStart = map[at];
  const win = sourceRaw.slice(rawStart, Math.min(sourceRaw.length, rawStart + maxLen + 60));
  const minLen = 100;
  // Collect real sentence boundaries, skipping abbreviation dots (i.e., e.g.,
  // single-letter initials) so a quote is never cut mid-thought at "i.e.".
  const ends: number[] = [];
  for (let i = 0; i < win.length; i++) {
    const ch = win[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const after = win[i + 1];
    if (i !== win.length - 1 && after !== " " && after !== "\n") continue;
    const c2 = win[i - 2];
    if (c2 === "." || c2 === " ") continue; // ".e." (i.e./e.g.) or " e." (initial)
    ends.push(i + 1);
  }
  const within = ends.filter((e) => e >= minLen && e <= maxLen);
  const cut = within.length
    ? within[within.length - 1]
    : ends.find((e) => e >= minLen) ?? Math.min(maxLen, win.length);
  return win.slice(0, cut).replace(/\s+/g, " ").trim() || null;
}

/** Pick the chunk most likely to contain `excerpt`. */
export function bestChunk(excerpt: string, chunks: EvidenceChunk[]): EvidenceChunk | undefined {
  if (chunks.length === 0) return undefined;
  const ne = normalize(excerpt);
  const eTokens = new Set(tokens(ne));
  let best: { c: EvidenceChunk | undefined; score: number } = { c: undefined, score: 0 };
  for (const c of chunks) {
    const nc = normalize(c.content);
    let score = 0;
    if (ne.length >= 16 && nc.includes(ne.slice(0, 60))) score += 100;
    for (const t of eTokens) if (nc.includes(t)) score++;
    if (score > best.score) best = { c, score };
  }
  return best.c ?? chunks[0];
}

/** Mutates each finding in place with a located `evidence` block, and returns the array. */
export function attachEvidence(
  findings: CreditRiskFinding[],
  ctx: EvidenceContext,
): CreditRiskFinding[] {
  const byTitle = new Map(ctx.caseDocs.map((d) => [d.title, d] as const));
  const byTitleNorm = new Map(ctx.caseDocs.map((d) => [normalize(d.title), d] as const));

  for (const f of findings) {
    const evidence: NonNullable<CreditRiskFinding["evidence"]> = {};

    if (ctx.applicationFileUrl) evidence.applicationFileUrl = ctx.applicationFileUrl;
    const appPage =
      locatePage(f.applicationQuote ?? "", ctx.appPages) ??
      locatePage((f.matchTerms ?? []).join(" "), ctx.appPages);
    if (appPage) evidence.applicationPage = appPage;

    const doc = byTitle.get(f.traceReference) ?? byTitleNorm.get(normalize(f.traceReference));
    if (doc) {
      evidence.caseDocId = doc.id;
      if (doc.file_url) evidence.caseFileUrl = doc.file_url;
      const chunks = ctx.chunksByCase.get(doc.id) ?? [];
      const ch = bestChunk(f.traceExcerpt, chunks);
      if (ch) {
        if (ch.page_number != null) evidence.casePage = ch.page_number;
        if (ch.chapter_ref) evidence.caseChapter = ch.chapter_ref;
      }
      // Ground the displayed precedent quote in the case's REAL text so we never
      // show a paraphrased/fabricated tail as if it were a verbatim quote.
      const caseText = chunks.map((c) => c.content).join("\n");
      const grounded = groundQuote(f.traceExcerpt, caseText);
      if (grounded) f.traceExcerpt = grounded;
    }

    f.evidence = evidence;
  }
  return findings;
}
