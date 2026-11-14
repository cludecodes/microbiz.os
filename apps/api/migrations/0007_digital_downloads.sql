-- Phase 2 (Digital Downloads): enable the app, meter it like the other
-- products, and add the catalog/purchase tables. A purchase is delivered ONLY
-- when its linked payment goes through the single authoritative confirm path
-- (lib/billing.ts confirmPayment) — provider webhook or admin reconciliation.

UPDATE applications SET enabled = 1 WHERE id = 'digital-downloads';

UPDATE plans SET limits = json_set(
  limits,
  '$."digital-downloads.monthly"', 2
) WHERE id = 'free';

UPDATE plans SET limits = json_set(
  limits,
  '$."digital-downloads.monthly"', 10
) WHERE id IN ('starter', 'starter-usd');

UPDATE plans SET limits = json_set(
  limits,
  '$."digital-downloads.monthly"', json('null')
) WHERE id IN ('pro', 'pro-usd');

-- The workspace's downloadable catalog. file_url/delivery_note are only ever
-- released to a buyer after confirmed payment.
CREATE TABLE digital_products (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_minor   INTEGER NOT NULL CHECK (price_minor > 0),
  currency      TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  file_url      TEXT NOT NULL,
  delivery_note TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_digital_products_ws ON digital_products(workspace_id, active);

-- One purchase intent per buyer/product. delivery_token is the secret that
-- unlocks the public delivery endpoint once the payment is confirmed.
CREATE TABLE digital_purchases (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES digital_products(id),
  buyer_email    TEXT NOT NULL,
  payment_id     TEXT REFERENCES payments(id),
  status         TEXT NOT NULL DEFAULT 'awaiting_payment'
                 CHECK (status IN ('awaiting_payment','delivered','canceled')),
  delivery_token TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL,
  paid_at        TEXT,
  delivered_at   TEXT
);
CREATE INDEX idx_digital_purchases_ws ON digital_purchases(workspace_id, status);
CREATE INDEX idx_digital_purchases_product ON digital_purchases(product_id);

-- Payments gain a link to a digital purchase so a confirmed payment can
-- deliver it automatically (single authoritative path in lib/billing.ts).
-- No SQL-level REFERENCES here on purpose: the FK would be circular with
-- digital_purchases.payment_id; the link is created transactionally in
-- one batch (payment inserted first) and only ever points at a real row.
ALTER TABLE payments ADD COLUMN purchase_id TEXT;
CREATE INDEX idx_payments_purchase ON payments(purchase_id) WHERE purchase_id IS NOT NULL;
