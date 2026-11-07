-- Seed data: application registry + subscription plans.
-- NOTE: prices below are CONFIGURATION, not real revenue. No payments exist
-- until a verified provider transaction creates one.

INSERT INTO applications (id, name, description, phase, enabled, created_at) VALUES
  ('whatsapp-crm', 'WhatsApp Business CRM & Order Manager',
   'Track contacts, catalogs and WhatsApp orders in one pipeline.', 1, 1, '2026-01-01T00:00:00Z'),
  ('qr-menu', 'Restaurant QR Menu & Ordering',
   'Mobile-first QR menus with live ordering for restaurants.', 1, 1, '2026-01-01T00:00:00Z'),
  ('invoices', 'Invoice, Quotation & Payment Reminder',
   'Professional invoices, quotations and automated payment reminders.', 1, 1, '2026-01-01T00:00:00Z'),
  ('appointments', 'Appointment Booking', 'Phase 2 - scheduling for clinics, salons and services.', 2, 1, '2026-01-01T00:00:00Z'),
  ('pdf-tools', 'PDF Utilities', 'Phase 2 - merge, split and compress PDFs.', 2, 1, '2026-01-01T00:00:00Z'),
  ('cv-generator', 'CV Generator', 'Phase 2 - professional resume builder.', 2, 1, '2026-01-01T00:00:00Z'),
  ('digital-downloads', 'Digital Downloads', 'Phase 2 - one-time digital product sales.', 2, 0, '2026-01-01T00:00:00Z'),
  ('lead-marketplace', 'Qualified Lead Marketplace', 'Phase 3 - qualified lead sales with billing.', 3, 0, '2026-01-01T00:00:00Z'),
  ('referrals', 'Referral & Affiliate System', 'Phase 3 - referral links, commissions ledger.', 3, 0, '2026-01-01T00:00:00Z')
ON CONFLICT DO NOTHING;

-- Limits: feature_key -> max per workspace (null = unlimited).
-- Free plan limits are metered via usage_events.
INSERT INTO plans (id, name, price_minor, currency, limits, features, is_active, is_public, sort) VALUES
  ('free', 'Free', 0, 'PKR',
   '{"whatsapp-crm.orders":50,"qr-menu.scans":200,"invoices.monthly":5,"team_members":1,"appointments.monthly":0}',
   '[]', 1, 1, 0),
  ('starter', 'Starter', 150000, 'PKR',
   '{"whatsapp-crm.orders":500,"qr-menu.scans":5000,"invoices.monthly":100,"team_members":3,"appointments.monthly":5}',
   '["urdu_locale"]', 1, 1, 1),
  ('pro', 'Pro', 450000, 'PKR',
   '{"whatsapp-crm.orders":null,"qr-menu.scans":null,"invoices.monthly":null,"team_members":10,"appointments.monthly":null}',
   '["urdu_locale","api_access"]', 1, 1, 2),
  ('starter-usd', 'Starter', 1500, 'USD',
   '{"whatsapp-crm.orders":500,"qr-menu.scans":5000,"invoices.monthly":100,"team_members":3,"appointments.monthly":5}',
   '["urdu_locale"]', 1, 1, 3),
  ('pro-usd', 'Pro', 4500, 'USD',
   '{"whatsapp-crm.orders":null,"qr-menu.scans":null,"invoices.monthly":null,"team_members":10,"appointments.monthly":null}',
   '["urdu_locale","api_access"]', 1, 1, 4)
ON CONFLICT DO NOTHING;
