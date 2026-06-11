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
  /** COMMENT-ONLY edit: no text change — attach `comment` to the paragraph whose
   *  drawing references `anchorRelId` (figures/charts can't be redlined). */
  commentOnly?: boolean;
  anchorRelId?: string;
  comment?: string;
};

export type SimplifyDocxResult = {
  buffer: Buffer;
  appliedCount: number;
  skipped: { reason: string; before: string }[];
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
export function applySimplificationToDocx(
  sourceBuffer: Buffer,
  edits: SimplifyDocxEdit[],
  opts: { author?: string; mode?: "redline" | "highlight" } = {},
): SimplifyDocxResult {
  const zip = new PizZip(sourceBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Invalid DOCX: word/document.xml not found");
  let documentXml = docFile.asText();

  // "redline" = Word tracked changes (red strikethrough deletions + insertions,
  // Accept/Reject-able). "highlight" = yellow highlight + a Word comment.
  const mode = opts.mode ?? "redline";
  const author = (opts.author ?? "AI Document Workflow").slice(0, 60);
  const dateIso = new Date().toISOString();
  const commentEntries: string[] = [];
  const paraIds: string[] = []; // one per comment — links commentsExtended.xml back

  let nextCommentId = 0;
  let nextRevId = 1000; // <w:ins>/<w:del> revision ids (kept clear of any in the source)
  let appliedCount = 0;
  const skipped: { reason: string; before: string }[] = [];

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

      let newPara: string;
      if (mode === "redline") {
        const loc = tolerantLocate(paraText, before);
        if (!loc) continue;
        newPara = buildRedlineParagraph(
          m[0], paraText, loc, edit.after ?? "", nextRevId++, nextRevId++, author, dateIso,
        );
      } else {
        const amended = tolerantReplace(paraText, before, edit.after ?? "");
        if (amended === null) continue;
        const commentId = nextCommentId++;
        // 8-char hex paraId — unique per comment, matches what commentsExtended uses.
        const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
        paraIds.push(paraId);
        newPara = buildHighlightedParaWithComment(amended, commentId);
        const commentContent = edit.rationale
          ? `Before: ${before}\n\n${edit.rationale}`
          : `Before: ${before}`;
        commentEntries.push(buildCommentEntry(commentId, commentContent, author, dateIso, paraId));
      }

      documentXml =
        documentXml.slice(0, m.index) + newPara + documentXml.slice(m.index + m[0].length);
      appliedCount++;
      matched = true;
      break; // next edit re-walks from the start (indices shifted)
    }
    if (!matched) skipped.push({ reason: "before not located in any paragraph", before });
  }

  zip.file("word/document.xml", documentXml);
  if (commentEntries.length > 0) attachComments(zip, commentEntries, paraIds);

  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, appliedCount, skipped };
}
