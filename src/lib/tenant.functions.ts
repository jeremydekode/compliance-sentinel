// ============================================================================
// TENANT SCOPING — server-side helpers (Tier 1 enforcement).
// ----------------------------------------------------------------------------
// Every document in the system belongs to a tenant (analysis_reports,
// sop_documents, legal_matters, legal_kb_entries carry tenant_id). The scope
// of any request is the CALLER's profiles.tenant_id — resolved server-side
// from the authenticated user id, never from client input.
//
// There is deliberately NO super-admin bypass: an unscoped super admin would
// recreate the exact cross-tenant demo leak this exists to prevent. A super
// admin changes scope by flipping their own tenant (Settings → Team & Access).
//
// Tier 2 (RLS policies on tenant_id) is a separate post-demo migration; until
// then these helpers + the client-side filters are the enforcement layer.
// ============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { ALL_FEATURES } from "@/lib/tenant";

/** Feature keys = workspace ids + capability switches. Single source of truth
 *  lives in src/lib/tenant.ts (client-safe); this re-export keeps the server
 *  zod enums and gates on the same list. */
export const ALL_TENANT_FEATURES = ALL_FEATURES;

export type TenantFeature = (typeof ALL_TENANT_FEATURES)[number];

export interface CallerTenant {
  tenantId: string;
  features: string[];
}

/**
 * Resolves the caller's tenant + enabled features in one service-role query.
 *
 * Failure semantics matter here:
 *  - a MISSING PROFILE ROW (legit race right after signup) → 'default' tenant,
 *    all features — the benign fallback;
 *  - a QUERY ERROR (transient DB failure) → THROW. Failing open here would
 *    silently re-scope reads/deletes to the 'default' tenant and bypass every
 *    feature gate — wrong-tenant behavior is strictly worse than a failed
 *    request the user can retry.
 */
export async function getCallerTenant(userId: string): Promise<CallerTenant> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("profiles")
    .select("tenant_id, tenants ( features )")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not resolve your organisation: ${error.message}`);
  if (!data) return { tenantId: "default", features: [...ALL_TENANT_FEATURES] };
  const features: string[] = Array.isArray(data.tenants?.features)
    ? data.tenants.features
    : [...ALL_TENANT_FEATURES];
  return { tenantId: (data.tenant_id as string) ?? "default", features };
}

/** Tenant boundary check for by-id reads/mutations: a row belonging to another
 *  tenant must behave exactly like a missing row. NULL tenant (pre-migration
 *  stragglers) is treated as unowned and allowed through. */
export function assertRowTenant(rowTenant: string | null | undefined, callerTenant: string): void {
  if (rowTenant && rowTenant !== callerTenant) {
    throw new Error("Not found");
  }
}

/** Guard for feature-gated server functions (Rudy, create-document, …). */
export function requireFeature(features: string[], key: TenantFeature): void {
  if (!features.includes(key)) {
    throw new Error(`This capability ("${key}") is not enabled for your organisation.`);
  }
}
