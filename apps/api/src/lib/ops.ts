import type { Context } from "hono";
import type { Env } from "../types";
import { nowIso, uuid } from "./http";
import { sha256Hex } from "./crypto";

// ---------------------------------------------------------------- rate limit

/**
 * Fixed-window rate limiting in D1. Single authoritative source so it works
 * across Worker isolates. Cheap enough for the free tier at MVP scale.
 */
export async function rateLimit(
  c: Context<{ Bindings: Env }>,
  scope: string,
  identity: string,
  max: number,
  windowSeconds: number
): Promise<{ ok: boolean; remaining: number }> {
  const key = `${scope}:${identity}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);

  const row = await c.env.DB.prepare(`SELECT window_start, count FROM rate_limits WHERE key = ?`)
    .bind(key)
    .first<{ window_start: number; count: number }>();

  if (!row || row.window_start !== windowStart) {
    await c.env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`
    )
      .bind(key, windowStart)
      .run();
    return { ok: true, remaining: max - 1 };
  }

  const next = row.count + 1;
  if (next > max) return { ok: false, remaining: 0 };
  await c.env.DB.prepare(`UPDATE rate_limits SET count = ? WHERE key = ?`).bind(next, key).run();
  return { ok: true, remaining: max - next };
}

// ------------------------------------------------------------------- audit

export interface AuditEntry {
  actor_user_id?: string | null;
  workspace_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  detail?: Record<string, unknown>;
}

/** IP is never stored raw: truncated sha256 hash, privacy-safe. */
export async function audit(c: Context<{ Bindings: Env }>, entry: AuditEntry): Promise<void> {
  const ip = entry.ip ?? c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "";
  const ipHash = ip ? `${(await sha256Hex(ip)).slice(0, 16)}${ip.split(".").length}` : null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, ts, actor_user_id, workspace_id, action, target_type, target_id, ip_hash, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        nowIso(),
        entry.actor_user_id ?? null,
        entry.workspace_id ?? null,
        entry.action,
        entry.target_type ?? null,
        entry.target_id ?? null,
        ipHash,
        entry.user_agent ?? c.req.header("User-Agent") ?? null,
        JSON.stringify(entry.detail ?? {})
      )
      .run();
  } catch {
    // Auditing must never break a request, but real deployment monitors this.
  }
}
