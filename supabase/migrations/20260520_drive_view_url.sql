-- Drive-synced SOPs now mirror their binary into Supabase storage and use
-- that as file_url (so downstream fetchFile calls always get a real file,
-- not Drive's HTML viewer page). Keep the human-readable Drive viewer URL
-- separately so the KB UI can still link out to Drive for editing.
alter table public.sop_documents
  add column if not exists drive_view_url text;

notify pgrst, 'reload schema';
