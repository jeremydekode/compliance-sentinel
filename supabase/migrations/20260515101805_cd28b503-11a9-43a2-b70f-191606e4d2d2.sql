
-- Tables
create table public.sop_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  doc_type text not null default 'SOP',
  version text not null default '1.0',
  summary text,
  tags text[] not null default '{}',
  file_url text,
  created_at timestamptz not null default now()
);

create table public.analysis_reports (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  policy_name text not null,
  status text not null default 'draft',
  source_file_url text,
  summary_json jsonb,
  created_at timestamptz not null default now()
);

create table public.regulatory_changes (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.analysis_reports(id) on delete cascade,
  chapter_ref text not null,
  old_requirement text,
  new_requirement text,
  change_summary text,
  impact text not null default 'medium',
  tone_shift text,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.sop_impacts (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.analysis_reports(id) on delete cascade,
  sop_id uuid references public.sop_documents(id) on delete set null,
  sop_title text not null,
  change_type text not null default 'find_replace',
  page int,
  line_range text,
  paragraph text,
  chapter text,
  warning text,
  find_text text,
  replace_text text,
  edited_text text,
  status text not null default 'pending',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.analysis_reports(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

-- RLS enabled, but public/open for demo
alter table public.sop_documents enable row level security;
alter table public.analysis_reports enable row level security;
alter table public.regulatory_changes enable row level security;
alter table public.sop_impacts enable row level security;
alter table public.chat_messages enable row level security;

create policy "public all" on public.sop_documents for all using (true) with check (true);
create policy "public all" on public.analysis_reports for all using (true) with check (true);
create policy "public all" on public.regulatory_changes for all using (true) with check (true);
create policy "public all" on public.sop_impacts for all using (true) with check (true);
create policy "public all" on public.chat_messages for all using (true) with check (true);

-- Storage bucket
insert into storage.buckets (id, name, public) values ('policies', 'policies', true)
on conflict (id) do nothing;

create policy "policies public read" on storage.objects for select using (bucket_id = 'policies');
create policy "policies public write" on storage.objects for insert with check (bucket_id = 'policies');
create policy "policies public update" on storage.objects for update using (bucket_id = 'policies');
create policy "policies public delete" on storage.objects for delete using (bucket_id = 'policies');

-- Seed Knowledge Base
insert into public.sop_documents (title, doc_type, version, summary, tags) values
('Cyber Resilience & Incident Response SOP', 'SOP', '3.2', 'Defines incident classification, escalation, and reporting timelines for cybersecurity events.', array['cyber','incident','rmit']),
('Third-Party / Vendor Risk Management SOP', 'SOP', '2.4', 'Onboarding, due diligence, and ongoing monitoring of technology service providers.', array['vendor','outsourcing','tprm']),
('Business Continuity Management SOP', 'SOP', '4.0', 'BCP, DR testing cadence, and recovery time objectives for critical systems.', array['bcm','dr','rto']),
('Cloud Services Governance SOP', 'SOP', '1.6', 'Controls for adoption, migration, and operation of public cloud workloads.', array['cloud','governance']),
('Access Control & Privileged Access SOP', 'SOP', '2.1', 'Identity lifecycle, MFA, and privileged access management.', array['iam','mfa','pam']),
('Data Loss Prevention SOP', 'SOP', '1.3', 'DLP rules, classification, and exfiltration response.', array['dlp','data']),
('Outsourcing Policy (Historical)', 'Policy', '2019', 'Pre-RMiT outsourcing arrangements and BNM notification thresholds.', array['outsourcing','historical']),
('Technology Risk Management Framework', 'Policy', '2021', 'Enterprise tech risk taxonomy, RACI, and reporting structure.', array['risk','framework']);
