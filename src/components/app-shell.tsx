import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, FolderOpen, ShieldCheck, FileSearch, Settings, Zap, Scale, UserRound, ChevronDown, PanelLeftClose, PanelLeftOpen, Layers, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRole, ROLE_META, type UserRole } from "@/lib/role";
import { useAuth, signOut, type AppRole } from "@/lib/auth";
import { useWorkspace, WORKSPACES, type WorkspaceId } from "@/lib/workspace";
import { useState, useRef, useEffect } from "react";
import { Briefcase } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getWorkspaceVisibility } from "@/lib/compliance.functions";

const BASE_NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/knowledge-base", label: "Knowledge Base", icon: FolderOpen },
  { to: "/reports", label: "Analyses", icon: FileSearch },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const LAYOUT_NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/layout", label: "Layouts", icon: Layers },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const SIDEBAR_KEY = "sidebar_collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [ws] = useWorkspace();
  // Workspace lives in localStorage, which doesn't exist on the server.
  // Defer the nav switch to AFTER hydration so the server's BASE_NAV and
  // the client's first render match — otherwise React throws a hydration
  // mismatch when the layout nav has different anchors/icons than base.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const NAV = mounted && ws === "layout" ? LAYOUT_NAV : BASE_NAV;
  const currentNav = NAV.find((n) =>
    n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)
  );

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(SIDEBAR_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);
  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className={cn(
        "hidden md:flex shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200",
        collapsed ? "w-14" : "w-60"
      )}>
        {/* Logo + collapse button */}
        <div className={cn(
          "flex items-center border-b border-sidebar-border",
          collapsed ? "flex-col gap-2 px-2 py-3" : "gap-3 px-5 py-5"
        )}>
          <div className="size-9 rounded-xl bg-gradient-to-br from-sidebar-primary/30 to-sidebar-primary/10 grid place-items-center ring-1 ring-sidebar-primary/20 shrink-0">
            <ShieldCheck className="size-5 text-sidebar-primary" />
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <div className="font-display text-sm font-bold leading-tight text-sidebar-foreground truncate">
                AI Document Workflow
              </div>
              <div className="text-[10px] text-sidebar-foreground/50 font-medium uppercase tracking-widest">
                Intelligence Platform
              </div>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="p-1.5 rounded-lg text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
          >
            {collapsed ? <PanelLeftOpen className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}
          </button>
        </div>

        {/* Nav */}
        <nav className={cn("flex-1 space-y-0.5 pt-4", collapsed ? "p-2" : "p-3")}>
          {NAV.map((n) => {
            const active =
              n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                title={collapsed ? n.label : undefined}
                className={cn(
                  "flex items-center rounded-xl text-sm transition-all duration-150 font-medium",
                  collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                )}
              >
                <n.icon className={cn("size-4 shrink-0", active ? "opacity-100" : "opacity-60")} />
                {!collapsed && <>{n.label}{active && (<span className="ml-auto size-1.5 rounded-full bg-sidebar-primary" />)}</>}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className={cn("border-t border-sidebar-border", collapsed ? "p-2" : "p-4")}>
          {collapsed ? (
            <div className="flex items-center justify-center py-2" title="AI Engine · Gemini 3.1 Active">
              <div className="size-7 rounded-lg bg-gradient-to-br from-sidebar-primary/20 to-sidebar-primary/5 grid place-items-center relative">
                <Zap className="size-3.5 text-sidebar-primary" />
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.4)]" />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-xl bg-sidebar-accent/40 px-3 py-2.5">
              <div className="size-6 rounded-lg bg-gradient-to-br from-sidebar-primary/20 to-sidebar-primary/5 grid place-items-center">
                <Zap className="size-3.5 text-sidebar-primary" />
              </div>
              <div>
                <div className="text-[10px] font-bold text-sidebar-foreground/90 uppercase tracking-widest">AI Engine</div>
                <div className="text-[10px] text-sidebar-foreground/40 font-medium">Gemini 3.1 Active</div>
              </div>
              <span className="ml-auto size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.4)]" />
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="h-14 border-b bg-card/80 backdrop-blur-sm flex items-center justify-between px-6 sticky top-0 z-20">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-primary/60" />
            <span className="text-foreground font-semibold">{currentNav?.label ?? "AI Document Workflow"}</span>
          </div>
          <div className="flex items-center gap-2">
            <WorkspaceSwitcher />
            <div className="h-6 w-px bg-border" />
            <RoleSwitcher />
            <div className="h-6 w-px bg-border" />
            <UserMenu />
          </div>
        </header>

        <div className="flex-1 min-w-0">{children}</div>
      </main>
    </div>
  );
}

const APP_ROLE_META: Record<AppRole, { label: string; color: string; bg: string }> = {
  super_admin: { label: "Super Admin", color: "text-amber-700", bg: "bg-amber-100" },
  member:      { label: "Member",      color: "text-emerald-700", bg: "bg-emerald-100" },
  viewer:      { label: "Viewer",      color: "text-slate-600", bg: "bg-slate-100" },
};

// Real signed-in identity (Supabase Auth) — distinct from the cosmetic
// compliance/legal RoleSwitcher. Shows email + security role + Sign out, or a
// Sign in link when unauthenticated. Mounted-gated so SSR and the first client
// paint agree (auth state resolves async on the client only).
function UserMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Stable placeholder until the client resolves the session (avoids hydration mismatch).
  if (!mounted || auth.loading) {
    return <div className="size-7 rounded-full bg-muted animate-pulse" aria-hidden />;
  }

  if (!auth.userId) {
    return (
      <Link
        to="/login"
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card text-xs font-medium transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        <UserRound className="size-3.5" />
        Sign in
      </Link>
    );
  }

  const meta = APP_ROLE_META[auth.role];
  const initial = (auth.email ?? "?").charAt(0).toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    navigate({ to: "/login" });
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded-lg border bg-card text-xs font-medium transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        <span className={cn("size-6 rounded-full grid place-items-center font-bold", meta.bg, meta.color)}>
          {initial}
        </span>
        <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-60 rounded-xl border bg-card shadow-lg overflow-hidden z-30">
          <div className="px-3 py-2.5 border-b bg-muted/30">
            <div className="text-xs font-semibold truncate">{auth.email}</div>
            <span className={cn("inline-block mt-1 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded", meta.bg, meta.color)}>
              {meta.label}
            </span>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
          >
            <LogOut className="size-3.5 text-muted-foreground" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function RoleSwitcher() {
  const [role, setRoleHook] = useRole();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const Icon = role === "legal" ? Scale : UserRound;
  const meta = ROLE_META[role];

  const options: { value: UserRole; label: string; description: string }[] = [
    { value: "compliance", label: "Compliance Officer", description: "Triage every change, propose amendments, route for legal." },
    { value: "legal",      label: "Head of Legal",      description: "Review batch summary, sign off, return for revision." },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card text-xs font-medium transition-colors",
          "hover:border-primary/40 hover:bg-muted/40"
        )}
      >
        <span className={cn("size-6 rounded-full grid place-items-center",
          role === "legal" ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
        )}>
          <Icon className="size-3" />
        </span>
        <div className="text-left leading-tight">
          <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">Viewing as</div>
          <div className={cn("font-semibold", meta.color)}>{meta.label}</div>
        </div>
        <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-xl border bg-card shadow-lg overflow-hidden z-30">
          <div className="px-3 py-2 border-b bg-muted/30">
            <div className="text-[9px] uppercase tracking-widest font-black text-muted-foreground">Switch role</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">Demo only — affects the report review interface.</div>
          </div>
          {options.map(opt => {
            const active = opt.value === role;
            const OptIcon = opt.value === "legal" ? Scale : UserRound;
            return (
              <button
                key={opt.value}
                onClick={() => { setRoleHook(opt.value); setOpen(false); }}
                className={cn(
                  "w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors border-b last:border-b-0",
                  active ? "bg-primary/5" : "hover:bg-muted/40"
                )}
              >
                <span className={cn("size-7 rounded-full grid place-items-center shrink-0 mt-0.5",
                  opt.value === "legal" ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
                )}>
                  <OptIcon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">{opt.label}</span>
                    {active && <span className="text-[9px] font-bold uppercase tracking-widest text-primary">active</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">{opt.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkspaceSwitcher() {
  const [ws, setWs] = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Workspace lives in localStorage — server has no access, so it defaults
  // to "rmit". Defer the workspace-specific display (name, colours) to the
  // post-hydration tick so the server's render and the client's first render
  // match (both show "rmit" briefly), avoiding a React 19 hydration error.
  // Behaviour is identical across all workspaces — this is purely a timing fix.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Until mounted, render as if on the default workspace (matches server).
  const displayWs: WorkspaceId = mounted ? ws : "rmit";
  const meta = WORKSPACES[displayWs];
  // The super-admin can hide workspaces (master visibility toggle). The
  // switcher filters them out; the CURRENT workspace stays visible even if
  // hidden, so the user isn't trapped if they just hid the one they're on.
  const getVis = useServerFn(getWorkspaceVisibility);
  const visibilityQuery = useQuery({
    queryKey: ["workspace_visibility"],
    queryFn: () => getVis(),
    staleTime: 60_000,
  });
  const visibility = visibilityQuery.data?.visibility ?? {};
  const options = (Object.keys(WORKSPACES) as WorkspaceId[]).filter(
    (id) => visibility[id] !== false || id === ws,
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card text-xs font-medium transition-colors',
          'hover:border-primary/40 hover:bg-muted/40'
        )}
      >
        <span className={cn('size-6 rounded-full grid place-items-center', meta.bgColor, meta.color)}>
          <Briefcase className="size-3" />
        </span>
        <div className="text-left leading-tight">
          <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">Workspace</div>
          <div className={cn('font-semibold', meta.color)}>{meta.name}</div>
        </div>
        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-xl border bg-card shadow-lg overflow-hidden z-30">
          <div className="px-3 py-2 border-b bg-muted/30">
            <div className="text-[9px] uppercase tracking-widest font-black text-muted-foreground">Switch demo workspace</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">Each workspace has its own KB &amp; analyses.</div>
          </div>
          {options.map(id => {
            const o = WORKSPACES[id];
            const active = id === ws;
            return (
              <button
                key={id}
                onClick={() => { setWs(id); setOpen(false); }}
                className={cn(
                  'w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors border-b last:border-b-0',
                  active ? 'bg-primary/5' : 'hover:bg-muted/40'
                )}
              >
                <span className={cn('size-7 rounded-full grid place-items-center shrink-0 mt-0.5', o.bgColor, o.color)}>
                  <Briefcase className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">{o.name}</span>
                    {active && <span className="text-[9px] font-bold uppercase tracking-widest text-primary">active</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">{o.tagline}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

