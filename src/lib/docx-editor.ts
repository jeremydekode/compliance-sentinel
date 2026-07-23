// Server-side DOCX paragraph-level find/replace + insertion engine.
// Used by the "Apply Approved Edits" workflow to produce a full-fidelity
// amended .docx file where only the edited paragraphs differ from the original
// (rest of the document is preserved bit-for-bit).
//
// Amended paragraphs are highlighted with yellow shading so reviewers can spot
// the changes at a glance without needing track-changes.
//
// Limitations of this MVP approach:
//   • Operates at paragraph granularity only — finds the FIRST <w:p> whose
//     normalised text contains the find_text, then replaces or inserts after it.
//   • Find_text spanning multiple paragraphs is not supported (each edit
//     should target a single paragraph or section heading).
//   • Insertions go AFTER the matched anchor paragraph.
//   • If find_text doesn't match anything, the edit is silently skipped and
//     surfaced in the report so the user knows it was missed.

import PizZip from "pizzip";

export type DocxEdit = {
  change_type: string;
  find_text?: string | null;
  replace_text?: string | null;
  edited_text?: string | null;
  paragraph?: string | null;
};

export type DocxEditResult = {
  buffer: Buffer;
  appliedCount: number;
  skipped: { reason: string; edit: DocxEdit }[];
};

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Extract concatenated text content of a <w:p>...</w:p> block, ignoring formatting. */
function getParagraphText(pXml: string): string {
  // Preserve tabs/line-breaks as whitespace BEFORE extracting runs.
  const normalised = pXml
    .replace(/<w:tab\b[^>]*\/?>/g, " ")
    .replace(/<w:br\b[^>]*\/?>/g, "\n");
  const out: string[] = [];
  // Match ONLY real text runs: "<w:t>" or "<w:t ...attrs>". Requiring a space or
  // ">" right after "w:t" prevents false matches on <w:tab/>, <w:tbl>, <w:tc>,
  // <w:tr> etc. — the old /<w:t[^>]*>/ matched those and captured raw XML as
  // "text" for tab/form-field/table paragraphs (so their content never reached
  // the model and `before` failed to anchor on apply).
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalised)) !== null) {
    out.push(m[1]);
  }
  // Unescape XML entities so we compare against plain text from the AI
  return out
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseForCompare(s: string): string {
  return (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase();
}

/** Build a fresh <w:p> with each line as a yellow-highlighted run. */
function buildHighlightedParagraph(text: string): string {
  if (!text || !text.trim()) return "";
  const lines = text.split(/\r?\n/);
  const runs = lines
    .map((line, idx) => {
      const t = escapeXml(line);
      const run = `<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
      return idx < lines.length - 1 ? `${run}<w:r><w:br/></w:r>` : run;
    })
    .join("");
  return `<w:p>${runs}</w:p>`;
}

/** Apply a list of edits to a DOCX buffer and return the amended buffer + stats. */
export function applyEditsToDocx(sourceBuffer: Buffer, edits: DocxEdit[]): DocxEditResult {
  const zip = new PizZip(sourceBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("Invalid DOCX: word/document.xml not found");
  }
  let documentXml = docFile.asText();

  let appliedCount = 0;
  const skipped: { reason: string; edit: DocxEdit }[] = [];

  for (const edit of edits) {
    const replacementText = (edit.edited_text ?? edit.replace_text ?? "").trim();
    if (!replacementText) {
      skipped.push({ reason: "empty replacement text", edit });
      continue;
    }

    const isInsertion =
      edit.change_type === "insertion" || edit.change_type === "new_section";

    const findNorm = normaliseForCompare(edit.find_text ?? "");

    // For pure insertions with no anchor, append at end (simple fallback)
    if (isInsertion && !findNorm) {
      const newPara = buildHighlightedParagraph(`[Inserted — ${edit.paragraph ?? "new section"}]\n${replacementText}`);
      // Insert before the closing </w:body>
      documentXml = documentXml.replace(/<\/w:body>/, `${newPara}</w:body>`);
      appliedCount += 1;
      continue;
    }

    // Walk paragraphs, find the first match by normalised text
    const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
    let matched = false;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    const matches: { full: string; start: number; end: number }[] = [];
    while ((m = pRegex.exec(documentXml)) !== null) {
      matches.push({ full: m[0], start: m.index, end: m.index + m[0].length });
    }

    for (const candidate of matches) {
      const pText = normaliseForCompare(getParagraphText(candidate.full));
      if (!pText) continue;

      // Match if either side contains the other (handles partial finds and superset paragraphs)
      const isHit =
        findNorm.length > 10
          ? (pText.includes(findNorm) || findNorm.includes(pText))
          : pText === findNorm;

      if (isHit) {
        const newPara = buildHighlightedParagraph(replacementText);
        if (isInsertion) {
          // Insert AFTER the matched paragraph
          documentXml =
            documentXml.slice(0, candidate.end) +
            newPara +
            documentXml.slice(candidate.end);
        } else {
          // Replace the matched paragraph
          documentXml =
            documentXml.slice(0, candidate.start) +
            newPara +
            documentXml.slice(candidate.end);
        }
        appliedCount += 1;
        matched = true;
        lastIndex = candidate.end;
        break;
      }
    }

    if (!matched) {
      skipped.push({ reason: `find_text not located in document`, edit });
    }
  }

  zip.file("word/document.xml", documentXml);
  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, appliedCount, skipped };
}

/** Quick check: does the source mime/url look like a DOCX? */
export function looksLikeDocx(mimeType: string | undefined | null, url: string | undefined | null): boolean {
  if (mimeType && (
    mimeType.includes("officedocument.wordprocessingml") ||
    mimeType.includes("vnd.openxmlformats-officedocument") ||
    mimeType === "application/msword"
  )) return true;
  if (url && /\.docx?($|\?)/i.test(url)) return true;
  return false;
}

/**
 * Extract plain text from a DOCX buffer, paragraph by paragraph.
 * Used to feed DOCX content to LLMs that don't accept DOCX as inline data
 * (Gemini only accepts PDF/images/audio/video).
 *
 * Now async because we delegate to the `mammoth` library, which handles edge
 * cases our regex extractor missed (text boxes, SDT content controls,
 * namespace variations, headers/footers, etc.). Falls back to the regex
 * extractor if mammoth fails for any reason.
 */
export async function docxToText(buffer: Buffer): Promise<string> {
  try {
    // Lazy import — mammoth is a heavy dep we only need server-side
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value ?? "").trim();
    if (text) return text;
  } catch (e) {
    console.warn("[docx-editor] mammoth extraction failed, falling back to regex:", (e as Error)?.message);
  }
  // Fallback: regex-based extraction
  return docxToTextFallback(buffer);
}

/**
 * Convert a DOCX buffer to HTML — preserving tables (<table>), headings
 * (<h1>-<h6>) and lists. Document simplification (UC4) needs this structure,
 * tables especially; flat text extraction loses it. Returns "" on failure so
 * the caller can fall back to plain text.
 */
export async function docxToHtml(buffer: Buffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ buffer });
    return (result.value ?? "").trim();
  } catch (e) {
    console.warn("[docx-editor] mammoth HTML conversion failed:", (e as Error)?.message);
    return "";
  }
}

/** Synchronous regex-based fallback (less reliable but no deps). */
export function docxToTextFallback(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return "";
  const xml = docFile.asText();

  const paragraphs: string[] = [];
  const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(xml)) !== null) {
    const text = getParagraphText(m[0]);
    if (text) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}

/**
 * Cell-aware extraction for Document Simplification (UC4).
 *
 * mammoth's extractRawText flattens tables (tab-joins the cells of a row onto
 * one line), so cell prose can't be cleanly anchored and the simplifier skips
 * it. This walks the document IN ORDER and emits each body paragraph and — the
 * point — each TABLE CELL paragraph as its own clean line, using the SAME
 * getParagraphText() the apply step uses, so a `before` quoted from here
 * re-anchors exactly when applySimplificationToDocx() locates the cell's <w:p>.
 * Tables are wrapped in [TABLE n] … [END TABLE n] marker lines (non-prose, so
 * the model won't quote them) so it knows which lines are tabular and can
 * simplify verbose cell prose while leaving labels/codes/numbers/dates alone.
 *
 * Note: the apply path is already cell-capable (it walks every <w:p>, including
 * those inside <w:tc>), so only this extraction needed to change.
 */
export function docxToSimplifyText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return "";
  const xml = docFile.asText();

  const out: string[] = [];
  // Match a whole table OR a body paragraph, in document order. The table
  // alternative consumes its inner <w:p> cells, so they are not double-emitted.
  const tokenRe = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
  let tableNo = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const block = m[0];
    if (block.startsWith("<w:tbl")) {
      tableNo++;
      out.push(
        `\n[TABLE ${tableNo}] — each line below is one table cell. Simplify verbose prose sentences here just like body text; leave labels, codes, reference numbers, dates and short values unchanged.`,
      );
      const pRe = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
      let pm: RegExpExecArray | null;
      while ((pm = pRe.exec(block)) !== null) {
        const t = getParagraphText(pm[0]);
        if (t) out.push(t);
      }
      out.push(`[END TABLE ${tableNo}]\n`);
    } else {
      const t = getParagraphText(block);
      if (t) out.push(t);
    }
  }
  return out.join("\n");
}

/**
 * Like docxToSimplifyText, but returns an ORDERED LIST of units — one per body
 * paragraph and one per table-cell paragraph — for PER-UNIT batched
 * simplification. Each unit carries the most recent ALL-CAPS heading as its
 * `section`. The unit text is exactly getParagraphText(<w:p>), so a `before`
 * derived from a unit anchors 1:1 when applySimplificationToDocx re-locates it.
 */
export function docxToSimplifyUnits(buffer: Buffer): { text: string; section: string }[] {
  const zip = new PizZip(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return [];
  const xml = docFile.asText();
  const units: { text: string; section: string }[] = [];
  let section = "";
  const tokenRe = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const block = m[0];
    const inTable = block.startsWith("<w:tbl");
    const paras = inTable
      ? [...block.matchAll(/<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g)].map((x) => x[0])
      : [block];
    for (const p of paras) {
      const t = getParagraphText(p);
      if (!t) continue;
      // Track section from short, all-caps body headings (e.g. "APPLICABILITY").
      if (!inTable && t.length <= 80 && t.length >= 3 && t === t.toUpperCase() && /[A-Z]/.test(t)) {
        section = t;
      }
      units.push({ text: t, section });
    }
  }
  return units;
}

/** A source unit for the RESTRUCTURE pipeline. Unlike docxToSimplifyUnits
 *  (which flattens every table cell into its own paragraph unit, losing the
 *  grid), a table here stays a single unit carrying its rows — so the redraft
 *  can reproduce it as a real Word table instead of a list of loose lines.
 *  `text` is a readable flattening of the table (used for section grouping and
 *  the content-preservation fuzzy match, which only need plain text). */
export interface StructuredUnit {
  text: string;
  section: string;
  table?: string[][];
  /** Verbatim <w:tbl> XML of a table unit — so a table the redraft reproduces
   *  UNCHANGED can be re-emitted byte-for-byte (keeping its shading, borders,
   *  column widths and merged cells) instead of rebuilt as a generic grid. */
  tableXml?: string;
  /** The source paragraph's <w:pPr> — its spacing, alignment, indent, style.
   *  Carried so regenerated body text can inherit the document's real
   *  formatting instead of being emitted as bare unstyled paragraphs. */
  pPr?: string;
  /** This paragraph is an item in a real bullet/numbered list (its <w:numPr>
   *  resolves to that format in numbering.xml) — so the redraft can rebuild it
   *  as a native list instead of flattening the items into prose paragraphs. */
  list?: "bullet" | "number";
  /** Verbatim paragraph XML for units that must be re-emitted untouched —
   *  currently paragraphs carrying an image (logo, flowchart, diagram). The
   *  AI never sees or rewrites these; they are passed through so figures
   *  survive the rebuild instead of being silently dropped. */
  figureXml?: string;
}

/**
 * Maps each list paragraph's <w:numPr> (numId + ilvl) to its format by reading
 * numbering.xml — so we can tell a genuine BULLET list from a decimal/lettered
 * NUMBERED list, and from a numbered-clause paragraph that merely looks numbered.
 * Returns (numId → ilvl → "bullet" | "number"); missing entries => not a list.
 */
function readNumberingFormats(zip: PizZip): Map<string, Map<string, "bullet" | "number">> {
  const out = new Map<string, Map<string, "bullet" | "number">>();
  const numXml = zip.file("word/numbering.xml")?.asText();
  if (!numXml) return out;
  // abstractNumId → (ilvl → format)
  const abstractFmt = new Map<string, Map<string, "bullet" | "number">>();
  for (const am of numXml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="([^"]+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const aid = am[1];
    const levels = new Map<string, "bullet" | "number">();
    for (const lv of am[0].matchAll(/<w:lvl\b[^>]*w:ilvl="([^"]+)"[\s\S]*?<\/w:lvl>/g)) {
      const fmt = lv[0].match(/<w:numFmt\b[^>]*w:val="([^"]+)"/)?.[1] ?? "";
      levels.set(lv[1], fmt === "bullet" ? "bullet" : "number");
    }
    abstractFmt.set(aid, levels);
  }
  // num (numId) → abstractNumId
  for (const nm of numXml.matchAll(/<w:num\b[^>]*w:numId="([^"]+)"[\s\S]*?<\/w:num>/g)) {
    const aid = nm[0].match(/<w:abstractNumId\b[^>]*w:val="([^"]+)"/)?.[1];
    if (aid && abstractFmt.has(aid)) out.set(nm[1], abstractFmt.get(aid)!);
  }
  return out;
}

/** The list format of a paragraph, from its <w:numPr>, or null when not a list. */
function paragraphListFormat(
  pXml: string,
  numFormats: Map<string, Map<string, "bullet" | "number">>,
): "bullet" | "number" | null {
  const numPr = pXml.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/)?.[0];
  if (!numPr) return null;
  const numId = numPr.match(/<w:numId\b[^>]*w:val="([^"]+)"/)?.[1];
  const ilvl = numPr.match(/<w:ilvl\b[^>]*w:val="([^"]+)"/)?.[1] ?? "0";
  if (!numId) return null;
  return numFormats.get(numId)?.get(ilvl) ?? numFormats.get(numId)?.get("0") ?? null;
}

/** The <w:pPr> of a paragraph, or "" when it has none. */
function paragraphProps(pXml: string): string {
  return pXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)?.[0] ?? "";
}

/** Does this paragraph carry a drawing/picture (logo, flowchart, diagram)? */
function hasImage(pXml: string): boolean {
  return /<w:drawing\b|<w:pict\b|<w:object\b/.test(pXml);
}

/** Styles that must never win the body-formatting vote. A long manual's table
 *  of contents can easily outnumber its prose — picking TOC2 would style every
 *  regenerated paragraph as a contents line. */
const NON_BODY_STYLE_RE = /toc|contents|index|header|footer|caption|heading|title|figure|table/i;

/**
 * The paragraph formatting to apply to regenerated body text.
 *
 * Votes for the most common *prose* paragraph style in the source, then builds
 * a CLEAN <w:pPr> from it rather than reusing the source XML verbatim. Two
 * reasons: OOXML requires pPr children in a fixed schema order (splicing into
 * arbitrary markup silently breaks it), and the winning style often carries no
 * spacing at all — which is what made rebuilt documents read as a wall of text.
 * Explicit spacing and justification are therefore always applied.
 */
export function dominantBodyProps(units: StructuredUnit[]): string {
  const styleTally = new Map<string, number>();
  const spacingTally = new Map<string, number>();
  const jcTally = new Map<string, number>();
  const vote = (map: Map<string, number>, k: string) => map.set(k, (map.get(k) ?? 0) + 1);
  for (const u of units) {
    if (u.table || u.figureXml || !u.pPr) continue;
    if (u.text === u.section) continue;              // heading
    if (u.text.trim().length < 60) continue;         // labels/captions skew short
    if (!/[.;:]/.test(u.text)) continue;             // require prose, not a TOC line
    const style = u.pPr.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? "";
    if (NON_BODY_STYLE_RE.test(style)) continue;
    vote(styleTally, style);
    // Sample the paragraphs' REAL spacing and justification so the rebuild keeps
    // the document's actual layout instead of a one-size-fits-all guess.
    const sp = u.pPr.match(/<w:spacing\b[^>]*\/>/)?.[0];
    if (sp) vote(spacingTally, sp);
    const jc = u.pPr.match(/<w:jc\b[^>]*\/>/)?.[0];
    if (jc) vote(jcTally, jc);
  }
  const winner = (map: Map<string, number>) => {
    let best = "", bestN = 0;
    for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
    return best;
  };
  const bestStyle = winner(styleTally);

  // Schema order matters: pStyle → spacing → jc.
  const style = bestStyle ? `<w:pStyle w:val="${escapeXml(bestStyle)}"/>` : "";
  const spacing = winner(spacingTally) || `<w:spacing w:before="0" w:after="160" w:line="276" w:lineRule="auto"/>`;
  const jc = winner(jcTally); // inherit (no jc) when the source doesn't set one
  return `<w:pPr>${style}${spacing}${jc}</w:pPr>`;
}

/**
 * The dominant RUN font + size of the source's body PROSE — sampled from the
 * actual text runs (not styles, which would need inheritance resolution). Applied
 * to every regenerated run so the redraft keeps the document's real typeface and
 * size instead of falling back to the Word default (Calibri). Returns a ready
 * <w:rPr> (or "" when the source carries no explicit run font anywhere).
 */
export function dominantBodyRunProps(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const xml = zip.file("word/document.xml")?.asText() ?? "";
  const tally = new Map<string, number>(); // "font|size" → count
  const pRe = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml)) !== null) {
    const pXml = m[0];
    if (!/<w:t[ >]/.test(pXml)) continue;               // no visible text
    if (getParagraphText(pXml).trim().length < 40) continue; // prose, not labels
    // The first real text run's rPr represents the paragraph's body font.
    const rPr = pXml.match(/<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
    const font = rPr.match(/<w:rFonts\b[^>]*\bw:ascii="([^"]+)"/)?.[1] ?? "";
    const sz = rPr.match(/<w:sz\b[^>]*w:val="([^"]+)"/)?.[1] ?? "";
    if (!font && !sz) continue;
    vote2(tally, `${font}|${sz}`);
  }
  let font = "", sz = "", best = 0;
  for (const [k, n] of tally) if (n > best) { best = n; [font, sz] = k.split("|"); }
  // Fall back to docDefaults when body runs carry no explicit font.
  if (!font && !sz) {
    const styles = zip.file("word/styles.xml")?.asText() ?? "";
    const dd = styles.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? "";
    font = dd.match(/<w:rFonts\b[^>]*\bw:ascii="([^"]+)"/)?.[1] ?? "";
    sz = dd.match(/<w:sz\b[^>]*w:val="([^"]+)"/)?.[1] ?? "";
  }
  if (!font && !sz) return "";
  const rFonts = font ? `<w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:cs="${escapeXml(font)}"/>` : "";
  const size = sz ? `<w:sz w:val="${escapeXml(sz)}"/><w:szCs w:val="${escapeXml(sz)}"/>` : "";
  return `<w:rPr>${rFonts}${size}</w:rPr>`;
}

function vote2(map: Map<string, number>, k: string) { map.set(k, (map.get(k) ?? 0) + 1); }

/**
 * Index just PAST the close tag matching the element that opens at `start`,
 * counting nesting depth. `start` must be the "<" of an opening `<tag …>`.
 * Self-closing (`<tag/>`) elements return the index just past that tag.
 * Returns -1 when the markup is unbalanced.
 *
 * A non-greedy /<w:tbl>[\s\S]*?<\/w:tbl>/ stops at the FIRST close tag, which
 * for a table containing a table ends the match inside the parent — silently
 * truncating the outer table's remaining rows. This walks depth instead.
 */
function endOfElement(xml: string, start: number, tag: string): number {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const s = m[0];
    if (s.startsWith("</")) {
      depth--;
      if (depth === 0) return re.lastIndex;
    } else if (s.endsWith("/>")) {
      if (depth === 0) return re.lastIndex; // self-closing element, no body
    } else {
      depth++;
    }
  }
  return -1;
}

/** Outer XML of each DIRECT child `tag` inside `xml`. Consuming each match whole
 *  (depth-aware) means a nested table's rows/cells are skipped rather than
 *  mistaken for the parent's. */
function directChildren(xml: string, tag: string): string[] {
  const out: string[] = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "g");
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) {
    const end = m[0].endsWith("/>")
      ? m.index + m[0].length
      : endOfElement(xml, m.index, tag);
    if (end < 0) break;
    out.push(xml.slice(m.index, end));
    openRe.lastIndex = end;
  }
  return out;
}

/**
 * Rows of a single <w:tbl> as string[][] (one string per cell, cell text = its
 * paragraphs joined). Depth-aware: only the table's OWN rows and cells are read.
 *
 * A table nested inside a cell cannot be represented in this flat row model, so
 * its text is folded into the containing cell — the outer grid stays intact and
 * no content is dropped, which beats truncating the parent table.
 */
function tableRows(tblXml: string): string[][] {
  const rows: string[][] = [];
  for (const rowXml of directChildren(tblXml, "w:tr")) {
    const cells: string[] = [];
    for (const cellXml of directChildren(rowXml, "w:tc")) {
      // Every paragraph in the cell, including any inside a nested table, so
      // nested content survives as text rather than vanishing.
      const cellParas = [...cellXml.matchAll(/<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g)]
        .map((p) => getParagraphText(p[0]))
        .filter(Boolean);
      cells.push(cellParas.join(" "));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/**
 * Like docxToSimplifyUnits, but TABLE-AWARE: paragraphs become para units and
 * each table becomes ONE unit carrying its `rows`. This is what the redraft /
 * restructure pipeline consumes so tables survive regeneration (docxToSimplify-
 * Units is kept for the audit, which wants per-cell granularity for claims).
 */
export function docxToStructuredUnits(buffer: Buffer): StructuredUnit[] {
  const zip = new PizZip(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return [];
  const xml = docFile.asText();
  const numFormats = readNumberingFormats(zip);
  const units: StructuredUnit[] = [];
  let section = "";
  // Walk TOP-LEVEL tables and paragraphs in document order. Each table is
  // consumed whole (depth-aware), so its own paragraphs — and any nested
  // table — are handled as part of that table, never re-emitted as loose body
  // paragraphs.
  const tokenRe = /<w:tbl\b[^>]*>|<w:p\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const isTable = m[0].startsWith("<w:tbl");
    const tag = isTable ? "w:tbl" : "w:p";
    const end = m[0].endsWith("/>")
      ? m.index + m[0].length
      : endOfElement(xml, m.index, tag);
    if (end < 0) break; // unbalanced markup — stop rather than mis-slice
    const block = xml.slice(m.index, end);
    tokenRe.lastIndex = end;

    if (isTable) {
      const rows = tableRows(block).filter((r) => r.some((c) => c.trim()));
      if (rows.length === 0) continue;
      const text = rows.map((r) => r.join(" | ")).join("\n");
      // Carry the verbatim table XML so an unchanged table can be re-emitted
      // with its exact styling instead of rebuilt as a generic grid.
      units.push({ text, section, table: rows, tableXml: block });
    } else if (/<w:txbxContent>/.test(block)) {
      // A floating TEXT BOX (e.g. a "Note:" callout). Word floats it, so after a
      // redraft reflows the body it lands ON TOP of the table it used to sit
      // beside. De-float it: pull the text box's paragraphs INLINE so the note
      // flows with the document instead of overlapping other content.
      const inner = block.match(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/)?.[1] ?? "";
      for (const pm of inner.matchAll(/<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g)) {
        const t = getParagraphText(pm[0]);
        if (t) units.push({ text: t, section });
      }
    } else if (hasImage(block)) {
      // A figure (logo, flowchart, diagram). Kept verbatim — it carries no
      // rewritable text, and dropping it loses real procedural content.
      const caption = getParagraphText(block);
      units.push({ text: caption || "[figure]", section, figureXml: block, pPr: paragraphProps(block) });
    } else {
      const t = getParagraphText(block);
      if (!t) continue;
      // Skip Table-of-Contents entries. The rebuild can't regenerate a Word TOC
      // field, so reproducing it flattens the tab leaders — titles and page
      // numbers run together ("D.1Business Rules…D-1") and the page numbers are
      // stale once the body is regenerated. Detected by the TOC paragraph styles
      // Word applies to TOC lines (TOC1–TOC9, TOCHeading, Contents…). The reader
      // can regenerate a clean TOC in Word in one click.
      const pStyle = paragraphProps(block).match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? "";
      if (/^toc/i.test(pStyle) || /contents/i.test(pStyle)) continue;
      if (t.length <= 80 && t.length >= 3 && t === t.toUpperCase() && /[A-Z]/.test(t)) {
        section = t;
      }
      const list = paragraphListFormat(block, numFormats) ?? undefined;
      units.push({ text: t, section, pPr: paragraphProps(block), list });
    }
  }
  return units;
}

// ════════════════════════════════════════════════════════════════════════════
// UC4 — FIGURES (charts / flowcharts / diagrams embedded as images)
// Text extraction can't see image content, so figures are extracted here and
// analysed by the vision model; suggestions come back as Word COMMENTS anchored
// on the figure (an image can't be redlined in place).
// ════════════════════════════════════════════════════════════════════════════

export type DocxFigure = {
  /** rId of the FIRST drawing in document.xml that references this image —
   *  used to locate the paragraph to anchor the review comment on. */
  anchorRelId: string;
  name: string;
  mimeType: string;
  dataBase64: string;
  /** How many times this same image appears in the document (logos repeat). */
  occurrences: number;
};

const FIGURE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Extracts the UNIQUE raster images referenced by word/document.xml, largest
 * first. Tiny files (icons/logos) and unsupported formats (gif/emf/wmf — the
 * vision model can't take them) are skipped and counted. Each figure carries
 * the rId of its first reference so a comment can be anchored on that drawing's
 * paragraph.
 */
export function extractDocxFigures(
  buffer: Buffer,
  opts: { maxFigures?: number; minBytes?: number } = {},
): { figures: DocxFigure[]; skipped: number } {
  const maxFigures = opts.maxFigures ?? 15;
  const minBytes = opts.minBytes ?? 8 * 1024;
  const zip = new PizZip(buffer);
  const docFile = zip.file("word/document.xml");
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (!docFile || !relsFile) return { figures: [], skipped: 0 };
  const xml = docFile.asText();
  const rels = relsFile.asText();

  const relTarget = new Map<string, string>();
  const relRe = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(rels)) !== null) relTarget.set(rm[1], rm[2]);

  // Group references by media target so a logo used 300x is analysed once.
  const byTarget = new Map<string, { relId: string; count: number; name: string }>();
  const refRe = /<a:blip[^>]*r:embed="([^"]+)"|<v:imagedata[^>]*r:id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(xml)) !== null) {
    const rid = m[1] ?? m[2];
    const target = relTarget.get(rid);
    if (!target) continue;
    const entry = byTarget.get(target);
    if (entry) {
      entry.count++;
    } else {
      // The drawing's alt-text/name sits in wp:docPr just before the blip.
      const back = xml.slice(Math.max(0, m.index - 700), m.index);
      const nm = [...back.matchAll(/<wp:docPr[^>]*name="([^"]*)"/g)].pop()?.[1] ?? "";
      byTarget.set(target, { relId: rid, count: 1, name: nm });
    }
  }

  const all: DocxFigure[] = [];
  let skipped = 0;
  for (const [target, info] of byTarget) {
    const rel = target.replace(/^\//, "").replace(/^(\.\.\/)+/, "");
    const f = zip.file(rel.startsWith("word/") ? rel : `word/${rel}`);
    if (!f) {
      skipped++;
      continue;
    }
    const ext = (rel.split(".").pop() ?? "").toLowerCase();
    const mime = FIGURE_MIME[ext];
    const bytes = f.asUint8Array();
    if (!mime || bytes.length < minBytes) {
      skipped++;
      continue;
    }
    all.push({
      anchorRelId: info.relId,
      name: info.name || rel.split("/").pop() || rel,
      mimeType: mime,
      dataBase64: Buffer.from(bytes).toString("base64"),
      occurrences: info.count,
    });
  }
  all.sort((a, b) => b.dataBase64.length - a.dataBase64.length);
  const figures = all.slice(0, maxFigures);
  skipped += all.length - figures.length;
  return { figures, skipped };
}

// ════════════════════════════════════════════════════════════════════════════
// UC4 — APPLY SIMPLIFICATION TO DOCX
// Paragraph-aware sub-text replacement: when `before` is a sentence inside a
// longer paragraph, the OTHER content in that paragraph is preserved. Each
// amended paragraph is yellow-highlighted AND wrapped in a Word comment range
// carrying the original "Before:" text — so reviewers see, in-document, both
// the new wording (highlighted) and what it replaced (the comment).
// ════════════════════════════════════════════════════════════════════════════

/** One simplification edit: replace `before` (verbatim from the source text)
 *  with `after`, and leave a Word comment carrying the original. */
export type SimplifyDocxEdit = {
  before: string;
  after: string;
  /** Optional context appended after "Before:" in the Word comment. */
  rationale?: string;
  /** Replace the ENTIRE located paragraph, not just the `before` span. Used for
   *  clause omissions / whole-clause rewrites: `before` only needs to anchor the
   *  right paragraph, and the whole clause is struck and replaced with `after` —
   *  so a partial quote can't leave a dangling fragment of the original sentence. */
  replaceParagraph?: boolean;
  /** COMMENT-ONLY edit: no text change — attach `comment` to the paragraph whose
   *  drawing references `anchorRelId` (figures/charts can't be redlined). */
  commentOnly?: boolean;
  anchorRelId?: string;
  comment?: string;
  /** INSERTION edit: add `after` as NEW standalone paragraph(s) immediately
   *  after the first paragraph whose text contains this anchor (verbatim from
   *  the source). `before` is ignored. Inserted paragraphs inherit the anchor's
   *  paragraph/run formatting (numbering stripped — new steps carry their own
   *  literal numbering like "5a." so existing steps are never renumbered) and
   *  are wrapped in <w:ins> tracked-insert in redline mode. Word repaginates
   *  around them automatically. */
  insertAfter?: string;
  /** TABLE-ROW edit: insert a NEW row after the row whose text contains this
   *  anchor (e.g. a glossary entry). `cells` holds one string per column, in
   *  order ("" leaves the cell empty). The new row clones the anchor row's
   *  cell formatting; in redline mode it is a Word tracked row-insert. */
  insertRowAfter?: string;
  cells?: string[];
};

export type SimplifyDocxResult = {
  buffer: Buffer;
  appliedCount: number;
  skipped: { reason: string; before: string }[];
  /** One entry per applied text edit: the `before` that anchored, the `after`
   *  inserted, and `locatedText` — the exact original span that was struck (the
   *  whole paragraph for a replaceParagraph edit). Lets callers report the true
   *  "was" in a change history instead of a partial excerpt. */
  applied: { before: string; after: string; locatedText: string }[];
};

const COMMENTS_CTYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
// commentsExtended.xml is what modern Word (2013+) reads to anchor a comment to
// its text range. Without it, Word shows the comment in the pane but won't draw
// the link/highlight to the commented text.
const COMMENTS_EX_CTYPE = "application/vnd.ms-word.commentsExtended+xml";
const COMMENTS_EX_REL_TYPE =
  "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";

/** Replace `before` with `after` inside `paraText`. Tolerant of smart-quote
 *  drift and case differences (a verified `before` may still differ slightly
 *  from the paragraph's raw text in punctuation glyphs or casing). */
function tolerantReplace(paraText: string, before: string, after: string): string | null {
  const q = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const p = q(paraText);
  const b = q(before);
  if (!b) return null;
  // 1. quote-normalised exact substring
  let at = p.indexOf(b);
  if (at >= 0) return p.slice(0, at) + after + p.slice(at + b.length);
  // 2. case-insensitive — same length so indices line up
  at = p.toLowerCase().indexOf(b.toLowerCase());
  if (at >= 0) return p.slice(0, at) + after + p.slice(at + b.length);
  return null;
}

/** Like tolerantReplace, but returns the match span (indices into the ORIGINAL
 *  paraText) instead of replacing — used to build a redline. Quote-normalisation
 *  is 1:1 in length, so indices map straight back to the original text. */
function tolerantLocate(paraText: string, before: string): { start: number; end: number } | null {
  const q = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const p = q(paraText);
  const b = q(before);
  if (!b) return null;
  let at = p.indexOf(b);
  if (at < 0) at = p.toLowerCase().indexOf(b.toLowerCase());
  if (at < 0) return null;
  return { start: at, end: at + b.length };
}

/**
 * Whitespace-tolerant "does this paragraph hold this clause?" test — for
 * WHOLE-PARAGRAPH replacements (omissions) only, where we just need to IDENTIFY
 * the paragraph, not compute an exact span. `tolerantLocate` does an exact
 * substring match (quotes/case only); a long omission excerpt drifts on a single
 * tab→space or double space somewhere across its ~50 words and fails, silently
 * skipping the deletion. Here both sides are whitespace-collapsed, and a
 * distinctive prefix of the excerpt is tried as a fallback, so the clause still
 * anchors. Short paragraphs are guarded against false "b contains p" matches.
 */
function paragraphContainsLoose(paraText: string, before: string): boolean {
  const norm = (s: string) =>
    (s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
  const p = norm(paraText);
  const b = norm(before);
  if (p.length < 8 || b.length < 8) return false;
  if (p.includes(b)) return true;              // paragraph holds the excerpt
  if (p.length >= 40 && b.includes(p)) return true; // excerpt spans ≥ this paragraph
  // Whitespace-AGNOSTIC compare: run extraction can glue a clause number to its
  // text ("7.2The…" when a tab sits between runs) or drift a tab→space, so a
  // single-space collapse still misses. Strip ALL whitespace and compare — a
  // long excerpt is distinctive enough that collisions aren't a real risk.
  const ps = p.replace(/\s/g, "");
  const bs = b.replace(/\s/g, "");
  if (bs.length >= 12 && (ps.includes(bs) || (ps.length >= 40 && bs.includes(ps)))) return true;
  // Distinctive leading fragment of the excerpt (carries the clause number).
  const words = b.split(" ");
  for (const n of [12, 8, 6]) {
    const frag = words.slice(0, n).join(" ").replace(/\s/g, "");
    if (frag.length >= 18 && ps.includes(frag)) return true;
  }
  return false;
}

/**
 * Whitespace/glue-tolerant span locator: finds `before` inside `paraText` and
 * returns the ORIGINAL [start,end) span, even when run extraction dropped a tab
 * (gluing a clause number to its text, "13.1The…") or drifted spacing — cases
 * where `tolerantLocate`'s exact substring search fails and the edit gets
 * skipped. It compares with ALL whitespace removed, keeping a map from each kept
 * character back to its original index, so the redline still strikes the real
 * text region. Used as the FALLBACK after an exact match fails, so precise sub-
 * span swaps keep their exact fidelity when the exact match succeeds.
 */
function looseLocateSpan(paraText: string, before: string): { start: number; end: number } | null {
  const q = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  const pq = q(paraText); // 1:1 length with paraText (quote-swap + lowercase preserve length)
  const kept: string[] = [];
  const map: number[] = []; // index in `kept` → index in paraText
  for (let i = 0; i < pq.length; i++) {
    if (/\s/.test(pq[i])) continue;
    kept.push(pq[i]);
    map.push(i);
  }
  const p = kept.join("");
  const b = q(before).replace(/\s+/g, "");
  if (b.length < 8) return null;
  const at = p.indexOf(b);
  if (at < 0) return null;
  return { start: map[at], end: map[at + b.length - 1] + 1 };
}

/**
 * Finds the innermost <w:p>…</w:p> that ENCLOSES position `refIndex` — used to
 * anchor figure comments, whose drawing paragraph may contain nested textbox
 * paragraphs (so a leaf-only search misses it). Walks back over candidate
 * <w:p openers and, for each (nearest first), counts nested opens/closes
 * forward to find its matching close; the first whose close lies beyond
 * `refIndex` is the enclosing paragraph. Returns null if none encloses it
 * (e.g. the ref sits in a header part, not document.xml body).
 */
function locateEnclosingParagraph(
  xml: string,
  refIndex: number,
): { start: number; end: number } | null {
  const openRe = /<w:p\b[^>]*>/g;
  const opens: number[] = [];
  let om: RegExpExecArray | null;
  while ((om = openRe.exec(xml)) !== null) {
    if (om.index >= refIndex) break;
    opens.push(om.index);
  }
  const tokenRe = /<w:p\b[^>]*>|<\/w:p>/g;
  for (let i = opens.length - 1; i >= 0; i--) {
    const start = opens[i];
    tokenRe.lastIndex = start;
    let depth = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(xml)) !== null) {
      depth += tm[0] === "</w:p>" ? -1 : 1;
      if (depth === 0) {
        const end = tm.index + tm[0].length;
        if (end > refIndex) return { start, end };
        break; // closed before the ref — try the next-outer candidate
      }
    }
  }
  return null;
}

/**
 * Build a paragraph as a REDLINE (Word tracked changes): the deleted `before`
 * span is wrapped in <w:del> (Word renders this as red strikethrough in markup
 * view; the explicit <w:strike/> + red colour make it unmistakable), and the
 * new `after` text is wrapped in <w:ins> (Word shows insertions underlined).
 * Reviewers can Accept/Reject each change in Word's Review pane. Paragraph
 * properties (<w:pPr> — numbering, style) are preserved.
 *
 * For a "delete_redundant" action `after` is empty → a pure deletion (struck
 * text, nothing inserted).
 */
function buildRedlineParagraph(
  origPXml: string,
  paraText: string,
  loc: { start: number; end: number },
  after: string,
  delId: number,
  insId: number,
  author: string,
  dateIso: string,
): string {
  const pPrMatch = origPXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : "";
  // Inherit the FIRST real text run's properties (font, SIZE, bold, colour…) so
  // inserted/kept text matches the surrounding text and doesn't balloon past a
  // flowchart box or table cell. (The paragraph-mark rPr inside <w:pPr> is the
  // wrong one — we want an actual <w:r>'s rPr.)
  const rPr = origPXml.match(/<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
  const prefix = paraText.slice(0, loc.start);
  const deleted = paraText.slice(loc.start, loc.end);
  const suffix = paraText.slice(loc.end);

  const a = escapeXml(author);
  const textRun = (t: string) =>
    t ? `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>` : "";
  // Deletion keeps the original size/font + an explicit red strikethrough.
  const delRpr = rPr
    ? rPr.replace(/<\/w:rPr>$/, `<w:strike/><w:color w:val="FF0000"/></w:rPr>`)
    : `<w:rPr><w:strike/><w:color w:val="FF0000"/></w:rPr>`;
  const delRun = deleted
    ? `<w:del w:id="${delId}" w:author="${a}" w:date="${dateIso}">` +
      `<w:r>${delRpr}` +
      `<w:delText xml:space="preserve">${escapeXml(deleted)}</w:delText></w:r></w:del>`
    : "";
  // Insertion keeps the original size/font (Word underlines insertions in markup).
  const insRun = after
    ? `<w:ins w:id="${insId}" w:author="${a}" w:date="${dateIso}">` +
      `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(after)}</w:t></w:r></w:ins>`
    : "";

  return `<w:p>${pPr}${textRun(prefix)}${delRun}${insRun}${textRun(suffix)}</w:p>`;
}

/**
 * Build a paragraph with the edit applied PLAINLY — no tracked changes, no
 * highlight. Same sub-paragraph swap and pPr/rPr inheritance as the redline
 * builder, so the clean export is formatting-identical to the source around
 * the change. Returns "" when the edit deletes the paragraph's entire text
 * (pure delete_redundant of a whole paragraph) so the caller can drop it.
 */
function buildCleanParagraph(
  origPXml: string,
  paraText: string,
  loc: { start: number; end: number },
  after: string,
): string {
  const pPr = origPXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const rPr = origPXml.match(/<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
  const prefix = paraText.slice(0, loc.start);
  const suffix = paraText.slice(loc.end);
  if (!(prefix + after + suffix).trim()) return ""; // paragraph fully deleted
  const textRun = (t: string) =>
    t ? `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>` : "";
  return `<w:p>${pPr}${textRun(prefix)}${textRun(after)}${textRun(suffix)}</w:p>`;
}

/** Wraps an already-built paragraph in a Word comment range (rationale rider). */
function wrapParagraphWithComment(para: string, commentId: number): string {
  const open = para.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const pPr = para.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const head = para.startsWith(open + pPr) ? open + pPr : open;
  const inner = para.slice(head.length, para.length - "</w:p>".length);
  return (
    head +
    `<w:commentRangeStart w:id="${commentId}"/>` +
    inner +
    `<w:commentRangeEnd w:id="${commentId}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>` +
    `</w:p>`
  );
}

/** Build a <w:p> with one highlighted run, optionally wrapped in a comment range. */
function buildHighlightedParaWithComment(text: string, commentId: number | null): string {
  const lines = text.split(/\r?\n/);
  const runs = lines
    .map((line, i) => {
      const r = `<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
      return i < lines.length - 1 ? `${r}<w:r><w:br/></w:r>` : r;
    })
    .join("");
  if (commentId === null) return `<w:p>${runs}</w:p>`;
  return (
    `<w:p>` +
    `<w:commentRangeStart w:id="${commentId}"/>` +
    `${runs}` +
    `<w:commentRangeEnd w:id="${commentId}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>` +
    `</w:p>`
  );
}

/** Build one <w:comment> XML entry. The first `<w:p>` inside the comment is
 *  tagged with `w14:paraId` so commentsExtended.xml can anchor against it. */
function buildCommentEntry(
  id: number,
  content: string,
  author: string,
  dateIso: string,
  paraId: string,
): string {
  const lines = content.split(/\r?\n/);
  const ps = lines
    .map((line, i) => {
      const pidAttr = i === 0 ? ` w14:paraId="${paraId}" w14:textId="${paraId}"` : "";
      return `<w:p${pidAttr}><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
    })
    .join("");
  const initials =
    author
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .join("")
      .slice(0, 4)
      .toUpperCase() || "CS";
  return `<w:comment w:id="${id}" w:author="${escapeXml(author)}" w:initials="${escapeXml(initials)}" w:date="${dateIso}">${ps}</w:comment>`;
}

/** Writes word/comments.xml + word/commentsExtended.xml and registers both in
 *  document.xml.rels and [Content_Types].xml. The commentsExtended part is what
 *  modern Word reads to actually link the comment to its in-document text range —
 *  without it, comments show in the pane but the anchor highlight is broken. */
function attachComments(zip: PizZip, commentEntries: string[], paraIds: string[]): void {
  if (commentEntries.length === 0) return;

  // 1. word/comments.xml with the full namespace set Word 365 expects.
  const commentsNs =
    `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
    ` xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"` +
    ` xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"` +
    ` xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"` +
    ` mc:Ignorable="w14 w15"`;
  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${commentsNs}>${commentEntries.join("")}</w:comments>`;
  zip.file("word/comments.xml", commentsXml);

  // 2. word/commentsExtended.xml — one <w15:commentEx> per comment, anchored by
  //    the paraId on the comment's first paragraph. This is what makes the link
  //    between the comment and the text range visible in Word 2013+.
  const exEntries = paraIds
    .map((pid) => `<w15:commentEx w15:paraId="${pid}" w15:done="0"/>`)
    .join("");
  const commentsExtendedXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"` +
    ` xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"` +
    ` mc:Ignorable="w14">${exEntries}</w15:commentsEx>`;
  zip.file("word/commentsExtended.xml", commentsExtendedXml);

  // 3. word/_rels/document.xml.rels — register both relationships.
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (relsFile) {
    let rels = relsFile.asText();
    const existingIds = [...rels.matchAll(/Id="rId(\d+)"/g)].map((mm) => Number(mm[1]));
    let nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
    if (!rels.includes(COMMENTS_REL_TYPE)) {
      const rel = `<Relationship Id="rId${nextId++}" Type="${COMMENTS_REL_TYPE}" Target="comments.xml"/>`;
      rels = rels.replace("</Relationships>", `${rel}</Relationships>`);
    }
    if (!rels.includes(COMMENTS_EX_REL_TYPE)) {
      const rel = `<Relationship Id="rId${nextId++}" Type="${COMMENTS_EX_REL_TYPE}" Target="commentsExtended.xml"/>`;
      rels = rels.replace("</Relationships>", `${rel}</Relationships>`);
    }
    zip.file("word/_rels/document.xml.rels", rels);
  }

  // 4. [Content_Types].xml — register both parts.
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = ctFile.asText();
    if (!ct.includes("/word/comments.xml")) {
      const ovr = `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CTYPE}"/>`;
      ct = ct.replace("</Types>", `${ovr}</Types>`);
    }
    if (!ct.includes("/word/commentsExtended.xml")) {
      const ovr = `<Override PartName="/word/commentsExtended.xml" ContentType="${COMMENTS_EX_CTYPE}"/>`;
      ct = ct.replace("</Types>", `${ovr}</Types>`);
    }
    zip.file("[Content_Types].xml", ct);
  }
}

/**
 * Applies UC4 simplification edits to a DOCX, producing an amended .docx where:
 *  - each changed paragraph keeps its OTHER content (`before` → `after` is a
 *    sub-paragraph swap, not a whole-paragraph clobber);
 *  - the changed text is yellow-highlighted so it is visible at a glance;
 *  - each amended paragraph carries a Word comment with the ORIGINAL "Before:"
 *    text plus optional rationale, so reviewers see what changed in-document.
 *
 * Edits whose `before` cannot be located in any paragraph are SKIPPED and
 * returned in `skipped` — they are never silently dropped.
 */
/** Innermost <w:TAG>…</w:TAG> block containing `pos` (depth-aware — survives
 *  nested tables). Returns null if pos isn't inside such a block. */
function findEnclosingBlock(xml: string, pos: number, tag: string): { start: number; end: number } | null {
  const re = new RegExp(`<w:${tag}(?=[ >])[^>]*>|</w:${tag}>`, "g");
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith(`</`)) {
      const start = stack.pop();
      if (start !== undefined && start < pos && m.index + m[0].length > pos) {
        return { start, end: m.index + m[0].length };
      }
      if (m.index > pos && stack.length === 0) return null; // passed pos, nothing open
    } else {
      if (m.index > pos) { if (!stack.length) return null; continue; }
      stack.push(m.index);
    }
  }
  return null;
}

/** Top-level <w:TAG>…</w:TAG> blocks directly inside `xml` (depth-aware). */
function splitTopLevelBlocks(xml: string, tag: string): { start: number; end: number }[] {
  const re = new RegExp(`<w:${tag}(?=[ >])[^>]*>|</w:${tag}>`, "g");
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith(`</`)) {
      depth--;
      if (depth === 0 && open >= 0) { out.push({ start: open, end: m.index + m[0].length }); open = -1; }
    } else {
      if (depth === 0) open = m.index;
      depth++;
    }
  }
  return out;
}

export function applySimplificationToDocx(
  sourceBuffer: Buffer,
  edits: SimplifyDocxEdit[],
  opts: { author?: string; mode?: "redline" | "highlight" | "clean"; redlineComments?: boolean } = {},
): SimplifyDocxResult {
  const zip = new PizZip(sourceBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Invalid DOCX: word/document.xml not found");
  let documentXml = docFile.asText();

  // "redline" = Word tracked changes (red strikethrough deletions + insertions,
  // Accept/Reject-able); with opts.redlineComments each change also carries a
  // Word comment holding the rationale. "highlight" = yellow highlight + a Word
  // comment. "clean" = plain replacement, no markup at all (final-copy export).
  const mode = opts.mode ?? "redline";
  const author = (opts.author ?? "AI Document Workflow").slice(0, 60);
  const dateIso = new Date().toISOString();
  const commentEntries: string[] = [];
  const paraIds: string[] = []; // one per comment — links commentsExtended.xml back

  let nextCommentId = 0;
  let nextRevId = 1000; // <w:ins>/<w:del> revision ids (kept clear of any in the source)
  let appliedCount = 0;
  const skipped: { reason: string; before: string }[] = [];
  const applied: { before: string; after: string; locatedText: string }[] = [];

  for (const edit of edits) {
    // ── Figure comment: anchor a Word comment on the paragraph containing the
    // drawing that references anchorRelId. No text change, works in both modes.
    // NOTE: a drawing's paragraph is often NOT a leaf (the drawing can hold a
    // textbox with nested <w:p>), so locate the ref position first and walk
    // outward to its ENCLOSING paragraph. Nested paragraphs live inside runs,
    // so the enclosing paragraph's direct children are still runs — inserting
    // comment-range markers at that level stays schema-valid.
    if (edit.commentOnly && edit.anchorRelId) {
      const ridEsc = edit.anchorRelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refMatch = new RegExp(`(?:r:embed|r:id|r:dm)="${ridEsc}"`).exec(documentXml);
      const span = refMatch ? locateEnclosingParagraph(documentXml, refMatch.index) : null;
      if (!span) {
        skipped.push({ reason: "figure anchor not found", before: edit.anchorRelId });
        continue;
      }
      const para = documentXml.slice(span.start, span.end);
      const commentId = nextCommentId++;
      const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
      paraIds.push(paraId);
      commentEntries.push(
        buildCommentEntry(commentId, edit.comment ?? edit.after ?? "", author, dateIso, paraId),
      );
      // commentRangeStart must come after <w:pPr>, so split open-tag + pPr off.
      const open = para.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
      const pPr = para.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
      const head = para.startsWith(open + pPr) ? open + pPr : open;
      const inner = para.slice(head.length, para.length - "</w:p>".length);
      const newPara =
        head +
        `<w:commentRangeStart w:id="${commentId}"/>` +
        inner +
        `<w:commentRangeEnd w:id="${commentId}"/>` +
        `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>` +
        `</w:p>`;
      documentXml = documentXml.slice(0, span.start) + newPara + documentXml.slice(span.end);
      appliedCount++;
      continue;
    }

    // ── Table-row insertion: new row after the row containing the anchor. ──
    if (edit.insertRowAfter?.trim() && edit.cells?.some((c) => c.trim())) {
      const anchorText = edit.insertRowAfter.trim();
      const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
      let am: RegExpExecArray | null;
      let placedRow = false;
      while ((am = pRegex.exec(documentXml)) !== null) {
        const paraText = getParagraphText(am[0]);
        if (!paraText || !paragraphContainsLoose(paraText, anchorText)) continue;
        const row = findEnclosingBlock(documentXml, am.index, "tr");
        if (!row) {
          skipped.push({ reason: "row anchor is not inside a table row", before: anchorText });
          placedRow = true;
          break;
        }
        const rowXml = documentXml.slice(row.start, row.end);
        const tcs = splitTopLevelBlocks(rowXml, "tc");
        if (!tcs.length) {
          skipped.push({ reason: "anchor row has no readable cells", before: anchorText });
          placedRow = true;
          break;
        }
        const a = escapeXml(author);
        // Clone per-column formatting from the anchor row's cells; missing
        // template cells (more values than columns) reuse the last one.
        const newCells = edit.cells.slice(0, Math.max(tcs.length, edit.cells.length)).map((val, i) => {
          const tpl = rowXml.slice(tcs[Math.min(i, tcs.length - 1)].start, tcs[Math.min(i, tcs.length - 1)].end);
          const tcPr = tpl.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0] ?? "";
          const pPr = (tpl.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "").replace(/<w:numPr\b[\s\S]*?<\/w:numPr>/, "");
          const rPr = tpl.match(/<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
          const t = val.trim();
          const run = t ? `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>` : "";
          const content = t && mode === "redline"
            ? `<w:ins w:id="${nextRevId++}" w:author="${a}" w:date="${dateIso}">${run}</w:ins>`
            : run;
          return { xml: `<w:tc>${tcPr}<w:p>${pPr}${content}</w:p></w:tc>`, hasText: !!t, pPr, content };
        });
        // Row-level tracked insert so Word offers Accept/Reject on the ROW.
        const trPr = mode === "redline"
          ? `<w:trPr><w:ins w:id="${nextRevId++}" w:author="${a}" w:date="${dateIso}"/></w:trPr>`
          : (rowXml.match(/<w:trPr\b[\s\S]*?<\/w:trPr>/)?.[0] ?? "");
        let cellsXml = newCells.map((c) => c.xml).join("");
        // Rationale comment on the first non-empty cell's paragraph.
        if (opts.redlineComments && edit.rationale) {
          const target = newCells.find((c) => c.hasText);
          if (target) {
            const commentId = nextCommentId++;
            const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
            paraIds.push(paraId);
            commentEntries.push(buildCommentEntry(commentId, `[ADDED ROW] ${edit.rationale}`, author, dateIso, paraId));
            const wrapped = wrapParagraphWithComment(`<w:p>${target.pPr}${target.content}</w:p>`, commentId);
            cellsXml = cellsXml.replace(`<w:p>${target.pPr}${target.content}</w:p>`, wrapped);
          }
        }
        const newRow = `<w:tr>${trPr}${cellsXml}</w:tr>`;
        documentXml = documentXml.slice(0, row.end) + newRow + documentXml.slice(row.end);
        applied.push({ before: `[insert row after] ${anchorText}`, after: edit.cells.filter(Boolean).join(" | "), locatedText: paraText });
        appliedCount++;
        placedRow = true;
        break;
      }
      if (!placedRow) skipped.push({ reason: "row anchor not located in any paragraph", before: anchorText });
      continue;
    }

    // ── Insertion: new standalone paragraph(s) after an anchor paragraph. ──
    if (edit.insertAfter?.trim()) {
      const anchorText = edit.insertAfter.trim();
      const newText = (edit.after ?? "").trim();
      if (!newText) {
        skipped.push({ reason: "insertion with empty content", before: anchorText });
        continue;
      }
      const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
      let am: RegExpExecArray | null;
      let placed = false;
      while ((am = pRegex.exec(documentXml)) !== null) {
        const paraText = getParagraphText(am[0]);
        if (!paraText || !paragraphContainsLoose(paraText, anchorText)) continue;
        // Refuse to insert paragraphs INSIDE a table cell: an "addition" there
        // is almost always meant as a new table ROW (e.g. a glossary entry),
        // which needs <w:tr> insertion — appending paragraphs into the cell
        // corrupts the table's content. Honest skip until row-insert support.
        const back = documentXml.slice(0, am.index);
        if (back.lastIndexOf("<w:tc") > back.lastIndexOf("</w:tc>")) {
          skipped.push({ reason: "insertion anchor is inside a table — needs row insertion (not yet supported), apply manually", before: anchorText });
          placed = true; // handled: reported, not silently retried on later matches
          break;
        }
        // Inherit the anchor's paragraph + run formatting; strip list numbering
        // so auto-numbering never renumbers existing steps (inserted steps carry
        // their own literal labels per the fix format).
        const pPr = (am[0].match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "")
          .replace(/<w:numPr\b[\s\S]*?<\/w:numPr>/, "");
        const rPr = am[0].match(/<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
        const a = escapeXml(author);
        const mkRun = (line: string) =>
          `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
        const mkBreak = () => `<w:r>${rPr}<w:br/></w:r>`;
        const paras = newText.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
        const builtParas = paras.map((t) => {
          const lines = t.split(/\n/);
          const inner = lines
            .map((line, i) => mkRun(line) + (i < lines.length - 1 ? mkBreak() : ""))
            .join("");
          const content = mode === "redline"
            ? `<w:ins w:id="${nextRevId++}" w:author="${a}" w:date="${dateIso}">${inner}</w:ins>`
            : inner;
          return `<w:p>${pPr}${content}</w:p>`;
        });
        // Rationale comment rides on the FIRST inserted paragraph.
        if (opts.redlineComments && edit.rationale && builtParas.length) {
          const commentId = nextCommentId++;
          const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
          paraIds.push(paraId);
          commentEntries.push(buildCommentEntry(commentId, `[ADDED] ${edit.rationale}`, author, dateIso, paraId));
          builtParas[0] = wrapParagraphWithComment(builtParas[0], commentId);
        }
        const insertAt = am.index + am[0].length;
        documentXml = documentXml.slice(0, insertAt) + builtParas.join("") + documentXml.slice(insertAt);
        applied.push({ before: `[insert after] ${anchorText}`, after: newText, locatedText: paraText });
        appliedCount++;
        placed = true;
        break;
      }
      if (!placed) skipped.push({ reason: "insert anchor not located in any paragraph", before: anchorText });
      continue;
    }

    const before = (edit.before ?? "").trim();
    if (!before) {
      skipped.push({ reason: "empty before", before: "" });
      continue;
    }

    // Find the first <w:p> whose text contains `before` (tolerantly).
    const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = pRegex.exec(documentXml)) !== null) {
      const paraText = getParagraphText(m[0]);
      if (!paraText) continue;

      // Anchor `before` in this paragraph. Exact match first (best fidelity for a
      // precise sub-span swap); on failure fall back to a whitespace/glue-tolerant
      // locator, so an edit whose quote drifted on a dropped tab ("13.1The…") or
      // stray space still lands instead of being skipped as "not located". For a
      // whole-clause replacement (replaceParagraph — e.g. an omission) the span is
      // the ENTIRE paragraph, so a partial `before` strikes the whole clause
      // rather than leaving a dangling fragment.
      const anchor = tolerantLocate(paraText, before) ?? looseLocateSpan(paraText, before);
      let loc: { start: number; end: number };
      if (edit.replaceParagraph) {
        if (!anchor && !paragraphContainsLoose(paraText, before)) continue;
        loc = { start: 0, end: paraText.length };
      } else {
        if (!anchor) continue;
        loc = anchor;
      }
      const locatedText = paraText.slice(loc.start, loc.end);

      let newPara: string;
      if (mode === "clean") {
        newPara = buildCleanParagraph(m[0], paraText, loc, edit.after ?? "");
      } else if (mode === "redline") {
        newPara = buildRedlineParagraph(
          m[0], paraText, loc, edit.after ?? "", nextRevId++, nextRevId++, author, dateIso,
        );
        if (opts.redlineComments && edit.rationale) {
          const commentId = nextCommentId++;
          const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
          paraIds.push(paraId);
          commentEntries.push(buildCommentEntry(commentId, edit.rationale, author, dateIso, paraId));
          newPara = wrapParagraphWithComment(newPara, commentId);
        }
      } else {
        // highlight mode: swap the located span, or the whole paragraph for an
        // omission/whole-clause replacement.
        const amended = edit.replaceParagraph
          ? (edit.after ?? "")
          : tolerantReplace(paraText, before, edit.after ?? "");
        if (amended === null) continue;
        const commentId = nextCommentId++;
        // 8-char hex paraId — unique per comment, matches what commentsExtended uses.
        const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
        paraIds.push(paraId);
        newPara = buildHighlightedParaWithComment(amended, commentId);
        const commentContent = edit.rationale
          ? `Before: ${locatedText}\n\n${edit.rationale}`
          : `Before: ${locatedText}`;
        commentEntries.push(buildCommentEntry(commentId, commentContent, author, dateIso, paraId));
      }

      documentXml =
        documentXml.slice(0, m.index) + newPara + documentXml.slice(m.index + m[0].length);
      appliedCount++;
      applied.push({ before, after: edit.after ?? "", locatedText });
      matched = true;
      break; // next edit re-walks from the start (indices shifted)
    }
    if (!matched) skipped.push({ reason: "before not located in any paragraph", before });
  }

  zip.file("word/document.xml", documentXml);
  if (commentEntries.length > 0) attachComments(zip, commentEntries, paraIds);

  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, appliedCount, skipped, applied };
}

// ════════════════════════════════════════════════════════════════════════════
// SIMPLIFY V2 — RESTRUCTURED-BODY REBUILD
// Replaces the BODY content of an existing DOCX with generated sections while
// preserving everything else in the package: headers/footers (and the logo
// images they carry), styles.xml, numbering, fonts, media, theme, settings.
// The final <w:sectPr> (page setup + header/footer references) is retained, so
// the output opens in Word looking like the same document family — only the
// body text is new.
// ════════════════════════════════════════════════════════════════════════════

import type { RestructuredSection, RestructureBlock } from "./recommend";

/** Discovers the original's Heading 1-3 paragraph style ids from styles.xml. */
function discoverHeadingStyles(zip: PizZip): Record<1 | 2 | 3, string | null> {
  const out: Record<1 | 2 | 3, string | null> = { 1: null, 2: null, 3: null };
  const stylesFile = zip.file("word/styles.xml");
  if (!stylesFile) return out;
  const xml = stylesFile.asText();
  const styleRe = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(xml)) !== null) {
    const nameMatch = m[2].match(/<w:name\b[^>]*w:val="([^"]+)"/);
    const name = (nameMatch?.[1] ?? "").toLowerCase();
    const lvl = name.match(/^heading (\d)$/)?.[1];
    if (lvl === "1" || lvl === "2" || lvl === "3") out[Number(lvl) as 1 | 2 | 3] ??= m[1];
  }
  return out;
}

/** Insert `inner` inside an existing `<w:rPr>…</w:rPr>` (before its close), or
 *  wrap it in a fresh rPr when there is none. Keeps run props schema-valid. */
function mergeRPr(rPr: string, inner: string): string {
  if (!rPr) return `<w:rPr>${inner}</w:rPr>`;
  return rPr.replace(/<\/w:rPr>\s*$/, `${inner}</w:rPr>`);
}

function headingParagraph(text: string, level: 1 | 2 | 3, styleId: string | null, rPr = ""): string {
  // Left-align headings (the source often centres section titles, which reads
  // awkwardly in the regenerated flow); jc overrides the style's alignment.
  if (styleId) {
    return `<w:p><w:pPr><w:pStyle w:val="${escapeXml(styleId)}"/><w:jc w:val="left"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  }
  // No heading styles in the source — approximate with the body font, bold + size.
  const sz = level === 1 ? 32 : level === 2 ? 28 : 24; // half-points
  const font = rPr.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? "";
  return `<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr>${font}<w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** A body paragraph carrying the document's own formatting. `pPr` is the
 *  source's dominant body paragraph properties (spacing, alignment, indent) and
 *  `rPr` its dominant run font — without them the rebuilt document came out as
 *  bare, wrong-font text that read nothing like the original. */
function bodyParagraph(text: string, pPr = "", rPr = ""): string {
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** An empty paragraph whose only job is to start a new page. */
function pageBreakParagraph(): string {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

/** A NATIVE Word list item — real bullet/number via a numbering.xml numId, so
 *  the redraft's lists render, indent and (for numbered) auto-count like Word's
 *  own, instead of a literal "• " glyph baked into the text. */
function listParagraph(text: string, numId: number, rPr = ""): string {
  return (
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
    `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

// Twips of usable text width on A4 with 1" margins (11906 − 2×1440).
const PAGE_TEXT_WIDTH = 9026;

function simpleTable(rows: string[][], rPr = ""): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  // Distribute the page width by each column's longest content, so a wide
  // "Process Details" column gets the room and a "Seq." column stays slim —
  // fills the page without one-word-per-line wrapping. Every width is explicit
  // (with fixed layout) so nothing ever collapses to one char per line.
  const maxLen = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.map((r) => (r[c] ?? "").length)));
  const totalLen = maxLen.reduce((a, b) => a + b, 0) || cols;
  const MIN = 700;
  const colW = maxLen.map((l) => Math.max(MIN, Math.round((l / totalLen) * PAGE_TEXT_WIDTH)));
  // The MIN floor can push the total past the page width — pull the excess back
  // out of the columns that have room above the floor, so the table fits the
  // page exactly instead of overflowing off the right edge.
  let over = colW.reduce((a, b) => a + b, 0) - PAGE_TEXT_WIDTH;
  if (over > 0) {
    const flex = colW.map((w) => Math.max(0, w - MIN));
    const flexTotal = flex.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < cols; i++) colW[i] = Math.max(MIN, colW[i] - Math.round((over * flex[i]) / flexTotal));
  }
  const totalW = colW.reduce((a, b) => a + b, 0);
  const borders =
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((b) => `<w:${b} w:val="single" w:sz="4" w:color="auto"/>`)
      .join("") +
    `</w:tblBorders>`;
  const grid = `<w:tblGrid>${colW.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const headerRPr = mergeRPr(rPr, "<w:b/>");
  const trs = rows
    .map((row, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => {
        const runPr = ri === 0 ? headerRPr : rPr;
        return (
          `<w:tc><w:tcPr><w:tcW w:w="${colW[ci]}" w:type="dxa"/></w:tcPr>` +
          `<w:p><w:r>${runPr}<w:t xml:space="preserve">${escapeXml(row[ci] ?? "")}</w:t></w:r></w:p></w:tc>`
        );
      }).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  // Schema order: tblW → tblBorders → tblLayout. Fixed layout honours the
  // explicit gridCol widths so the columns never collapse to one char per line.
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/></w:tblPr>${grid}${trs}</w:tbl>`;
}

interface RebuildCtx {
  bodyPPr: string;
  bodyRPr: string;
  bulletNumId: number;
  numberNumId: number;
}

function blockToXml(block: RestructureBlock, ctx: RebuildCtx): string {
  if (block.type === "para" && block.text) return bodyParagraph(block.text, ctx.bodyPPr, ctx.bodyRPr);
  if (block.type === "bullets" && block.items) {
    const numId = block.ordered ? ctx.numberNumId : ctx.bulletNumId;
    return block.items.map((it) => listParagraph(it, numId, ctx.bodyRPr)).join("");
  }
  // A reproduced-unchanged table re-emits its ORIGINAL xml UNTOUCHED — Word
  // authored its column widths correctly, so leave them alone (over-writing them
  // collapsed some tables to one character per line). An edited/new table uses
  // the rebuilt grid, which carries its own explicit full-width columns.
  if (block.type === "table" && block.xml) return block.xml;
  if (block.type === "table" && block.rows) return simpleTable(block.rows, ctx.bodyRPr);
  // A figure is re-emitted exactly as it appeared in the source, so the logo
  // and process diagrams survive the rebuild.
  if (block.type === "figure" && block.xml) return block.xml;
  return "";
}

/**
 * Ensures the package has a bullet list and a decimal (numbered) list definition
 * in numbering.xml, returning their numIds. Creates numbering.xml (and registers
 * it in the rels + content types) when the source has none. Ids are chosen past
 * the highest existing ones so they never clash with the document's own lists.
 * OOXML requires every <w:abstractNum> to precede every <w:num>, so the new
 * abstractNums are spliced right after the opening tag and the nums before the
 * close.
 */
function ensureListNumbering(zip: PizZip): { bulletNumId: number; numberNumId: number } {
  let numXml = zip.file("word/numbering.xml")?.asText();
  const created = !numXml;
  if (!numXml) {
    numXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>`;
  }
  const absIds = [...numXml.matchAll(/w:abstractNumId="(\d+)"/g)].map((mm) => Number(mm[1]));
  const numIds = [...numXml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"/g)].map((mm) => Number(mm[1]));
  let nextAbs = (absIds.length ? Math.max(...absIds) : 0) + 1;
  let nextNum = (numIds.length ? Math.max(...numIds) : 0) + 1;
  const bulletAbs = nextAbs++, numberAbs = nextAbs++;
  const bulletNumId = nextNum++, numberNumId = nextNum++;
  const lvlPPr = `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>`;
  const abstracts =
    `<w:abstractNum w:abstractNumId="${bulletAbs}"><w:multiLevelType w:val="hybridMultilevel"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>${lvlPPr}</w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="${numberAbs}"><w:multiLevelType w:val="hybridMultilevel"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>${lvlPPr}</w:lvl></w:abstractNum>`;
  const nums =
    `<w:num w:numId="${bulletNumId}"><w:abstractNumId w:val="${bulletAbs}"/></w:num>` +
    `<w:num w:numId="${numberNumId}"><w:abstractNumId w:val="${numberAbs}"/></w:num>`;
  numXml = numXml.replace(/(<w:numbering\b[^>]*>)/, `$1${abstracts}`).replace("</w:numbering>", `${nums}</w:numbering>`);
  zip.file("word/numbering.xml", numXml);

  if (created) {
    const relsFile = zip.file("word/_rels/document.xml.rels");
    if (relsFile) {
      let rels = relsFile.asText();
      if (!/Target="numbering\.xml"/.test(rels)) {
        const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((mm) => Number(mm[1]));
        const nid = (ids.length ? Math.max(...ids) : 0) + 1;
        const rel = `<Relationship Id="rId${nid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`;
        zip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `${rel}</Relationships>`));
      }
    }
    const ctFile = zip.file("[Content_Types].xml");
    if (ctFile) {
      const ct = ctFile.asText();
      if (!/word\/numbering\.xml/.test(ct)) {
        const ovr = `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`;
        zip.file("[Content_Types].xml", ct.replace("</Types>", `${ovr}</Types>`));
      }
    }
  }
  return { bulletNumId, numberNumId };
}

/**
 * Replaces the document body with the restructured sections. Optionally anchors
 * a Word comment on the first paragraph of each section listing the changes
 * made there (the "annotated" export for whole-document restructures, where
 * tracked changes would be unreadable).
 */
export function rebuildDocxBody(
  originalBuffer: Buffer,
  sections: RestructuredSection[],
  opts: {
    author?: string;
    sectionComments?: Record<string, string>;
    /** The source's dominant body <w:pPr>, applied to regenerated paragraphs so
     *  they inherit the document's real spacing/alignment (see
     *  dominantBodyProps). Without it the rebuild emits bare paragraphs and the
     *  output reads nothing like the original. */
    bodyPPr?: string;
    /** The source's dominant body run <w:rPr> (font + size). Defaults to
     *  dominantBodyRunProps(originalBuffer) so regenerated text keeps the
     *  document's real typeface instead of the Word default. */
    bodyRPr?: string;
    /** Start each top-level section on a new page, restoring the pagination
     *  that rebuilding the body would otherwise flatten away. */
    pageBreakBeforeSections?: boolean;
  } = {},
): Buffer {
  const zip = new PizZip(originalBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Invalid DOCX: word/document.xml not found");
  const documentXml = docFile.asText();

  const bodyOpen = documentXml.match(/<w:body\b[^>]*>/);
  const bodyClose = documentXml.lastIndexOf("</w:body>");
  if (!bodyOpen || bodyClose < 0) throw new Error("Invalid DOCX: <w:body> not found");
  const bodyStart = documentXml.indexOf(bodyOpen[0]) + bodyOpen[0].length;
  const bodyInner = documentXml.slice(bodyStart, bodyClose);

  // Retain the FINAL sectPr — page size/margins + header/footer references —
  // which sits as the LAST direct child of <w:body>. Multi-section documents
  // also carry sectPr elements mid-body (inside a paragraph's pPr at each
  // section break), so anchor on the LAST occurrence, not the first: a greedy
  // first-match would drag a chunk of the old body along with it.
  const lastSectAt = bodyInner.lastIndexOf("<w:sectPr");
  const sectPr = lastSectAt >= 0
    ? bodyInner.slice(lastSectAt).match(/^<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0] ?? ""
    : "";

  const headingStyles = discoverHeadingStyles(zip);
  const author = (opts.author ?? "AI Document Workflow").slice(0, 60);
  const dateIso = new Date().toISOString();
  const commentEntries: string[] = [];
  const paraIds: string[] = [];
  let nextCommentId = 0;

  // Body run font (keeps the document's real typeface) + native list numbering
  // (only wired when the redraft actually has lists, so an all-prose document
  // isn't given a numbering part it never uses).
  const bodyRPr = opts.bodyRPr ?? dominantBodyRunProps(originalBuffer);
  const hasList = sections.some((s) => s.blocks.some((b) => b.type === "bullets" && b.items?.length));
  const { bulletNumId, numberNumId } = hasList ? ensureListNumbering(zip) : { bulletNumId: 0, numberNumId: 0 };
  const ctx: RebuildCtx = { bodyPPr: opts.bodyPPr ?? "", bodyRPr, bulletNumId, numberNumId };

  const parts: string[] = [];
  let emitted = 0;
  sections.forEach((s) => {
    // Skip sections with no content — e.g. a "TABLE OF CONTENTS" whose entries
    // were dropped — so the redraft doesn't carry an empty heading on a blank page.
    if (!s.blocks || s.blocks.length === 0) return;
    // Page-break between top-level sections (never before the first EMITTED one,
    // which would open the document on a blank page).
    if (opts.pageBreakBeforeSections && emitted > 0 && s.level === 1) {
      parts.push(pageBreakParagraph());
    }
    emitted++;
    let heading = headingParagraph(s.heading, s.level, headingStyles[s.level], bodyRPr);
    const note = opts.sectionComments?.[s.heading];
    if (note) {
      const commentId = nextCommentId++;
      const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
      paraIds.push(paraId);
      commentEntries.push(buildCommentEntry(commentId, note, author, dateIso, paraId));
      heading = wrapParagraphWithComment(heading, commentId);
    }
    parts.push(heading);
    for (const b of s.blocks) parts.push(blockToXml(b, ctx));
  });

  const newXml =
    documentXml.slice(0, bodyStart) + parts.join("") + sectPr + documentXml.slice(bodyClose);
  zip.file("word/document.xml", newXml);
  if (commentEntries.length > 0) attachComments(zip, commentEntries, paraIds);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// ════════════════════════════════════════════════════════════════════════════
// FROM-SCRATCH REDLINE DOCX
// Builds a clean, self-contained .docx (real Word tracked changes) from an
// amended-text redline string — used when there is NO source DOCX to preserve
// (e.g. the original was a PDF or plain text). The redline string uses four
// control-char markers to delimit deletions and insertions:
//   \x01 …deleted… \x02   and   \x03 …inserted… \x04
// Deletions become <w:del>/<w:delText> (red strikethrough in Word); insertions
// become <w:ins>/<w:t> (underlined). The result is a valid, editable Word
// document in Calibri 11 with 1" margins — presentable to a client, no HTML
// artefacts, no notice banners.
// ════════════════════════════════════════════════════════════════════════════

export function buildRedlineDocx(redline: string, opts: { author?: string } = {}): Buffer {
  const author = escapeXml((opts.author ?? "AI Document Workflow").slice(0, 60));
  const dateIso = new Date().toISOString();
  const D_O = String.fromCharCode(1), D_C = String.fromCharCode(2);
  const I_O = String.fromCharCode(3), I_C = String.fromCharCode(4);

  type Run = { mode: "text" | "del" | "ins"; text: string };
  const paragraphs: Run[][] = [];
  let cur: Run[] = [];
  let mode: "text" | "del" | "ins" = "text";
  let buf = "";
  const flush = () => { if (buf) { cur.push({ mode, text: buf }); buf = ""; } };
  for (const ch of redline) {
    if (ch === D_O) { flush(); mode = "del"; }
    else if (ch === D_C) { flush(); mode = "text"; }
    else if (ch === I_O) { flush(); mode = "ins"; }
    else if (ch === I_C) { flush(); mode = "text"; }
    else if (ch === "\n") { flush(); paragraphs.push(cur); cur = []; }
    else if (ch === "\r") { /* drop CR */ }
    else { buf += ch; }
  }
  flush();
  paragraphs.push(cur);

  let revId = 1;
  const pXml = paragraphs.map((runs) => {
    if (runs.length === 0) return "<w:p/>";
    const runsXml = runs.map((r) => {
      if (!r.text) return "";
      const t = escapeXml(r.text);
      if (r.mode === "del") {
        return `<w:del w:id="${revId++}" w:author="${author}" w:date="${dateIso}"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;
      }
      if (r.mode === "ins") {
        return `<w:ins w:id="${revId++}" w:author="${author}" w:date="${dateIso}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:ins>`;
      }
      return `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
    }).join("");
    return `<w:p>${runsXml}</w:p>`;
  }).join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;

  const zip = new PizZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/_rels/document.xml.rels", docRels);
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", styles);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
