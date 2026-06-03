import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  // redirect is optional, so links to /login don't need to pass a search param.
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
});

function LoginPage() {
  const search = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Already signed in? Bounce to the intended destination. Client-only — the
  // session lives in localStorage, which does not exist during SSR. A full
  // replace() keeps the redirect path untyped-safe and rehydrates cleanly.
  useEffect(() => {
    if (!mounted) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.replace(search.redirect ?? "/");
    });
  }, [mounted]);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      if (search.redirect) {
        window.sessionStorage.setItem("post_login_redirect", search.redirect);
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) {
        setError(error.message);
        setBusy(false);
      }
      // On success the browser is redirected to Google, then back to /auth/callback.
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card shadow-sm p-8 text-center">
        <div className="size-12 mx-auto rounded-xl bg-gradient-to-br from-primary/30 to-primary/10 grid place-items-center ring-1 ring-primary/20">
          <ShieldCheck className="size-6 text-primary" />
        </div>
        <h1 className="font-display text-lg font-bold mt-4">AI Document Workflow</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Sign in to continue.
        </p>

        <button
          onClick={signIn}
          disabled={busy}
          className="mt-6 w-full flex items-center justify-center gap-3 rounded-xl border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-muted/40 disabled:opacity-60"
        >
          <GoogleGlyph />
          {busy ? "Redirecting…" : "Sign in with Google"}
        </button>

        {error && (
          <p className="mt-4 text-xs text-destructive">{error}</p>
        )}

        <p className="mt-6 text-[11px] text-muted-foreground/70 leading-relaxed">
          Access is restricted. If you believe you should have access, contact your
          platform administrator.
        </p>
      </div>
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg className="size-4" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.2-3.9 6.6-9.6 6.6-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.2-5.6c-2 1.4-4.6 2.2-8.3 2.2-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
