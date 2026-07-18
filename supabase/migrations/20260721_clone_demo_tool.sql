-- ============================================================================
-- 20260721_clone_demo_tool.sql
-- DEMO SEEDING: clone generic demo content (reports + KB docs WITH their
-- embedding chunks) from one tenant into another, entirely inside Postgres so
-- embedding vectors never cross the network. Files in storage are shared by
-- URL — clones reference the same object; row deletes never remove storage
-- objects, so sharing is safe.
--
-- Service-role only: EXECUTE is revoked from public/anon/authenticated; the
-- app calls it through supabaseAdmin after verifying the caller is a
-- super_admin (seedTenantDemo server function).
-- ============================================================================

create or replace function public.clone_demo_to_tenant(
  p_report_ids uuid[],
  p_sop_ids    uuid[],
  p_target     text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sop_map       jsonb := '{}'::jsonb;   -- old sop id -> new sop id
  r             record;
  new_sop_id    uuid;
  new_report_id uuid;
  reports_done  int := 0;
  sops_done     int := 0;
  chunks_done   int := 0;
  tmp           int;
begin
  if not exists (select 1 from public.tenants t where t.slug = p_target) then
    raise exception 'Unknown target tenant %', p_target;
  end if;

  -- ── 1. KB documents + their embedding chunks ──────────────────────────────
  for r in
    select * from public.sop_documents where id = any(coalesce(p_sop_ids, '{}'))
  loop
    new_sop_id := gen_random_uuid();
    insert into public.sop_documents
    select (jsonb_populate_record(
      null::public.sop_documents,
      to_jsonb(r) || jsonb_build_object(
        'id', new_sop_id,
        'tenant_id', p_target,
        'created_at', now(),
        -- a clone is a snapshot, not a live Drive-synced document: drop the
        -- Drive linkage so the (workspace, drive_file_id) uniqueness holds
        'drive_file_id', null,
        'drive_mime_type', null,
        'drive_modified_time', null,
        'last_sync_error', null
      )
    )).*;
    sop_map := sop_map || jsonb_build_object(r.id::text, new_sop_id::text);
    sops_done := sops_done + 1;

    insert into public.sop_chunks (id, sop_id, content, chapter_ref, page_number, embedding, created_at)
    select gen_random_uuid(), new_sop_id, c.content, c.chapter_ref, c.page_number, c.embedding, now()
    from public.sop_chunks c
    where c.sop_id = r.id;
    get diagnostics tmp = row_count;
    chunks_done := chunks_done + tmp;
  end loop;

  -- ── 2. Reports (+ regulatory child rows, sop refs remapped when cloned) ──
  for r in
    select * from public.analysis_reports where id = any(coalesce(p_report_ids, '{}'))
  loop
    new_report_id := gen_random_uuid();
    insert into public.analysis_reports
    select (jsonb_populate_record(
      null::public.analysis_reports,
      to_jsonb(r) || jsonb_build_object(
        'id', new_report_id,
        'tenant_id', p_target,
        'created_at', now()
      )
    )).*;
    reports_done := reports_done + 1;

    if to_regclass('public.regulatory_changes') is not null then
      insert into public.regulatory_changes
      select (jsonb_populate_record(
        null::public.regulatory_changes,
        to_jsonb(rc) || jsonb_build_object(
          'id', gen_random_uuid(),
          'report_id', new_report_id
        )
      )).*
      from public.regulatory_changes rc
      where rc.report_id = r.id;
    end if;

    if to_regclass('public.sop_impacts') is not null then
      insert into public.sop_impacts
      select (jsonb_populate_record(
        null::public.sop_impacts,
        to_jsonb(si) || jsonb_build_object(
          'id', gen_random_uuid(),
          'report_id', new_report_id,
          -- keep the impact pointing at the CLONED sop when it was cloned in
          -- the same call; otherwise null it so no cross-tenant reference
          -- survives.
          'sop_id', case
            when si.sop_id is null then null
            when sop_map ? si.sop_id::text then (sop_map ->> si.sop_id::text)::uuid
            else null
          end
        )
      )).*
      from public.sop_impacts si
      where si.report_id = r.id;
    end if;
  end loop;

  return jsonb_build_object(
    'reports', reports_done,
    'sops', sops_done,
    'chunks', chunks_done,
    'target', p_target
  );
end $$;

-- Service-role only.
revoke execute on function public.clone_demo_to_tenant(uuid[], uuid[], text) from public;
revoke execute on function public.clone_demo_to_tenant(uuid[], uuid[], text) from anon;
revoke execute on function public.clone_demo_to_tenant(uuid[], uuid[], text) from authenticated;
