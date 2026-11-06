import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, type ApiContext } from "../lib/auth";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { confirmPayment, type PaymentRow } from "../lib/billing";

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

// ------------------------------------------------------------ billing admin

adminRoutes.get("/plans", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.price_minor, p.currency, p.limits, p.features,
            p.is_active, p.is_public, p.sort,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_subs
     FROM plans p ORDER BY p.currency, p.sort`
  ).all();
  return c.json({ plans: rows.results });
});

adminRoutes.patch("/plans/:planId", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const planId = c.req.param("planId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError(c, 422, "Invalid body");
  const patch = body as Record<string, unknown>;

  const existing = await c.env.DB.prepare(`SELECT id, price_minor, is_active, is_public FROM plans WHERE id = ?`)
    .bind(planId)
    .first<{ id: string; price_minor: number; is_active: number; is_public: number }>();
  if (!existing) return jsonError(c, 404, "Plan not found");

  const nextPrice =
    patch.price_minor === undefined ? existing.price_minor : Number(patch.price_minor);
  const nextActive = patch.is_active === undefined ? existing.is_active : patch.is_active ? 1 : 0;
  const nextPublic = patch.is_public === undefined ? existing.is_public : patch.is_public ? 1 : 0;
  if (!Number.isInteger(nextPrice) || nextPrice < 0) return jsonError(c, 422, "price_minor must be a non-negative integer");

  await c.env.DB.prepare(`UPDATE plans SET price_minor = ?, is_active = ?, is_public = ? WHERE id = ?`)
    .bind(nextPrice, nextActive, nextPublic, planId)
    .run();

  await audit(c, {
    actor_user_id: admin.id,
    action: "admin.plan_update",
    target_type: "plan",
    target_id: planId,
    detail: {
      from: { price_minor: existing.price_minor, is_active: existing.is_active, is_public: existing.is_public },
      to: { price_minor: nextPrice, is_active: nextActive, is_public: nextPublic },
    },
  });
  return c.json({ ok: true, plan: { id: planId, price_minor: nextPrice, is_active: nextActive, is_public: nextPublic } });
});

adminRoutes.get("/payments", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const status = c.req.query("status");
  const provider = c.req.query("provider");
  const rows = await c.env.DB.prepare(
    `SELECT pm.id, pm.workspace_id, pm.plan_id, pm.provider, pm.provider_txn_ref,
            pm.amount_minor, pm.fee_minor, pm.currency, pm.status, pm.settlement_status,
            pm.refund_minor, pm.created_at, pm.confirmed_at, pm.settled_at,
            w.name AS workspace_name, pl.name AS plan_name
     FROM payments pm
     JOIN workspaces w ON w.id = pm.workspace_id
     LEFT JOIN plans pl ON pl.id = pm.plan_id
     WHERE (? IS NULL OR pm.status = ?) AND (? IS NULL OR pm.provider = ?)
     ORDER BY pm.created_at DESC LIMIT 200`
  )
    .bind(status ?? null, status ?? null, provider ?? null, provider ?? null)
    .all();
  return c.json({ payments: rows.results });
});

adminRoutes.get("/subscriptions", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const rows = await c.env.DB.prepare(
    `SELECT s.workspace_id, s.plan_id, s.status, s.provider, s.provider_ref,
            s.started_at, s.current_period_end, s.canceled_at,
            w.name AS workspace_name, w.currency, p.name AS plan_name, p.price_minor
     FROM subscriptions s
     JOIN workspaces w ON w.id = s.workspace_id
     JOIN plans p ON p.id = s.plan_id
     ORDER BY s.updated_at DESC LIMIT 200`
  ).all();
  return c.json({ subscriptions: rows.results });
});

/**
 * Manual receipt reconciliation (bank / Raast / Payoneer).
 * Hosted providers are refused: ONLY their signed webhook may confirm.
 */
adminRoutes.post("/payments/:paymentId/confirm", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const paymentId = c.req.param("paymentId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const amountMinor = Number(input.amount_minor);
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  const feeMinor = input.fee_minor === undefined ? 0 : Number(input.fee_minor);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return jsonError(c, 422, "amount_minor must be a positive integer (what the bank statement shows)");
  }
  if (!Number.isInteger(feeMinor) || feeMinor < 0) return jsonError(c, 422, "fee_minor must be a non-negative integer");

  const payment = await c.env.DB.prepare(
    `SELECT id, workspace_id, plan_id, provider, provider_txn_ref, amount_minor, fee_minor,
            currency, status, settlement_status, refund_minor
     FROM payments WHERE id = ?`
  )
    .bind(paymentId)
    .first<PaymentRow>();
  if (!payment) return jsonError(c, 404, "Payment not found");
  if (!["bank", "raast", "payoneer", "manual"].includes(payment.provider)) {
    return jsonError(c, 409, "Hosted provider payments can only be confirmed by their signed webhook");
  }
  if (payment.status === "confirmed") return jsonError(c, 409, "Payment is already confirmed");
  if (!["initiated", "awaiting_confirmation"].includes(payment.status)) {
    return jsonError(c, 409, `Payment is ${payment.status}; only pending receipts can be confirmed`);
  }

  const ts = nowIso();
  const isBank = payment.provider === "bank" || payment.provider === "raast";
  const referenceMismatch = reference !== "" && payment.provider_txn_ref && reference !== payment.provider_txn_ref;
  if (amountMinor !== payment.amount_minor || referenceMismatch) {
    if (isBank) {
      await c.env.DB.prepare(
        `INSERT INTO bank_settlements (id, workspace_id, payment_id, provider, reference, expected_minor, received_minor, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mismatch', ?, ?)`
      )
        .bind(
          uuid(),
          payment.workspace_id,
          payment.id,
          payment.provider,
          reference || payment.provider_txn_ref || "",
          payment.amount_minor,
          amountMinor,
          payment.currency,
          ts,
          ts
        )
        .run();
    }
    await audit(c, {
      actor_user_id: admin.id,
      workspace_id: payment.workspace_id,
      action: "admin.payment_reconcile_mismatch",
      target_type: "payment",
      target_id: payment.id,
      detail: { expected_minor: payment.amount_minor, received_minor: amountMinor, reference, reference_mismatch: referenceMismatch },
    });
    return jsonError(
      c,
      409,
      "Receipt does not match the payment intent",
      amountMinor !== payment.amount_minor
        ? `Expected ${payment.amount_minor} minor units, received ${amountMinor}`
        : "Transfer reference does not match"
    );
  }

  const result = await confirmPayment(c.env, {
    payment,
    feeMinor,
    settledDirectly: true,
    reason: "admin:reconcile",
  });
  if (!result.ok) return jsonError(c, 409, `Could not confirm: ${result.reason}`);

  if (isBank) {
    await c.env.DB.prepare(
      `INSERT INTO bank_settlements (id, workspace_id, payment_id, provider, reference, expected_minor, received_minor, currency, status, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?)`
    )
      .bind(
        uuid(),
        payment.workspace_id,
        payment.id,
        payment.provider,
        reference || payment.provider_txn_ref || "",
        payment.amount_minor,
        amountMinor,
        payment.currency,
        ts,
        ts,
        ts
      )
      .run();
  }

  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: payment.workspace_id,
    action: "admin.payment_confirmed",
    target_type: "payment",
    target_id: payment.id,
    detail: {
      provider: payment.provider,
      amount_minor: payment.amount_minor,
      fee_minor: feeMinor,
      plan_activated: result.planActivated,
      journal_id: result.journalId,
      reference,
    },
  });

  return c.json({
    ok: true,
    payment_id: payment.id,
    plan_activated: result.planActivated,
    journal_id: result.journalId,
    settlement_status: "settled",
  });
});

adminRoutes.get("/ledger", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const wsFilter = c.req.query("workspace_id") ?? null;

  const [journals, postings, totals] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, workspace_id, memo, currency, ref_type, ref_id, created_at
       FROM ledger_journals
       WHERE (? IS NULL OR workspace_id = ?)
       ORDER BY created_at DESC LIMIT 100`
    )
      .bind(wsFilter, wsFilter)
      .all(),
    c.env.DB.prepare(
      `SELECT lp.id, lp.journal_id, lp.account, lp.direction, lp.amount_minor, lp.ref_type, lp.ref_id
       FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
       WHERE (? IS NULL OR lj.workspace_id = ?)
       ORDER BY lj.created_at DESC, lp.id LIMIT 1000`
    )
      .bind(wsFilter, wsFilter)
      .all(),
    c.env.DB.prepare(
      `SELECT lp.account, lj.currency,
              SUM(CASE WHEN lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS debit_minor,
              SUM(CASE WHEN lp.direction = 'CREDIT' THEN lp.amount_minor ELSE 0 END) AS credit_minor
       FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
       WHERE (? IS NULL OR lj.workspace_id = ?)
       GROUP BY lp.account, lj.currency ORDER BY lj.currency, lp.account`
    )
      .bind(wsFilter, wsFilter)
      .all(),
  ]);

  const byJournal = new Map<string, unknown[]>();
  for (const p of postings.results as { journal_id: string }[]) {
    const list = byJournal.get(p.journal_id) ?? [];
    list.push(p);
    byJournal.set(p.journal_id, list);
  }
  return c.json({
    journals: (journals.results as { id: string }[]).map((j) => ({
      ...j,
      postings: byJournal.get(j.id) ?? [],
    })),
    totals: totals.results,
    note: "Signed balance = debits - credits for assets; revenue accounts accumulate credits.",
  });
});

export default adminRoutes;
