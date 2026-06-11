import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// ----------------------------------------------------------------------------
// LITE RBAC client store.
//
// Source of truth = the public.profiles row for the signed-in auth user. The
// role is NEVER read from localStorage (that was the old demo persona switcher
// in src/lib/role.ts, which is now a cosmetic job-function tag only). The role
// here gates UI; server-side enforcement lives in RLS + server functions.
//
// Hydration-safety: this mirrors src/lib/workspace.ts exactly — a module
// singleton + listener set, and consumers use the mounted-gate pattern so the
// server render (always "unauthenticated / viewer") matches the client's first
// paint, avoiding the React 19 hydration mismatch the app warns about.
// ----------------------------------------------------------------------------

export type AppRole = "super_admin" | "member" | "viewer";

export interface AuthState {
  loading: boolean;        // true until the first session+profile resolve on the client
  userId: string | null;
  email: string | null;
  role: AppRole;           // defaults to least privilege ("viewer")
  workspaceId: string | null;
  jobFunction: string | null; // non-security tag (compliance/legal); UI labels only
  approved: boolean;       // is this account on the login allowlist (or member/super)?
}

// Server-default / pre-auth state. MUST be the value the SSR render assumes so
// first client paint matches it. `approved` defaults true so we never flash the
// "pending access" screen before the check resolves (we only ever act on an
// EXPLICIT false, and only once loading === false).
const DEFAULT_STATE: AuthState = {
  loading: true,
  userId: null,
  email: null,
  role: "viewer",
  workspaceId: null,
  jobFunction: null,
  approved: true,
};

const listeners = new Set<(s: AuthState) => void>();
let current: AuthState = { ...DEFAULT_STATE };

function emit() {
  for (const l of listeners) l(current);
}

function setState(patch: Partial<AuthState>) {
  current = { ...current, ...patch };
  emit();
}

export function getAuth(): AuthState {
  return current;
}

export function isSuperAdmin(): boolean {
  return current.role === "super_admin";
}

// Convenience predicates used by UI guards.
export function canManage(): boolean {
  // members + super_admins can perform write/workflow actions; viewers cannot.
  return current.role === "super_admin" || current.role === "member";
}

async function loadProfile(userId: string, email: string | null) {
  // RLS lets a user read their own profile row. If the row is missing (rare
  // race before the signup trigger commits), fall back to least privilege.
  // `profiles` is not in the (stale) generated types.ts, so cast like the rest
  // of the codebase does for newer tables (e.g. layout_jobs, analysis_guidance).
  //
  // In parallel, resolve approval via the SECURITY DEFINER is_approved() RPC.
  // FAIL-OPEN: if the function doesn't exist yet (before the RLS-lockdown
  // migration is applied) the RPC returns an error — we treat that as approved
  // so the app keeps working unchanged until the gate is live.
  const [profileRes, approvedRes] = await Promise.all([
    (supabase as any)
      .from("profiles")
      .select("role, workspace_id, job_function, email")
      .eq("id", userId)
      .maybeSingle(),
    (supabase as any).rpc("is_approved").then(
      (r: any) => r,
      () => ({ data: true, error: null }), // network/throw -> fail open
    ),
  ]);

  const approved = approvedRes?.error ? true : approvedRes?.data === true;
  const { data, error } = profileRes;

  if (error || !data) {
    setState({
      loading: false,
      userId,
      email,
      role: "viewer",
      workspaceId: null,
      jobFunction: null,
      approved,
    });
    return;
  }

  setState({
    loading: false,
    userId,
    email: data.email ?? email,
    role: (data.role as AppRole) ?? "viewer",
    workspaceId: data.workspace_id ?? null,
    jobFunction: data.job_function ?? null,
    approved,
  });
}

// Initialise exactly once, on the client only.
let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;

  supabase.auth.getSession().then(({ data }) => {
    const session = data.session;
    if (session?.user) {
      void loadProfile(session.user.id, session.user.email ?? null);
    } else {
      setState({ loading: false, userId: null, email: null, role: "viewer", workspaceId: null, jobFunction: null, approved: true });
    }
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      void loadProfile(session.user.id, session.user.email ?? null);
    } else {
      setState({ loading: false, userId: null, email: null, role: "viewer", workspaceId: null, jobFunction: null, approved: true });
    }
  });
}

// Kick off init at module load on the client.
start();

/**
 * useAuth — subscribe to the live auth/role state.
 *
 * Hydration note: callers that branch UI on role MUST also gate on `mounted`
 * (see app-shell.tsx) OR treat `loading === true` as "render the unauthenticated
 * default", so the server (viewer) and first client paint agree.
 */
export function useAuth(): AuthState {
  const [state, setLocal] = useState<AuthState>(current);
  useEffect(() => {
    start();
    const cb = (s: AuthState) => setLocal(s);
    listeners.add(cb);
    setLocal(current);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return state;
}

export async function signOut() {
  await supabase.auth.signOut();
  // onAuthStateChange resets state to the unauthenticated default.
}
