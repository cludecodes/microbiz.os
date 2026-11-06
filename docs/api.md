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
| POST   | `/api/auth/register` | `{email,password(≥10),name,locale=en|ur}` → 201 + session; auto-creates first Free workspace |
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
| GET    | `/api/admin/subscriptions` | Latest 200 subscriptions with workspace + plan |
| GET    | `/api/admin/ledger`    | Latest 100 journals + postings + per-account totals; `?workspace_id=` scopes all three |

## Billing & subscriptions (`/api/billing`, M5a)

| Method | Path                                             | Min role | Description |
| ------ | ------------------------------------------------ | -------- | ----------- |
| GET    | `/api/billing/plans`                             | public   | Active plans + provider capabilities; `?currency=PKR\|USD` |
| GET    | `/api/billing/providers`                         | public   | Provider capability list with per-environment `configured` flag |
| GET    | `/api/billing/workspace/:workspaceId`            | member   | Subscription, workspace-currency plans, payment history, `can_manage_billing` |
| POST   | `/api/billing/workspace/:workspaceId/checkout`   | owner    | `{plan_id, provider, idempotency_key?}` → 201 `{payment, checkout}` |
| POST   | `/api/billing/workspace/:workspaceId/downgrade`  | owner    | Immediate switch to Free (no partial refunds) |
| GET    | `/api/billing/workspace/:workspaceId/payments/:paymentId` | member | Payment status (polling for hosted checkout) |

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
  `settled_at` set. Marking hosted payouts as settled is M5b.
- **Currency pinning**: PKR workspaces buy PKR plans only; USD workspaces buy
  USD plans only. Provider/currency mismatches are 422.
- **No hosted checkout without configuration**: missing webhook secret or
  payment-link template → 501 with the exact env var name. There is no fake
  checkout URL in this codebase.

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
| GET    | `/api/invoices/:workspaceId/:docId`   | member   | Document + line items                                           |
| PATCH  | `/api/invoices/:workspaceId/:docId`   | member   | `{status}` — forward-only transition, 409 on invalid move        |

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
  platform). Verified provider settlement for invoices (paying an invoice
  through a hosted checkout) is the next billing step (M5b); subscription
  payments already require a verified event before activation (see Billing).
- **PDF export**: the print view (`/app/invoices/:docId/print`) uses the
  browser's print dialog — free, no third-party service. Server-side PDF
  generation is **flagged for approval** before it ships (see roadmap).
