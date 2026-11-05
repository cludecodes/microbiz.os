import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { recordUsage, currentUsage, loadWorkspaceEntitlements, decideFeature } from "../lib/entitlements";
import { qrMenuItemCreateSchema, qrMenuItemPatchSchema } from "@microbiz/shared";

const SCAN_FEATURE = "qr-menu.scans";

async function wsCtx(c: Context<{ Bindings: Env }>, workspaceId: string, minRole: "member" | "admin" | "owner") {
  return requireWorkspaceAccess(c, workspaceId, minRole);
}

export const qrMenuRoutes = new Hono<{ Bindings: Env }>();
export const qrMenuPublicRoutes = new Hono<{ Bindings: Env }>();

// -------------------------------------------------- authenticated management

qrMenuRoutes.get("/:workspaceId/menu", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, price_minor, currency, active, created_at
     FROM products WHERE workspace_id = ? AND app_id = 'qr-menu'
     ORDER BY active DESC, created_at DESC LIMIT 300`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ items: rows.results, currency: ctx.workspace.currency });
});

qrMenuRoutes.post("/:workspaceId/menu", async (c) => {
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
  const parsed = qrMenuItemCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO products (id, workspace_id, app_id, kind, name, description, price_minor, currency, stock, active, created_at, updated_at)
     VALUES (?, ?, 'qr-menu', 'physical', ?, ?, ?, ?, NULL, 1, ?, ?)`
  )
    .bind(
      id,
      ctx.workspace.id,
      parsed.data.name,
      parsed.data.description,
      parsed.data.price_minor,
      ctx.workspace.currency,
      nowIso(),
      nowIso()
    )
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "qrmenu.item.create",
    target_type: "product",
    target_id: id,
    detail: { price_minor: parsed.data.price_minor, currency: ctx.workspace.currency },
  });
  return c.json({ item: { id, ...parsed.data, currency: ctx.workspace.currency, active: 1 } }, 201);
});

qrMenuRoutes.patch("/:workspaceId/menu/:itemId", async (c) => {
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
  const parsed = qrMenuItemPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  const out = await c.env.DB.prepare(
    `UPDATE products SET active = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND app_id = 'qr-menu'`
  )
    .bind(parsed.data.is_available ? 1 : 0, nowIso(), c.req.param("itemId"), ctx.workspace.id)
    .run();
  if (out.meta.changes === 0) return jsonError(c, 404, "Menu item not found");

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "qrmenu.item.availability",
    target_type: "product",
    target_id: String(c.req.param("itemId")),
    detail: { is_available: parsed.data.is_available },
  });
  return c.json({ ok: true, is_available: parsed.data.is_available });
});

// ------------------------------------------------------ public (no session)

/**
 * The endpoint behind the QR sticker. No workspace membership required —
 * any phone that scans can load the menu. Safe fields only. Metered
 * against the plan's `qr-menu.scans` allowance; beyond it, the menu degrades
 * gracefully to `{ limited: true }` instead of an error.
 */
qrMenuPublicRoutes.get("/qrmenu/:workspaceId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const ws = await c.env.DB.prepare(`SELECT id, name, currency FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ id: string; name: string; currency: string }>();
  if (!ws) return jsonError(c, 404, "Menu not found");

  const ents = await loadWorkspaceEntitlements(c.env, workspaceId);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, workspaceId, SCAN_FEATURE, monthStart);
  const decision = decideFeature(ents, SCAN_FEATURE, used);
  if (!decision.allowed) {
    return c.json({
      workspace: { name: ws.name, currency: ws.currency },
      limited: true,
      items: [],
    });
  }

  const items = await c.env.DB.prepare(
    `SELECT name, description, price_minor, currency FROM products
     WHERE workspace_id = ? AND app_id = 'qr-menu' AND active = 1
     ORDER BY created_at DESC LIMIT 300`
  )
    .bind(workspaceId)
    .all<{ name: string; description: string | null; price_minor: number; currency: string }>();

  await recordUsage(c.env, workspaceId, "qr-menu", SCAN_FEATURE, 1, { view: "public_menu" });

  return c.json({
    workspace: { name: ws.name, currency: ws.currency },
    limited: false,
    items: items.results,
  });
});
