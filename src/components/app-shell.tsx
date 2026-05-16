import { Link, useLocation } from "@tanstack/react-router";
import { LayoutDashboard, FolderOpen, ShieldCheck, FileSearch, Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/knowledge-base", label: "Knowledge Base", icon: FolderOpen },
  { to: "/reports", label: "Analyses", icon: FileSearch },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const currentNav = NAV.find((n) =>
    n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
          <div className="size-9 rounded-xl bg-gradient-to-br from-sidebar-primary/30 to-sidebar-primary/10 grid place-items-center ring-1 ring-sidebar-primary/20">
            <ShieldCheck className="size-5 text-sidebar-primary" />
          </div>
          <div>
            <div className="font-display text-sm font-bold leading-tight text-sidebar-foreground">
              Compliance Sentinel
            </div>
            <div className="text-[10px] text-sidebar-foreground/50 font-medium uppercase tracking-widest">
              Intelligence Platform
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5 pt-4">
          {NAV.map((n) => {
            const active =
              n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-150 font-medium",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                )}
              >
                <n.icon className={cn("size-4 shrink-0", active ? "opacity-100" : "opacity-60")} />
                {n.label}
                {active && (
                  <span className="ml-auto size-1.5 rounded-full bg-sidebar-primary" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-sidebar-border">
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
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="h-14 border-b bg-card/80 backdrop-blur-sm flex items-center justify-between px-6 sticky top-0 z-20">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-primary/60" />
            <span className="text-foreground font-semibold">{currentNav?.label ?? "Compliance Sentinel"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground/60 font-medium">Powered by Gemini 3.1</span>
          </div>
        </header>

        <div className="flex-1 min-w-0">{children}</div>
      </main>
    </div>
  );
}
