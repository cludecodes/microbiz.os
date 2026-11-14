import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { recordUsage, currentUsage, loadWorkspaceEntitlements, decideFeature } from "../lib/entitlements";
import { generateToken } from "../lib/crypto";
import { newUniquePaymentReference } from "../lib/billing";
import {
  digitalProductCreateSchema,
  digitalProductPatchSchema,
  digitalPurchaseCreateSchema,
  PROVIDER_CAPABILITIES,
  type BillingProvider,
} from "@microbiz/shared";
import {
  createCheckoutSession,
  PaymentProviderNotConfigured,
} from "../lib/payments/adapters";

const METER_FEATURE = "digital-downloads.monthly";

/** The mount path (`/api/digital/:workspaceId`) provides the param; Hono's
 *  generic typing just can't see it inside a sub-app (same as appointments). */
const workspaceIdParam = (c: { req: { param: (k: string) => string | undefined } }) =>
  c.req.param("workspaceId") as string;

async function wsCtx(c: Context<{ Bindings: Env }>, workspaceId: string, minRole: "member" | "admin" | "owner") {
  return requireWorkspaceAccess(c, workspaceId, minRole);
}

export const digitalRoutes = new Hono<{ Bindings: Env }>();

// ------------------------------------------------------------------- products

digitalRoutes.get("/", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, price_minor, currency, file_url, delivery_note, active, created_at, updated_at
       FROM digital_products WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ products: rows.results });
});

digitalRoutes.post("/", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = digitalProductCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const data = parsed.data;

  // Deny-by-default metered entitlement: published products per month.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, METER_FEATURE, monthStart);
  const decision = decideFeature(ents, METER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(c, 403, `Monthly product limit reached (${decision.reason}). Upgrade the plan to publish more.`);
  }

  const id = uuid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO digital_products (id, workspace_id, name, description, price_minor, currency, file_url, delivery_note, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, ctx.workspace.id, data.name, data.description, data.price_minor, data.currency, data.file_url, data.delivery_note, ts, ts)
    .run();
  await recordUsage(c.env, ctx.workspace.id, "digital-downloads", METER_FEATURE, 1, { product_id: id });
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "digital.product_created",
    target_type: "digital_product",
    target_id: id,
    detail: { name: data.name, price_minor: data.price_minor, currency: data.currency },
  });

  return c.json(
    {
      product: { id, name: data.name, description: data.description, price_minor: data.price_minor, currency: data.currency, file_url: data.file_url, delivery_note: data.delivery_note, active: 1, created_at: ts, updated_at: ts },
    },
    201
  );
});

digitalRoutes.patch("/:productId", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = digitalProductPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const patch = parsed.data;

  const product = await c.env.DB.prepare(
    `SELECT id FROM digital_products WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("productId"), ctx.workspace.id)
    .first<{ id: string }>();
  if (!product) return jsonError(c, 404, "Product not found");

  await c.env.DB.prepare(
    `UPDATE digital_products
        SET name = COALESCE(?, name),
            description = COALESCE(?, description),
            price_minor = COALESCE(?, price_minor),
            currency = COALESCE(?, currency),
            file_url = COALESCE(?, file_url),
            delivery_note = COALESCE(?, delivery_note),
            active = COALESCE(?, active),
            updated_at = ?
      WHERE id = ?`
  )
    .bind(
      patch.name ?? null,
      patch.description ?? null,
      patch.price_minor ?? null,
      patch.currency ?? null,
      patch.file_url ?? null,
      patch.delivery_note ?? null,
      patch.active === undefined ? null : patch.active ? 1 : 0,
      nowIso(),
      product.id
    )
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "digital.product_updated",
    target_type: "digital_product",
    target_id: product.id,
    detail: { fields: Object.keys(patch) },
  });

  const updated = await c.env.DB.prepare(
    `SELECT id, name, description, price_minor, currency, file_url, delivery_note, active, created_at, updated_at
       FROM digital_products WHERE id = ?`
  )
    .bind(product.id)
    .first();
  return c.json({ product: updated });
});

digitalRoutes.delete("/:productId", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const product = await c.env.DB.prepare(
    `SELECT id, name FROM digital_products WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("productId"), ctx.workspace.id)
    .first<{ id: string; name: string }>();
  if (!product) return jsonError(c, 404, "Product not found");

  // Soft archive: historical purchases keep referencing the product.
  await c.env.DB.prepare(
    `UPDATE digital_products SET active = 0, updated_at = ? WHERE id = ?`
  )
    .bind(nowIso(), product.id)
    .run();
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "digital.product_archived",
    target_type: "digital_product",
    target_id: product.id,
    detail: { name: product.name },
  });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ purchases

digitalRoutes.get("/purchases", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.product_id, p.buyer_email, p.status, p.delivery_token, p.created_at, p.paid_at, p.delivered_at,
            pr.name AS product_name, pr.price_minor, pr.currency,
            pay.provider AS payment_provider, pay.status AS payment_status, pay.provider_txn_ref
       FROM digital_purchases p
       JOIN digital_products pr ON pr.id = p.product_id
       LEFT JOIN payments pay ON pay.id = p.payment_id
      WHERE p.workspace_id = ?
      ORDER BY p.created_at DESC LIMIT 200`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ purchases: rows.results });
});

digitalRoutes.post("/purchases", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = digitalPurchaseCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { product_id, buyer_email, provider } = parsed.data;

  const product = await c.env.DB.prepare(
    `SELECT id, name, price_minor, currency FROM digital_products
      WHERE id = ? AND workspace_id = ? AND active = 1`
  )
    .bind(product_id, ctx.workspace.id)
    .first<{ id: string; name: string; price_minor: number; currency: "PKR" | "USD" }>();
  if (!product) return jsonError(c, 404, "Active product not found");

  if (!PROVIDER_CAPABILITIES[provider].currencies.includes(product.currency)) {
    return jsonError(c, 422, `${PROVIDER_CAPABILITIES[provider].label} cannot settle ${product.currency}`);
  }

  const reference = await newUniquePaymentReference(c.env, provider);
  let checkout;
  try {
    checkout = createCheckoutSession(c.env, provider, {
      reference,
      amountMinor: product.price_minor,
      currency: product.currency,
      planName: product.name,
      label: `digital ${product.name}`,
    });
  } catch (err) {
    if (err instanceof PaymentProviderNotConfigured) {
      return jsonError(c, 501, err.message, "Configure the provider secrets and payment-link template before enabling this checkout.");
    }
    throw err;
  }

  const purchaseId = uuid();
  const paymentId = uuid();
  const deliveryToken = generateToken();
  const ts = nowIso();
  await c.env.DB.batch([
    // Payment first: digital_purchases.payment_id references payments(id).
    c.env.DB.prepare(
      `INSERT INTO payments (id, workspace_id, invoice_id, purchase_id, plan_id, provider, provider_txn_ref,
                             amount_minor, fee_minor, currency, status, settlement_status, created_at)
       VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, 0, ?, 'awaiting_confirmation', 'pending', ?)`
    ).bind(paymentId, ctx.workspace.id, purchaseId, provider, reference, product.price_minor, product.currency, ts),
    c.env.DB.prepare(
      `INSERT INTO digital_purchases (id, workspace_id, product_id, buyer_email, payment_id, status, delivery_token, created_at)
       VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)`
    ).bind(purchaseId, ctx.workspace.id, product.id, buyer_email, paymentId, deliveryToken, ts),
  ]);

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "digital.purchase_created",
    target_type: "digital_purchase",
    target_id: purchaseId,
    detail: { product_id: product.id, buyer_email, provider, reference, amount_minor: product.price_minor },
  });

  return c.json(
    {
      purchase: { id: purchaseId, product_id: product.id, buyer_email, status: "awaiting_payment", delivery_token: deliveryToken, created_at: ts, paid_at: null, delivered_at: null },
      payment: { id: paymentId, provider, provider_txn_ref: reference, amount_minor: product.price_minor, currency: product.currency, status: "awaiting_confirmation" },
      checkout,
    },
    201
  );
});

export default digitalRoutes;

/** Public delivery endpoint — no session, gated by the purchase's secret
 *  delivery token. The file is only revealed once the payment is confirmed. */
export const digitalPublicRoutes = new Hono<{ Bindings: Env }>();

digitalPublicRoutes.get("/digital/:workspaceId/:purchaseId", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return jsonError(c, 403, "Delivery token required");

  const purchase = await c.env.DB.prepare(
    `SELECT p.id, p.status, p.delivery_token, p.delivered_at,
            pr.name AS product_name, pr.description AS product_description,
            pr.file_url, pr.delivery_note
       FROM digital_purchases p
       JOIN digital_products pr ON pr.id = p.product_id
      WHERE p.id = ? AND p.workspace_id = ?`
  )
    .bind(c.req.param("purchaseId"), c.req.param("workspaceId"))
    .first<{
      id: string;
      status: string;
      delivery_token: string;
      delivered_at: string | null;
      product_name: string;
      product_description: string;
      file_url: string;
      delivery_note: string;
    }>();
  if (!purchase || purchase.delivery_token !== token) return jsonError(c, 404, "Purchase not found");
  if (purchase.status !== "delivered") {
    return jsonError(c, 403, "The download unlocks once the payment is confirmed.");
  }

  return c.json({
    status: purchase.status,
    delivered_at: purchase.delivered_at,
    product: {
      name: purchase.product_name,
      description: purchase.product_description,
      file_url: purchase.file_url,
      delivery_note: purchase.delivery_note,
    },
  });
});
