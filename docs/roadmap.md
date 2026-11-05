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
| M4c       | Invoices & quotations product            | ⏳ next |
| M5        | Subscriptions, payouts, settlement, ledger | ⏳ |
| M6        | Super-admin analytics                      | ⏳ |
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

- **Safepay** (PK checkout): business account + onboarding/KYC + sandbox keys.
  Webhook signing secret must be obtained from Safepay and set via
  `wrangler secret put SAFEPAY_WEBHOOK_SECRET`.
- **Lemon Squeezy** (SaaS + digital sales): store approval and webhook secret
  (`LEMON_SQUEEZE_WEBHOOK_SECRET`). Note: Lemon Squeezy charges per-transaction
  fees — approval from the project owner is required before enabling.
- **RAAST / bank-transfer reconciliation**: implement only against accounts the
  owner controls; manual reconciliation UI in M5, no credentials stored.
- **Payoneer** (US/B2B invoices): requires Payoneer account + API access approval.
- No feature above is enabled by default; `assertProviderConfigured` fails
  closed until secrets are configured by the owner.

## Deliberate safety rails (per development rules)

1. No endpoint marks a payment successful without a verified provider event.
2. `confirmed_receipts` counts only `payments.status = 'confirmed'` rows.
3. Seed data contains plans/app colors only — **no invented transactions**.
4. Ledger journals must balance per currency before persisting.
5. Settlement status is a separate column/flow from payment status.
6. Never store card numbers, CVV, banking passwords or OTPs — payout profiles
   hold AES-256-GCM-encrypted account metadata only.
