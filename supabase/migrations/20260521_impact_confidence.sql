-- Per-impact AI confidence score (0-100).
-- Drives the triage split: >= 90 = Ready (one-click bulk approve),
-- < 90 = Needs review (individual review).
ALTER TABLE public.sop_impacts ADD COLUMN IF NOT EXISTS confidence integer;

notify pgrst, 'reload schema';
