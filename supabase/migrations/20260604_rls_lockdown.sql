-- ============================================================================
-- 20260604_rls_lockdown.sql
-- PERMANENT SECURITY FIX: close the public (anon) hole on every table + lock the
-- Google-token table to service-role only + stop public writes to the storage
-- bucket. Replaces every legacy `using(true)` policy.
--
-- Depends on 20260603_lite_rbac.sql (public.app_role enum, public.is_super_admin(),
--   public.current_app_role()). MUST run AFTER it.
--
-- MODEL = ROLE-ONLY (deliberately NOT workspace-scoped). The app's workspace_id
--   is a per-browser product-area switcher (rmit/fatf/forms/simplify/layout) that
--   every user toggles freely — it is NOT a tenant boundary. So policies gate on
--   ROLE only:
--     - any authenticated user (viewer/member/super_admin) -> READ all rows
--     - member or super_admin                              -> WRITE (insert/update/delete)
--     - anon (unauthenticated, i.e. the public anon key)   -> DENIED everywhere
--   The browser keeps filtering by workspace via .eq('workspace_id', ws); that is
--   a UI concern, not a security boundary. (If true per-workspace isolation is ever
--   wanted, model it as many-workspace membership — a separate product change.)
--
-- !!!  DO NOT APPLY THIS UNTIL THE SERVER-FUNCTION CUTOVER IS DEPLOYED  !!!
--   Every serverFn in src/lib/compliance.functions.ts and src/lib/layout.functions.ts
--   currently talks to Postgres as the ANON role and only works because of the
--   using(true) policies this migration removes. Applying this alone takes the live
--   app dark (reads return 0 rows, writes silently no-op). Ship it together with the
--   cutover (attachSupabaseAuth in start.ts + requireSupabaseAuth/context.supabase or
--   supabaseAdmin in every serverFn) and SUPABASE_SERVICE_ROLE_KEY set in Vercel.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Reconcile out-of-band tables into version control so their RLS is
--    reproducible. CREATE IF NOT EXISTS is a no-op on the live DB (keeps the
--    existing shape) and just captures the definition for fresh environments.
-- ---------------------------------------------------------------------------
create extension if not exists vector;

create table if not exists public.sop_chunks (
  id          uuid primary key default gen_random_uuid(),
  sop_id      uuid references public.sop_documents(id) on delete cascade,
  content     text not null,
  chapter_ref text,
  page_number int,
  embedding   vector(1536),
  created_at  timestamptz default now()
);

create table if not exists public.workspace_settings (
  workspace_id text primary key,
  visible      boolean not null default true,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 1. DATA TABLES — drop ALL existing policies (robust against unknown/legacy
--    names: the five "public all" policies AND the orphan sop_chunks policy the
--    advisor flagged), enable RLS, then add fresh role-only READ + WRITE policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
  data_tables text[] := array[
    'sop_documents','analysis_reports','regulatory_changes','sop_impacts',
    'chat_messages','analysis_guidance','sop_chunks','layout_jobs',
    'layout_frames','layout_placements'
  ];
begin
  foreach t in array data_tables loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

    execute format('alter table public.%I enable row level security', t);

    -- READ: any authenticated user. anon is excluded by `to authenticated`.
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t
    );

    -- WRITE (insert/update/delete): member or super_admin only. Viewers cannot write.
    -- (Permissive policies OR-combine, so the READ policy above still lets viewers SELECT.)
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.is_super_admin() or public.current_app_role() = ''member''::public.app_role) '
      || 'with check (public.is_super_admin() or public.current_app_role() = ''member''::public.app_role)',
      t || '_write', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. workspace_google_connections (Google refresh/access tokens) — DENY-ALL.
--    RLS enabled + FORCED, and ZERO policies => unreachable by anon AND
--    authenticated. Only the service-role key (supabaseAdmin) may touch it.
--    The 6 access sites in google-oauth.ts / compliance.functions.ts MUST use
--    supabaseAdmin (part of the cutover).
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'workspace_google_connections'
  loop
    execute format('drop policy if exists %I on public.workspace_google_connections', p.policyname);
  end loop;
end $$;

alter table public.workspace_google_connections enable row level security;
alter table public.workspace_google_connections force row level security;
-- (intentionally NO policies created here)

-- ---------------------------------------------------------------------------
-- 3. workspace_settings — read by any authenticated user (the workspace switcher
--    needs the whole visibility map); the master visibility toggle is WRITE and
--    is restricted to super_admin.
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'workspace_settings'
  loop
    execute format('drop policy if exists %I on public.workspace_settings', p.policyname);
  end loop;
end $$;

alter table public.workspace_settings enable row level security;

create policy workspace_settings_read on public.workspace_settings
  for select to authenticated using (true);

create policy workspace_settings_write on public.workspace_settings
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 4. Storage bucket 'policies' — close the public WRITE/UPDATE/DELETE hole
--    (anyone could overwrite/delete files). We KEEP public READ so getPublicUrl()
--    keeps working across ~9 upload/preview/AI-extract call sites (flipping the
--    bucket to private would 404 every stored file URL — a separate, larger
--    signed-URL migration tracked as a follow-up).
-- ---------------------------------------------------------------------------
drop policy if exists "policies public write" on storage.objects;
drop policy if exists "policies public update" on storage.objects;
drop policy if exists "policies public delete" on storage.objects;

create policy "policies authed insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'policies'
    and (public.is_super_admin() or public.current_app_role() = 'member'::public.app_role)
  );

create policy "policies authed update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'policies'
    and (public.is_super_admin() or public.current_app_role() = 'member'::public.app_role)
  )
  with check (
    bucket_id = 'policies'
    and (public.is_super_admin() or public.current_app_role() = 'member'::public.app_role)
  );

create policy "policies authed delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'policies'
    and (public.is_super_admin() or public.current_app_role() = 'member'::public.app_role)
  );

commit;

-- End of RLS lockdown migration.
