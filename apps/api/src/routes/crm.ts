import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { recordUsage, currentUsage, loadWorkspaceEntitlements, decideFeature } from "../lib/entitlements";
import {
  contactCreateSchema,
  contactPatchSchema,
  productCreateSchema,
  orderCreateSchema,
  orderStatusPatchSchema,
  ORDER_STATUS_TRANSITIONS,
} from "@microbiz/shared";

const ORDER_FEATURE = "whatsapp-crm.orders";

async function wsCtx(c: Context<{ Bindings: Env }>, workspaceId: string, minRole: "member" | "admin" | "owner") {
  return requireWorkspaceAccess(c, workspaceId, minRole);
}

export const crmRoutes = new Hono<{ Bindings: Env }>();

// ------------------------------------------------------------------ contacts

crmRoutes.get("/:workspaceId/contacts", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, phone, email, locale, tags, notes, created_at FROM customers
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 500`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ contacts: rows.results });
});

crmRoutes.post("/:workspaceId/contacts", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
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
  const parsed = contactCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO customers (id, workspace_id, name, phone, email, locale, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.workspace.id,
      parsed.data.name,
      parsed.data.phone,
      parsed.data.email || null,
      parsed.data.locale,
      JSON.stringify(parsed.data.tags),
      parsed.data.notes,
      nowIso(),
      nowIso()
    )
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.contact.create",
    target_type: "customer",
    target_id: id,
  });
  return c.json({ contact: { id, ...parsed.data, created_at: nowIso() } }, 201);
});

crmRoutes.patch("/:workspaceId/contacts/:contactId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
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
  const parsed = contactPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  const existing = await c.env.DB.prepare(
    `SELECT id, tags FROM customers WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("contactId"), ctx.workspace.id)
    .first();
  if (!existing) return jsonError(c, 404, "Contact not found");

  const d = parsed.data;
  const sets = ["updated_at = ?"];
  const vals: unknown[] = [nowIso()];
  if (d.name !== undefined) (sets.push("name = ?"), vals.push(d.name));
  if (d.phone !== undefined) (sets.push("phone = ?"), vals.push(d.phone));
  if (d.email !== undefined) (sets.push("email = ?"), vals.push(d.email || null));
  if (d.locale !== undefined) (sets.push("locale = ?"), vals.push(d.locale));
  if (d.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(d.tags)));
  if (d.notes !== undefined) (sets.push("notes = ?"), vals.push(d.notes));

  await c.env.DB.prepare(
    `UPDATE customers SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`
  )
    .bind(...vals, c.req.param("contactId"), ctx.workspace.id)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.contact.update",
    target_type: "customer",
    target_id: String(c.req.param("contactId")),
  });
  return c.json({ ok: true });
});

crmRoutes.delete("/:workspaceId/contacts/:contactId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "admin");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const ordersUsing = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE workspace_id = ? AND customer_id = ?`
  )
    .bind(ctx.workspace.id, c.req.param("contactId"))
    .first<{ n: number }>();
  if ((ordersUsing?.n ?? 0) > 0) {
    return jsonError(c, 409, "Contact has orders. Remove or reassign them before deleting.");
  }
  const out = await c.env.DB.prepare(`DELETE FROM customers WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("contactId"), ctx.workspace.id)
    .run();
  if (out.meta.changes === 0) return jsonError(c, 404, "Contact not found");

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.contact.delete",
    target_type: "customer",
    target_id: String(c.req.param("contactId")),
  });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- catalog

crmRoutes.get("/:workspaceId/products", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, kind, price_minor, currency, stock, active, created_at
     FROM products WHERE workspace_id = ? AND app_id = 'whatsapp-crm'
     ORDER BY active DESC, sort_order, created_at DESC LIMIT 500`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ products: rows.results });
});

crmRoutes.post("/:workspaceId/products", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
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
  const parsed = productCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO products (id, workspace_id, app_id, kind, name, description, price_minor, currency, stock, active, created_at, updated_at)
     VALUES (?, ?, 'whatsapp-crm', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.workspace.id,
      parsed.data.kind,
      parsed.data.name,
      parsed.data.description,
      parsed.data.price_minor,
      ctx.workspace.currency,
      parsed.data.stock ?? null,
      parsed.data.active ? 1 : 0,
      nowIso(),
      nowIso()
    )
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.product.create",
    target_type: "product",
    target_id: id,
    detail: { price_minor: parsed.data.price_minor, currency: ctx.workspace.currency },
  });
  return c.json({ product: { id, ...parsed.data, currency: ctx.workspace.currency } }, 201);
});

crmRoutes.delete("/:workspaceId/products/:productId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "admin");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  // Historical orders keep their line-item data; catalog entries deactivate.
  const out = await c.env.DB.prepare(
    `UPDATE products SET active = 0, updated_at = ? WHERE id = ? AND workspace_id = ?`
  )
    .bind(nowIso(), c.req.param("productId"), ctx.workspace.id)
    .run();
  if (out.meta.changes === 0) return jsonError(c, 404, "Product not found");

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.product.deactivate",
    target_type: "product",
    target_id: String(c.req.param("productId")),
  });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------- orders

crmRoutes.get("/:workspaceId/orders", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT o.id, o.number, o.status, o.channel, o.currency, o.subtotal_minor, o.tax_minor,
            o.total_minor, o.meta, o.created_at, o.customer_id, c.name AS customer_name,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.workspace_id = ? AND o.app_id = 'whatsapp-crm'
     ORDER BY o.created_at DESC LIMIT 200`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ orders: rows.results });
});

crmRoutes.get("/:workspaceId/orders/:orderId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const order = await c.env.DB.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ? AND o.workspace_id = ?`
  )
    .bind(c.req.param("orderId"), ctx.workspace.id)
    .first();
  if (!order) return jsonError(c, 404, "Order not found");
  const items = await c.env.DB.prepare(
    `SELECT id, product_id, name, qty_millis, unit_price_minor, total_minor FROM order_items WHERE order_id = ?`
  )
    .bind(String(order.id))
    .all();
  return c.json({ order, items: items.results });
});

crmRoutes.post("/:workspaceId/orders", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
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
  const parsed = orderCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const data = parsed.data;

  // Deny-by-default metered entitlement: monthly order count vs plan limit.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, ORDER_FEATURE, monthStart);
  const decision = decideFeature(ents, ORDER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(
      c,
      403,
      "Plan limit reached for WhatsApp orders",
      decision.reason === "limit_reached"
        ? `Used ${used} of your plan's monthly order allowance. Upgrade or wait for the next billing month.`
        : decision.reason
    );
  }

  // Optional customer must live in THIS workspace (tenant isolation).
  if (data.customer_id) {
    const customer = await c.env.DB.prepare(
      `SELECT id FROM customers WHERE id = ? AND workspace_id = ?`
    )
      .bind(data.customer_id, ctx.workspace.id)
      .first();
    if (!customer) return jsonError(c, 404, "Customer not found in this workspace");
  }

  // Resolve items server-side: catalog products are authoritative by price.
  const resolved: { product_id: string | null; name: string; qty_millis: number; unit_price_minor: number; total_minor: number }[] = [];
  for (const item of data.items) {
    let name = item.name;
    let unitPrice = item.unit_price_minor;
    let productId: string | null = null;
    if (item.product_id) {
      const product = await c.env.DB.prepare(
        `SELECT id, name, price_minor, currency, active FROM products WHERE id = ? AND workspace_id = ?`
      )
        .bind(item.product_id, ctx.workspace.id)
        .first<{ id: string; name: string; price_minor: number; currency: string; active: number }>();
      if (!product || product.active !== 1) {
        return jsonError(c, 422, `Unknown or inactive product: ${item.product_id}`);
      }
      if (product.currency !== ctx.workspace.currency) {
        return jsonError(c, 422, `Product currency ${product.currency} does not match workspace currency`);
      }
      productId = product.id;
      name = product.name;
      unitPrice = product.price_minor; // server decides, never the client
    }
    if (!name) {
      return jsonError(c, 422, "Each item needs a name or a product_id from this workspace's catalog");
    }
    const total = unitPrice * item.qty_millis;
    if (total % 1000 !== 0) {
      return jsonError(c, 422, `Item "${name}" has no exact minor-unit total (price x quantity must be divisible by 1000)`);
    }
    resolved.push({
      product_id: productId,
      name,
      qty_millis: item.qty_millis,
      unit_price_minor: unitPrice,
      total_minor: Math.floor(total / 1000),
    });
  }

  const subtotal = resolved.reduce((sum, r) => sum + r.total_minor, 0);
  const total = subtotal + data.tax_minor;

  // Sequential per-workspace number with collision retries.
  const counter = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE workspace_id = ?`)
    .bind(ctx.workspace.id)
    .first<{ n: number }>();
  let suffix = (counter?.n ?? 0) + 1;
  const orderId = uuid();
  const createdAt = nowIso();
  let inserted = false;
  let number = "";
  for (let attempt = 0; attempt < 4 && !inserted; attempt++) {
    number = `ORD-${String(suffix).padStart(4, "0")}`;
    try {
      await c.env.DB.prepare(
        `INSERT INTO orders (id, workspace_id, app_id, customer_id, number, status, channel, currency,
                             subtotal_minor, tax_minor, total_minor, meta, created_at, updated_at)
         VALUES (?, ?, 'whatsapp-crm', ?, ?, 'new', 'whatsapp', ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          orderId,
          ctx.workspace.id,
          data.customer_id ?? null,
          number,
          ctx.workspace.currency,
          subtotal,
          data.tax_minor,
          total,
          JSON.stringify({ note: data.note }),
          createdAt,
          createdAt
        )
        .run();
      inserted = true;
    } catch (err) {
      if (String(err).includes("UNIQUE")) suffix++;
      else throw err;
    }
  }
  if (!inserted) return jsonError(c, 409, "Could not allocate an order number, try again");

  await c.env.DB.batch(
    resolved.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, name, qty_millis, unit_price_minor, total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), orderId, r.product_id, r.name, r.qty_millis, r.unit_price_minor, r.total_minor)
    )
  );

  await recordUsage(c.env, ctx.workspace.id, "whatsapp-crm", ORDER_FEATURE, 1, { order_id: orderId, total_minor: total });
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.order.create",
    target_type: "order",
    target_id: orderId,
    detail: { number, total_minor: total, currency: ctx.workspace.currency },
  });

  return c.json(
    {
      order: {
        id: orderId,
        number,
        status: "new",
        currency: ctx.workspace.currency,
        subtotal_minor: subtotal,
        tax_minor: data.tax_minor,
        total_minor: total,
        created_at: createdAt,
      },
      items: resolved,
    },
    201
  );
});

crmRoutes.patch("/:workspaceId/orders/:orderId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
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
  const parsed = orderStatusPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const next = parsed.data.status;

  const order = await c.env.DB.prepare(
    `SELECT id, status, number FROM orders WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("orderId"), ctx.workspace.id)
    .first<{ id: string; status: string; number: string }>();
  if (!order) return jsonError(c, 404, "Order not found");

  const allowed = ORDER_STATUS_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(next)) {
    return jsonError(c, 409, `Cannot move order ${order.number} from ${order.status} to ${next}`);
  }

  await c.env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(next, nowIso(), order.id)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "crm.order.status_change",
    target_type: "order",
    target_id: order.id,
    detail: { from: order.status, to: next, number: order.number },
  });
  return c.json({ ok: true, status: next });
});

// -------------------------------------------------------------------- summary

crmRoutes.get("/:workspaceId/summary", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const [contacts, products, passing01, passing02, usage] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM customers WHERE workspace_id = ?`)
      .bind(ctx.workspace.id)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM products WHERE workspace_id = ? AND app_id = 'whatsapp-crm' AND active = 1`)
      .bind(ctx.workspace.id)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE workspace_id = ? AND app_id = 'whatsapp-crm' GROUP BY status`)
      .bind(ctx.workspace.id)
      .all<{ status: string; n: number }>(),
    Promise.resolve(null),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(quantity),0) AS used FROM usage_events
       WHERE workspace_id = ? AND feature_key = ? AND occurred_at >= ?`
    )
      .bind(ctx.workspace.id, ORDER_FEATURE, `${nowIso().slice(0, 7)}-01T00:00:00Z`)
      .first<{ used: number }>(),
  ]);

  const pipeline = Object.fromEntries((passing01?.results ?? []).map((r: { status: string; n: number }) => [r.status, r.n]));
  return c.json({
    contacts: contacts?.n ?? 0,
    products: products?.n ?? 0,
    pipeline,
    orders_this_month: usage?.used ?? 0,
  });
});
