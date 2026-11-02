import { Hono } from "hono";
import type { Env } from "../types";
import { registerSchema, loginSchema } from "@microbiz/shared";
import { hashPassword, verifyPassword, generateToken } from "../lib/crypto";
import { createSession, getSessionUser, revokeSession, issueCsrfCookie } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit, rateLimit } from "../lib/ops";
import { slugify } from "@microbiz/shared";

export const authRoutes = new Hono<{ Bindings: Env }>();

function userAgent(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return c.req.header("user-agent") ?? null;
}

authRoutes.get("/csrf", (c) => {
  const token = issueCsrfCookie(c);
  return c.json({ token });
});

// ------------------------------------------------------------------ register
authRoutes.post("/register", async (c) => {
  const rl = await rateLimit(c, "register", c.req.header("CF-Connecting-IP") ?? "unknown", 5, 15 * 60);
  if (!rl.ok) return jsonError(c, 429, "Too many attempts. Try again later.");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { email, password, name, locale } = parsed.data;

  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) {
    // Do not reveal whether the email exists.
    return jsonError(c, 409, "Email already registered. Try logging in.");
  }

  const userId = uuid();
  const passwordHash = await hashPassword(password);
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, name, locale, is_super_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(userId, email, passwordHash, name, locale, ts, ts),
  ]);

  // Onboarding: auto-create the user's first workspace so the dashboard is
  // immediately usable. Owner membership created in the same step.
  const wsId = uuid();
  const slugBase = slugify(`${name}`);
  const slug = `${slugBase}-${generateToken().slice(0, 6).toLowerCase()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO workspaces (id, name, slug, currency, locale, plan_id, created_at)
       VALUES (?, ?, ?, 'PKR', ?, 'free', ?)`
    ).bind(wsId, `${name}'s Workspace`, slug, locale, ts),
    c.env.DB.prepare(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`
    ).bind(wsId, userId, ts),
    c.env.DB.prepare(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, provider, started_at, updated_at)
       VALUES (?, ?, 'free', 'active', 'manual', ?, ?)`
    ).bind(uuid(), wsId, ts, ts),
  ]);

  await createSession(c, userId);
  await audit(c, {
    actor_user_id: userId,
    workspace_id: wsId,
    action: "auth.register",
    target_type: "user",
    target_id: userId,
    detail: { locale },
  });

  const user = await c.env.DB.prepare(
    `SELECT id, email, name, locale, is_super_admin, created_at FROM users WHERE id = ?`
  )
    .bind(userId)
    .first();
  return c.json({ user }, 201);
});

// ---------------------------------------------------------------------- login
authRoutes.post("/login", async (c) => {
  const rl = await rateLimit(c, "login", c.req.header("CF-Connecting-IP") ?? "unknown", 10, 15 * 60);
  if (!rl.ok) return jsonError(c, 429, "Too many login attempts. Try again later.");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { email, password } = parsed.data;

  const user = await c.env.DB.prepare(
    `SELECT id, email, password_hash, name, locale, is_super_admin FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; name: string; locale: string; is_super_admin: number }>();

  const fakeHash = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, fakeHash);
  if (!user || !ok) {
    return jsonError(c, 401, "Invalid email or password");
  }

  await createSession(c, user.id);
  await audit(c, {
    actor_user_id: user.id,
    action: "auth.login",
    ip: c.req.header("CF-Connecting-IP"),
  });
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, locale: user.locale, is_super_admin: user.is_super_admin },
  });
});

// --------------------------------------------------------------------- logout
authRoutes.post("/logout", async (c) => {
  const user = await getSessionUser(c);
  if (user) {
    await revokeSession(c, user.id);
    await audit(c, { actor_user_id: user.id, action: "auth.logout" });
  }
  return c.json({ ok: true });
});

// ----------------------------------------------------------------- who am I
authRoutes.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, "Authentication required");

  const workspaces = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.currency, w.locale, w.plan_id, w.created_at,
            m.role, p.name AS plan_name, s.status AS subscription_status
     FROM memberships m
     JOIN workspaces w ON w.id = m.workspace_id AND w.archived = 0
     JOIN plans p ON p.id = w.plan_id
     LEFT JOIN subscriptions s ON s.workspace_id = w.id
     WHERE m.user_id = ?
     ORDER BY w.created_at`
  )
    .bind(user.id)
    .all();

  return c.json({ user, workspaces: workspaces.results });
});
