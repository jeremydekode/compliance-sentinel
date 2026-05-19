-- Google OAuth connection per workspace.
-- One admin connects Google per workspace; the refresh_token is reused by all
-- users of that workspace for KB sync + comment insertion.
create table if not exists public.workspace_google_connections (
  workspace_id text primary key,
  google_email text not null,
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  drive_folder_id text,
  drive_folder_name text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_google_connections enable row level security;

-- MVP: allow anon reads/writes from the app. Will tighten once real user auth ships.
drop policy if exists "workspace_google_connections_all" on public.workspace_google_connections;
create policy "workspace_google_connections_all"
  on public.workspace_google_connections
  for all
  using (true)
  with check (true);

-- Auto-bump updated_at on every UPDATE
create or replace function public.touch_workspace_google_connections()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_wgc on public.workspace_google_connections;
create trigger trg_touch_wgc
  before update on public.workspace_google_connections
  for each row execute function public.touch_workspace_google_connections();
