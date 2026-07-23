// ============================================================================
// Inject AI findings into a .docx as NATIVE Word comments + yellow highlights,
// server-side (OOXML). Deterministic — if the XML is valid, OnlyOffice/Word
// render the comments. Anchors at PARAGRAPH granularity (finds the first <w:p>
// whose text contains the finding's quote) so it never has to split runs and
// can't corrupt the document. Reuses the same paragraph/normalise approach as
// docx-editor.ts.
// ============================================================================

import PizZip from "pizzip";

export interface DocxComment {
  quote: string; // anchor text (a distinctive snippet of the flagged text)
  text: string;  // the comment body (severity, title, fix, …)
  author?: string;
}

/** Build comment items from audit findings (server-side mirror of the rail). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFindingComments(findings: any[]): DocxComment[] {
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((f) => f?.verification?.status !== "rejected")
    .map((f): DocxComment | null => {
      const quote = String(f?.evidence?.[0]?.quote ?? "").trim();
      if (!quote) return null;
      const anchor = quote.split("\n")[0].slice(0, 90).trim();
      if (anchor.length < 6) return null;
      const label = String(f?.severity ?? "info").toUpperCase();
      const parts = [`[${label}] ${f?.title ?? "Finding"}`];
      if (f?.description) parts.push(String(f.description));
      if (f?.suggestedFix) parts.push(`Suggested fix: ${String(f.suggestedFix)}`);
      return { quote: anchor, text: parts.join("\n\n") };
    })
    .filter((c): c is DocxComment => !!c);
}

function escapeXml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getParagraphText(pXml: string): string {
  const normalised = pXml
    .replace(/<w:tab\b[^>]*\/?>/g, " ")
    .replace(/<w:br\b[^>]*\/?>/g, "\n");
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalised)) !== null) out.push(m[1]);
  return out.join("")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function norm(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase();
}

/** Add a yellow highlight to every run in a paragraph (idempotent per run). */
function highlightRun(run: string): string {
  if (/<w:highlight\b/.test(run)) return run;
  if (/<w:rPr\b[^>]*\/>/.test(run)) return run.replace(/<w:rPr\b[^>]*\/>/, '<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
  if (/<w:rPr\b[^>]*>/.test(run)) return run.replace(/(<w:rPr\b[^>]*>)/, '$1<w:highlight w:val="yellow"/>');
  return run.replace(/(<w:r\b[^>]*>)/, '$1<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
}

/** Wrap a matched paragraph with comment range marks + a reference, and highlight it. */
function wrapParagraph(pXml: string, id: number): string {
  // Highlight existing runs first (before adding the reference run).
  let out = pXml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, highlightRun);
  const startMark = `<w:commentRangeStart w:id="${id}"/>`;
  if (/<\/w:pPr>/.test(out)) out = out.replace(/<\/w:pPr>/, `</w:pPr>${startMark}`);
  else out = out.replace(/(<w:p\b[^>]*>)/, `$1${startMark}`);
  const endMark =
    `<w:commentRangeEnd w:id="${id}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
  return out.replace(/<\/w:p>\s*$/, `${endMark}</w:p>`);
}

function commentBodyXml(id: number, author: string, text: string): string {
  const paras = text.split(/\n\n+/).map((para) => {
    const lines = para.split(/\n/);
    const runs = lines.map((line, i) =>
      `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>` + (i < lines.length - 1 ? "<w:r><w:br/></w:r>" : ""),
    ).join("");
    return `<w:p>${runs}</w:p>`;
  }).join("");
  return `<w:comment w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-01-01T00:00:00Z" w:initials="AI">${paras}</w:comment>`;
}

function patchContentTypes(zip: PizZip) {
  const f = zip.file("[Content_Types].xml");
  if (!f) return;
  let xml = f.asText();
  if (xml.includes("comments+xml")) return;
  const override = `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`;
  xml = xml.replace(/<\/Types>/, `${override}</Types>`);
  zip.file("[Content_Types].xml", xml);
}

function patchRels(zip: PizZip) {
  const f = zip.file("word/_rels/document.xml.rels");
  if (!f) return;
  let xml = f.asText();
  if (/Target="comments\.xml"/.test(xml)) return;
  const rel = `<Relationship Id="rIdAIComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`;
  xml = xml.replace(/<\/Relationships>/, `${rel}</Relationships>`);
  zip.file("word/_rels/document.xml.rels", xml);
}

export interface RedraftChange {
  findingId?: string;
  section?: string;
  summary?: string;
  before?: string;
  after?: string;
}

/** A red strikethrough paragraph showing removed text, with a comment attached. */
function removedParagraphXml(id: number, text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const runs = lines
    .map((line, i) => {
      const run = `<w:r><w:rPr><w:strike/><w:color w:val="C00000"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
      return i < lines.length - 1 ? `${run}<w:r><w:br/></w:r>` : run;
    })
    .join("");
  return (
    `<w:p><w:commentRangeStart w:id="${id}"/>${runs}<w:commentRangeEnd w:id="${id}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r></w:p>`
  );
}

/**
 * Annotates the GENERATED redraft for the final-output editor:
 *  - edits/additions → the changed paragraph gets a margin comment (+ highlight)
 *    anchored on the NEW text, with the rationale and the before-text;
 *  - removals (empty `after`) → a red strikethrough paragraph with the removed
 *    text is inserted under its section (or at the end), with a comment, so the
 *    reviewer SEES what was taken out and can delete the marker once satisfied.
 * Returns the buffer unchanged if there is nothing to annotate.
 */
export function annotateRedraftDocx(buffer: Buffer, changes: RedraftChange[]): { buffer: Buffer; annotated: number } {
  if (!changes?.length) return { buffer, annotated: 0 };
  let zip: PizZip;
  try { zip = new PizZip(buffer); } catch { return { buffer, annotated: 0 }; }
  const docFile = zip.file("word/document.xml");
  if (!docFile || zip.file("word/comments.xml")) return { buffer, annotated: 0 };

  let documentXml = docFile.asText();
  const entries: { id: number; text: string }[] = [];
  const used = new Set<string>();
  let id = 0;

  const findParagraph = (needle: string) => {
    const q = norm(needle);
    if (q.length < 6) return null;
    const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
    let mm: RegExpExecArray | null;
    while ((mm = pRegex.exec(documentXml)) !== null) {
      const pText = norm(getParagraphText(mm[0]));
      if (!pText || used.has(pText)) continue;
      if (pText.includes(q) || (q.length > 24 && q.includes(pText) && pText.length > 12)) {
        return { full: mm[0], start: mm.index, end: mm.index + mm[0].length, text: pText };
      }
    }
    return null;
  };

  for (const c of changes) {
    const before = String(c.before ?? "").trim();
    const after = String(c.after ?? "").trim();
    const summary = String(c.summary ?? "").trim() || "Change applied";
    const section = String(c.section ?? "").trim();

    if (after) {
      // Edited or added: anchor on the VERBATIM new text now present in the
      // redraft. `after` is often descriptive ("Changed X to \"…\"") — the
      // verbatim part is the quoted span. Same ladder as the edits view:
      // longest quoted span → text after last colon → leading slice → before.
      const candidates: string[] = [];
      const quoted = [...after.matchAll(/[‘“"']([^’”"']{12,})[’”"']/g)].map((m) => m[1].trim()).filter(Boolean);
      if (quoted.length) candidates.push(quoted.sort((a, b) => b.length - a.length)[0]);
      if (after.includes(":")) {
        const tail = after.slice(after.lastIndexOf(":") + 1).trim();
        if (tail.length >= 12) candidates.push(tail);
      }
      candidates.push(after.split("\n")[0].slice(0, 90).trim());
      const words = after.replace(/\s+/g, " ").split(" ");
      if (words.length > 8) candidates.push(words.slice(0, 8).join(" "));
      if (before) candidates.push(before.split("\n")[0].slice(0, 90).trim());
      let hit: ReturnType<typeof findParagraph> = null;
      for (const cand of candidates) {
        if (cand.length >= 12) { hit = findParagraph(cand.slice(0, 90)); if (hit) break; }
      }
      if (!hit) continue;
      const label = before ? "[EDITED]" : "[ADDED]";
      const parts = [`${label} ${summary}`];
      if (before) parts.push(`Before: ${before.slice(0, 400)}${before.length > 400 ? "…" : ""}`);
      const wrapped = wrapParagraph(hit.full, id);
      documentXml = documentXml.slice(0, hit.start) + wrapped + documentXml.slice(hit.end);
      used.add(hit.text);
      entries.push({ id, text: parts.join("\n\n") });
      id += 1;
    } else if (before) {
      // Removal: show the removed text struck through, under its section.
      const removedXml = removedParagraphXml(id, before.slice(0, 600));
      const anchor = section ? findParagraph(section) : null;
      if (anchor) {
        documentXml = documentXml.slice(0, anchor.end) + removedXml + documentXml.slice(anchor.end);
      } else {
        documentXml = documentXml.replace(/<\/w:body>/, `${removedXml}</w:body>`);
      }
      entries.push({ id, text: `[REMOVED] ${summary}${section ? `\n\nSection: ${section}` : ""}` });
      id += 1;
    }
  }

  if (!entries.length) return { buffer, annotated: 0 };

  zip.file("word/document.xml", documentXml);
  const commentsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    entries.map((e) => commentBodyXml(e.id, "Compliance AI", e.text)).join("") +
    `</w:comments>`;
  zip.file("word/comments.xml", commentsXml);
  patchContentTypes(zip);
  patchRels(zip);
  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, annotated: entries.length };
}

/**
 * Returns a new .docx buffer with the given findings injected as native comments
 * + highlights. If nothing anchors (or the doc already has comments), returns
 * the original buffer unchanged so the caller can fall back safely.
 */
export function injectCommentsIntoDocx(buffer: Buffer, comments: DocxComment[]): { buffer: Buffer; injected: number } {
  if (!comments?.length) return { buffer, injected: 0 };
  let zip: PizZip;
  try { zip = new PizZip(buffer); } catch { return { buffer, injected: 0 }; }
  const docFile = zip.file("word/document.xml");
  if (!docFile) return { buffer, injected: 0 };
  // Keep it simple/safe: only handle docs without pre-existing comments.
  if (zip.file("word/comments.xml")) return { buffer, injected: 0 };

  let documentXml = docFile.asText();
  const entries: { id: number; author: string; text: string }[] = [];
  const used = new Set<string>();
  let id = 0;

  for (const c of comments) {
    const q = norm(c.quote);
    if (q.length < 6) continue;
    const pRegex = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
    let hit: { full: string; start: number; end: number; text: string } | null = null;
    let mm: RegExpExecArray | null;
    while ((mm = pRegex.exec(documentXml)) !== null) {
      const pText = norm(getParagraphText(mm[0]));
      if (!pText || used.has(pText)) continue;
      if (pText.includes(q) || (q.length > 24 && q.includes(pText) && pText.length > 12)) {
        hit = { full: mm[0], start: mm.index, end: mm.index + mm[0].length, text: pText };
        break;
      }
    }
    if (!hit) continue;
    const wrapped = wrapParagraph(hit.full, id);
    documentXml = documentXml.slice(0, hit.start) + wrapped + documentXml.slice(hit.end);
    used.add(hit.text);
    entries.push({ id, author: c.author ?? "Compliance AI", text: c.text });
    id += 1;
  }

  if (!entries.length) return { buffer, injected: 0 };

  zip.file("word/document.xml", documentXml);
  const commentsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    entries.map((e) => commentBodyXml(e.id, e.author, e.text)).join("") +
    `</w:comments>`;
  zip.file("word/comments.xml", commentsXml);
  patchContentTypes(zip);
  patchRels(zip);

  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buffer: out, injected: entries.length };
}
