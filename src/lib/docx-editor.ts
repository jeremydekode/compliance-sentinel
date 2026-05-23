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
  const out: string[] = [];
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml)) !== null) {
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
    const pRegex = /<w:p\b[\s\S]*?<\/w:p>/g;
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
  const pRegex = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(xml)) !== null) {
    const text = getParagraphText(m[0]);
    if (text) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
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
  opts: { author?: string } = {},
): SimplifyDocxResult {
  const zip = new PizZip(sourceBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Invalid DOCX: word/document.xml not found");
  let documentXml = docFile.asText();

  const author = (opts.author ?? "AI Document Workflow").slice(0, 60);
  const dateIso = new Date().toISOString();
  const commentEntries: string[] = [];
  const paraIds: string[] = []; // one per comment — links commentsExtended.xml back

  let nextCommentId = 0;
  let appliedCount = 0;
  const skipped: { reason: string; before: string }[] = [];

  for (const edit of edits) {
    const before = (edit.before ?? "").trim();
    if (!before) {
      skipped.push({ reason: "empty before", before: "" });
      continue;
    }

    // Find the first <w:p> whose text contains `before` (tolerantly).
    const pRegex = /<w:p\b[\s\S]*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = pRegex.exec(documentXml)) !== null) {
      const paraText = getParagraphText(m[0]);
      if (!paraText) continue;
      const amended = tolerantReplace(paraText, before, edit.after ?? "");
      if (amended === null) continue;

      const commentId = nextCommentId++;
      // 8-char hex paraId — unique per comment, matches what commentsExtended uses.
      const paraId = (commentId + 1).toString(16).padStart(8, "0").toUpperCase();
      paraIds.push(paraId);
      const newPara = buildHighlightedParaWithComment(amended, commentId);
      const commentContent = edit.rationale
        ? `Before: ${before}\n\n${edit.rationale}`
        : `Before: ${before}`;
      commentEntries.push(buildCommentEntry(commentId, commentContent, author, dateIso, paraId));

      documentXml =
        documentXml.slice(0, m.index) + newPara + documentXml.slice(m.index + m[0].length);
      appliedCount++;
      matched = true;
      break; // next edit re-walks from the start (indices shifted)
    }
    if (!matched) skipped.push({ reason: "before not located in any paragraph", before });
  }

  zip.file("word/document.xml", documentXml);
  attachComments(zip, commentEntries, paraIds);

  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, appliedCount, skipped };
}
