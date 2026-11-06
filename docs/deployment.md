# Deployment guide (Cloudflare, free tier)

## 1. Cloudflare account + tools

```bash
npx wrangler login
```

## 2. Create the real D1 database

```bash
cd apps/api
npx wrangler d1 create microbiz
```

Copy the printed `database_id` into `apps/api/wrangler.jsonc` (replacing
`local-dev-placeholder`). Then apply migrations remotely and seed:

```bash
npm run db:migrate:remote
npm run db:seed:remote
```

## 3. Secrets (server-side only — never in wrangler.jsonc)

```bash
npx wrangler secret put SAFEPAY_WEBHOOK_SECRET
npx wrangler secret put LEMON_SQUEEZY_WEBHOOK_SECRET
# Optional per-plan hosted checkout links (see docs/providers.md)
npx wrangler secret put SAFEPAY_CHECKOUT_URL_TEMPLATE
npx wrangler secret put LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE
# Encrypts payout-profile account details (AES-256-GCM). Generate once:
#   openssl rand -base64 32
npx wrangler secret put PAYOUT_ENCRYPTION_KEY
```

Checkout and webhooks fail closed (501/401) until these are configured; saving
payout profiles fails closed (501) without `PAYOUT_ENCRYPTION_KEY`. Never put
real credentials in `wrangler.jsonc` or any committed file. Rotating the payout
key makes existing profiles undecryptable — owners must re-enter them.

```bash
# apply the M5b indexes (payout profile uniqueness, invoice payment lookups)
npm run db:migrate:remote
```

## 4. Deploy the worker

```bash
npm run deploy        # in apps/api
```

`ENVIRONMENT` defaults to production (secure cookies on HTTPS). In production
the Worker serves the SPA statically (or use a Pages project for `apps/web/dist`
connected to the same `/api` custom domain).
TODO(M4): add `assets` binding in wrangler.jsonc to serve the built SPA from the
same Worker, or attach a Pages project and route `*/api/*` to this Worker.

## 5. Frontend

```bash
cd apps/web && npm run build   # outputs dist/
npx wrangler pages deploy dist --project-name microbiz-web
```

PWA: `manifest.webmanifest` + `sw.js` are served from `public/` automatically.

## 6. Payment provider onboarding (M5)

1. Create the provider account in **sandbox** first (Safepay / Lemon Squeezy).
2. Create one payment link per plan in the provider dashboard.
3. Set the webhook endpoint to `https://<api-domain>/api/webhooks/safepay` or
   `/api/webhooks/lemonsqueezy`.
4. Store the signing secret and link template with `wrangler secret put`
   (names above), then redeploy so the Worker sees them.
5. Send a sandbox event and confirm: invalid signature → 401, valid event with
   the wrong amount → 409 and the payment stays pending, valid event → 200 with
   `confirmed: true`, plan switched and one balanced ledger journal.
6. Only then switch the provider dashboard to live mode. See
   [docs/providers.md](providers.md) for payload contracts and the ledger rules.

## 7. Post-deploy checks

- `GET /api/health` → 200
- `GET /api/ready` → 200 (D1 reachable)
- Register a user, create a workspace, add a member by email, verify the audit
  log in the super-admin view.
- Confirm cookies are `Secure; HttpOnly; SameSite=Lax` in production.
- Billing: hosted checkout returns 501 until secrets exist (expected); a bank
  checkout creates an `awaiting_confirmation` payment with an `MB-…` reference.
- Payout profiles: saving works only with `PAYOUT_ENCRYPTION_KEY`; the response
  must show a masked account (never the full IBAN/account number).
- Invoice payment link: create one for a sent invoice; confirm it via a sandbox
  webhook (hosted) or admin reconciliation (bank) and verify the invoice becomes
  `paid` with a balanced ledger journal.
- Settlement: mark a hosted payout settled with the real bank amount and verify
  the `payout_fees` shortfall posting.
- Super-admin `/api/admin/ledger` shows balanced journals only; no seeded rows.

## Rollback

Wrangler keeps versions: `npx wrangler rollback` reverts to the previous
deployment.
