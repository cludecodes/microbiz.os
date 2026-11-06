-- M5b: one payout target per kind per workspace, and fast invoice payment
-- lookups. No new tables; no existing columns are rewritten.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_profiles_workspace_kind
  ON payout_profiles(workspace_id, kind);

CREATE INDEX IF NOT EXISTS idx_payments_invoice
  ON payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_payments_settlement
  ON payments(settlement_status, provider);
