# MicroBiz OS

Multi-tenant SaaS portfolio serving **Pakistan 🇵🇰 and the United States 🇺🇸**. One platform powers
independent micro-webapps with unified authentication, database, subscriptions, payments,
analytics and administration.

## Stack

| Layer      | Technology                                                        | Cost |
| ---------- | ----------------------------------------------------------------- | ---- |
| Frontend   | React 18, TypeScript, Vite, Tailwind CSS, PWA (mobile-first)      | Free |
| API        | Cloudflare Workers (Hono)                                         | Free tier |
| Database   | Cloudflare D1 (SQLite) with migrations                            | Free tier |
| Repo/CD    | GitHub + Workers CI                                               | Free |

## Monorepo layout

```
microbiz-os/
├─ apps/
│  ├─ web/         React SPA (landing, dashboard, workspace + app shell)
│  └─ api/         Cloudflare Worker API (auth, workspaces, apps, admin, webhooks)
├─ packages/
│  └─ shared/      Money, entitlements, ledger invariants, Zod schemas, types
├─ docs/           Setup, API reference, deployment, roadmap/approvals
└─ .github/        CI (typecheck + test + build)
```

## Milestones

- [x] **M0** Repository and deployment foundation (npm workspaces, CI, docs, env template)
- [x] **M1** Shared kernel: integer money (PKR/USD), entitlements, double-entry ledger rules
- [x] **M2** API: full D1 schema (22 tables), auth/sessions, CSRF, rate limits, audit logs,
      roles, workspace isolation, super-admin, webhook ingestion contract
- [x] **M3** Web: landing, register/login, dashboard, workspaces & RBAC UI, app launcher
      with usage meters, settings (EN/UR + dark/light), PWA manifest + service worker
- [x] **M4a** WhatsApp CRM & Order Manager: contacts, catalog, order pipeline
      (server-computed totals, enforced status transitions), usage metering vs the
      Free plan limit, RBAC + tenant isolation — API + module UI + integration tests
- [ ] **M4b** Phase-1 products: QR menu, invoices
- [ ] **M5** Subscriptions, payment providers, settlement + ledger posting
- [ ] **M6** Super-admin analytics deepening
- [ ] **M7** Marketing, referrals, affiliate commissions
- [ ] **M8** Security hardening, coverage, production prep

## Quick start

```bash
npm install
npm run db:setup          # local D1 migrations + seed (runs wrangler local)
npm run dev:api           # Worker on http://localhost:8787
npm run dev:web           # Vite on http://localhost:5173 (proxies /api)
```

Then open http://localhost:5173, **Register**, and you land on the dashboard with
your first workspace created automatically.

## Tests

```bash
npm run test              # all workspaces (vitest)
# API integration tests run against a real workerd + local D1 (cloudflare:test)
```

## Principles

- Multi-tenant **workspace isolation** with server-side role checks everywhere.
- Deny-by-default entitlements; usage metering via `usage_events`.
- Money is **integer minor units** (paisa/cents) end-to-end.
- A **balanced double-entry ledger** underlies all financial postings.
- Payment status and **settlement status are tracked independently**.
- No customer wallets or escrow; no card data, CVV, banking passwords or OTPs stored.
- Never present mock data as genuine revenue; never mark unverified payments successful.

See [docs/setup.md](docs/setup.md), [docs/api.md](docs/api.md),
[docs/deployment.md](docs/deployment.md) and [docs/roadmap.md](docs/roadmap.md).
