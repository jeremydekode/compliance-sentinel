-- Per-workspace, user-editable analysis guidance. The compliance team edits
-- this in Settings; it is injected into the regulatory analysis prompts as an
-- additional guidance section (it refines approach/emphasis — it never replaces
-- the output format or the find_text/verification rules).
CREATE TABLE IF NOT EXISTS public.analysis_guidance (
  workspace_id text PRIMARY KEY,
  guidance text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The app's server functions access the database with the project key (no
-- per-user auth), exactly as they do for the other tables. Disable RLS so the
-- guidance can be read and saved, consistent with the rest of the schema.
ALTER TABLE public.analysis_guidance DISABLE ROW LEVEL SECURITY;
