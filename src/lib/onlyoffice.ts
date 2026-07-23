// ============================================================================
// OnlyOffice integration (server-only). Signs the editor config so the Document
// Server trusts it, and mints/verifies a short token that pins the storage path
// a save-back callback is allowed to write — so the public callback can't be
// abused to overwrite an arbitrary object. HS256 is implemented with Node crypto
// (OnlyOffice's JWT algorithm) to avoid a dependency.
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function secret(): string {
  const s = process.env.ONLYOFFICE_JWT_SECRET;
  if (!s) throw new Error("Exact editor isn't configured (missing ONLYOFFICE_JWT_SECRET).");
  return s;
}

/** Sign an HS256 JWT the way OnlyOffice expects (header.payload.signature). */
export function signJwt(payload: Record<string, unknown>, expiresInSec = 60 * 60 * 8): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const data = `${head}.${b64urlJson(body)}`;
  const sig = b64url(createHmac("sha256", secret()).update(data).digest());
  return `${data}.${sig}`;
}

/** Verify an HS256 JWT (from OnlyOffice or minted by us). Returns payload or null. */
export function verifyJwt(token: string | undefined | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = b64url(createHmac("sha256", secret()).update(`${head}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Ask the Document Server to force-save an open document NOW (instead of the
 * lazy save it does seconds after the editor closes). Triggers the save-back
 * callback immediately. error 0 = save started; error 4 = nothing changed.
 */
export async function forceSave(key: string): Promise<{ ok: boolean; code?: number }> {
  const url = process.env.ONLYOFFICE_URL;
  if (!url) return { ok: false };
  const payload = { c: "forcesave", key };
  const token = signJwt(payload);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...payload, token }),
    });
    const j = (await resp.json().catch(() => ({}))) as { error?: number };
    return { ok: j?.error === 0 || j?.error === 4, code: j?.error };
  } catch {
    return { ok: false };
  }
}

export interface EditorConfigArgs {
  /** Unique per document VERSION — changing it forces OnlyOffice to reload. */
  key: string;
  title: string;
  /** Public/signed URL the Document Server downloads the docx from. */
  docUrl: string;
  /** Absolute URL OnlyOffice POSTs the edited doc back to (path-pinned token embedded). */
  callbackUrl: string;
  user: { id: string; name: string };
  mode?: "edit" | "view";
}

/**
 * Build the OnlyOffice editor config and its signature token. The returned
 * `{ config }` already carries `config.token`; the client passes the whole thing
 * to `new DocsAPI.DocEditor(...)`.
 */
export function buildEditorConfig(args: EditorConfigArgs) {
  const config: Record<string, unknown> = {
    documentType: "word",
    document: {
      fileType: "docx",
      key: args.key,
      title: args.title,
      url: args.docUrl,
      permissions: { edit: args.mode !== "view", download: true, print: true, review: true, comment: true },
    },
    editorConfig: {
      mode: args.mode ?? "edit",
      lang: "en",
      callbackUrl: args.callbackUrl,
      user: args.user,
      customization: { autosave: true, forcesave: true, compactHeader: false, toolbarNoTabs: false },
    },
  };
  config.token = signJwt(config as Record<string, unknown>);
  return { config };
}
