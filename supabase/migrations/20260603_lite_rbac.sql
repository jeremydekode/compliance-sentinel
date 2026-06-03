-- ============================================================================
-- LITE RBAC: profiles + auto-provision + super-admin seed + self-escalation block
-- ----------------------------------------------------------------------------
-- Roles (exactly three): 'super_admin' | 'member' | 'viewer'.
-- Everyone defaults to LEAST privilege ('viewer') on signup.
-- ONLY jeremy@dekode.ai is ever auto-promoted to 'super_admin'.
-- Users can NEVER escalate their own role (enforced by a BEFORE UPDATE trigger,
--   not just RLS, so it holds even if an UPDATE policy is loosened later).
--
-- This migration is idempotent and SAFE to run on the live DB. It does NOT
-- touch the existing using(true) policies on the data tables (that is the
-- separate RLS-hardening pillar). It only introduces the identity/role source
-- of truth that those policies will reference via public.is_super_admin() /
-- public.current_app_role().
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Role enum (idempotent create)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('super_admin', 'member', 'viewer');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Super-admin allowlist (by email) — lets us seed jeremy@dekode.ai
--    BEFORE he has ever signed in. The signup trigger consults this table,
--    and a backfill below promotes him if his auth.users row already exists.
-- ---------------------------------------------------------------------------
create table if not exists public.super_admin_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.super_admin_allowlist enable row level security;
-- No public policies at all => unreachable by anon/authenticated; only
-- service_role (bypasses RLS) and SECURITY DEFINER functions can read it.

-- Seed the sole super admin. Lowercased to match auth.users.email normalisation.
insert into public.super_admin_allowlist (email)
values ('jeremy@dekode.ai')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 3. profiles table — PK = auth.users.id
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  role         public.app_role not null default 'viewer',
  -- Optional default workspace for the user. Free text to match the existing
  -- workspace_id convention ('rmit' | 'fatf' | 'forms' | 'simplify' | 'layout').
  workspace_id text not null default 'rmit',
  -- Non-security job-function tag carried over from the old demo persona
  -- switcher (compliance/legal). Drives ONLY the approval-workflow viewing UI,
  -- never authorization. Nullable; the user may set/clear it freely.
  job_function text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- 4. updated_at touch trigger (mirrors trg_touch_wgc pattern already in repo)
-- ---------------------------------------------------------------------------
create or replace function public.touch_profiles()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_profiles on public.profiles;
create trigger trg_touch_profiles
  before update on public.profiles
  for each row execute function public.touch_profiles();

-- ---------------------------------------------------------------------------
-- 5. SELF-ESCALATION BLOCK (critical)
--    On UPDATE, if the caller is NOT a super_admin, force role + workspace_id
--    back to their previous values. A user can edit other (future) profile
--    columns but can never change their own role or move workspace via the
--    privileged columns. This runs BEFORE the touch trigger by name ordering
--    is irrelevant — both are BEFORE UPDATE row triggers; this one only
--    rewrites NEW, the other only stamps updated_at.
--
--    We detect "is this caller a super_admin" by reading the CALLER's own
--    profile row inside a SECURITY DEFINER helper, so the check itself is not
--    subject to RLS recursion.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER helper: is the *current* auth user a super_admin?
-- SECURITY DEFINER + locked search_path so it can read public.profiles
-- regardless of the caller's RLS, and cannot be hijacked via search_path.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_admin'
  );
$$;

-- Returns the caller's role (defaults to 'viewer' if no profile / unauthenticated).
create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid()),
    'viewer'::public.app_role
  );
$$;

-- The guard trigger function.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / SECURITY DEFINER admin paths run with auth.uid() = NULL and
  -- are trusted; let them through unchanged.
  if auth.uid() is null then
    return new;
  end if;

  -- Super admins may change anyone's role/workspace, including their own.
  if public.is_super_admin() then
    return new;
  end if;

  -- Everyone else: privileged columns are immutable. Silently pin them back to
  -- OLD so a malicious UPDATE neither escalates nor errors-leaks the policy.
  new.role := old.role;
  new.workspace_id := old.workspace_id;
  return new;
end $$;

drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- 6. RLS policies on profiles
--    - read: a user reads their OWN row; super_admins read all.
--    - update: a user updates their OWN row (role/workspace are neutralised by
--              the guard trigger above); super_admins update any row.
--    - insert/delete: NOT granted to authenticated. Inserts happen via the
--              signup trigger (SECURITY DEFINER); admin management happens via
--              service_role / server functions.
--    NOTE: these are policies on the profiles table only and do not affect any
--    other table's existing using(true) posture.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
  on public.profiles
  for select
  to authenticated
  using ( id = auth.uid() or public.is_super_admin() );

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
  on public.profiles
  for update
  to authenticated
  using ( id = auth.uid() or public.is_super_admin() )
  with check ( id = auth.uid() or public.is_super_admin() );

-- ---------------------------------------------------------------------------
-- 7. Auto-provision a profile on new signup, defaulting to LEAST privilege.
--    jeremy@dekode.ai (and anyone on the allowlist) is provisioned as
--    super_admin instead. Runs as the auth trigger owner (SECURITY DEFINER).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seed_role public.app_role := 'viewer';  -- least privilege by default
begin
  if exists (
    select 1 from public.super_admin_allowlist a
    where lower(a.email) = lower(new.email)
  ) then
    seed_role := 'super_admin';
  end if;

  insert into public.profiles (id, email, role)
  values (new.id, new.email, seed_role)
  on conflict (id) do update
    set email = excluded.email;  -- never downgrade/overwrite an existing role here

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 8. Idempotent backfill — works whether or not jeremy@dekode.ai has signed in.
--    (a) If he already has an auth.users row but no profile, create it as
--        super_admin. (b) If he has a profile, ensure it is super_admin.
--    Uses service-role context (migration runs as table owner / postgres), so
--    the guard trigger's auth.uid() is NULL and it passes through unchanged.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, role)
select u.id, u.email, 'super_admin'::public.app_role
from auth.users u
join public.super_admin_allowlist a on lower(a.email) = lower(u.email)
on conflict (id) do update
  set role = 'super_admin', email = excluded.email;

-- ---------------------------------------------------------------------------
-- 9. Grants. Profiles is reached only through PostgREST as authenticated
--    (subject to the RLS above) or service_role. Helpers are usable by both.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, anon;
grant select, update on public.profiles to authenticated;
grant execute on function public.is_super_admin() to authenticated, anon;
grant execute on function public.current_app_role() to authenticated, anon;

-- End of LITE RBAC migration.
