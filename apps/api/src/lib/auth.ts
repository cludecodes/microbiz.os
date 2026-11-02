import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, SessionUser } from "../types";
import { generateToken, sha256Hex, constantTimeEqual } from "./crypto";
import { jsonError, nowIso, uuid } from "./http";
import type { WorkspaceRow } from "../types";

export const SESSION_COOKIE = "mb_session";
export const CSRF_COOKIE = "mb_csrf";
const SESSION_TTL_DAYS = 30;

export type ApiContext = Context<{ Bindings: Env }>;

export function isSecureRequest(c: ApiContext): boolean {
  const proto = c.req.header("X-Forwarded-Proto") ?? "";
  if (proto) return proto === "https";
  return c.env.ENVIRONMENT !== "development" && new URL(c.req.url).protocol === "https:";
}

export function setSessionCookie(c: ApiContext, token: string): void {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

export function clearSessionCookie(c: ApiContext): void {
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

/** Double-submit CSRF: HttpOnly cookie + X-CSRF-Token header must match. */
export function issueCsrfCookie(c: ApiContext): string {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing) return existing;
  const token = generateToken();
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return token;
}

export function csrfCookieMatchesHeader(c: ApiContext): boolean {
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header("X-CSRF-Token");
  if (!cookie || !header) return false;
  return constantTimeEqual(cookie, header);
}

export async function createSession(
  c: ApiContext,
  userId: string
): Promise<void> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), userId, tokenHash, c.req.header("User-Agent") ?? null, nowIso(), expires)
    .run();
  setSessionCookie(c, token);
  issueCsrfCookie(c);
}

export async function getSessionUser(c: ApiContext): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.locale, u.is_super_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?`
  )
    .bind(tokenHash, nowIso())
    .first<SessionUser>();
  if (!row) return null;
  await c.env.DB.prepare(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`)
    .bind(nowIso(), tokenHash)
    .run();
  return row;
}

export async function revokeSession(c: ApiContext, userId: string): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await c.env.DB.prepare(`UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND user_id = ?`)
    .bind(tokenHash, userId)
    .run();
}

// ------------------------------------------------------------ authorization

export type Role = "owner" | "admin" | "manager" | "member";
const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, member: 1 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface WorkspaceMembership {
  workspace: WorkspaceRow;
  membership: { workspace_id: string; user_id: string; role: Role };
}

/**
 * Server-side workspace authorization. Every workspace-scoped operation MUST
 * go through this: user must be authenticated and a member of the workspace.
 */
export async function requireWorkspaceAccess(
  c: ApiContext,
  workspaceId: string,
  minRole: Role
): Promise<WorkspaceMembership | null> {
  const user = await getSessionUser(c);
  if (!user) return null;
  const row = await c.env.DB.prepare(
    `SELECT w.*, m.role
     FROM workspaces w
     JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?
     WHERE w.id = ? AND w.archived = 0`
  )
    .bind(user.id, workspaceId)
    .first<WorkspaceRow & { role: Role }>();
  if (!row || !roleAtLeast(row.role, minRole)) return null;
  const workspace: WorkspaceRow = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    currency: row.currency,
    locale: row.locale,
    plan_id: row.plan_id,
    archived: row.archived as 0 | 1,
    created_at: row.created_at,
  };
  return {
    workspace,
    membership: { workspace_id: row.id, user_id: user.id, role: row.role },
  };
}

export function unauthorized(c: ApiContext, msg = "Authentication required") {
  return jsonError(c, 401, msg);
}

export function forbidden(c: ApiContext, msg = "You do not have access to this workspace") {
  return jsonError(c, 403, msg);
}
