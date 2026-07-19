-- Retail Layout Planner workspace — additive, no existing tables touched.
-- Phase 1: sketch upload → AI-extracted frame → user approval → rules-based
-- fixture placement → user approval → export.

create table if not exists layout_jobs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  text not null default 'layout',
  title         text not null,
  status        text not null default 'uploaded',
  -- uploaded | digitizing | pending_frame_approval | frame_approved
  -- | placing_fixtures | pending_placement_review | approved
  store_type    text,
  -- standard | small | kiosk | cafe
  sketch_file_id    text,
  sketch_mime_type  text,
  sketch_drive_url  text,
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table layout_jobs disable row level security;

create table if not exists layout_frames (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references layout_jobs(id) on delete cascade,
  geometry      jsonb not null,
  -- { units, walls: [...], openings: [...], zones: [...], dimensions: {...}, totalArea }
  ai_confidence numeric,
  ai_reasoning  text,
  -- Token counts from Gemini's usageMetadata — exact, not estimates.
  ai_input_tokens     integer,
  ai_output_tokens    integer,
  ai_thinking_tokens  integer,
  approved_at   timestamptz,
  created_at    timestamptz default now()
);
alter table layout_frames disable row level security;
create index if not exists idx_layout_frames_job on layout_frames(job_id);

create table if not exists layout_placements (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references layout_jobs(id) on delete cascade,
  fixture_code  text not null,
  x             numeric not null,
  y             numeric not null,
  rotation      numeric not null default 0,
  width         numeric not null,
  height        numeric not null,
  zone          text,
  reason        text,
  status        text not null default 'pending',
  -- pending | approved | rejected
  created_at    timestamptz default now()
);
alter table layout_placements disable row level security;
create index if not exists idx_layout_placements_job on layout_placements(job_id);

-- Hide layout workspace from the switcher by default. The super-admin
-- (you) can toggle it back on from Settings before internal demos.
insert into workspace_settings (workspace_id, visible)
values ('layout', false)
on conflict (workspace_id) do nothing;
