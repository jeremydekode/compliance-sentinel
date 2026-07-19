-- ============================================================================
-- 20260716_tenant_branding.sql
-- MULTI-TENANT BRANDING: a general "Tenants" system so we can re-skin the app
-- (name/tagline/logo/colors) for external prospects (first case: RHB) without
-- a separate deployment and without touching the existing data model.
--
-- Depends on 20260603_lite_rbac.sql (public.profiles, public.is_super_admin())
-- and 20260604_rls_lockdown.sql (public.login_allowlist). MUST run after both.
--
-- Deliberately NOT a data-isolation boundary — this only changes what a user
-- SEES (chrome/branding), never what they can READ/WRITE. The existing
-- role-only RLS model (20260604) is untouched: every tenant's users still see
-- every workspace, exactly as today. Branding is non-sensitive, so `tenants`
-- gets a public (anon-readable) SELECT policy so the pre-login screen can
-- preview it via a `?org=<slug>` link — that param is cosmetic only, never a
-- security boundary. The real tenant a signed-in user gets is always
-- `profiles.tenant_id`, resolved at signup from `login_allowlist.tenant_id`
-- and changeable thereafter only by a super_admin (enforced by extending the
-- existing guard_profile_role() trigger below).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. public.tenants — branding config, keyed by a human-readable slug.
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  slug                  text primary key,
  name                  text not null,
  tagline               text,
  logo_url              text,
  -- Nullable color overrides mapping 1:1 to the CSS custom properties in
  -- src/styles.css (--primary / --sidebar / --sidebar-primary /
  -- --sidebar-accent). Null = inherit the app's built-in default. Accepts any
  -- valid CSS color string (hex from a color picker, or hand-authored oklch()).
  color_primary         text,
  color_sidebar         text,
  color_sidebar_primary text,
  color_sidebar_accent  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create or replace function public.touch_tenants()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_tenants on public.tenants;
create trigger trg_touch_tenants
  before update on public.tenants
  for each row execute function public.touch_tenants();

-- Seed the 'default' tenant with today's hardcoded copy/colors (see
-- app-shell.tsx / login.tsx / styles.css :root) so existing users see a
-- pixel-identical experience once the client starts reading from this table.
insert into public.tenants
  (slug, name, tagline, color_primary, color_sidebar, color_sidebar_primary, color_sidebar_accent)
values
  ('default', 'AI Document Workflow', 'Intelligence Platform',
   'oklch(0.32 0.12 260)', 'oklch(0.22 0.06 260)', 'oklch(0.65 0.18 250)', 'oklch(0.28 0.07 260)')
on conflict (slug) do nothing;

alter table public.tenants enable row level security;

-- Branding is not sensitive — readable by anon (pre-login preview) and
-- authenticated. Writes are NOT granted here; they only ever happen via
-- supabaseAdmin in server functions that re-check the caller is super_admin.
drop policy if exists "tenants_select_all" on public.tenants;
create policy "tenants_select_all"
  on public.tenants
  for select
  to authenticated, anon
  using ( true );

grant select on public.tenants to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. tenant_id on profiles + login_allowlist.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists tenant_id text not null default 'default' references public.tenants(slug);

alter table public.login_allowlist
  add column if not exists tenant_id text not null default 'default' references public.tenants(slug);

-- ---------------------------------------------------------------------------
-- 3. Extend the self-escalation guard so a normal user can never reassign
--    their own tenant/branding either — only role + workspace_id were pinned
--    before. Same function name/signature as 20260603_lite_rbac.sql; only the
--    non-super-admin branch gains a tenant_id pin.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if public.is_super_admin() then
    return new;
  end if;

  new.role := old.role;
  new.workspace_id := old.workspace_id;
  new.tenant_id := old.tenant_id;
  return new;
end $$;

-- Trigger already exists (created in 20260603); function body swap above is
-- sufficient, but re-create defensively in case this migration ever runs
-- standalone against a fresh database.
drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- 4. Extend signup provisioning to resolve tenant_id from the allowlist entry
--    (if any) that let this email in, same lookup pattern already used for
--    seed_role via super_admin_allowlist.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seed_role   public.app_role := 'viewer';
  seed_tenant text;
begin
  if exists (
    select 1 from public.super_admin_allowlist a
    where lower(a.email) = lower(new.email)
  ) then
    seed_role := 'super_admin';
  end if;

  select l.tenant_id into seed_tenant
  from public.login_allowlist l
  where lower(l.email) = lower(new.email);

  insert into public.profiles (id, email, role, tenant_id)
  values (new.id, new.email, seed_role, coalesce(seed_tenant, 'default'))
  on conflict (id) do update
    set email = excluded.email;  -- never downgrade/overwrite an existing role/tenant here

  return new;
end $$;

-- Trigger already exists (created in 20260603); no change needed, function
-- body swap above is sufficient. Re-create defensively for a fresh database.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;

-- End of tenant branding migration.
