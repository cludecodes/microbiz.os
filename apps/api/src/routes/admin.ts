import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, type ApiContext } from "../lib/auth";
import { jsonError } from "../lib/http";
import { audit } from "../lib/ops";

/**
 * Super-admin controls. Every route requires users.is_super_admin = 1,
 * checked SERVER-SIDE on each request.
 */
export const adminRoutes = new Hono<{ Bindings: Env }>();

async function requireSuperAdmin(c: ApiContext) {
  const u = await getSessionUser(c);
  return u && u.is_super_admin === 1 ? u : null;
}

adminRoutes.get("/summary", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  const [users, workspaces, subs, payments] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE archived = 0`).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT p.name AS plan_name, COUNT(*) AS n, p.currency FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active' GROUP BY s.plan_id`
    ).all(),
    // Honest reporting: only confirmed, signature-verified rows. No invented revenue.
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total, currency FROM payments
       WHERE status = 'confirmed' GROUP BY currency`
    ).all(),
  ]);

  return c.json({
    users: users?.n ?? 0,
    workspaces: workspaces?.n ?? 0,
    active_subscriptions: subs.results,
    confirmed_receipts: payments.results,
    note: "confirmed_receipts counts provider-verified payments only",
  });
});

adminRoutes.get("/users", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const rows = await c.env.DB.prepare(
    `SELECT id, email, name, locale, is_super_admin, created_at FROM users ORDER BY created_at DESC LIMIT 200`
  ).all();
  return c.json({ users: rows.results });
});

adminRoutes.get("/workspaces", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.currency, w.plan_id, w.created_at, p.name AS plan_name
     FROM workspaces w JOIN plans p ON p.id = w.plan_id
     ORDER BY w.created_at DESC LIMIT 200`
  ).all();
  return c.json({ workspaces: rows.results });
});

adminRoutes.get("/audit-logs", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const rows = await c.env.DB.prepare(
    `SELECT id, ts, actor_user_id, workspace_id, action, target_type, target_id, ip_hash, detail
     FROM audit_logs ORDER BY ts DESC LIMIT 200`
  ).all();
  await audit(c, { actor_user_id: admin.id, action: "admin.audit_log_view" });
  return c.json({ logs: rows.results });
});

export default adminRoutes;
