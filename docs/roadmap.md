# Roadmap, dependencies and approvals

## Milestone status

| Milestone | Scope                                     | Status |
| --------- | ----------------------------------------- | ------ |
| M0        | Repo, CI, env template, docs              | ✅ |
| M1        | Shared kernel (money, entitlements, ledger)| ✅ |
| M2        | DB schema + auth + tenancy + security core | ✅ |
| M3        | Central dashboard + workspace mgmt + PWA   | ✅ |
| M4a       | WhatsApp CRM & Order Manager (contacts, catalog, orders pipeline, metering) | ✅ |
| M4b       | QR Restaurant Menu (public menu, scan metering, live availability) | ✅ |
| M4c       | Invoices & quotations product            | ✅ |
| M5a       | Billing core: plans, checkout intents, webhook verification, plan activation, double-entry ledger, manual reconciliation | ✅ |
| M5b       | Settlement marking, refunds, payout profiles, invoice payment links | ✅ |
| M6        | Super-admin analytics                      | ⏳ next |
| M7        | Marketing, referrals, affiliate commissions| ⏳ |
| M8        | Security audit, coverage, production prep  | ⏳ |

Note: the M4a CRM module UI is English-first; its Urdu strings are batched
with the i18n polish pass in M8 (the app shell itself is fully EN/UR today).

## Zero-cash budget notes (flagged as required by the brief)

| Thing | Free-tier status |
| ----- | ---------------- |
| Cloudflare Workers / D1 | ✅ Free tier sufficient for MVP |
| GitHub + Actions CI | ✅ Free for public repos; private repos have 2000 min/mo free |
| Vite/Vitest/Hono/Tailwind | ✅ All open source |
| Fonts (Inter, Noto Nastaliq Urdu) | ✅ Open source (must be self-hosted or via system; no paid font service used) |

## Third-party approvals required before enabling money features

- **Safepay** (PK checkout): business account + onboarding/KYC + sandbox keys +
  a payment-link template per plan. Webhook signing secret must be obtained from
  Safepay and set via `wrangler secret put SAFEPAY_WEBHOOK_SECRET`.
- **Lemon Squeezy** (SaaS + digital sales): store approval, a payment link per
  plan and webhook secret (`LEMON_SQUEEZY_WEBHOOK_SECRET`). Note: Lemon Squeezy
  charges per-transaction fees — approval from the project owner is required
  before enabling.
- **RAAST / bank-transfer reconciliation**: implement only against accounts the
  owner controls; reconciliation is a super-admin action against the real bank
  statement, no credentials stored.
- **Payoneer** (US/B2B invoices): requires Payoneer account + API access approval.
- No feature above is enabled by default; hosted checkout and webhooks fail
  closed (501/401) until secrets and links are configured by the owner.
- **Flagged for approval:** server-created hosted checkout via provider APIs
  (currently owner-configured payment links), automatic provider payout-report
  ingestion, automated refund API calls, and server-side PDF generation.
  M5b implements admin-attested settlement marking/refunds instead: the admin
  checks the real bank/provider dashboard first, then records it here.

## Deliberate safety rails (per development rules)

1. No endpoint marks a payment successful without a verified provider event.
2. `confirmed_receipts` counts only `payments.status = 'confirmed'` rows.
3. Seed data contains plans/app colors only — **no invented transactions**.
4. Ledger journals must balance per currency before persisting.
5. Settlement status is a separate column/flow from payment status.
6. Never store card numbers, CVV, banking passwords or OTPs — payout profiles
   hold AES-256-GCM-encrypted account metadata only.
