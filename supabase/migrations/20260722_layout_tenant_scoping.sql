-- ============================================================================
-- 20260722_layout_tenant_scoping.sql
-- TENANT SCOPING (Tier 1) for the Retail Layout Planner.
-- ----------------------------------------------------------------------------
-- layout_jobs was outside the 20260720 tenant-scoping pass (it has no
-- tenant_id column at all), so any signed-in user could list/read/mutate every
-- tenant's layout jobs. This adds the column + backfill + the same
-- auto-stamping trigger the four document tables use. Child tables
-- (layout_frames, layout_placements) scope via job_id joins, mirroring how
-- legal child tables scope via matter_id.
--
-- The app code (src/lib/layout.functions.ts) is written defensively: before
-- this migration runs it treats jobs as unowned (visible), after it every
-- read/mutation is checked against the caller's tenant.
--
-- Idempotent and safe to re-run. Additive + backfill only; no drops.
-- Depends on: 20260720_tenant_scoping.sql (public.stamp_tenant_id()).
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.layout_jobs') is not null then
    alter table public.layout_jobs add column if not exists tenant_id text references public.tenants(slug);

    -- Backfill — every existing layout job is RHB demo material, same call as
    -- the 20260720 backfill of the document tables.
    update public.layout_jobs set tenant_id = 'rhb' where tenant_id is null;

    drop trigger if exists trg_stamp_tenant_lj on public.layout_jobs;
    create trigger trg_stamp_tenant_lj before insert on public.layout_jobs
      for each row execute function public.stamp_tenant_id();
  end if;
end $$;

commit;
