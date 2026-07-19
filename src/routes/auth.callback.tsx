import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ShieldCheck, Loader2, AlertTriangle } from "lucide-react";

// Supabase Auth redirect target. DISTINCT from the Google Drive OAuth callback
// (/auth/google/callback), which belongs to the separate Drive integration.
export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
});

function AuthCallback() {
  const [status, setStatus] = useState<"working" | "error">("working");
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // supabase-js (detectSessionInUrl) auto-exchanges the code/hash on load
        // and persists the session. Read it back to confirm.
        let { data } = await supabase.auth.getSession();
        if (!data.session) {
          // PKCE explicit-exchange fallback.
          const { error: exErr } = await supabase.auth.exchangeCodeForSession(
            window.location.href,
          );
          if (exErr) throw exErr;
          ({ data } = await supabase.auth.getSession());
        }
        if (cancelled) return;
        if (!data.session) throw new Error("No session was established.");

        const dest = window.sessionStorage.getItem("post_login_redirect") || "/";
        window.sessionStorage.removeItem("post_login_redirect");
        window.location.replace(dest);
      } catch (e: any) {
        if (cancelled) return;
        setStatus("error");
        setMsg(e?.message ?? "Sign-in failed.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card shadow-sm p-8 text-center">
        <div className="size-12 mx-auto rounded-xl bg-gradient-to-br from-primary/30 to-primary/10 grid place-items-center ring-1 ring-primary/20">
          <ShieldCheck className="size-6 text-primary" />
        </div>
        {status === "working" ? (
          <>
            <Loader2 className="size-5 mx-auto mt-5 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground mt-3">{msg}</p>
          </>
        ) : (
          <>
            <AlertTriangle className="size-5 mx-auto mt-5 text-destructive" />
            <p className="text-sm font-medium mt-3">Sign-in failed</p>
            <p className="text-xs text-muted-foreground mt-1">{msg}</p>
            <Link
              to="/login"
              className="mt-5 inline-block rounded-xl border px-4 py-2 text-sm font-medium hover:bg-muted/40"
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
