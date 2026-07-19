-- ============================================================================
-- 20260720_tenant_scoping.sql
-- TENANT SCOPING (Tier 1) + per-tenant feature toggles + app settings.
-- ----------------------------------------------------------------------------
-- Documents become tenant-owned: every report/SOP/legal record carries the
-- tenant of the user who created it, and every list/search/RAG read path is
-- filtered server-side by the CALLER's profiles.tenant_id (no super-admin
-- bypass — a super admin flips their own tenant to change scope). This closes
-- the cross-tenant demo leak (Bank B must never see RHB files).
--
-- Tier 1 = application-level enforcement (server functions + UI filters).
-- Tier 2 (RLS policies keyed on profiles.tenant_id, a hard DB boundary) is
-- DELIBERATELY DEFERRED to a post-demo migration — it touches every table's
-- policies on the shared live DB and deserves its own careful rollout.
--
-- Idempotent and safe to re-run. Additive + backfill only; no drops.
-- Depends on: 20260716_tenant_branding.sql (public.tenants).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-tenant feature toggles.
--    Keys = workspace ids + capability keys ('legal_cms', 'rudy',
--    'create_document'). Default = EVERYTHING, so existing tenants (default,
--    rhb) behave exactly as today until a super admin edits them in Settings.
-- ---------------------------------------------------------------------------
alter table public.tenants add column if not exists features text[] not null
  default array['rmit','fatf','forms','simplify','simplify_v2','layout','policy',
                'credit_risk','credit_risk_demo','legal_cms','rudy','create_document'];

-- ---------------------------------------------------------------------------
-- 2. tenant_id on the document tables. Nullable by design this week — the app
--    stamps it on every insert; the backfill below covers history. Legal child
--    tables (events/comments/documents/shares) scope via matter_id joins.
-- ---------------------------------------------------------------------------
alter table public.analysis_reports add column if not exists tenant_id text references public.tenants(slug);
alter table public.sop_documents    add column if not exists tenant_id text references public.tenants(slug);

do $$
begin
  if to_regclass('public.legal_matters') is not null then
    alter table public.legal_matters add column if not exists tenant_id text references public.tenants(slug);
  end if;
  if to_regclass('public.legal_kb_entries') is not null then
    alter table public.legal_kb_entries add column if not exists tenant_id text references public.tenants(slug);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Backfill — every existing document is RHB demo material (user-approved).
-- ---------------------------------------------------------------------------
update public.analysis_reports set tenant_id = 'rhb' where tenant_id is null;
update public.sop_documents    set tenant_id = 'rhb' where tenant_id is null;

do $$
begin
  if to_regclass('public.legal_matters') is not null then
    update public.legal_matters set tenant_id = 'rhb' where tenant_id is null;
  end if;
  if to_regclass('public.legal_kb_entries') is not null then
    update public.legal_kb_entries set tenant_id = 'rhb' where tenant_id is null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3b. AUTO-STAMP tenant_id on INSERT from the authenticated caller's profile.
--     A BEFORE INSERT trigger beats stamping in every server function: it
--     covers all 14+ insert sites today AND every future one, and can't be
--     forgotten. Rules:
--       - explicit tenant_id provided        -> respected (admin/seed paths)
--       - user-JWT insert (auth.uid() set)   -> caller's profiles.tenant_id
--       - service-role insert (auth.uid()=∅) -> 'default' (fail-safe bucket,
--         never another tenant's data)
-- ---------------------------------------------------------------------------
create or replace function public.stamp_tenant_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tenant_id is null then
    new.tenant_id := coalesce(
      (select p.tenant_id from public.profiles p where p.id = auth.uid()),
      'default'
    );
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_tenant_ar on public.analysis_reports;
create trigger trg_stamp_tenant_ar before insert on public.analysis_reports
  for each row execute function public.stamp_tenant_id();

drop trigger if exists trg_stamp_tenant_sop on public.sop_documents;
create trigger trg_stamp_tenant_sop before insert on public.sop_documents
  for each row execute function public.stamp_tenant_id();

do $$
begin
  if to_regclass('public.legal_matters') is not null then
    drop trigger if exists trg_stamp_tenant_lm on public.legal_matters;
    create trigger trg_stamp_tenant_lm before insert on public.legal_matters
      for each row execute function public.stamp_tenant_id();
  end if;
  if to_regclass('public.legal_kb_entries') is not null then
    drop trigger if exists trg_stamp_tenant_lkb on public.legal_kb_entries;
    create trigger trg_stamp_tenant_lkb before insert on public.legal_kb_entries
      for each row execute function public.stamp_tenant_id();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the hot list paths.
-- ---------------------------------------------------------------------------
create index if not exists analysis_reports_tenant_ws_idx on public.analysis_reports (tenant_id, workspace_id);
create index if not exists sop_documents_tenant_ws_idx    on public.sop_documents (tenant_id, workspace_id);

do $$
begin
  if to_regclass('public.legal_matters') is not null then
    create index if not exists legal_matters_tenant_idx on public.legal_matters (tenant_id);
  end if;
  if to_regclass('public.legal_kb_entries') is not null then
    create index if not exists legal_kb_entries_tenant_idx on public.legal_kb_entries (tenant_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. app_settings — tiny key/value store for app-level preferences (first
--    consumer: the default AI model picker). Service-role only: RLS enabled
--    with NO public policies; reads/writes go through server functions.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Seed the 'acme' verification tenant (distinct branding, all features) —
--    used to prove cross-tenant isolation before the demo. Safe no-op if it
--    already exists.
-- ---------------------------------------------------------------------------
insert into public.tenants (slug, name, tagline, color_primary, color_sidebar, color_sidebar_primary, color_sidebar_accent)
values ('acme', 'ACME Bank', 'Document Intelligence', '#0F766E', '#134E4A', '#2DD4BF', '#115E59')
on conflict (slug) do nothing;

commit;

-- Verification (run after):
--   select slug, features from public.tenants order by slug;
--   select tenant_id, count(*) from public.analysis_reports group by 1;
--   select tenant_id, count(*) from public.sop_documents group by 1;
