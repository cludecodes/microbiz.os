-- Phase 2: CV generator and PDF tools tables
-- CV templates store reusable templates for CV generation
CREATE TABLE cv_templates (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL CHECK (kind in ('basic','professional','creative')),
  layout_json      TEXT NOT NULL DEFAULT '{}',   -- JSON describing layout
  is_public        INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_cv_templates_workspace ON cv_templates(workspace_id, is_public);

-- PDF operations store PDF merge/split/compress jobs
CREATE TABLE pdf_operations (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind in ('merge','split','compress')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  input_files      TEXT NOT NULL DEFAULT '[]',   -- JSON array of file paths or ids
  output_file      TEXT,                           -- generated file path or id
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX idx_pdf_operations_workspace ON pdf_operations(workspace_id, status);

-- Usage limits for Phase 2 features
INSERT INTO usage_limits (feature_key, max_per_month) VALUES
  ('cv-generator.monthly', 5),
  ('pdf-tools.monthly', 10)
ON CONFLICT DO NOTHING;