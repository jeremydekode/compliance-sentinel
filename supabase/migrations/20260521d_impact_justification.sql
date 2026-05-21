-- Each impact carries the AI's rationale for WHERE it is placed — shown to the
-- reviewer so a placement (especially a topic-routed one without a verbatim
-- anchor) is transparent rather than a silent guess.
ALTER TABLE public.sop_impacts ADD COLUMN IF NOT EXISTS justification text;
