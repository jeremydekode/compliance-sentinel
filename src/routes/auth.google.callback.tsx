// Google OAuth callback. URL: /auth/google/callback?code=...&state=...
// Google redirects the user here after consent. We hand the code to a server
// function which exchanges + stores the tokens, then bounce back to /settings.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { handleGoogleCallback } from "@/lib/compliance.functions";
import { setWorkspace, type WorkspaceId } from "@/lib/workspace";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/auth/google/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
    state: typeof search.state === "string" ? search.state : "",
    error: typeof search.error === "string" ? search.error : "",
  }),
  component: GoogleCallback,
  head: () => ({ meta: [{ title: "Connecting Google · Compliance Sentinel" }] }),
});

function GoogleCallback() {
  const { code, state, error } = Route.useSearch();
  const navigate = useNavigate();
  const callback = useServerFn(handleGoogleCallback);
  const [status, setStatus] = useState<"working" | "ok" | "err">("working");
  const [message, setMessage] = useState<string>("Finishing connection…");

  useEffect(() => {
    if (error) {
      setStatus("err");
      setMessage(`Google denied the connection: ${error}`);
      return;
    }
    if (!code || !state) {
      setStatus("err");
      setMessage("Missing code/state from Google — try Connect again from Settings.");
      return;
    }
    (async () => {
      try {
        const r = await callback({ data: { code, state, origin: window.location.origin } });
        // Switch to the workspace the user just connected so Settings shows the right state
        setWorkspace(r.workspace as WorkspaceId);
        setStatus("ok");
        setMessage(`Connected as ${r.email}`);
        setTimeout(() => navigate({ to: "/settings" }), 1200);
      } catch (e: any) {
        setStatus("err");
        setMessage(e?.message ?? "Connection failed");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6">
      <div className="max-w-md w-full rounded-2xl border bg-card p-8 text-center space-y-4">
        {status === "working" && (
          <>
            <Loader2 className="size-10 mx-auto animate-spin text-primary" />
            <h1 className="font-display text-xl font-semibold">Connecting Google Drive</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
          </>
        )}
        {status === "ok" && (
          <>
            <CheckCircle2 className="size-10 mx-auto text-emerald-600" />
            <h1 className="font-display text-xl font-semibold">Connected</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <p className="text-xs text-muted-foreground">Redirecting to Settings…</p>
          </>
        )}
        {status === "err" && (
          <>
            <AlertTriangle className="size-10 mx-auto text-amber-600" />
            <h1 className="font-display text-xl font-semibold">Connection failed</h1>
            <p className="text-sm text-muted-foreground break-words">{message}</p>
            <button
              onClick={() => navigate({ to: "/settings" })}
              className="mt-2 inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm hover:bg-muted"
            >
              Back to Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
