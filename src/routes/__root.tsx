import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { useAuth, signOut } from "@/lib/auth";

import appCss from "../styles.css?url";

// Paths that an unauthenticated user is allowed to sit on (the login screen and
// the OAuth return URLs). Everything else triggers a redirect to /login.
const PUBLIC_PATHS = new Set(["/login", "/auth/callback", "/auth/google/callback"]);

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Compliance Gap Analysis · AI Workflow" },
      { name: "description", content: "Automated regulatory compliance gap analysis and SOP impact mapping." },
      { property: "og:title", content: "Compliance Gap Analysis · AI Workflow" },
      { property: "og:description", content: "Automated regulatory compliance gap analysis and SOP impact mapping." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Compliance Gap Analysis · AI Workflow" },
      { name: "twitter:description", content: "Automated regulatory compliance gap analysis and SOP impact mapping." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/220183b2-8158-435f-bfa0-38369802a8bd/id-preview-8fb55664--1dd572ce-0d1b-48f4-9751-2b5efcf8e7e0.lovable.app-1778841564016.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/220183b2-8158-435f-bfa0-38369802a8bd/id-preview-8fb55664--1dd572ce-0d1b-48f4-9751-2b5efcf8e7e0.lovable.app-1778841564016.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230EA5E9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/></svg>" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <LoginGate />
      <ApprovalGate>
        <Outlet />
      </ApprovalGate>
      <Toaster richColors position="bottom-right" />
    </QueryClientProvider>
  );
}

/**
 * Approval gate. A user can authenticate with any Google account, but only
 * approved accounts (super_admin, member, or an email in login_allowlist) may
 * USE the app. For a signed-in-but-unapproved account we render a clear
 * "pending access" screen instead of the app shell (which would otherwise show
 * an empty, broken-looking UI because RLS returns zero rows).
 *
 * Gated on `mounted && !loading` and an EXPLICIT `approved === false`, so the
 * SSR/first-paint (which assumes approved) never flashes this, and we never
 * block before the check resolves. Fails open if is_approved() isn't deployed.
 */
function ApprovalGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (mounted && !auth.loading && auth.userId && auth.approved === false) {
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    if (!PUBLIC_PATHS.has(path)) return <NotApproved email={auth.email} />;
  }
  return <>{children}</>;
}

function NotApproved({ email }: { email: string | null }) {
  async function handleSignOut() {
    await signOut();
    window.location.replace("/login");
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card shadow-sm p-8 text-center">
        <div className="size-12 mx-auto rounded-xl bg-amber-100 grid place-items-center ring-1 ring-amber-200">
          <ShieldAlert className="size-6 text-amber-600" />
        </div>
        <h1 className="font-display text-lg font-bold mt-4">Access pending</h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          You're signed in{email ? <> as <span className="font-medium text-foreground">{email}</span></> : null}, but
          this account hasn't been granted access yet.
        </p>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Ask the platform administrator to approve your email, then sign in again.
        </p>
        <button
          onClick={handleSignOut}
          className="mt-6 w-full rounded-xl border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * Client-only login gate.
 *
 * Renders nothing — it just watches the resolved auth state and bounces an
 * unauthenticated visitor to /login. The gating is deliberately NOT done in a
 * server-running beforeLoad: the Supabase session lives in the browser, so on
 * the server `auth.userId` is always null and a server-side guard would redirect
 * every first paint. We also wait for `mounted` so SSR HTML is unchanged and the
 * first client paint matches it (no hydration mismatch), and for `!auth.loading`
 * so we don't redirect before the session has actually resolved.
 */
function LoginGate() {
  const auth = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || auth.loading || auth.userId) return;
    const path = window.location.pathname;
    if (PUBLIC_PATHS.has(path)) return;
    window.location.replace(
      "/login?redirect=" + encodeURIComponent(window.location.pathname + window.location.search),
    );
  }, [mounted, auth.loading, auth.userId]);

  return null;
}
