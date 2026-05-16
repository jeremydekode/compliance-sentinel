ALTER TABLE public.regulatory_changes
  ADD COLUMN IF NOT EXISTS pages text,
  ADD COLUMN IF NOT EXISTS legal_refs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS related_instruments text[] NOT NULL DEFAULT '{}';