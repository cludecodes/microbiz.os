import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import { csrfCookieMatchesHeader, issueCsrfCookie } from "./lib/auth";
import { jsonError, nowIso } from "./lib/http";
import { rateLimit } from "./lib/ops";
import { authRoutes } from "./routes/auth";
import { workspaceRoutes } from "./routes/workspaces";
import { appRoutes } from "./routes/apps";
import { adminRoutes } from "./routes/admin";
import { webhookRoutes } from "./routes/webhooks";
import { crmRoutes } from "./routes/crm";
import { qrMenuRoutes, qrMenuPublicRoutes } from "./routes/qrmenu";
import { invoiceRoutes } from "./routes/invoices";
import { appointmentsRoutes } from "./routes/appointments";
import { pdfToolsRoutes } from "./routes/pdftools";
import { billingRoutes } from "./routes/billing";
import { referralRoutes } from "./routes/referrals";
import { commissionRoutes } from "./routes/commissions";
import { digitalRoutes, digitalPublicRoutes } from "./routes/digital";
import { leadMarketRoutes } from "./routes/leadmarket";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------- middleware

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // hero SPA styles
    scriptSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
  },
  referrerPolicy: "strict-origin-when-cross-origin",
  crossOriginResourcePolicy: "same-origin",
}));

/**
 * Double-submit CSRF for every mutating request.
 * Webhook paths are exempt: they authenticate by provider signature instead
 * and are not called from a browser.
 */
app.use("/api/*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname;
  const isWebhook = path.startsWith("/api/webhooks/");
  if (["GET", "HEAD", "OPTIONS"].includes(method) || isWebhook) return next();

  if (!csrfCookieMatchesHeader(c)) {
    issueCsrfCookie(c);
    return jsonError(c, 403, "CSRF token missing or invalid");
  }
  return next();
});

// Basic global rate limit: 600 requests / 5 min per IP (auth routes add stricter limits).
app.use("/api/*", async (c, next) => {
  if (new URL(c.req.url).pathname.startsWith("/api/webhooks/")) return next();
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await rateLimit(c, "global", ip, 600, 5 * 60);
  if (!rl.ok) return jsonError(c, 429, "Rate limit exceeded");
  return next();
});

// ------------------------------------------------------------------- routes

app.onError((err, c) => {
  if (err.message?.startsWith("PAYMENT_PROVIDER_NOT_CONFIGURED:")) {
    return jsonError(c, 501, err.message);
  }
  console.error("unhandled error", err);
  return jsonError(c, 500, "Internal server error");
});

app.notFound((c) => jsonError(c, 404, "Not found"));

app.get("/api/health", (c) =>
  c.json({ status: "ok", time: nowIso(), env: c.env.ENVIRONMENT ?? "unknown" })
);

app.get("/api/ready", async (c) => {
  try {
    await c.env.DB.prepare(`SELECT 1 AS ok`).first();
    return c.json({ status: "ready", database: "ok" });
  } catch {
    return jsonError(c, 503, "Database unavailable");
  }
});

app.route("/api/auth", authRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/apps", appRoutes);
app.route("/api/crm", crmRoutes); // /api/crm/:workspaceId/* — Phase 1 WhatsApp CRM
app.route("/api/qrmenu", qrMenuRoutes); // /api/qrmenu/:workspaceId/* — Phase 1 QR menu management
app.route("/api/invoices", invoiceRoutes); // /api/invoices/:workspaceId/* — Phase 1 invoices & quotations
app.route("/api/billing", billingRoutes); // /api/billing/* — plans, subscriptions, checkout, payment status
app.route("/api/digital/:workspaceId", digitalRoutes); // /api/digital/:workspaceId/* — Phase 2 digital product sales
app.route("/api/leadmarket/:workspaceId", leadMarketRoutes); // /api/leadmarket/:workspaceId/* — Phase 3 lead marketplace
app.route("/api/referrals", referralRoutes); // /api/referrals/* — M7 referral codes & conversions
app.route("/api/commissions", commissionRoutes); // /api/commissions/* — M7 affiliate commissions ledger
app.route("/api/appointments/:workspaceId", appointmentsRoutes); // /api/appointments/:workspaceId/* — Phase 2 appointment booking
app.route("/api/pdftools/:workspaceId", pdfToolsRoutes); // /api/pdftools/:workspaceId/* — Phase 2 PDF tools metering
app.route("/api/public", qrMenuPublicRoutes); // /api/public/qrmenu/:workspaceId — behind the QR sticker, no auth
app.route("/api/public", digitalPublicRoutes); // /api/public/digital/:workspaceId/:purchaseId — token-gated delivery
app.route("/api/admin", adminRoutes); // /api/admin/*
app.route("/api", webhookRoutes); // /api/webhooks/* — provider signature auth

export default app;
