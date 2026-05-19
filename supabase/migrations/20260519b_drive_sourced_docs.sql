-- Stage 2: track which SOPs were sourced from Google Drive so re-sync can
-- update them in place (vs creating duplicates) and the UI can link out to
-- the original Drive file.
alter table public.sop_documents
  add column if not exists drive_file_id text,
  add column if not exists drive_mime_type text;

-- Unique (workspace, drive_file_id) so sync upsert is idempotent and a single
-- Drive file can't get indexed twice in the same workspace.
create unique index if not exists sop_documents_workspace_drivefile_uniq
  on public.sop_documents (workspace_id, drive_file_id)
  where drive_file_id is not null;
