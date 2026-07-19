-- ============================================================================
-- 20260605_policy_change_workflow.sql
-- Supports the 'policy_change' workflow (a variant of the existing report state
-- machine) with:
--   (1) a first-class analysis_reports.workflow_type column — safer than stashing
--       the discriminator in the volatile summary_json blob (a read-modify-write
--       spread elsewhere could drop it), and queryable for KPIs; and
--   (2) an append-only audit trail (workflow_events) recording who/when/what for
--       every transition across regulatory / form_update / policy_change reports.
--
-- Depends on 20260603_lite_rbac.sql helpers. Run AFTER 20260604_rls_lockdown.sql.
-- ============================================================================

begin;

-- 1. First-class workflow discriminator. Default 'regulatory' so every existing
--    report keeps its current behaviour; policy_change reports set it at creation.
alter table public.analysis_reports
  add column if not exists workflow_type text not null default 'regulatory';

-- 2. Append-only audit trail.
create table if not exists public.workflow_events (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.analysis_reports(id) on delete cascade,
  event       text not null,            -- created | submitted_legal | signed_off | published | pending_manual | impact_decided
  from_status text,
  to_status   text,
  actor_id    uuid,                      -- auth.uid() of the acting user (null for system)
  actor_email text,
  detail      jsonb,                     -- e.g. { impact_id, status } for impact_decided
  created_at  timestamptz not null default now()
);

create index if not exists workflow_events_report_idx
  on public.workflow_events (report_id, created_at desc);

alter table public.workflow_events enable row level security;

-- READ: any authenticated user (consistent with the role-only reads on data tables).
drop policy if exists "workflow_events_read" on public.workflow_events;
create policy "workflow_events_read" on public.workflow_events
  for select to authenticated using (true);

-- NO insert/update/delete policy is created: only the service-role key
-- (supabaseAdmin, used inside the transition server fns) may write the audit log,
-- which keeps it tamper-resistant (clients cannot forge or delete history).

commit;

-- End of policy_change workflow migration.
