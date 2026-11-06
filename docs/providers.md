# Payment providers, webhooks and ledger (M5a–M5b)

This document is the integration contract every payment adapter must satisfy.
If a provider cannot satisfy it, the feature stays disabled — the codebase never
fakes a successful payment.

## Provider matrix

| Provider | Mode | Currencies | Confirmation path | Secrets / config |
| -------- | ---- | ---------- | ----------------- | ---------------- |
| Safepay | hosted | PKR | signed webhook (`X-SFPY-Signature`) | `SAFEPAY_WEBHOOK_SECRET`, `SAFEPAY_CHECKOUT_URL_TEMPLATE` |
| Lemon Squeezy | hosted | USD | signed webhook (`X-Signature`) | `LEMON_SQUEEZY_WEBHOOK_SECRET`, `LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE` |
| Bank transfer | manual | PKR | super-admin reconciliation | none |
| Raast | manual | PKR | super-admin reconciliation | none |
| Payoneer | manual | USD | super-admin reconciliation | none |

Rules shared by all adapters:

- Secrets live only in Cloudflare Worker secrets (`wrangler secret put`) or a
  gitignored local `.dev.vars`. Never in `wrangler.jsonc`, never in the SPA.
- The browser is never trusted. Only a verified webhook or an admin-checked real
  receipt may move a payment to `confirmed`.
- Webhooks are idempotent on `(provider, event_id)`; checkouts are idempotent on
  `payments.idempotency_key`.
- Amount, currency and reference are re-verified server-side before confirming.
- A payment links to at most one plan; plan activation and the ledger journal
  happen only after the guarded status update succeeds.
- We never store card numbers, CVV, bank passwords or OTPs. Hosted providers
  receive those directly; this application only stores references.

## Hosted checkout configuration

Hosted providers require **both** a webhook secret and a payment-link template
created in the provider dashboard (one link per plan, sandbox first):

```bash
# local (apps/api/.dev.vars) or production (`wrangler secret put`)
SAFEPAY_WEBHOOK_SECRET=...
SAFEPAY_CHECKOUT_URL_TEMPLATE=https://sandbox.getsafepay.com/pay/<link>
LEMON_SQUEEZY_WEBHOOK_SECRET=...
LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE=https://<store>.lemonsqueezy.com/buy/<variant-id>
```

At checkout the server appends our transfer reference:

- Lemon Squeezy: `checkout[custom][reference]=MB-XXXXXXXX` (official custom-data
  parameter; the webhook echoes it in `meta.custom_data.reference`).
- Safepay: `reference=MB-XXXXXXXX` (verify in the Safepay sandbox that the
  payment link forwards the parameter; the webhook contract below is normalized
  and must be confirmed against Safepay's live docs during onboarding).

If either value is missing, `POST /api/billing/.../checkout` returns **501**
with the missing environment variable named. There is no fallback/fake URL.
Starting the checkout through the provider's server API (instead of a static
payment link) is a later enhancement and is flagged for approval because it
requires live credentials plus a sandbox round-trip.

## Webhook contracts

### Safepay (normalized sandbox contract)

Header: `X-SFPY-Signature: <hex HMAC-SHA256(raw body, SAFEPAY_WEBHOOK_SECRET)>`

```json
{
  "id": "evt_01HXYZ",
  "event": "payment.succeeded",
  "data": {
    "reference": "MB-7F3K2Q9ABC",
    "tracker": "track_123",
    "amount_minor": 150000,
    "amount": "1500.00",
    "currency": "PKR",
    "fee_minor": 30000,
    "status": "succeeded"
  }
}
```

- `amount_minor` is preferred; a decimal `amount` string is accepted and
  converted exactly (`toMinorUnits`). Floats are never parsed as floats.
- Supported statuses map to `succeeded` / `failed` / `refunded` / `other`.
- **Flagged:** confirm this exact shape against Safepay's live webhook docs
  during sandbox onboarding before enabling production traffic. The adapter is
  deliberately normalized so only `parseSafepayEvent` changes.

### Lemon Squeezy (official shape)

Header: `X-Signature: <hex HMAC-SHA256(raw body, LEMON_SQUEEZY_WEBHOOK_SECRET)>`

```json
{
  "meta": {
    "event_id": "1",
    "event_name": "order_created",
    "custom_data": { "reference": "MB-7F3K2Q9ABC" }
  },
  "data": {
    "id": "order_123",
    "type": "orders",
    "attributes": { "total": 1500, "currency": "USD", "status": "paid" }
  }
}
```

`attributes.total` is already in cents. Lemon Squeezy is merchant of record, so
its fee is deducted at payout rather than itemized per order; the receipt
journal therefore records `fee_minor = 0` and the fee is reconciled at payout
(M5b). Refund events are recorded and audited but never move money here.

## Manual receipt reconciliation

1. Owner starts a bank/Raast/Payoneer checkout → `payments` row in
   `awaiting_confirmation` with a unique `MB-XXXXXXXX` reference (shown in the
   Billing UI and in the provider instructions).
2. Customer transfers the exact amount with that reference.
3. A super admin checks the real bank statement and calls
   `POST /api/admin/payments/:id/confirm` with
   `{amount_minor, reference?, fee_minor?}`.
4. The server refuses hosted-provider payments (409), wrong amounts/references
   (409, recorded in `bank_settlements` as `mismatch`), and non-pending statuses.
5. On success: `status=confirmed`, `settlement_status=settled`, `settled_at` set,
   `bank_settlements` row `settled`, plan activated, ledger journal posted.

## Ledger sign convention

Accounts (per workspace, per currency):

| Account | Type | Increases with |
| ------- | ---- | -------------- |
| `gross_receipts` | revenue | CREDIT |
| `processing_fees` | expense | DEBIT |
| `refunds` | contra-revenue | DEBIT |
| `available_balance` | asset (held by provider) | DEBIT |
| `settled_bank` | asset (in owner's bank) | DEBIT |
| `payout_fees` | expense | DEBIT |
| `commission_expense` | expense | DEBIT |

Journals are validated **before** insert by `validateJournal` (balanced, one
currency, positive integer minor units). Examples:

- Hosted receipt ₨1,500 with ₨300 fee:
  `DR available_balance 1,200 · DR processing_fees 300 · CR gross_receipts 1,500`
- Bank receipt ₨4,500 (money already in bank):
  `DR settled_bank 4,500 · CR gross_receipts 4,500`
- Refund ₨500 before payout: `DR refunds 500 · CR available_balance 500`
- Refund ₨500 after payout: `DR refunds 500 · CR settled_bank 500`
- Provider payout ₨1,200 to bank: `DR settled_bank 1,200 · CR available_balance 1,200`
- Payout ₨1,200 with a ₨50 payout fee: `DR settled_bank 1,150 · DR payout_fees 50 · CR available_balance 1,200`

Settlement is tracked independently of payment status: a confirmed hosted
payment can remain `settlement_status=pending` for days.

## Settlement marking (M5b)

`POST /api/admin/payments/:id/settle` is a super-admin action performed after
the real bank credit is checked. It refuses:

- manual providers (they settle at confirmation),
- payments already settled/inapplicable,
- a received amount larger than `amount - fee - refund` (409).

The request may omit `amount_minor` (defaults to net held funds) or pass the
actual bank credit. Any shortfall is recorded as a `payout_fees` expense, which
is essential for Lemon Squeezy because its merchant-of-record fee is deducted
at payout rather than itemized per order. The payout reference is stored in the
audit log; our `MB-…` payment reference is never overwritten. Automatically
pulling provider payout reports remains **flagged for approval**.

## Refunds (M5b)

`POST /api/admin/payments/:id/refund` records a refund the admin has already
executed in the provider dashboard or bank. It is deliberately not an automated
provider API call (that remains flagged). Rules:

- only `confirmed`/`refunded` payments; partial refunds allowed;
- `amount_minor` must be positive and at most `amount - refund_minor`;
- the guarded `UPDATE … WHERE refund_minor = <old>` prevents concurrent
  over-refunds; the payment becomes `refunded` only when fully refunded;
- if the receipt was already settled, the journal credits `settled_bank`;
  otherwise it credits `available_balance`;
- the admin must pass `provider_ref`/`reason` for the audit trail;
- an invoice already marked `paid` stays paid when refunded (refunds are
  financial events; invoice status is not rewound).

## Payout profiles (M5b)

Owners register payout targets through
`/api/billing/workspace/:id/payout-profiles/:kind` (`safepay`, `bank_raast`,
`lemonsqueezy`, `payoneer`). Details are an allowlisted object
(`account_title`, `account_number`/`iban`, `bank_name`, `swift`, Payoneer
email, country, note) encrypted with AES-256-GCM before insert. Reads return a
masked preview only. Card numbers, CVVs, banking passwords and OTPs are rejected
by strict validation. A missing/invalid `PAYOUT_ENCRYPTION_KEY` makes writes
fail closed with 501. Any edit resets `approved = 0`; a super admin approves the
masked target (or revokes it) via the admin endpoint.

## Invoice payment links (M5b)

`POST /api/invoices/:workspaceId/:docId/payment-link` turns a **sent** invoice
into one payable intent for its full total:

- hosted provider → signed webhook confirmation (amount/currency re-checked);
- bank/Raast/Payoneer → admin verifies the real receipt against the `MB-…`
  reference;
- invoice payments have `plan_id = NULL` and never activate a subscription;
- the invoice moves to `paid` only when confirmed receipts cover its total;
- replaying the link returns the same pending intent (no duplicate payable
  intents);
- manually marking an invoice paid (or void) cancels pending intents so a later
  webhook cannot double-count money.

## Super-admin analytics (M6)

`GET /api/admin/analytics` is read-only and super-admin-only. It assembles
reports from verified data only:

- balanced ledger journals for gross receipts, refunds, processing/payout fees,
  bank inflow/outflow and derived balances;
- provider-confirmed payments for gross, refunds, net and per-provider figures;
- subscriptions/plans for active counts and contracted monthly value;
- usage events and product documents for module activity.

The response includes explicit definitions for net receipts, fees, contracted
value and merchant activity so dashboards never present estimates as revenue.
`GET /api/admin/analytics/export` writes audited CSV exports of the verified
daily revenue series or confirmed payment rows.

## Explicit non-goals

- No customer wallets or escrow: the platform never holds customer balances.
- No invented bank balances, no seeded revenue rows, no mock "paid" statuses.
- No paid third-party services added for this milestone.
- No automatic provider payout reports or refund API calls yet; both are
  admin-attested and flagged for approval.
- Invoice payments are full-total only; partial invoice payments are not
  modelled yet (a future enhancement, not silently accepted).
