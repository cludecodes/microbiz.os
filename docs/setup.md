# Local setup guide

## Prerequisites

- Node.js ≥ 20 (tested with 26)
- npm ≥ 10
- A Cloudflare account (free) — only needed for deployment, not local dev

## 1. Install

```bash
npm install
```

## 2. Create the local database

`apps/api/wrangler.jsonc` binds a D1 database named `microbiz`. The
`database_id` shipped is a local placeholder — fine for local and test runs
(`--local` mode). For deployment, create your own database first (see
[deployment.md](deployment.md)).

```bash
npm run db:setup     # applies migrations/ + seed (plans, applications)
```

## 3. Run the stack

Two terminals:

```bash
npm run dev:api     # http://127.0.0.1:8787
npm run dev:web     # http://localhost:5173  (proxies /api -> 8787)
```

The dev proxy exists so session cookies remain **first-party** (SameSite=Lax,
same origin) even in development. In production the Worker serves the API under
`/api` of the same domain.

## 4. Environment & secrets

- `apps/web/.env.local` — see root `.env.example` (frontend values only).
- `apps/api/.dev.vars` — copy from `.dev.vars.example` for local-only secrets
  (e.g. provider webhook secrets). This file is gitignored; **never** commit it.
- Production secrets go through `wrangler secret put ...` — never in wrangler.jsonc.

## 5. Tests

```bash
npm run test         # shared unit tests + API unit/integration (workerd + D1)
npm run typecheck
```

The API integration suite (`apps/api/test/api.test.ts`) exercises real HTTP
flows against workerd with a migrated local D1: registration, CSRF rejection,
session auth, RBAC workspace access, entitlements and webhook signature
rejection.

## 6. Useful commands

```bash
npm run db:migrate:local              # re-apply local migrations
npm run db:seed:local                 # re-run seed.sql
npx wrangler d1 execute microbiz --local --command "SELECT COUNT(*) FROM plans -- FROM workspaces"
```

## 7. Super-admin user

There is deliberately **no sign-up endpoint for super admins**. Promote a user
directly in the database (local dev):

```sql
UPDATE users SET is_super_admin = 1 WHERE email = 'you@example.com';
```

For production, run the same statement against the remote database while
authenticated to Cloudflare — and record it in the audit process.
