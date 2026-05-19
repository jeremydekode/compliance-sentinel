-- Stage 2.1: per-file sync state so re-syncs can skip unchanged docs and
-- selectively retry the ones that failed last time.
alter table public.sop_documents
  add column if not exists drive_modified_time timestamptz,
  add column if not exists last_sync_error text;

notify pgrst, 'reload schema';
