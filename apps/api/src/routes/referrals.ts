import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, unauthorized } from "../lib/auth";
import { audit } from "../lib/ops";
import { createReferral } from "../lib/referrals";
import { jsonError, nowIso, uuid } from "../lib/http";

export const referralRoutes = new Hono<{ Bindings: Env }>();

/**
 * Referral program (M7): authenticated users can create personal referral
 * codes. A code is converted when a new account registers with it.
 */
referralRoutes.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.referrer_user_id, r.referred_user_id, r.converted_at, r.created_at,
            referred.email AS referred_email, referred.name AS referred_name
       FROM referrals r
       LEFT JOIN users referred ON referred.id = r.referred_user_id
      WHERE r.referrer_user_id = ?
      ORDER BY r.created_at DESC`
  )
    .bind(user.id)
    .all();

  const referrals = (rows.results ?? []) as Array<{
    id: string;
    code: string;
    referrer_user_id: string;
    referred_user_id: string | null;
    converted_at: string | null;
    created_at: string;
    referred_email: string | null;
    referred_name: string | null;
  }>;
  const converted = referrals.filter((row) => row.referred_user_id !== null).length;

  return c.json({
    referrals,
    stats: {
      total: referrals.length,
      converted,
      pending: referrals.length - converted,
    },
  });
});

referralRoutes.post("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);

  const referral = await createReferral(c.env, user.id);
  await audit(c, {
    actor_user_id: user.id,
    action: "referral.code_created",
    target_type: "referral",
    target_id: referral.id,
    detail: { code: referral.code },
  });

  return c.json({ referral }, 201);
});

export default referralRoutes;
