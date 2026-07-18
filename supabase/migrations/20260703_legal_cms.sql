-- ============================================================================
-- 20260703_legal_cms.sql
-- Legal CMS — canonical schema for the single-company legal workflow.
-- 6-step workflow (Intake → Triage → Assignment → Review → Approval → Vault),
-- 4 routes (A self-service / B bespoke / C simple advisory / D complex advisory).
--
-- Idempotent: safe to re-run. Tables/columns guarded with IF NOT EXISTS; RLS
-- policies dropped-then-created. This is the source-of-truth for the column
-- contract that src/lib/legal.functions.ts writes/reads — keep them in sync.
--
-- RLS is intentionally permissive (any authenticated user) for the demo. True
-- per-role / per-tenant isolation is a separate hardening step.
-- ============================================================================

-- ---- Reference-number sequence -------------------------------------------
create sequence if not exists legal_matter_seq start 1;

-- ---- legal_matters --------------------------------------------------------
create table if not exists legal_matters (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default 'legal',
  entity_code text not null default 'org',
  reference_number text unique,
  title text not null,
  description text,
  matter_type text,
  route text check (route in ('A','B','C','D')),
  ai_route_reasoning text,
  status text not null default 'draft' check (status in (
    'draft','triage','pending_assignment','assigned',
    'in_review','pending_approval','approved','rejected','archived','resolved'
  )),
  priority text default 'normal' check (priority in ('low','normal','high','urgent')),
  is_material boolean default false,
  contract_value numeric,
  ai_screening jsonb,
  requestor_id uuid,
  requestor_name text,
  requestor_email text,
  assigned_to uuid,
  assigned_to_name text,
  assigned_to_email text,
  assigned_by uuid,
  assigned_by_name text,
  assigned_at timestamptz,
  ai_triage_result jsonb,
  ai_triage_summary text,
  ai_risk_flags jsonb,
  ai_response text,
  ai_executive_summary text,
  referred_to_gc boolean default false,
  referred_to_gc_at timestamptz,
  tagged_functions jsonb,
  approved_by uuid,
  approved_by_name text,
  approved_at timestamptz,
  rejection_reason text,
  due_date timestamptz,
  expiry_date timestamptz,
  retention_until timestamptz,
  destroy_after timestamptz,
  completed_at timestamptz,
  awaiting_role text check (awaiting_role in ('submitter','reviewer')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Backfill columns on an existing table (idempotent adds).
alter table legal_matters add column if not exists contract_value    numeric;
alter table legal_matters add column if not exists ai_screening      jsonb;
alter table legal_matters add column if not exists referred_to_gc    boolean default false;
alter table legal_matters add column if not exists referred_to_gc_at timestamptz;
alter table legal_matters add column if not exists tagged_functions  jsonb;
alter table legal_matters add column if not exists expiry_date       timestamptz;
alter table legal_matters add column if not exists retention_until   timestamptz;
alter table legal_matters add column if not exists destroy_after     timestamptz;
alter table legal_matters add column if not exists awaiting_role     text;

-- Allow 'submitter'/'reviewer' awaiting_role on existing tables.
alter table legal_matters drop constraint if exists legal_matters_awaiting_role_check;
alter table legal_matters add constraint legal_matters_awaiting_role_check
  check (awaiting_role in ('submitter','reviewer'));

-- ---- legal_matter_events (append-only audit trail) ------------------------
create table if not exists legal_matter_events (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references legal_matters(id) on delete cascade not null,
  event_type text not null,
  actor_id uuid,
  actor_name text,
  from_status text,
  to_status text,
  payload jsonb,
  created_at timestamptz default now()
);

-- ---- legal_matter_comments (in-matter chat) -------------------------------
create table if not exists legal_matter_comments (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references legal_matters(id) on delete cascade not null,
  author_id uuid,
  author_name text,
  author_email text,
  content text not null,
  comment_type text default 'comment' check (
    comment_type in ('comment','review_note','rejection_reason','ai_note','client_approved')
  ),
  function_tag text,
  mentions jsonb,
  created_at timestamptz default now()
);
alter table legal_matter_comments add column if not exists function_tag text;
alter table legal_matter_comments add column if not exists mentions     jsonb;

-- Allow 'client_approved' comment_type on existing tables.
alter table legal_matter_comments drop constraint if exists legal_matter_comments_comment_type_check;
alter table legal_matter_comments add constraint legal_matter_comments_comment_type_check
  check (comment_type in ('comment','review_note','rejection_reason','ai_note','client_approved'));

-- ---- legal_matter_documents (uploads + AI review) -------------------------
create table if not exists legal_matter_documents (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references legal_matters(id) on delete cascade not null,
  file_name text not null,
  file_url text not null,
  mime_type text,
  size_bytes bigint,
  doc_role text default 'submitted' check (doc_role in ('submitted','reference','executed','draft','counterparty_markup')),
  access_level text default 'standard' check (access_level in ('standard','restricted')),
  ai_review jsonb,
  ai_review_status text default 'none' check (ai_review_status in ('none','running','done','failed')),
  ai_reviewed_at timestamptz,
  version int default 1,
  parent_document_id uuid references legal_matter_documents(id) on delete set null,
  version_note text,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz default now()
);
alter table legal_matter_documents add column if not exists access_level       text default 'standard';
alter table legal_matter_documents add column if not exists version            int default 1;
alter table legal_matter_documents add column if not exists parent_document_id uuid;
alter table legal_matter_documents add column if not exists version_note       text;

-- Allow 'draft' + 'counterparty_markup' doc_role on existing tables.
alter table legal_matter_documents drop constraint if exists legal_matter_documents_doc_role_check;
alter table legal_matter_documents add constraint legal_matter_documents_doc_role_check
  check (doc_role in ('submitted','reference','executed','draft','counterparty_markup'));

-- ---- legal_kb_entries (Route D → Route C knowledge base) ------------------
create table if not exists legal_kb_entries (
  id uuid primary key default gen_random_uuid(),
  entity_code text not null default 'org',
  title text not null,
  takeaways text not null,
  source_matter_id uuid references legal_matters(id) on delete set null,
  source_reference text,
  published_by uuid,
  published_by_name text,
  created_at timestamptz default now()
);

-- ---- legal_matter_shares (send-to-counterparty) ---------------------------
create table if not exists legal_matter_shares (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references legal_matters(id) on delete cascade not null,
  recipient_name text,
  recipient_email text,
  document_ids jsonb,
  document_names jsonb,
  message text,
  sent_by uuid,
  sent_by_name text,
  sent_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz default now()
);

-- ---- Reference-number generation ('LGL-YYYY-0001') ------------------------
create or replace function generate_legal_ref()
returns trigger language plpgsql as $$
begin
  if new.reference_number is null then
    new.reference_number := 'LGL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('legal_matter_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'legal_matter_ref_trigger') then
    create trigger legal_matter_ref_trigger
      before insert on legal_matters
      for each row execute function generate_legal_ref();
  end if;
end $$;

-- ---- updated_at maintenance -----------------------------------------------
create or replace function update_legal_matter_ts()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'legal_matter_updated_at') then
    create trigger legal_matter_updated_at
      before update on legal_matters
      for each row execute function update_legal_matter_ts();
  end if;
end $$;

-- ---- Indexes --------------------------------------------------------------
create index if not exists idx_legal_matters_status     on legal_matters(status);
create index if not exists idx_legal_matters_created     on legal_matters(created_at desc);
create index if not exists idx_legal_events_matter       on legal_matter_events(matter_id);
create index if not exists idx_legal_comments_matter     on legal_matter_comments(matter_id);
create index if not exists idx_legal_documents_matter    on legal_matter_documents(matter_id);
create index if not exists idx_legal_shares_matter       on legal_matter_shares(matter_id);

-- ---- RLS (permissive demo: any authenticated user) ------------------------
alter table legal_matters          enable row level security;
alter table legal_matter_events    enable row level security;
alter table legal_matter_comments  enable row level security;
alter table legal_matter_documents enable row level security;
alter table legal_kb_entries       enable row level security;
alter table legal_matter_shares    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'legal_matters','legal_matter_events','legal_matter_comments',
    'legal_matter_documents','legal_kb_entries','legal_matter_shares'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on %I for insert to authenticated with check (true)', t || '_insert', t);
    execute format('create policy %I on %I for update to authenticated using (true)', t || '_update', t);
    execute format('create policy %I on %I for delete to authenticated using (true)', t || '_delete', t);
  end loop;
end $$;
