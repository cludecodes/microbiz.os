import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { createWorkspaceSchema, addMemberSchema, updateMemberRoleSchema, slugify } from "@microbiz/shared";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden, roleAtLeast } from "../lib/auth";
import type { Role } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { generateToken } from "../lib/crypto";

export const workspaceRoutes = new Hono<{ Bindings: Env }>();

type C = { Bindings: Env } & { Variables: { user: { id: string } } };

/** Fetch the workspace + caller's membership; helper for route handlers. */
async function loadWs(c: Context<{ Bindings: Env }>, wsId: string, minRole: Role) {
  return requireWorkspaceAccess(c, wsId, minRole);
}

// ---------------------------------------------------------------------- list
workspaceRoutes.get("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.currency, w.locale, w.plan_id, w.created_at,
            m.role, p.price_minor, p.currency AS plan_currency, s.status AS subscription_status
     FROM memberships m
     JOIN workspaces w ON w.id = m.workspace_id AND w.archived = 0
     JOIN plans p ON p.id = w.plan_id
     LEFT JOIN subscriptions s ON s.workspace_id = w.id
     WHERE m.user_id = ?
     ORDER BY w.created_at`
  )
    .bind(user.id)
    .all();
  return c.json({ workspaces: rows.results });
});

// -------------------------------------------------------------------- create
workspaceRoutes.post("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { name, currency, locale } = parsed.data;

  const memberCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`)
    .bind(user.id)
    .first<{ n: number }>();
  const entitled = await c.env.DB.prepare(
    `SELECT limit_value FROM entitlements
     WHERE workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id = ?)
       AND feature_key = 'team_members'`
  )
    .bind(user.id)
    .all<{ limit_value: number | null }>();
  const totalLimit = entitled.results.reduce<number | null>(
    (acc, row) => (acc === null ? row.limit_value : acc),
    null
  );
  // Free accounts get 2 workspaces; explicit limits may constrain further.
  const maxWorkspaces = totalLimit === null ? 2 : Math.max(totalLimit, 2);
  if ((memberCount?.n ?? 0) + 1 > maxWorkspaces && user.is_super_admin !== 1) {
    return jsonError(c, 403, "Workspace limit reached for your current plan");
  }

  const wsId = uuid();
  const ts = nowIso();
  const slug = `${slugify(name)}-${generateToken().slice(0, 6).toLowerCase()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO workspaces (id, name, slug, currency, locale, plan_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'free', ?)`
    ).bind(wsId, name, slug, currency, locale, ts),
    c.env.DB.prepare(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`
    ).bind(wsId, user.id, ts),
    c.env.DB.prepare(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, provider, started_at, updated_at)
       VALUES (?, ?, 'free', 'active', 'manual', ?, ?)`
    ).bind(uuid(), wsId, ts, ts),
  ]);

  await audit(c, {
    actor_user_id: user.id,
    workspace_id: wsId,
    action: "workspace.create",
    target_type: "workspace",
    target_id: wsId,
    detail: { name, currency },
  });
  return c.json({ id: wsId, slug }, 201);
});

// ------------------------------------------------------------------ detail
workspaceRoutes.get("/:id", async (c) => {
  const ctx = await loadWs(c, c.req.param("id"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const members = await c.env.DB.prepare(
    `SELECT m.user_id, m.role, m.created_at, u.email, u.name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY m.created_at`
  )
    .bind(ctx.workspace.id)
    .all();

  const plan = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.price_minor, p.currency, p.limits,
            s.status AS subscription_status
     FROM workspaces w
     JOIN plans p ON p.id = w.plan_id
     LEFT JOIN subscriptions s ON s.workspace_id = w.id AND s.plan_id = p.id
     WHERE w.id = ?`
  )
    .bind(ctx.workspace.id)
    .first();

  const usage = await c.env.DB.prepare(
    `SELECT feature_key, SUM(quantity) AS used FROM usage_events
     WHERE workspace_id = ?
       AND occurred_at >= substr(?, 1, 7) || '-01'
     GROUP BY feature_key`
  )
    .bind(ctx.workspace.id, nowIso())
    .all();

  return c.json({
    workspace: { ...ctx.workspace, role: ctx.membership.role },
    members: members.results,
    plan,
    usage: usage.results,
    entitlements: plan ? JSON.parse((plan as { limits: string }).limits) : {},
  });
});

// ------------------------------------------------------------------- members
workspaceRoutes.post("/:id/members", async (c) => {
  const ctx = await loadWs(c, c.req.param("id"), "admin");
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
  const parsed = addMemberSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { email, role } = parsed.data;

  const target = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: string }>();
  if (!target) return jsonError(c, 404, "No MicroBiz account with that email yet");

  const workspaceMembers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?`
  )
    .bind(ctx.workspace.id)
    .first<{ n: number }>();

  // Effective team limit = entitlement override (if any) else plan limit.
  const planLimits = await c.env.DB.prepare(
    `SELECT limits FROM plans WHERE id = (SELECT plan_id FROM workspaces WHERE id = ?)`
  )
    .bind(ctx.workspace.id)
    .first<{ limits: string }>();
  const override = await c.env.DB.prepare(
    `SELECT limit_value FROM entitlements WHERE workspace_id = ? AND feature_key = 'team_members'`
  )
    .bind(ctx.workspace.id)
    .first<{ limit_value: number | null }>();
  const teamLimit =
    override && override.limit_value !== null
      ? override.limit_value
      : planLimits
        ? (JSON.parse(planLimits.limits)["team_members"] ?? null)
        : null;
  if (teamLimit !== null && (workspaceMembers?.n ?? 0) + 1 > teamLimit) {
    return jsonError(c, 403, "Team member limit reached. Upgrade the plan to add more.");
  }

  const existing = await c.env.DB.prepare(
    `SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(ctx.workspace.id, target.id)
    .first();
  if (existing) return jsonError(c, 409, "Already a member of this workspace");

  await c.env.DB.prepare(
    `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(ctx.workspace.id, target.id, role, nowIso())
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "workspace.member.add",
    target_type: "user",
    target_id: target.id,
    detail: { role },
  });
  return c.json({ ok: true }, 201);
});

workspaceRoutes.patch("/:id/members/:userId", async (c) => {
  const ctx = await loadWs(c, c.req.param("id"), "admin");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const targetUserId = c.req.param("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));

  // Only owners may create/assign owner, and only owners may modify owners.
  if (parsed.data.role === "owner" && ctx.membership.role !== "owner") {
    return forbidden(c, "Only the workspace owner can promote another owner");
  }
  const targetMember = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(ctx.workspace.id, targetUserId)
    .first<{ role: Role }>();
  if (!targetMember) return jsonError(c, 404, "Member not found");
  if (targetMember.role === "owner" && !roleAtLeast(ctx.membership.role, "owner")) {
    return forbidden(c);
  }

  await c.env.DB.prepare(`UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?`)
    .bind(parsed.data.role, ctx.workspace.id, targetUserId)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "workspace.member.role_change",
    target_type: "user",
    target_id: targetUserId,
    detail: { from: targetMember.role, to: parsed.data.role },
  });
  return c.json({ ok: true });
});

workspaceRoutes.delete("/:id/members/:userId", async (c) => {
  const ctx = await loadWs(c, c.req.param("id"), "admin");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const targetUserId = c.req.param("userId");

  const targetMember = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(ctx.workspace.id, targetUserId)
    .first<{ role: Role }>();
  if (!targetMember) return jsonError(c, 404, "Member not found");
  if (targetMember.role === "owner") {
    const ownerCount = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'`
    )
      .bind(ctx.workspace.id)
      .first<{ n: number }>();
    if ((ownerCount?.n ?? 0) <= 1 && ctx.membership.role !== "owner") {
      return jsonError(c, 409, "Cannot remove the last owner. Transfer ownership first.");
    }
    if (ctx.membership.role !== "owner") return forbidden(c);
  }

  await c.env.DB.prepare(`DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?`)
    .bind(ctx.workspace.id, targetUserId)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "workspace.member.remove",
    target_type: "user",
    target_id: targetUserId,
  });
  return c.json({ ok: true });
});
