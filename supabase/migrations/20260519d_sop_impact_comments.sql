-- Stage 4: track which approved impacts have been pushed back to the source
-- file as a Drive comment, so the UI can show "Inserted" and avoid duplicate
-- comments on re-click.
alter table public.sop_impacts
  add column if not exists drive_comment_id text,
  add column if not exists inserted_at timestamptz;

notify pgrst, 'reload schema';
