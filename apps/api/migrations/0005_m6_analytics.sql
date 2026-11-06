-- M6: analytics read paths. Index-only migration; no tables or columns change.
-- All analytics are derived from rows that already exist.

CREATE INDEX IF NOT EXISTS idx_payments_confirmed_at
  ON payments(confirmed_at, currency);

CREATE INDEX IF NOT EXISTS idx_payments_created_at
  ON payments(created_at, currency);

CREATE INDEX IF NOT EXISTS idx_ledger_journals_created
  ON ledger_journals(created_at);

CREATE INDEX IF NOT EXISTS idx_usage_occurred_at
  ON usage_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_users_created_at
  ON users(created_at);

CREATE INDEX IF NOT EXISTS idx_workspaces_created_at
  ON workspaces(created_at);

CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders(created_at);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at
  ON invoices(created_at);

CREATE INDEX IF NOT EXISTS idx_support_created_at
  ON support_tickets(created_at);

CREATE INDEX IF NOT EXISTS idx_audit_action_ts
  ON audit_logs(action, ts DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions(status, plan_id);
