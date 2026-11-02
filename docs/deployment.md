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
npx wrangler secret put LEMON_SQUEEZE_WEBHOOK_SECRET
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

## 6. Post-deploy checks

- `GET /api/health` → 200
- `GET /api/ready` → 200 (D1 reachable)
- Register a user, create a workspace, add a member by email, verify the audit
  log in the super-admin view.
- Confirm cookies are `Secure; HttpOnly; SameSite=Lax` in production.

## Rollback

Wrangler keeps versions: `npx wrangler rollback` reverts to the previous
deployment.
