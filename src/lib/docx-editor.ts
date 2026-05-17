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
