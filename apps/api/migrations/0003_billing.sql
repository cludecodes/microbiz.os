-- M5a: billing fields on payments.
-- A subscription purchase is tied to the plan it pays for so a verified
-- provider event can activate exactly that plan. No seed transactions are
-- added here: revenue records only ever come from verified provider events.

ALTER TABLE payments ADD COLUMN plan_id TEXT REFERENCES plans(id);
CREATE INDEX idx_payments_provider_status ON payments(provider, status);
CREATE INDEX idx_payments_settlement ON payments(settlement_status, provider);
