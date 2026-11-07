import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, unauthorized } from "../lib/auth";
import { audit } from "../lib/ops";
import { jsonError } from "../lib/http";
import { createCommissionSchema } from "@microbiz/shared";
import { uuid } from "../lib/http";

export const commissionRoutes = new Hono<{ Bindings: Env }>();

/**
 * Affiliate commissions for the signed-in referrer (M7). Admin lifecycle
 * transitions (approve → pay / void) live under /api/admin/commissions.
 */
commissionRoutes.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.referral_id, c.referrer_user_id, c.basis, c.basis_id, c.currency,
            c.amount_minor, c.status, c.created_at, c.paid_at, r.code AS referral_code,
            r.referred_user_id
       FROM commissions c
       JOIN referrals r ON r.id = c.referral_id
      WHERE c.referrer_user_id = ?
      ORDER BY c.created_at DESC`
  )
    .bind(user.id)
    .all();

  const commissions = (rows.results ?? []) as Array<{
    id: string;
    referral_id: string;
    referrer_user_id: string;
    basis: string;
    basis_id: string;
    currency: string;
    amount_minor: number;
    status: string;
    created_at: string;
    paid_at: string | null;
    referral_code: string;
    referred_user_id: string | null;
  }>;

  const earned = commissions
    .filter((row) => row.status === "approved" || row.status === "paid")
    .reduce((sum, row) => sum + row.amount_minor, 0);

  return c.json({
    commissions,
    summary: {
      count: commissions.length,
      earned_minor: earned,
      pending: commissions.filter((row) => row.status === "pending").length,
      approved: commissions.filter((row) => row.status === "approved").length,
      paid: commissions.filter((row) => row.status === "paid").length,
      void: commissions.filter((row) => row.status === "void").length,
    },
  });
});

commissionRoutes.post("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = createCommissionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 422, "Invalid commission payload", JSON.stringify(parsed.error.issues));
  }

  const referral = await c.env.DB.prepare(
    `SELECT id, referrer_user_id FROM referrals WHERE id = ?`
  )
    .bind(parsed.data.referral_id)
    .first<{ id: string; referrer_user_id: string }>();
  if (!referral) return jsonError(c, 404, "Referral not found");
  if (referral.referrer_user_id !== user.id) return jsonError(c, 403, "Referral belongs to another user");

  const id = uuid();
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO commissions (id, referral_id, referrer_user_id, basis, basis_id, currency, amount_minor, status, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
  )
    .bind(
      id,
      parsed.data.referral_id,
      user.id,
      parsed.data.basis,
      parsed.data.basis_id,
      parsed.data.currency,
      parsed.data.amount_minor,
      ts
    )
    .run();

  await audit(c, {
    actor_user_id: user.id,
    action: "commission.created",
    target_type: "commission",
    target_id: id,
    detail: { referral_id: parsed.data.referral_id, basis: parsed.data.basis, amount_minor: parsed.data.amount_minor },
  });

  return c.json({ commission: { id } }, 201);
});

export default commissionRoutes;
