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

## Payment webhooks (provider signature auth; no CSRF, never browser-called)

| Method | Path                         | Auth                                |
| ------ | ---------------------------- | ----------------------------------- |
| POST   | `/api/webhooks/safepay`      | `X-SFPY-Signature` HMAC-SHA256 hex  |
| POST   | `/api/webhooks/lemonsqueezy` | `X-Signature` HMAC-SHA256 hex       |

Contract: verify signature → idempotent insert into `payment_events` by
`(provider, event_id)` → audit → and **only then** may status change. Invalid
signatures return 401 and are recorded but never trigger payment confirmation.
Provider-specific confirmation + ledger posting arrive in the payments
milestone (M5); today the handler refuses to mark anything paid.

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
