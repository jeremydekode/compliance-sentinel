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
    mimeType === "application/pdf" ||                            // PDF
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || // .docx
    mimeType === "application/msword"                            // .doc
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
    body.quotedFileContent = { value: opts.quotedText.slice(0, 1500) };
  }
  const r = await fetch(`${DRIVE_API}/files/${opts.fileId}/comments?fields=id,htmlContent&supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Drive comment create failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}
