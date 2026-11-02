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
