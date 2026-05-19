// Server-side helpers for the Google OAuth flow.
// Used by /auth/google/callback (code exchange) and the Settings server fns
// (auth URL generation, token refresh, connection lookup).

import { supabase } from "@/integrations/supabase/client";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "openid",
  "email",
];

/** Origin-aware redirect URI. Honors REDIRECT_URI override env first, else builds from request host. */
export function buildRedirectUri(host: string, protocolHint?: string): string {
  const override = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (override) return override;
  const isLocal = /^localhost|^127\./.test(host);
  const proto = protocolHint ?? (isLocal ? "http" : "https");
  return `${proto}://${host}/auth/google/callback`;
}

/** Build the consent URL the browser navigates to when the user clicks Connect. */
export function buildAuthUrl(opts: { workspace: string; redirectUri: string; state: string }): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID not set");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",         // we need a refresh_token
    prompt: "consent",              // force consent so we always get a refresh_token
    include_granted_scopes: "true",
    state: opts.state,              // workspace id + nonce, verified on callback
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
}

/** Exchange the authorization code for tokens. Called by the /auth/google/callback handler. */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Fetch the connected user's email + profile from Google. */
export async function fetchUserInfo(accessToken: string): Promise<{ email: string; name?: string }> {
  const r = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`User info fetch failed: ${r.status}`);
  const j = (await r.json()) as { email?: string; name?: string };
  if (!j.email) throw new Error("Google did not return an email");
  return { email: j.email, name: j.name };
}

/** Persist tokens + email against the workspace. Upserts (idempotent reconnect). */
export async function storeConnection(opts: {
  workspace: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scope: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + opts.expiresIn * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("workspace_google_connections")
    .upsert({
      workspace_id: opts.workspace,
      google_email: opts.email,
      refresh_token: opts.refreshToken,
      access_token: opts.accessToken,
      access_token_expires_at: expiresAt,
      scopes: opts.scope.split(" "),
    }, { onConflict: "workspace_id" });
  if (error) throw new Error(`Failed to store Google connection: ${error.message}`);
}

/** Refresh the access token using the stored refresh_token. Returns the new access token. */
export async function refreshAccessToken(workspaceId: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await (supabase as any)
    .from("workspace_google_connections")
    .select("refresh_token, access_token, access_token_expires_at")
    .eq("workspace_id", workspaceId)
    .single();
  if (error || !row) throw new Error(`No Google connection for workspace ${workspaceId}`);

  // If existing access token is still good for >2 minutes, reuse it.
  if (row.access_token && row.access_token_expires_at) {
    const expiresMs = new Date(row.access_token_expires_at).getTime();
    if (expiresMs - Date.now() > 120_000) return row.access_token as string;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const body = new URLSearchParams({
    refresh_token: row.refresh_token,
    client_id: clientId ?? "",
    client_secret: clientSecret ?? "",
    grant_type: "refresh_token",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Refresh failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as TokenResponse;
  const newExpires = new Date(Date.now() + j.expires_in * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("workspace_google_connections")
    .update({ access_token: j.access_token, access_token_expires_at: newExpires })
    .eq("workspace_id", workspaceId);
  return j.access_token;
}

/** Read-only lookup used by UI to show connection status. */
export async function getConnection(workspaceId: string): Promise<{
  connected: boolean;
  email?: string;
  driveFolderName?: string | null;
  driveFolderId?: string | null;
  connectedAt?: string;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (supabase as any)
    .from("workspace_google_connections")
    .select("google_email, drive_folder_id, drive_folder_name, connected_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!row) return { connected: false };
  return {
    connected: true,
    email: row.google_email,
    driveFolderName: row.drive_folder_name,
    driveFolderId: row.drive_folder_id,
    connectedAt: row.connected_at,
  };
}

/** Delete the workspace's Google connection. Idempotent. */
export async function deleteConnection(workspaceId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("workspace_google_connections")
    .delete()
    .eq("workspace_id", workspaceId);
}
