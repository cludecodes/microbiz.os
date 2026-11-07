-- Phase 2: Appointment booking table
CREATE TABLE appointments (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  start_at         TEXT NOT NULL,
  end_at           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','completed','canceled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_appointments_workspace ON appointments(workspace_id, start_at);
CREATE INDEX idx_appointments_user ON appointments(user_id);

-- Seed a few default plans limits (will be overridden by plan limits later)
INSERT INTO usage_limits (feature_key, max_per_month) VALUES
  ('appointments.monthly', 100)
ON CONFLICT DO NOTHING;