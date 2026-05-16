ALTER TABLE public.regulatory_changes
  ADD COLUMN IF NOT EXISTS diff_source text NOT NULL DEFAULT 'document',
  ADD COLUMN IF NOT EXISTS compared_against text[] NOT NULL DEFAULT '{}'::text[];