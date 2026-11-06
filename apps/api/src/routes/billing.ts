import { Hono } from "hono";
import type { Env } from "../types";
import { BILLING_PROVIDERS, PROVIDER_CAPABILITIES, checkoutSchema, type BillingProvider, type CurrencyCode } from "@microbiz/shared";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { getPaymentForWorkspace, newTransferReference } from "../lib/billing";
import {
  createCheckoutSession,
  isProviderConfigured,
  PaymentProviderNotConfigured,
} from "../lib/payments/adapters";

export const billingRoutes = new Hono<{ Bindings: Env }>();

const PROVIDER_IDS = BILLING_PROVIDERS;

// ------------------------------------------------------------------- plans

/** Public plan catalog. No secrets, no per-workspace data. */
billingRoutes.get("/plans", async (c) => {
  const currency = c.req.query("currency");
  const rows = await c.env.DB.prepare(
    `SELECT id, name, price_minor, currency, limits, features, is_public, sort
     FROM plans WHERE is_active = 1 ${currency === "PKR" || currency === "USD" ? "AND currency = ?" : ""}
     ORDER BY currency, sort, price_minor`
  )
    .bind(...(currency === "PKR" || currency === "USD" ? [currency] : []))
    .all<{ id: string; name: string; price_minor: number; currency: CurrencyCode; limits: string; features: string }>();

  return c.json({
    plans: rows.results.map((p) => ({
      ...p,
      limits: JSON.parse(p.limits) as Record<string, number | null>,
      features: JSON.parse(p.features) as string[],
    })),
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_CAPABILITIES[id].label,
      mode: PROVIDER_CAPABILITIES[id].mode,
      currencies: PROVIDER_CAPABILITIES[id].currencies,
      description: PROVIDER_CAPABILITIES[id].description,
    })),
    note: "Prices are configuration. No payment exists until a provider verifies one.",
  });
});

// ------------------------------------------------------- workspace billing

billingRoutes.get("/workspace/:workspaceId", async (c) => {
  const ctx = await requireWorkspaceAccess(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const wsId = ctx.workspace.id;

  const subscription = await c.env.DB.prepare(
    `SELECT s.plan_id, s.status, s.provider, s.provider_ref, s.started_at,
            s.current_period_end, s.canceled_at, s.updated_at,
            p.name AS plan_name, p.price_minor, p.currency AS plan_currency
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.workspace_id = ?`
  )
    .bind(wsId)
    .first();

  const plans = await c.env.DB.prepare(
    `SELECT id, name, price_minor, currency, limits, features, sort
     FROM plans WHERE is_active = 1 AND currency = ? ORDER BY sort, price_minor`
  )
    .bind(ctx.workspace.currency)
    .all<{ id: string; name: string; price_minor: number; currency: CurrencyCode; limits: string; features: string }>();

  const payments = await c.env.DB.prepare(
    `SELECT pm.id, pm.provider, pm.provider_txn_ref, pm.amount_minor, pm.fee_minor, pm.currency,
            pm.status, pm.settlement_status, pm.refund_minor, pm.plan_id,
            pm.created_at, pm.confirmed_at, pm.settled_at,
            pl.name AS plan_name
     FROM payments pm LEFT JOIN plans pl ON pl.id = pm.plan_id
     WHERE pm.workspace_id = ?
     ORDER BY pm.created_at DESC LIMIT 25`
  )
    .bind(wsId)
    .all();

  return c.json({
    subscription,
    plans: plans.results.map((p) => ({
      ...p,
      limits: JSON.parse(p.limits) as Record<string, number | null>,
      features: JSON.parse(p.features) as string[],
    })),
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_CAPABILITIES[id].label,
      mode: PROVIDER_CAPABILITIES[id].mode,
      currencies: PROVIDER_CAPABILITIES[id].currencies,
      description: PROVIDER_CAPABILITIES[id].description,
      /** Hosted providers stay disabled until the owner configures secrets. */
      configured: isProviderConfigured(c.env, id),
    })),
    payments: payments.results,
    can_manage_billing: ctx.membership.role === "owner",
  });
});

// ----------------------------------------------------------------- checkout

billingRoutes.post("/workspace/:workspaceId/checkout", async (c) => {
  const ctx = await requireWorkspaceAccess(c, c.req.param("workspaceId"), "owner");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const wsId = ctx.workspace.id;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { plan_id, provider, idempotency_key } = parsed.data;

  // Idempotent replay: the same key returns the same payment, never a second one.
  if (idempotency_key) {
    const existing = await c.env.DB.prepare(
      `SELECT id, workspace_id, plan_id, provider, provider_txn_ref, amount_minor, fee_minor,
              currency, status, settlement_status, refund_minor, created_at
       FROM payments WHERE idempotency_key = ? AND workspace_id = ?`
    )
      .bind(idempotency_key, wsId)
      .first<{
        id: string;
        plan_id: string;
        provider: BillingProvider;
        provider_txn_ref: string;
        amount_minor: number;
        currency: CurrencyCode;
        status: string;
      }>();
    if (existing) {
      const plan = await c.env.DB.prepare(`SELECT name FROM plans WHERE id = ?`)
        .bind(existing.plan_id)
        .first<{ name: string }>();
      let checkout = null;
      try {
        checkout = createCheckoutSession(c.env, existing.provider, {
          reference: existing.provider_txn_ref,
          amountMinor: existing.amount_minor,
          currency: existing.currency,
          planName: plan?.name ?? existing.plan_id,
        });
      } catch (err) {
        if (!(err instanceof PaymentProviderNotConfigured)) throw err;
        // Existing intent stays valid; hosted checkout is currently disabled.
      }
      return c.json({ payment: existing, checkout, replayed: true });
    }
  }

  const plan = await c.env.DB.prepare(
    `SELECT id, name, price_minor, currency, is_active FROM plans WHERE id = ?`
  )
    .bind(plan_id)
    .first<{ id: string; name: string; price_minor: number; currency: CurrencyCode; is_active: number }>();
  if (!plan) return jsonError(c, 404, "Plan not found");
  if (!plan.is_active) return jsonError(c, 409, "This plan is not available for purchase");
  if (plan.price_minor <= 0) return jsonError(c, 409, "Free plan needs no checkout — use the switch-to-Free action");
  if (plan.currency !== ctx.workspace.currency) {
    return jsonError(c, 422, `This workspace bills in ${ctx.workspace.currency}; ${plan.id} is priced in ${plan.currency}`);
  }
  if (ctx.workspace.plan_id === plan.id) return jsonError(c, 409, "This workspace is already on that plan");
  if (!PROVIDER_CAPABILITIES[provider].currencies.includes(plan.currency)) {
    return jsonError(c, 422, `${PROVIDER_CAPABILITIES[provider].label} cannot settle ${plan.currency}`);
  }

  // Provider-side reference: short, human-readable, unique per provider.
  let reference = newTransferReference();
  for (let i = 0; i < 3; i++) {
    const clash = await c.env.DB.prepare(
      `SELECT 1 FROM payments WHERE provider = ? AND provider_txn_ref = ?`
    )
      .bind(provider, reference)
      .first();
    if (!clash) break;
    reference = newTransferReference();
  }

  let checkout;
  try {
    checkout = createCheckoutSession(c.env, provider, {
      reference,
      amountMinor: plan.price_minor,
      currency: plan.currency,
      planName: plan.name,
    });
  } catch (err) {
    if (err instanceof PaymentProviderNotConfigured) {
      return jsonError(c, 501, err.message, "Configure the provider secrets and payment-link template before enabling this checkout.");
    }
    throw err;
  }

  const id = uuid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO payments (id, workspace_id, plan_id, provider, provider_txn_ref, amount_minor, fee_minor,
                           currency, status, settlement_status, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'awaiting_confirmation', 'pending', ?, ?)`
  )
    .bind(id, wsId, plan.id, provider, reference, plan.price_minor, plan.currency, idempotency_key ?? null, ts)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: wsId,
    action: "billing.checkout_initiated",
    target_type: "payment",
    target_id: id,
    detail: { plan_id: plan.id, provider, amount_minor: plan.price_minor, currency: plan.currency, reference },
  });

  return c.json(
    {
      payment: {
        id,
        workspace_id: wsId,
        plan_id: plan.id,
        provider,
        provider_txn_ref: reference,
        amount_minor: plan.price_minor,
        fee_minor: 0,
        currency: plan.currency,
        status: "awaiting_confirmation",
        settlement_status: "pending",
        refund_minor: 0,
        created_at: ts,
      },
      checkout,
    },
    201
  );
});

// ----------------------------------------------------------------- downgrade

billingRoutes.post("/workspace/:workspaceId/downgrade", async (c) => {
  const ctx = await requireWorkspaceAccess(c, c.req.param("workspaceId"), "owner");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const wsId = ctx.workspace.id;

  const sub = await c.env.DB.prepare(
    `SELECT plan_id, status FROM subscriptions WHERE workspace_id = ?`
  )
    .bind(wsId)
    .first<{ plan_id: string; status: string }>();
  if (!sub) return jsonError(c, 404, "Subscription not found");
  if (sub.plan_id === "free") return jsonError(c, 409, "This workspace is already on the Free plan");

  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE workspaces SET plan_id = 'free' WHERE id = ?`).bind(wsId),
    c.env.DB.prepare(
      `UPDATE subscriptions
       SET plan_id = 'free', status = 'active', provider = 'manual', provider_ref = NULL,
           current_period_end = NULL, canceled_at = ?, updated_at = ?
       WHERE workspace_id = ?`
    ).bind(ts, ts, wsId),
  ]);

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: wsId,
    action: "billing.downgrade",
    target_type: "subscription",
    target_id: wsId,
    detail: { from_plan: sub.plan_id, to_plan: "free", refunded: false },
  });

  return c.json({
    ok: true,
    plan_id: "free",
    note: "Downgrade is immediate. Unused paid time is not refunded — refunds are handled as audited admin actions.",
  });
});

// ---------------------------------------------------------- payment status

billingRoutes.get("/workspace/:workspaceId/payments/:paymentId", async (c) => {
  const ctx = await requireWorkspaceAccess(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const payment = await getPaymentForWorkspace(c.env, ctx.workspace.id, c.req.param("paymentId"));
  if (!payment) return jsonError(c, 404, "Payment not found");
  return c.json({ payment });
});

/** Providers list for UI (kept small; configuration status per environment). */
billingRoutes.get("/providers", (c) => {
  return c.json({
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_CAPABILITIES[id].label,
      mode: PROVIDER_CAPABILITIES[id].mode,
      currencies: PROVIDER_CAPABILITIES[id].currencies,
      description: PROVIDER_CAPABILITIES[id].description,
      configured: isProviderConfigured(c.env, id),
    })),
  });
});
