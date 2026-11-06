# Payment providers, webhooks and ledger (M5a)

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
- Refund ₨500: `DR refunds 500 · CR available_balance 500`
- Provider payout ₨1,200 to bank: `DR settled_bank 1,200 · CR available_balance 1,200`

Settlement is tracked independently of payment status: a confirmed hosted
payment can remain `settlement_status=pending` for days. Marking hosted
settlements and issuing refunds through the API is the M5b scope; the shared
posting builders already exist and are unit-tested.

## Explicit non-goals

- No customer wallets or escrow: the platform never holds customer balances.
- No invented bank balances, no seeded revenue rows, no mock "paid" statuses.
- No paid third-party services added for this milestone.
