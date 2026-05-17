-- Add workspace scoping for multi-tenant demo (RMiT vs FATF).
-- Existing rows are backfilled to the default workspace 'rmit'.

ALTER TABLE sop_documents
  ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'rmit';

ALTER TABLE analysis_reports
  ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'rmit';

-- Optional: scope chat history too (chat is per-report so technically inherited,
-- but having it explicit makes deletions easier)
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'rmit';

-- Indexes for the workspace filter
CREATE INDEX IF NOT EXISTS sop_documents_workspace_idx     ON sop_documents(workspace_id);
CREATE INDEX IF NOT EXISTS analysis_reports_workspace_idx  ON analysis_reports(workspace_id);
CREATE INDEX IF NOT EXISTS chat_messages_workspace_idx     ON chat_messages(workspace_id);

-- Note: regulatory_changes and sop_impacts inherit via report_id;
-- sop_chunks inherits via sop_id. No need to add workspace_id there.
