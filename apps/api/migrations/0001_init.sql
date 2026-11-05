-- MicroBiz OS - initial schema (Cloudflare D1 / SQLite)
-- All money values are integers in minor units (paisa / cents).
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identities
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,          -- pbkdf2$iter$salt$hash
  name            TEXT NOT NULL,
  locale          TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ur')),
  is_super_admin  INTEGER NOT NULL DEFAULT 0 CHECK (is_super_admin IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,       -- sha256 hex of random token
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked     INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- --------------------------------------------------------------- tenancy
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  currency    TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  locale      TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ur')),
  plan_id     TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE applications (
  id          TEXT PRIMARY KEY,           -- e.g. 'whatsapp-crm'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phase       INTEGER NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at  TEXT NOT NULL
);

-- ----------------------------------------------------------- billing plans
CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_minor INTEGER NOT NULL DEFAULT 0,  -- monthly, minor units; 0 = free
  currency    TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  limits      TEXT NOT NULL DEFAULT '{}',  -- JSON: feature_key -> max|null
  features    TEXT NOT NULL DEFAULT '[]',  -- JSON: bundled one-off features
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_public   INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0,1)),
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL REFERENCES plans(id),
  status             TEXT NOT NULL CHECK (status IN ('active','trialing','canceled','past_due')),
  provider           TEXT NOT NULL DEFAULT 'manual',  -- manual|safepay|lemonsqueezy|payoneer|bank
  provider_ref       TEXT,
  started_at         TEXT NOT NULL,
  current_period_end TEXT,
  canceled_at        TEXT,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_workspace ON subscriptions(workspace_id);

-- Per-workspace feature overrides/add-ons on top of the plan.
CREATE TABLE entitlements (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL,
  limit_value  INTEGER,                    -- NULL = unlimited
  granted      INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0,1)),
  source       TEXT NOT NULL DEFAULT 'override' CHECK (source IN ('plan','override')),
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, feature_key)
);

-- ----------------------------------------------------------- business data
CREATE TABLE customers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  locale       TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ur')),
  tags         TEXT NOT NULL DEFAULT '[]',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_customers_workspace ON customers(workspace_id);
CREATE INDEX idx_customers_phone ON customers(workspace_id, phone);

-- Generic catalog for all apps (CRM items, menu items, digital goods).
CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('physical','digital')),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price_minor  INTEGER NOT NULL,
  currency     TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  stock        INTEGER,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  stream_id    TEXT,                       -- WhatsApp catalog stream / menu id
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_products_workspace ON products(workspace_id, app_id);

CREATE TABLE orders (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  customer_id    TEXT REFERENCES customers(id),
  number         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('new','confirmed','preparing','delivering','completed','canceled')),
  channel        TEXT NOT NULL DEFAULT 'whatsapp',   -- whatsapp|qr-menu|web
  currency       TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  subtotal_minor INTEGER NOT NULL,
  tax_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, number)
);
CREATE INDEX idx_orders_workspace ON orders(workspace_id, created_at DESC);

CREATE TABLE order_items (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  name       TEXT NOT NULL,
  qty_millis INTEGER NOT NULL,           -- quantity x1000 to stay integer
  unit_price_minor INTEGER NOT NULL,
  total_minor INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id    TEXT REFERENCES customers(id),
  number         TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('invoice','quotation')),
  status         TEXT NOT NULL CHECK (
                   (type = 'invoice'    AND status IN ('draft','sent','paid','void'))
                OR (type = 'quotation'  AND status IN ('draft','sent','accepted','declined','expired','void'))
                 ),
  client_name    TEXT NOT NULL,
  client_email   TEXT,
  client_address TEXT,
  subtotal_minor INTEGER NOT NULL,
  tax_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL,
  currency       TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  notes          TEXT NOT NULL DEFAULT '',
  due_date       TEXT,
  sent_at        TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, number)
);
CREATE INDEX idx_invoices_workspace ON invoices(workspace_id, created_at DESC);

CREATE TABLE invoice_line_items (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  qty_millis       INTEGER NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  total_minor      INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_invoice_items_invoice ON invoice_line_items(invoice_id);

-- ------------------------------------------------------------ money flow
-- Payment status and settlement status are tracked INDEPENDENTLY.
CREATE TABLE payments (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id         TEXT REFERENCES invoices(id),
  order_id           TEXT REFERENCES orders(id),
  provider           TEXT NOT NULL CHECK (provider IN ('safepay','bank','raast','lemonsqueezy','payoneer','manual')),
  provider_txn_ref   TEXT,
  amount_minor       INTEGER NOT NULL,
  fee_minor          INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  status             TEXT NOT NULL CHECK (status IN ('initiated','awaiting_confirmation','confirmed','failed','refunded','canceled')),
  settlement_status  TEXT NOT NULL DEFAULT 'not_applicable' CHECK (settlement_status IN ('not_applicable','pending','settled','mismatch')),
  refund_minor       INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  confirmed_at       TEXT,
  settled_at         TEXT,
  CHECK (confirmed_at IS NULL OR status IN ('confirmed','refunded'))
);
CREATE INDEX idx_payments_workspace ON payments(workspace_id, created_at DESC);
-- Idempotency: the same provider transaction reference can only land once.
CREATE UNIQUE INDEX idx_payments_provider_ref ON payments(provider, provider_txn_ref) WHERE provider_txn_ref IS NOT NULL;

-- Raw provider webhook events. Append-only; audit trail of third-party claims.
CREATE TABLE payment_events (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  event_id            TEXT NOT NULL,      -- provider's event id (idempotency key)
  payment_id          TEXT REFERENCES payments(id),
  event_type          TEXT NOT NULL,
  signature_verified  INTEGER NOT NULL DEFAULT 0 CHECK (signature_verified IN (0,1)),
  payload             TEXT NOT NULL,      -- sanitized raw payload
  processed_at        TEXT NOT NULL,
  UNIQUE (provider, event_id)
);
CREATE INDEX idx_payment_events_payment ON payment_events(payment_id);

-- Manual bank/RAAST transfer reconciliation.
CREATE TABLE bank_settlements (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_id      TEXT REFERENCES payments(id),
  provider        TEXT NOT NULL CHECK (provider IN ('bank','raast')),
  reference       TEXT NOT NULL,
  expected_minor  INTEGER NOT NULL,
  received_minor  INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  status          TEXT NOT NULL CHECK (status IN ('pending','partial','settled','mismatch')),
  settled_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_bank_settlements_workspace ON bank_settlements(workspace_id, status);

-- Payout targets. Sensitive fields are aes-256-gcm encrypted at rest.
-- NEVER store card numbers, CVV, banking passwords or OTPs in this table.
CREATE TABLE payout_profiles (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('safepay','bank_raast','lemonsqueezy','payoneer')),
  label       TEXT NOT NULL,
  details_encrypted TEXT NOT NULL,        -- encrypted JSON blob
  approved    INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_payout_profiles_workspace ON payout_profiles(workspace_id);

-- --------------------------------------------------- growth / monetization
CREATE TABLE leads (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'manual',
  contact_name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  qualification_score INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','contacted','won','lost')),
  consent_marketing INTEGER NOT NULL DEFAULT 0 CHECK (consent_marketing IN (0,1)),
  consent_at   TEXT,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_leads_workspace ON leads(workspace_id, status);

CREATE TABLE referrals (
  id               TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  code             TEXT NOT NULL UNIQUE,
  referred_user_id TEXT REFERENCES users(id),
  converted_at     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id);

CREATE TABLE commissions (
  id               TEXT PRIMARY KEY,
  referral_id      TEXT NOT NULL REFERENCES referrals(id),
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  basis            TEXT NOT NULL CHECK (basis IN ('subscription','lead_sale','digital_sale')),
  basis_id         TEXT NOT NULL,
  currency         TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  amount_minor     INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','void')),
  created_at       TEXT NOT NULL,
  paid_at          TEXT
);
CREATE INDEX idx_commissions_referrer ON commissions(referrer_user_id, status);

CREATE TABLE usage_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  feature_key  TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  occurred_at  TEXT NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_usage_workspace_feature ON usage_events(workspace_id, feature_key, occurred_at);

CREATE TABLE coupons (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value      INTEGER NOT NULL,
  plan_scope TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------- financial ledger
-- Double-entry-style balanced journal. Enforced app-side by validateJournal().
CREATE TABLE ledger_journals (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  memo         TEXT NOT NULL,
  currency     TEXT NOT NULL CHECK (currency IN ('PKR','USD')),
  ref_type     TEXT,
  ref_id       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ledger_journals_workspace ON ledger_journals(workspace_id, created_at DESC);

CREATE TABLE ledger_postings (
  id            TEXT PRIMARY KEY,
  journal_id    TEXT NOT NULL REFERENCES ledger_journals(id),
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  account       TEXT NOT NULL CHECK (account IN (
    'gross_receipts','processing_fees','refunds','available_balance',
    'settled_bank','payout_fees','commission_expense')),
  direction     TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  ref_type      TEXT,
  ref_id        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ledger_postings_journal ON ledger_postings(journal_id);
CREATE INDEX idx_ledger_postings_account ON ledger_postings(workspace_id, account, created_at DESC);

-- ------------------------------------------------------------ operations
CREATE TABLE support_tickets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tickets_workspace ON support_tickets(workspace_id, status);

CREATE TABLE audit_logs (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  actor_user_id  TEXT,
  workspace_id   TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  ip_hash        TEXT,                    -- truncated sha256 of client ip
  user_agent     TEXT,
  detail         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, ts DESC);
CREATE INDEX idx_audit_workspace ON audit_logs(workspace_id, ts DESC);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
