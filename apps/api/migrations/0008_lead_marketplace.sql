-- Phase 3 (Lead Marketplace): enable the app and add the marketplace tables.
-- Sellers list their OWN qualified, consented leads; buyers pay through the
-- standard payment intent path. A confirmed payment delivers the lead as a
-- new row in the buyer's workspace through the single authoritative
-- confirmPayment path (lib/billing.ts). Contact details are never exposed by
-- the browse endpoints — only after delivery.

UPDATE applications SET enabled = 1 WHERE id = 'lead-marketplace';

UPDATE plans SET limits = json_set(
  limits,
  '$."lead-marketplace.monthly"', 2
) WHERE id = 'free';

UPDATE plans SET limits = json_set(
  limits,
  '$."lead-marketplace.monthly"', 10
) WHERE id IN ('starter', 'starter-usd');

UPDATE plans SET limits = json_set(
  limits,
  '$."lead-marketplace.monthly"', json('null')
) WHERE id IN ('pro', 'pro-usd');

-- One active listing per lead (enforced by the partial unique index).
CREATE TABLE lead_listings (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  price_minor  INTEGER NOT NULL CHECK (price_minor > 0),
  currency     TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','removed')),
  created_at   TEXT NOT NULL,
  sold_at      TEXT
);
CREATE INDEX idx_lead_listings_ws ON lead_listings(workspace_id, status);
CREATE INDEX idx_lead_listings_lead ON lead_listings(lead_id);
CREATE UNIQUE INDEX idx_lead_listings_active_lead ON lead_listings(lead_id) WHERE status = 'active';

-- Buyer-side purchase intents. delivered = the lead was copied into the
-- buyer's workspace.
CREATE TABLE lead_purchases (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id   TEXT NOT NULL REFERENCES lead_listings(id),
  payment_id   TEXT REFERENCES payments(id),
  status       TEXT NOT NULL DEFAULT 'awaiting_payment'
               CHECK (status IN ('awaiting_payment','delivered','canceled')),
  created_at   TEXT NOT NULL,
  paid_at      TEXT,
  delivered_at TEXT
);
CREATE INDEX idx_lead_purchases_ws ON lead_purchases(workspace_id, status);

-- Payments gain a link to a lead purchase for the confirm-time delivery hook.
-- Plain column on purpose (see digital purchases note: circular FK).
ALTER TABLE payments ADD COLUMN lead_purchase_id TEXT;
CREATE INDEX idx_payments_lead_purchase ON payments(lead_purchase_id) WHERE lead_purchase_id IS NOT NULL;
