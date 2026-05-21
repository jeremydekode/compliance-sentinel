-- Phase 1: structural taxonomy for the internal corpus.
-- governance_tier — where a document sits in RHB's policy hierarchy
--   (policy = principles, guideline = operational parameters, sector_guideline
--   = subsidiary/sector-specific). Lets the analysis word an amendment for the
--   right level instead of treating every internal doc identically.
-- topic_map — a cached { topic -> [clause refs] } index per document, so the
--   regulatory mapping routes changes to real clauses instead of guessing.
ALTER TABLE public.sop_documents ADD COLUMN IF NOT EXISTS governance_tier text;
ALTER TABLE public.sop_documents ADD COLUMN IF NOT EXISTS topic_map jsonb;
