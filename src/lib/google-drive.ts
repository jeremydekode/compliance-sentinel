// Thin wrappers over Drive v3 + Docs v1 REST endpoints.
// Uses fetch directly to avoid pulling in the heavy googleapis package
// (which bloats serverless bundles).

import { refreshAccessToken } from "./google-oauth";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DOCS_API = "https://docs.googleapis.com/v1";

/** Folder/file URL or bare ID → folder/file ID. */
export function parseDriveId(input: string): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  // Already an ID
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  // Common Drive URL patterns
  const patterns = [
    /\/folders\/([A-Za-z0-9_-]+)/,
    /\/file\/d\/([A-Za-z0-9_-]+)/,
    /\/document\/d\/([A-Za-z0-9_-]+)/,
    /\bid=([A-Za-z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

/** Fetch a file (or folder) metadata. Used to validate folder ID + get folder name. */
export async function getFileMetadata(workspaceId: string, fileId: string): Promise<DriveFile> {
  const token = await refreshAccessToken(workspaceId);
  const r = await fetch(`${DRIVE_API}/files/${fileId}?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive getFile failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/** List all files in a folder (one page, capped at 200). Excludes subfolders. */
export async function listFolderFiles(workspaceId: string, folderId: string): Promise<DriveFile[]> {
  const token = await refreshAccessToken(workspaceId);
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(id,name,mimeType,modifiedTime,size)",
    pageSize: "200",
    orderBy: "name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const r = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive list failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { files?: DriveFile[] };
  return j.files ?? [];
}

/** Whether the app knows how to index this mime type. */
export function isIndexableMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/vnd.google-apps.document" ||      // Google Doc
    mimeType === "application/vnd.google-apps.spreadsheet" ||   // Google Sheets
    mimeType === "application/pdf" ||                            // PDF
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || // .docx
    mimeType === "application/msword" ||                         // .doc
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || // .xlsx
    mimeType === "application/vnd.ms-excel"                      // .xls
  );
}

/** Fetch bytes for a non-Google-Docs file. */
export async function downloadFile(workspaceId: string, fileId: string): Promise<Buffer> {
  const token = await refreshAccessToken(workspaceId);
  const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive download failed: ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/** Export a Google Doc as plain text (no formatting). */
export async function exportGoogleDocAsText(workspaceId: string, fileId: string): Promise<string> {
  const token = await refreshAccessToken(workspaceId);
  const r = await fetch(`${DRIVE_API}/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive export failed: ${r.status}`);
  return r.text();
}

/** Public viewer URL for any Drive file. */
export function driveViewerUrl(fileId: string, mimeType: string): string {
  if (mimeType === "application/vnd.google-apps.document") {
    return `https://docs.google.com/document/d/${fileId}/edit`;
  }
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * Post a comment on a Drive file. Works uniformly across Google Docs, PDFs,
 * and DOCX uploaded to Drive — anchoring fidelity differs by file type:
 *   - Google Doc: anchored to the quoted text range
 *   - PDF: anchored if the PDF has selectable text; otherwise file-level
 *   - DOCX / other: file-level with quoted-text snippet
 *
 * Returns the created comment's ID so the caller can record it.
 */
export async function createDriveComment(opts: {
  workspaceId: string;
  fileId: string;
  content: string;
  quotedText?: string;
}): Promise<{ id: string; htmlContent?: string }> {
  const token = await refreshAccessToken(opts.workspaceId);
  const body: Record<string, unknown> = { content: opts.content };
  if (opts.quotedText) {
    // Drive trims comment quotes to a few hundred chars; clip defensively.
    // Note: a Drive-side `anchor` matchedString format was tried here but
    // Google's Docs interpretation kept resolving it against an earlier
    // revision and surfacing "Original content deleted" — until that format is
    // pinned down, we ship file-level comments with the quoted snippet (same
    // behaviour as the regulatory workflow).
    body.quotedFileContent = { value: opts.quotedText.slice(0, 1500) };
  }
  const postComment = async (payload: Record<string, unknown>) => {
    const res = await fetch(`${DRIVE_API}/files/${opts.fileId}/comments?fields=id,htmlContent&supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res;
  };

  let r = await postComment(body);
  // Drive rejects quotedFileContent on non-Google-Doc files (PDFs, DOCX) with 400.
  // Retry without it so comments still land on binary Drive files.
  if (!r.ok && r.status === 400 && body.quotedFileContent) {
    const { quotedFileContent: _, ...bodyWithout } = body;
    r = await postComment(bodyWithout);
  }
  if (!r.ok) {
    throw new Error(`Drive comment create failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}

// Yellow highlight applied to text written into a Doc, so reviewers can see edits.
const DOC_HIGHLIGHT = { color: { rgbColor: { red: 1, green: 0.92, blue: 0.4 } } };
// Pale red background for content marked as removed/replaced — paired with
// strikethrough it gives a clear "this was deleted" track-changes signal.
const DOC_DELETED = { color: { rgbColor: { red: 1, green: 0.8, blue: 0.8 } } };

interface DocSeg { text: string; start: number }

/** Recursively collect text runs (with their Docs-API start index) from body content. */
function collectDocSegments(content: any[] | undefined, out: DocSeg[]): void {
  for (const el of content ?? []) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        const c = pe.textRun?.content;
        if (typeof c === "string" && typeof pe.startIndex === "number") {
          out.push({ text: c, start: pe.startIndex });
        }
      }
    }
    if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) collectDocSegments(cell.content, out);
      }
    }
  }
}

/**
 * Writes an edit into a Google Doc and highlights it yellow. Applies to EVERY
 * occurrence of the anchor text (a form is often referenced in several tables),
 * editing back-to-front so each occurrence's indices stay valid. Occurrences
 * whose anchor spans a table-cell boundary are skipped (those need a Comment).
 */
/**
 * Picks a doc index to insert an amendment at when find_text can't be located
 * (a bracket marker, or an anchor the AI hallucinated). Pulls clause-number
 * tokens out of the hint (e.g. "C.5.1.6", "8.2.4") and locates the most
 * specific one in the document; failing that tries the section name as plain
 * text; failing that falls back to the very end of the document. The caller
 * prefixes a newline, so the insert always lands on its own line and the
 * amendment is never silently lost.
 */
function resolveInsertAnchor(fullText: string, docIndexOf: number[], anchorHint: string): number {
  const lastIdx = docIndexOf.length > 0 ? docIndexOf[docIndexOf.length - 1] : 1;
  const hint = (anchorHint ?? "").trim();
  const atLineEnd = (at: number, probeLen: number): number => {
    let lineEnd = fullText.indexOf("\n", at + probeLen);
    if (lineEnd < 0) lineEnd = fullText.length - 1;
    return docIndexOf[Math.min(lineEnd, docIndexOf.length - 1)];
  };
  if (hint) {
    // Clause-number tokens are the most reliable locator. Try the most
    // specific (longest) first — "C.5.1.6" beats "C.5".
    const tokens = [
      ...(hint.match(/\b[A-Za-z]\.\d+(?:\.\d+)*\b/g) ?? []),
      ...(hint.match(/\b\d+(?:\.\d+)+\b/g) ?? []),
    ].sort((a, b) => b.length - a.length);
    for (const tok of tokens) {
      const at = fullText.indexOf(tok);
      if (at >= 0) return atLineEnd(at, tok.length);
    }
    // No clause number found — try the section name as plain text.
    const name = hint.replace(/[[\]·—|]/g, " ").replace(/\s+/g, " ").trim();
    if (name.length >= 6) {
      const at = fullText.indexOf(name);
      if (at >= 0) return atLineEnd(at, name.length);
    }
  }
  return lastIdx;
}

/** Common-prefix / common-suffix diff. Splits two strings into the shared
 *  parts at the start and end, and the differing "middles". Used to highlight
 *  only the actually-changed portion of an amendment instead of yellow-flooding
 *  an entire amended clause that mostly repeats the original. */
function diffSpans(orig: string, neu: string): {
  prefix: string;
  midOrig: string;
  midNew: string;
  suffix: string;
} {
  const minLen = Math.min(orig.length, neu.length);
  let p = 0;
  while (p < minLen && orig[p] === neu[p]) p++;
  let s = 0;
  while (
    s < orig.length - p &&
    s < neu.length - p &&
    orig[orig.length - 1 - s] === neu[neu.length - 1 - s]
  ) s++;
  return {
    prefix: orig.slice(0, p),
    midOrig: orig.slice(p, orig.length - s),
    midNew: neu.slice(p, neu.length - s),
    suffix: orig.slice(orig.length - s),
  };
}

export async function writeToGoogleDoc(opts: {
  workspaceId: string;
  fileId: string;
  findText: string;
  anchor: string;
  newText: string;
  mode: "insert" | "replace";
  /** Optional: when set on `mode: "replace"`, also inserts " (was: <originalText>)"
   *  in strike-through italic gray immediately after the new text. This gives a
   *  reliable in-document track-changes-style annotation showing what was
   *  displaced, without relying on Drive's flaky anchored-comments API. Ignored
   *  for `mode: "insert"` (nothing to strike). */
  originalText?: string;
}): Promise<{ highlighted: boolean; occurrences: number }> {
  const token = await refreshAccessToken(opts.workspaceId);

  const ft = (opts.findText ?? "").trim();
  const hasAnchor = !!ft && !ft.startsWith("[") && ft.length >= 6;

  // 1. Read the document
  const docResp = await fetch(`${DOCS_API}/documents/${opts.fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docResp.ok) throw new Error(`Docs read failed: ${docResp.status} ${await docResp.text()}`);
  const doc = await docResp.json();

  const segs: DocSeg[] = [];
  collectDocSegments(doc.body?.content, segs);
  if (segs.length === 0) throw new Error("Document has no editable text content.");

  // Flat text + a per-character map back to Docs-API indices
  let fullText = "";
  const docIndexOf: number[] = [];
  for (const s of segs) {
    for (let k = 0; k < s.text.length; k++) docIndexOf.push(s.start + k);
    fullText += s.text;
  }

  // 2. Locate the anchor — exact first, then whitespace-normalized fuzzy. If
  //    there is no anchor text, or it can't be found, `valid` stays empty and
  //    we fall back to a section-level insert (step 3) so nothing is lost.
  const valid: { fs: number; fe: number; docStart: number; docEnd: number }[] = [];
  if (hasAnchor) {
    const ranges: { fs: number; fe: number }[] = [];
    let idx = fullText.indexOf(ft);
    while (idx >= 0) {
      ranges.push({ fs: idx, fe: idx + ft.length });
      idx = fullText.indexOf(ft, idx + ft.length);
    }
    if (ranges.length === 0) {
      let norm = "";
      const normToRaw: number[] = [];
      let prevSpace = false;
      for (let i = 0; i < fullText.length; i++) {
        const ch = fullText[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
          if (!prevSpace) { norm += " "; normToRaw.push(i); }
          prevSpace = true;
        } else {
          norm += ch; normToRaw.push(i); prevSpace = false;
        }
      }
      const nFt = ft.replace(/\s+/g, " ").trim();
      if (nFt.length >= 6) {
        let nat = norm.indexOf(nFt);
        while (nat >= 0) {
          ranges.push({
            fs: normToRaw[nat],
            fe: normToRaw[Math.min(normToRaw.length - 1, nat + nFt.length - 1)] + 1,
          });
          nat = norm.indexOf(nFt, nat + nFt.length);
        }
      }
    }
    // Keep only occurrences that stay within a single table cell. Within a cell
    // the document indices are contiguous (+1 per char); a jump = a cell boundary.
    for (const { fs, fe } of ranges) {
      let crossesCell = false;
      for (let i = fs; i < fe - 1; i++) {
        if (docIndexOf[i + 1] - docIndexOf[i] !== 1) { crossesCell = true; break; }
      }
      if (!crossesCell) valid.push({ fs, fe, docStart: docIndexOf[fs], docEnd: docIndexOf[fe - 1] + 1 });
    }
  }

  // 3. Build the edits. When the anchor was found, "insert" appends at the END
  //    of its paragraph and "replace" swaps it in place. When there is no
  //    usable anchor, fall back to ONE section-level insert (at the section
  //    heading named by `anchor`, else end of document) so the amendment is
  //    always visible and highlighted. Process HIGH→LOW so indices stay valid.
  const edits: { at: number; requests: any[] }[] = [];
  if (valid.length === 0) {
    const insAt = resolveInsertAnchor(fullText, docIndexOf, `${opts.anchor ?? ""} ${opts.findText ?? ""}`);
    const insText = `\n${opts.newText}`;
    edits.push({
      at: insAt,
      requests: [
        { insertText: { location: { index: insAt }, text: insText } },
        {
          updateTextStyle: {
            range: { startIndex: insAt + 1, endIndex: insAt + insText.length },
            textStyle: { backgroundColor: DOC_HIGHLIGHT },
            fields: "backgroundColor",
          },
        },
      ],
    });
  }
  for (const v of valid) {
    if (opts.mode === "replace") {
      // Diff-aware track-changes replace: midOrig STAYS in place, marked red
      // + strikethrough (the "was deleted" cue); midNew is inserted right
      // after, highlighted yellow. For preserve-and-append amendments midOrig
      // is empty so no red styling is applied — just the yellow addition.
      const orig = ft;
      const { prefix, midOrig, midNew, suffix } = diffSpans(orig, opts.newText);
      const midStart = v.docStart + prefix.length;
      const midEnd = v.docEnd - suffix.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reqs: any[] = [];
      // Mark the original middle as deleted (in place — not removed).
      if (midOrig.length > 0) {
        reqs.push({
          updateTextStyle: {
            range: { startIndex: midStart, endIndex: midEnd },
            textStyle: { backgroundColor: DOC_DELETED, strikethrough: true },
            fields: "backgroundColor,strikethrough",
          },
        });
      }
      // Insert the new middle immediately after midOrig (or at midStart if there
      // was no midOrig), highlighted yellow.
      if (midNew.length > 0) {
        const insertAt = midEnd; // right after midOrig (or at midStart when midOrig is empty)
        reqs.push(
          { insertText: { location: { index: insertAt }, text: midNew } },
          {
            updateTextStyle: {
              range: { startIndex: insertAt, endIndex: insertAt + midNew.length },
              textStyle: { backgroundColor: DOC_HIGHLIGHT, strikethrough: false },
              fields: "backgroundColor,strikethrough",
            },
          },
        );
      }
      // If the diff produced no edits (orig === newText), don't emit a no-op.
      if (reqs.length > 0) edits.push({ at: midStart, requests: reqs });
    } else {
      // End of the anchor's paragraph = the next "\n" at/after the match end.
      let paraEnd = fullText.indexOf("\n", v.fe);
      if (paraEnd < 0) paraEnd = fullText.length - 1;
      const insAt = docIndexOf[Math.min(paraEnd, docIndexOf.length - 1)];
      const insText = `\n${opts.newText}`;
      edits.push({
        at: insAt,
        requests: [
          { insertText: { location: { index: insAt }, text: insText } },
          {
            updateTextStyle: {
              range: { startIndex: insAt + 1, endIndex: insAt + insText.length },
              textStyle: { backgroundColor: DOC_HIGHLIGHT },
              fields: "backgroundColor",
            },
          },
        ],
      });
    }
  }
  edits.sort((a, b) => b.at - a.at);
  const requests: any[] = edits.flatMap((e) => e.requests);

  const upd = await fetch(`${DOCS_API}/documents/${opts.fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!upd.ok) throw new Error(`Docs edit failed: ${upd.status} ${await upd.text()}`);

  return { highlighted: true, occurrences: valid.length || 1 };
}

/** Copies a Drive file (into the same folder as the original) and returns the new file's id + Doc URL.
 *  Set `opts.convertToGoogleDoc` to TRUE to convert a DOCX source into a native Google Doc on copy
 *  — required for anchored comments to work on the copy. */
export async function copyDriveFile(
  workspaceId: string, fileId: string, newName: string,
  opts: { convertToGoogleDoc?: boolean } = {},
): Promise<{ id: string; url: string }> {
  const token = await refreshAccessToken(workspaceId);
  // Place the copy alongside the original so it's easy to find.
  let parents: string[] | undefined;
  try {
    const m = await fetch(`${DRIVE_API}/files/${fileId}?fields=parents&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (m.ok) {
      const j = (await m.json()) as { parents?: string[] };
      if (Array.isArray(j.parents) && j.parents.length) parents = j.parents;
    }
  } catch { /* fall back to default location */ }

  const body: Record<string, unknown> = { name: newName };
  if (parents) body.parents = parents;
  if (opts.convertToGoogleDoc) body.mimeType = "application/vnd.google-apps.document";
  const r = await fetch(`${DRIVE_API}/files/${fileId}/copy?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Drive copy failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { id: string };
  return { id: j.id, url: `https://docs.google.com/document/d/${j.id}/edit` };
}

/**
 * Applies MANY impacts to a Google Doc in one read + one batchUpdate — used to
 * build an amended draft copy. Each impact is located independently; all edits
 * are sorted high→low so their indices stay valid through the batch. An impact
 * whose anchor can't be found (or spans table cells) is NOT skipped — its text
 * is inserted at the section heading named by `anchor`, else at end of doc, so
 * no approved amendment is ever silently lost.
 */
export async function applyImpactsToGoogleDoc(
  workspaceId: string,
  fileId: string,
  impacts: { findText: string; newText: string; mode: "insert" | "replace"; anchor?: string; originalText?: string }[],
  opts: { renderMode?: "clean" | "trackChanges" } = {},
): Promise<{ applied: number; total: number }> {
  // renderMode controls how a replace lands in the doc:
  //  - "trackChanges" (default): the original middle STAYS in place styled red +
  //    strike-through; the new middle is inserted right after it, highlighted
  //    yellow. Reads like a Word track-changes review copy.
  //  - "clean": the original middle is DELETED and the new middle inserted in
  //    its place, highlighted yellow. Reads like a finalised replacement.
  const renderMode: "clean" | "trackChanges" = opts.renderMode ?? "trackChanges";
  const token = await refreshAccessToken(workspaceId);
  const docResp = await fetch(`${DOCS_API}/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docResp.ok) throw new Error(`Docs read failed: ${docResp.status} ${await docResp.text()}`);
  const doc = await docResp.json();

  const segs: DocSeg[] = [];
  collectDocSegments(doc.body?.content, segs);
  let fullText = "";
  const docIndexOf: number[] = [];
  for (const s of segs) {
    for (let k = 0; k < s.text.length; k++) docIndexOf.push(s.start + k);
    fullText += s.text;
  }
  // Whitespace-normalized index map (built once, reused for every impact)
  let norm = "";
  const normToRaw: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (!prevSpace) { norm += " "; normToRaw.push(i); }
      prevSpace = true;
    } else {
      norm += ch; normToRaw.push(i); prevSpace = false;
    }
  }

  // Consolidate impacts that target the SAME `findText` in replace mode. Without
  // this, N amendments to one original clause produce N redundant "(was: …)"
  // annotations and the batch's sequential indices cascade unpredictably — the
  // user would see the original repeated N times in strike-through. We merge
  // them into a single replacement that joins all the amendments and keeps a
  // single "(was: original)" annotation.
  const consolidated: typeof impacts = [];
  const replaceByFind = new Map<string, typeof impacts>();
  for (const imp of impacts) {
    const ft = (imp.findText ?? "").trim();
    if (imp.mode === "replace" && ft) {
      if (!replaceByFind.has(ft)) replaceByFind.set(ft, []);
      replaceByFind.get(ft)!.push(imp);
    } else {
      consolidated.push(imp);
    }
  }
  for (const [ft, imps] of replaceByFind.entries()) {
    if (imps.length === 1) {
      consolidated.push(imps[0]);
    } else {
      // Merge by diff: each impact's new_text usually starts with the original
      // wording (the AI's "preserve and append" style) — joining full new_texts
      // would repeat that original N times. Instead, take each impact's diff
      // against the original, keep ONE copy of the shared prefix/suffix, and
      // concatenate just the genuinely-new middles.
      const diffs = imps.map((i) => diffSpans(ft, (i.newText ?? "").trim()));
      const prefix = diffs[0].prefix;
      const suffix = diffs[0].suffix;
      const midOrig = diffs[0].midOrig; // any impact's midOrig; usually all empty
      const midsNew = diffs.map((d) => d.midNew.trim()).filter(Boolean).join("\n\n");
      const mergedNew = prefix + (midOrig.length > 0 ? "" : "") + midsNew + suffix;
      consolidated.push({
        findText: ft,
        newText: mergedNew,
        mode: "replace",
        anchor: imps[0].anchor,
        originalText: imps[0].originalText,
      });
    }
  }

  const edits: { at: number; requests: any[] }[] = [];
  let applied = 0;
  for (const imp of consolidated) {
    const ft = (imp.findText ?? "").trim();
    const newText = (imp.newText ?? "").trim();
    if (!newText) continue;
    const hasAnchor = !!ft && !ft.startsWith("[") && ft.length >= 6;

    const ranges: { fs: number; fe: number }[] = [];
    if (hasAnchor) {
      let idx = fullText.indexOf(ft);
      while (idx >= 0) { ranges.push({ fs: idx, fe: idx + ft.length }); idx = fullText.indexOf(ft, idx + ft.length); }
      if (ranges.length === 0) {
        const nFt = ft.replace(/\s+/g, " ").trim();
        if (nFt.length >= 6) {
          let nat = norm.indexOf(nFt);
          while (nat >= 0) {
            ranges.push({
              fs: normToRaw[nat],
              fe: normToRaw[Math.min(normToRaw.length - 1, nat + nFt.length - 1)] + 1,
            });
            nat = norm.indexOf(nFt, nat + nFt.length);
          }
        }
      }
    }
    let producedEdit = false;
    for (const { fs, fe } of ranges) {
      let crosses = false;
      for (let i = fs; i < fe - 1; i++) {
        if (docIndexOf[i + 1] - docIndexOf[i] !== 1) { crosses = true; break; }
      }
      if (crosses) continue;
      const docStart = docIndexOf[fs];
      const docEnd = docIndexOf[fe - 1] + 1;
      if (imp.mode === "replace") {
        const orig = ft;
        const { prefix, midOrig, midNew, suffix } = diffSpans(orig, newText);
        const midStart = docStart + prefix.length;
        const midEnd = docEnd - suffix.length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reqs: any[] = [];
        if (renderMode === "clean") {
          // Clean mode: delete the old middle, insert the new middle highlighted.
          if (midOrig.length > 0) {
            reqs.push({
              deleteContentRange: { range: { startIndex: midStart, endIndex: midEnd } },
            });
          }
          if (midNew.length > 0) {
            reqs.push(
              { insertText: { location: { index: midStart }, text: midNew } },
              {
                updateTextStyle: {
                  range: { startIndex: midStart, endIndex: midStart + midNew.length },
                  textStyle: { backgroundColor: DOC_HIGHLIGHT, strikethrough: false },
                  fields: "backgroundColor,strikethrough",
                },
              },
            );
          }
        } else {
          // Track-changes mode (default): keep midOrig in place red + strikethrough,
          // append midNew right after it, highlighted yellow.
          if (midOrig.length > 0) {
            reqs.push({
              updateTextStyle: {
                range: { startIndex: midStart, endIndex: midEnd },
                textStyle: { backgroundColor: DOC_DELETED, strikethrough: true },
                fields: "backgroundColor,strikethrough",
              },
            });
          }
          if (midNew.length > 0) {
            const insertAt = midEnd;
            reqs.push(
              { insertText: { location: { index: insertAt }, text: midNew } },
              {
                updateTextStyle: {
                  range: { startIndex: insertAt, endIndex: insertAt + midNew.length },
                  textStyle: { backgroundColor: DOC_HIGHLIGHT, strikethrough: false },
                  fields: "backgroundColor,strikethrough",
                },
              },
            );
          }
        }
        if (reqs.length > 0) edits.push({ at: midStart, requests: reqs });
      } else {
        let paraEnd = fullText.indexOf("\n", fe);
        if (paraEnd < 0) paraEnd = fullText.length - 1;
        const insAt = docIndexOf[Math.min(paraEnd, docIndexOf.length - 1)];
        const insText = `\n${newText}`;
        edits.push({ at: insAt, requests: [
          { insertText: { location: { index: insAt }, text: insText } },
          { updateTextStyle: {
              range: { startIndex: insAt + 1, endIndex: insAt + insText.length },
              textStyle: { backgroundColor: DOC_HIGHLIGHT }, fields: "backgroundColor" } },
        ]});
      }
      producedEdit = true;
    }
    if (!producedEdit) {
      // No usable anchor — insert at the section heading (or end of doc) so the
      // approved amendment is still applied and visible, highlighted.
      const insAt = resolveInsertAnchor(fullText, docIndexOf, `${imp.anchor ?? ""} ${imp.findText ?? ""}`);
      const insText = `\n${newText}`;
      edits.push({ at: insAt, requests: [
        { insertText: { location: { index: insAt }, text: insText } },
        { updateTextStyle: {
            range: { startIndex: insAt + 1, endIndex: insAt + insText.length },
            textStyle: { backgroundColor: DOC_HIGHLIGHT }, fields: "backgroundColor" } },
      ]});
    }
    applied++;
  }

  if (edits.length > 0) {
    edits.sort((a, b) => b.at - a.at);
    const upd = await fetch(`${DOCS_API}/documents/${fileId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: edits.flatMap((e) => e.requests) }),
    });
    if (!upd.ok) throw new Error(`Docs edit failed: ${upd.status} ${await upd.text()}`);
  }
  // Report against the ORIGINAL impact count so the caller's stats are accurate
  // even when several impacts were merged into one consolidated replacement.
  return { applied, total: impacts.length };
}
