// ----------------------------------------------------------------------------
// Tenant branding — applies a tenant's chrome (name/tagline/logo/colors) at
// runtime by setting CSS custom properties on the document root. Every
// component already consumes the semantic Tailwind classes bound to these
// vars (bg-sidebar-primary, text-primary, ...), so no component-level styling
// changes are needed to re-skin the app.
//
// Colors are nullable per-tenant ("inherit the built-in default") — a missing
// value REMOVES any prior override rather than setting an empty string, so
// switching from a branded tenant back to the default doesn't leave stale
// inline styles behind.
// ----------------------------------------------------------------------------

export interface TenantBranding {
  slug: string;
  name: string;
  tagline: string | null;
  logoUrl: string | null;
  colorPrimary: string | null;
  colorSidebar: string | null;
  colorSidebarPrimary: string | null;
  colorSidebarAccent: string | null;
  /** Enabled feature keys: workspace ids + 'legal_cms' | 'rudy' | 'create_document'. */
  features: string[];
}

/** Every feature key — the single source of truth for tenant capabilities
 *  (workspace ids + capability switches). Client-safe; the server re-exports
 *  it as ALL_TENANT_FEATURES. */
export const ALL_FEATURES = [
  "rmit", "fatf", "forms", "simplify", "simplify_v2", "layout", "policy",
  "credit_risk", "credit_risk_demo", "legal_cms", "rudy", "create_document",
] as const;

// Mirrors the seeded 'default' row in 20260716_tenant_branding.sql — used as
// the fallback before the client has resolved the real tenant (or if the
// lookup fails), so the app never renders with blank branding.
export const DEFAULT_TENANT_BRANDING: TenantBranding = {
  slug: "default",
  name: "AI Document Workflow",
  tagline: "Intelligence Platform",
  logoUrl: null,
  colorPrimary: null,
  colorSidebar: null,
  colorSidebarPrimary: null,
  colorSidebarAccent: null,
  features: [...ALL_FEATURES],
};

const CSS_VAR_BY_FIELD: Record<string, keyof TenantBranding> = {
  "--primary": "colorPrimary",
  "--sidebar": "colorSidebar",
  "--sidebar-primary": "colorSidebarPrimary",
  "--sidebar-accent": "colorSidebarAccent",
};

/** Client-only. Sets/clears the tenant's color overrides on <html>. */
export function applyTenantBranding(tenant: TenantBranding | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  for (const [cssVar, field] of Object.entries(CSS_VAR_BY_FIELD)) {
    const value = tenant?.[field] as string | null | undefined;
    if (value) root.setProperty(cssVar, value);
    else root.removeProperty(cssVar);
  }
}
