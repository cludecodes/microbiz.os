# API reference (M2/M3 surface)

Base URL: `/api`. All bodies are JSON. All mutating requests require the
double-submit CSRF header `X-CSRF-Token` matching the `mb_csrf` HttpOnly cookie
(except provider webhooks, which authenticate by signature).

Conventions:
- Errors: `{ "error": string, "detail"?: string }` with proper HTTP status.
- Money: integers in **minor units** (paisa / cents), currency always explicit.
- Sessions: `mb_session` HttpOnly cookie, 30-day rolling window.

## Health

| Method | Path         | Description                    |
| ------ | ------------ | ------------------------------ |
| GET    | `/api/health`| Liveness                       |
| GET    | `/api/ready` | Readiness incl. D1 check       |

## Authentication

| Method | Path                 | Description                                       |
| ------ | -------------------- | ------------------------------------------------- |
| GET    | `/api/auth/csrf`     | Issue CSRF cookie + token `{token}`               |
| POST   | `/api/auth/register` | `{email,password(≥10),name,locale=en|ur,referral_code?}` → 201 + session; auto-creates first Free workspace. `referral_code` (M7) is optional and best-effort: unknown/used codes never block registration |
| POST   | `/api/auth/login`    | `{email,password}` → session cookie               |
| POST   | `/api/auth/logout`   | Revokes current session                           |
| GET    | `/api/auth/me`       | `{user, workspaces[]}` with per-workspace role/plan |

Rate limits: register 5/15min/IP, login 10/15min/IP, global 600/5min/IP.

## Workspaces (multi-tenant)

| Method | Path                                    | Min role | Description                      |
| ------ | --------------------------------------- | -------- | -------------------------------- |
| GET    | `/api/workspaces`                       | member   | List my workspaces               |
| POST   | `/api/workspaces`                       | —        | Create `{name,currency,locale}`; Free plan allows 2 |
| GET    | `/api/workspaces/:id`                   | member   | Detail: members, plan limits, monthly usage |
| POST   | `/api/workspaces/:id/members`           | admin    | `{email,role}` add existing account |
| PATCH  | `/api/workspaces/:id/members/:userId`   | admin    | `{role}` owner-only promotions/edits of owners |
| DELETE | `/api/workspaces/:id/members/:userId`   | admin    | Remove member (owner rules apply) |

Role hierarchy: `owner > admin > manager > member`. Every workspace-scoped
request re-checks membership **server-side** — IDs in URLs are never trusted.

## Apps & entitlements

| Method | Path                                        | Description                                |
| ------ | ------------------------------------------- | ------------------------------------------ |
| GET    | `/api/apps`                                 | Public registry (id, name, phase, enabled) |
| GET    | `/api/apps/workspace/:id`                   | Per-workspace apps with entitlement + usage limits |
| GET    | `/api/apps/workspace/:id/usage/:appId`      | `{used, limit, allowed, reason}`           |

Deny-by-default: features absent from the plan's limits map are refused.

## Admin (super-admin only, enforced server-side)

| Method | Path                   | Description                             |
| ------ | ---------------------- | --------------------------------------- |
| GET    | `/api/admin/summary`   | Counts; `confirmed_receipts` counts ONLY provider-verified payments |
| GET    | `/api/admin/users`     | Latest 200 users                        |
| GET    | `/api/admin/workspaces`| Latest 200 workspaces                   |
| GET    | `/api/admin/audit-logs`| Latest 200 audit events (viewing is itself audited) |
| GET    | `/api/admin/plans`     | All plans incl. inactive, with active subscriber counts |
| PATCH  | `/api/admin/plans/:planId` | `{price_minor?, is_active?, is_public?}` — audited; price is config, not revenue |
| GET    | `/api/admin/payments`  | Latest 200 payments; `?status=` / `?provider=` filters |
| POST   | `/api/admin/payments/:paymentId/confirm` | Manual receipt reconciliation (bank/Raast/Payoneer only) — see billing |
| POST   | `/api/admin/payments/:paymentId/refund` | `{amount_minor, reason?, provider_ref?}` — records an already-executed refund (partial allowed) |
| POST   | `/api/admin/payments/:paymentId/settle` | `{amount_minor?, provider_ref?}` — marks a hosted payout settled after checking the bank |
| GET    | `/api/admin/settlements` | Bank/Raast reconciliation rows + pending/settled hosted payouts |
| GET    | `/api/admin/payout-profiles` | All payout targets, masked; never returns encrypted plaintext |
| POST   | `/api/admin/payout-profiles/:profileId/approval` | `{approved}` — approve/revoke a payout target |
| GET    | `/api/admin/subscriptions` | Latest 200 subscriptions with workspace + plan |
| GET    | `/api/admin/ledger`    | Latest 100 journals + postings + per-account totals; `?workspace_id=` scopes all three |
| GET    | `/api/admin/analytics` | Verified super-admin analytics; `?days=30&currency=PKR\|USD&workspace_id=` |
| GET    | `/api/admin/analytics/export?dataset=revenue\|payments&days=30&currency=PKR\|USD&workspace_id=` | Audit-logged CSV export of verified daily revenue or confirmed payments |

### Super-admin analytics (M6)

`GET /api/admin/analytics` returns platform metrics derived only from recorded
data: balanced ledger journals, provider-verified payments, usage events,
subscriptions, workspaces, invoices and support tickets.

Query parameters:

- `days` (1–366, default 30) selects the trailing UTC day range for the
  requested report.
- `currency` (`PKR` or `USD`; default both currencies).
- `workspace_id` (optional super-admin drill-down; scopes financial/usage/product
  sections, not platform-level user/workspace totals).

Important definitions returned with the payload:

- **Net receipts** = verified gross receipts − refunds (refunds are contra-revenue).
- **Fees** (processing/payout) are separate expenses, not net-revenue deductions.
- **Contracted monthly value** = plan list price × active subscriptions; this is
  a plan-level estimate, not collected cash.
- **Merchant order/invoice totals** are customer activity, not MicroBiz revenue.
- **Ledger balances** are derived from recorded events and are not a live bank
  feed.

`GET /api/admin/analytics/export?dataset=revenue` returns daily gross/refund/fee
totals as CSV. `dataset=payments` returns confirmed/refunded payment rows. Both
exports are audit-logged and sanitized against spreadsheet formula injection.

## Referrals & Affiliate commissions (M7)

| Method | Path                                 | Min role | Description |
| ------ | ------------------------------------ | -------- | ----------- |
| GET    | `/api/referrals/me`                  | session  | Returns the authenticated user's created referral codes and conversion stats (`total`, `converted`, `pending`). |
| POST   | `/api/referrals`                     | session  | Generates a personal `MBC-XXXXXX` style referral code and stores it in the `referrals` table (referred_user_id = NULL). |
| GET    | `/api/commissions/me`                | session  | Lists the user's commission records with a summary (pending/approved/paid/void counts, earned minor amount). |
| POST   | `/api/commissions`                     | session  | Creates a commission (status `pending`) linked to a referral, with `basis` (`subscription`/`lead_sale`/`digital_sale`), `basis_id`, `currency`, `amount_minor`. |
| GET    | `/api/admin/commissions`               | super-admin | List all commissions (optional `?status` filter: `pending|approved|paid|void`). |
| POST   | `/api/admin/commissions`               | super-admin | Create a commission (same payload as `/api/commissions`). |
| POST   | `/api/admin/commissions/:id/approval` | super-admin | Transitions a commission from `pending` → `approved`. |
| POST   | `/api/admin/commissions/:id/pay`      | super-admin | Transitions a commission from `approved` → `paid`, records `paid_at`. |
| POST   | `/api/admin/commissions/:id/void`     | super-admin | Transitions a commission from `pending` or `approved` → `void`. |

Important notes:

- The referral & commissions surface is mounted under `/api/referrals` and `/api/commissions` (migration `0006_m7_referrals.sql` enables the `referrals` app and adds the `referrals.general` unlimited feature key to every plan).  
- All commission amounts are integer minor units (paisa/cents).  
- Commissions are fully audited via the `audit_logs` table; every status change writes an entry with actor, workspace, action, and detail.  
- Referral codes follow the format `MBC-XXXXXX` (uppercase, 3‑32 characters, `A‑Z` and `0‑9` and hyphen).  
- A referral code is considered *converted* when a new account registers with it (the `referred_user_id` field is set).  
- Commissions can only be created, approved, paid, or voided by a super‑admin or the referrer themselves (the API checks ownership).  

Query parameters:

- `?status=pending|approved|paid|void` – filter list endpoints.

Payload details:

- **Create commission** (`POST /api/commissions`): `{ referral_id, basis, basis_id, currency, amount_minor }`.  
- **Admin create** (`POST /api/admin/commissions`): same payload, additionally validated that the referrer matches the admin’s user id.  

See the code in `apps/api/src/routes/referrals.ts`, `apps/api/src/routes/commissions.ts`, and `apps/api/src/routes/admin.ts` for full implementation.

## Billing & subscriptions (`/api/billing`, M5a–M5b)

| Method | Path                                             | Min role | Description |
| ------ | ------------------------------------------------ | -------- | ----------- |
| GET    | `/api/billing/plans`                             | public   | Active plans + provider capabilities; `?currency=PKR\|USD` |
| GET    | `/api/billing/providers`                         | public   | Provider capability list with per-environment `configured` flag |
| GET    | `/api/billing/workspace/:workspaceId`            | member   | Subscription, workspace-currency plans, payment history, `can_manage_billing` |
| POST   | `/api/billing/workspace/:workspaceId/checkout`   | owner    | `{plan_id, provider, idempotency_key?}` → 201 `{payment, checkout}` |
| POST   | `/api/billing/workspace/:workspaceId/downgrade`  | owner    | Immediate switch to Free (no partial refunds) |
| GET    | `/api/billing/workspace/:workspaceId/payments/:paymentId` | member | Payment status (polling for hosted checkout) |
| GET    | `/api/billing/workspace/:workspaceId/payout-profiles` | owner | Masked payout targets + `encryption_configured` |
| POST   | `/api/billing/workspace/:workspaceId/payout-profiles/:kind` | owner | `{label, details}` — AES-256-GCM encrypted; resets approval |
| DELETE | `/api/billing/workspace/:workspaceId/payout-profiles/:kind` | owner | Remove one payout target |

Billing rules enforced server-side:

- **A browser success page never activates anything.** Hosted providers
  (Safepay, Lemon Squeezy) confirm only through signature-verified webhooks.
  Manual providers (bank, Raast, Payoneer) confirm only through the super-admin
  reconciliation endpoint after checking the real receipt.
- **Amount + currency + reference are re-checked** against the payment intent;
  a mismatch returns 409 and the payment stays pending.
- **Idempotency**: `payments.idempotency_key` makes checkout replay-safe, and
  `payment_events (provider, event_id)` makes webhook replay-safe.
- **Plan activation is atomic with confirmation**: the guarded `UPDATE … WHERE
  status IN ('initiated','awaiting_confirmation')` runs first; replayed events
  cannot activate twice or double-post the ledger.
- **Double-entry ledger**: every confirmed receipt posts one balanced journal
  (`receiptPostings` in `packages/shared/src/billing.ts`). Hosted receipts split
  `available_balance` (net) and `processing_fees`; bank receipts post straight
  into `settled_bank`. Refunds and settlements have their own balanced builders.
- **Settlement is independent of payment status**: hosted receipts start
  `settlement_status = pending`; reconciled bank receipts are `settled` with
  `settled_at` set. A super admin marks a hosted payout settled only after
  checking the real bank credit (`settlePayment`). If the credit is smaller than
  net held funds, the difference is posted to `payout_fees`.
- **Refunds are admin-attested, never browser-driven**: `POST
  /api/admin/payments/:id/refund` records a refund the admin already executed in
  the provider dashboard/bank. Partial and full refunds are supported; the
  guarded update prevents over-refunding. A settled receipt refunds from
  `settled_bank`; an unsettled receipt reduces `available_balance`.
- **Payout profiles are write-only**: details are validated against an
  allowlist, encrypted with AES-256-GCM (`PAYOUT_ENCRYPTION_KEY`), and returned
  only as a masked preview. Unknown fields (card number, CVV, password, OTP) are
  rejected; changing a profile resets admin approval. Missing key → 501.
- **Currency pinning**: PKR workspaces buy PKR plans only; USD workspaces buy
  USD plans only. Provider/currency mismatches are 422.
- **No hosted checkout without configuration**: missing webhook secret or
  payment-link template → 501 with the exact env var name. There is no fake
  checkout URL in this codebase.

## Digital Downloads (`/api/digital/:workspaceId`, Phase 2)

Enabled by migration `0007_digital_downloads.sql` (app `digital-downloads` + metered
`digital-downloads.monthly` product-publishing allowance: Free 2 / Starter 10 / Pro unlimited).

| Method | Path | Min role | Description |
| ------ | ---- | -------- | ----------- |
| GET    | `/api/digital/:workspaceId` | member | List the workspace's digital products (including archived). |
| POST   | `/api/digital/:workspaceId` | member | Create a product `{name, description?, price_minor, currency, file_url, delivery_note?}` → 201, metered via `digital-downloads.monthly`. |
| PATCH  | `/api/digital/:workspaceId/:productId` | member | Partial update `{name?, description?, price_minor?, currency?, file_url?, delivery_note?, active?}`. |
| DELETE | `/api/digital/:workspaceId/:productId` | member | Soft-archive a product (purchases keep referencing it). |
| GET    | `/api/digital/:workspaceId/purchases` | member | Purchases joined with product name and payment status. |
| POST   | `/api/digital/:workspaceId/purchases` | member | Record a sale `{product_id, buyer_email, provider}` → 201 `{purchase, payment, checkout}`. Creates an `awaiting_confirmation` payment linked to the purchase; the provider must be able to settle the product's currency (422 otherwise), hosted providers need configured secrets (501 otherwise). |
| GET    | `/api/public/digital/:workspaceId/:purchaseId?token=` | public (token) | Buyer delivery endpoint. Before confirmation: 403. After: `{product: {name, description, file_url, delivery_note}}`. Wrong/missing token: 404. |

Delivery rules (safety rails):

- The file URL is stored on the product but only ever released through the token-gated
  delivery endpoint, and only after the linked payment reaches `confirmed`.
- Delivery happens through the single authoritative confirm path (`confirmPayment` in
  `lib/billing.ts`) — provider webhook or super-admin reconciliation. Nothing else may
  mark a purchase delivered.
- A confirmed digital sale automatically mints a PENDING affiliate commission (M7,
  `basis: digital_sale`, 10% of the receipt) for the referrer of the workspace owner,
  if any. Pending = no money claim; a super-admin must still approve and pay it.
  The mint is idempotent per purchase (webhook replays cannot double-mint).

## Payment webhooks (provider signature auth; no CSRF, never browser-called)

| Method | Path                         | Auth                                |
| ------ | ---------------------------- | ----------------------------------- |
| POST   | `/api/webhooks/safepay`      | `X-SFPY-Signature` HMAC-SHA256 hex  |
| POST   | `/api/webhooks/lemonsqueezy` | `X-Signature` HMAC-SHA256 hex       |

Processing order (fail closed at every step):

1. Missing secret → 501; missing/invalid signature → 401, nothing stored.
2. Stable provider event id required; `(provider, event_id)` is unique.
3. Match an **existing** payment by our transfer reference — a webhook can
   never create a payment or revenue.
4. Re-check `amount_minor` and `currency` against the intent (409 on mismatch).
5. Confirm → activate the paid plan → post one balanced ledger journal.
6. Unmatched/refund/other events are recorded and audited but change nothing.

Payload contracts (including the normalized Safepay sandbox contract) live in
[`docs/providers.md`](providers.md).

## WhatsApp CRM & Order Manager (`/api/crm/:workspaceId`, M4)

All endpoints re-check workspace membership server-side (member-level read,
member-level create/update, admin-level delete). Order creation is metered
against the plan limit (`whatsapp-crm.orders`, 50/month on Free).

Contacts (WhatsApp customers):

| Method | Path                              | Min role | Description                                                     |
| ------ | --------------------------------- | -------- | --------------------------------------------------------------- |
| GET    | `/api/crm/:workspaceId/contacts`  | member   | Latest 500 contacts                                             |
| POST   | `/api/crm/:workspaceId/contacts`  | member   | `{name, phone(+(92/1…)), email?, locale?, tags?, notes?}` → 201 |
| PATCH  | `/api/crm/:workspaceId/contacts/:contactId` | member | Partial update                                              |
| DELETE | `/api/crm/:workspaceId/contacts/:contactId` | admin  | 409 if the contact has orders (financial records are kept)      |

Catalog (workspace-priced, currency pinned to the workspace):

| Method | Path                              | Min role | Description                                    |
| ------ | --------------------------------- | -------- | ---------------------------------------------- |
| GET    | `/api/crm/:workspaceId/products`  | member   | Active-first catalog list                      |
| POST   | `/api/crm/:workspaceId/products`  | member   | `{name, price_minor, kind=physical|digital, …}` |
| DELETE | `/api/crm/:workspaceId/products/:productId` | admin | Soft-deactivates (orders keep history)      |

Orders & pipeline (`new → confirmed → preparing → delivering → completed`,
`canceled` allowed until completed; `completed`/`canceled` are immutable):

| Method | Path                              | Min role | Description                                                     |
| ------ | --------------------------------- | -------- | --------------------------------------------------------------- |
| GET    | `/api/crm/:workspaceId/orders`    | member   | Latest 200 with customer name, item counts                      |
| GET    | `/api/crm/:workspaceId/orders/:orderId` | member | One order + its line items                                    |
| POST   | `/api/crm/:workspaceId/orders`    | member   | `{customer_id?, items[{product_id?|name, qty_millis, unit_price_minor?}], tax_minor?, note?}`; plan-limit 403 when exhausted |
| PATCH  | `/api/crm/:workspaceId/orders/:orderId` | member | `{status}`; invalid transition → 409                           |
| GET    | `/api/crm/:workspaceId/summary`   | member   | Honest live counts: contacts, active products, pipeline by status, orders this month |

## QR Restaurant Menu (`/api/qrmenu/:workspaceId`, M4b)

Management endpoints (same membership rules as CRM). `is_available=false` hides
the item from the public menu without deleting history.

| Method | Path                                    | Min role | Description                                              |
| ------ | --------------------------------------- | -------- | -------------------------------------------------------- |
| GET    | `/api/qrmenu/:workspaceId/menu`         | member   | Menu items incl. sold-out ones (300 max)                 |
| POST   | `/api/qrmenu/:workspaceId/menu`         | member   | `{name, price_minor, description?}` → 201, workspace currency pinned |
| PATCH  | `/api/qrmenu/:workspaceId/menu/:itemId` | member   | `{is_available: true|false}` — live availability         |
| GET    | `/api/apps/workspace/:id/usage/qr-menu`  | member   | `{used, limit}` scan meter for the month                 |

### Public menu (the QR endpoint — **no session by design**)

| Method | Path                                   | Description                                             |
| ------ | -------------------------------------- | ------------------------------------------------------- |
| GET    | `/api/public/qrmenu/:workspaceId`      | `{workspace:{name,currency}, limited, items[]}`         |

- The scan meter records one `qr-menu.scans` unit per fetch while the plan
  allows it. Past the plan limit (Free: 200/month) the endpoint returns 200
  with `limited: true` and **no items** — the public page shows an honest
  "menu temporarily unavailable" notice instead of fake data.
- The public payload is deliberately minimal: `name`, `description`,
  `price_minor`, `currency` only — no IDs, no costs, no contacts, nothing
  the scanner didn't ask for.
- The QR code itself encodes the same-origin `/menu/:workspaceId` page; it is
  generated client-side with the free MIT `qrcode` library — no paid service
  and no menu images are stored.

Financial integrity rules enforced server-side:

- **Catalog prices win**: items sent with `product_id` are re-priced from the
  workspace catalog; the client's typed price is ignored.
- **Exact math only**: every line total is `(unit_price_minor × qty_millis) / 1000`
  computed on the server; if the product isn't exact, the order is rejected (422).
- **Own currency pinned** to the workspace; catalog mismatches are rejected.
- **Cancellation never erases the meter**: usage counts real order creation.

## Invoices & Quotations (`/api/invoices/:workspaceId`, M4c)

Documents for billing and bidding. `type` selects the lifecycle: invoices go
`draft → sent → paid|void`, quotations go `draft → sent → accepted|declined|
expired|void`. Documents are financial records — **there is no DELETE route**;
they move forward or are voided, never destroyed.

| Method | Path                                  | Min role | Description                                                     |
| ------ | ------------------------------------- | -------- | --------------------------------------------------------------- |
| GET    | `/api/invoices/:workspaceId`          | member   | Documents (200 max, newest first); `?type=invoice\|quotation` filter |
| POST   | `/api/invoices/:workspaceId`          | member   | Create draft — see body below → 201 `{document, items}`         |
| GET    | `/api/invoices/:workspaceId/:docId`   | member   | Document + line items + payment intents                         |
| PATCH  | `/api/invoices/:workspaceId/:docId`   | member   | `{status}` — forward-only transition, 409 on invalid move        |
| POST   | `/api/invoices/:workspaceId/:docId/payment-link` | member | `{provider}` — create/replay a payable link for a sent invoice |

POST body: `{type, customer_id? | client_name, client_email?, client_address?,
due_date? (invoices only, YYYY-MM-DD), tax_minor?, notes?, items:[{name,
qty_millis, unit_price_minor}]}`. Numbers are sequential per workspace and type
(`INV-0001`, `QTN-0001`).

Financial integrity rules enforced server-side:

- **Exact math only**: line totals are computed on the server; a line whose
  `unit_price × qty` isn't a whole minor unit is rejected (422).
- **Totals**: `total = Σ line_totals + tax_minor`, integer minor units only,
  workspace currency pinned on the document.
- **Client identity**: either a `customer_id` that belongs to this workspace
  (404 otherwise) or a typed `client_name` — never both required, never
  cross-tenant.
- **Metering**: every created document (both types) consumes one
  `invoices.monthly` unit (Free: 5/month) → 403 past the limit with an honest
  explanation.
- **Status is audited**: every transition writes an audit entry with from/to.
- **Manual `paid` = owner attestation** (they received the money outside the
  platform). It also cancels any pending online payment intent for that invoice,
  so a later webhook cannot double-count the same money.
- **Verified invoice payment (M5b)**: `POST …/:docId/payment-link` creates one
  payment intent for the full invoice total (the same pending link is replayed
  instead of duplicated). A hosted link returns the configured checkout URL; a
  bank/Raast/Payoneer link returns transfer instructions and an `MB-…` reference.
  The invoice becomes `paid` **only** when confirmed receipts cover its total —
  via a signed webhook or an admin-verified bank receipt. Invoice payments carry
  `plan_id = NULL`, so they never activate a subscription.
- **PDF export**: the print view (`/app/invoices/:docId/print`) uses the
  browser's print dialog — free, no third-party service. Server-side PDF
  generation is **flagged for approval** before it ships (see roadmap).

## Appointment Booking (`/api/appointments/:workspaceId`, Phase 2)

| Method | Path                                                | Min role | Description                                                     |
| ------ | --------------------------------------------------- | -------- | --------------------------------------------------------------- |
| GET    | `/api/appointments/:workspaceId`                    | member   | Latest 50 appointments with owner name, newest first            |
| POST   | `/api/appointments/:workspaceId`                    | member   | `{title, description?, start_at, end_at}` (ISO) → 201 `{appointment:{id}}` |
| PATCH  | `/api/appointments/:workspaceId/:appointmentId`     | admin    | `{status}` in `new|confirmed|completed|canceled` — audited       |
| DELETE | `/api/appointments/:workspaceId/:appointmentId`     | owner    | Removes the row (keep-client data lives elsewhere)               |

Behavior:

- `end_at` must parse and be after `start_at` (422 otherwise).
- Creating an appointment consumes one `appointments.monthly` unit
  (Free: 0 — upgrade required; Starter: 5; Pro: unlimited) → 403 past the limit.
  Usage is ledger-style: deleting an appointment never returns the metered unit.
- Status transitions are audited with actor + target.

## CV Generator (client-side, Phase 2)

The builder runs entirely in the browser (no CV API): structured editor →
live A4 preview → `window.print()` "Save as PDF". Drafts autosave to
`localStorage`. One of three templates (minimal / professional / creative) is
applied to the preview. Server-side CV storage and metered generation are
flagged for a later iteration; until then nothing user-authored leaves the
device.

## PDF Utilities (`/api/pdftools/:workspaceId`, Phase 2)

The heavy lifting (merge / extract pages / re-save with object streams) runs
**client-side with pdf-lib** — files never leave the browser. This endpoint
records and meters the completed operations so plan limits stay enforced:

| Method | Path                                  | Min role | Description                                                        |
| ------ | ------------------------------------- | -------- | ------------------------------------------------------------------ |
| GET    | `/api/pdftools/:workspaceId`          | member   | Last 50 operations (`kind`, `input_files`, `output_file`, times)   |
| POST   | `/api/pdftools/:workspaceId`          | member   | `{kind: merge|split|compress, input_names[1..20], output_name, output_bytes?}` → 201 |

Each recorded operation consumes one `pdf-tools.monthly` unit
(Free: 2/month; Starter: 10; Pro: unlimited) → 403 past the limit.
