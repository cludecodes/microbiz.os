import { Hono } from "hono";
import type { Env } from "../types";
import { requireSuperAdmin } from "../lib/adminAuth";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { confirmPayment, refundPayment, settlePayment, type PaymentRow } from "../lib/billing";
import {
  decryptPayoutDetails,
  isPayoutEncryptionConfigured,
  payoutDetailsPreview,
} from "../lib/payouts";
import type { PayoutProfileKind } from "@microbiz/shared";
import { createCommissionSchema } from "@microbiz/shared";
import { adminAnalyticsRoutes } from "./adminAnalytics";

/**
 * Super-admin controls. Every route requires users.is_super_admin = 1,
 * checked SERVER-SIDE on each request.
 */
export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.route("/analytics", adminAnalyticsRoutes);

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
    `SELECT pm.id, pm.workspace_id, pm.plan_id, pm.invoice_id, pm.provider, pm.provider_txn_ref,
            pm.amount_minor, pm.fee_minor, pm.currency, pm.status, pm.settlement_status,
            pm.refund_minor, pm.created_at, pm.confirmed_at, pm.settled_at,
            w.name AS workspace_name, pl.name AS plan_name, i.number AS invoice_number
     FROM payments pm
     JOIN workspaces w ON w.id = pm.workspace_id
     LEFT JOIN plans pl ON pl.id = pm.plan_id
     LEFT JOIN invoices i ON i.id = pm.invoice_id
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
    `SELECT id, workspace_id, plan_id, invoice_id, provider, provider_txn_ref, amount_minor, fee_minor,
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
      invoice_paid: result.invoicePaid,
      journal_id: result.journalId,
      reference,
    },
  });

  return c.json({
    ok: true,
    payment_id: payment.id,
    plan_activated: result.planActivated,
    invoice_paid: result.invoicePaid,
    journal_id: result.journalId,
    settlement_status: "settled",
  });
});

/**
 * Record a refund the admin has ALREADY executed in the provider dashboard or
 * bank. No provider refund API is called here (that stays flagged), so the
 * reference is an attestation, not a machine confirmation.
 */
adminRoutes.post("/payments/:paymentId/refund", async (c) => {
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
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  const providerRef = typeof input.provider_ref === "string" ? input.provider_ref.trim().slice(0, 120) : "";
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return jsonError(c, 422, "amount_minor must be a positive integer");
  }

  const payment = await c.env.DB.prepare(
    `SELECT id, workspace_id, plan_id, invoice_id, provider, provider_txn_ref, amount_minor, fee_minor,
            currency, status, settlement_status, refund_minor
     FROM payments WHERE id = ?`
  )
    .bind(paymentId)
    .first<PaymentRow>();
  if (!payment) return jsonError(c, 404, "Payment not found");

  const result = await refundPayment(c.env, {
    payment,
    amountMinor,
    reason: reason || "admin:refund",
    providerRef: providerRef || null,
  });
  if (!result.ok) {
    return jsonError(
      c,
      409,
      `Refund refused: ${result.reason}`,
      result.reason === "refund_exceeds_refundable"
        ? `This payment has ${payment.amount_minor - payment.refund_minor} minor units still refundable.`
        : undefined
    );
  }

  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: payment.workspace_id,
    action: "admin.payment_refunded",
    target_type: "payment",
    target_id: payment.id,
    detail: {
      amount_minor: amountMinor,
      refund_minor: result.refundMinor,
      payment_status: result.status,
      from_settled_bank: result.fromSettledBank,
      provider: payment.provider,
      provider_ref: providerRef,
      reason,
      journal_id: result.journalId,
    },
  });

  return c.json({
    ok: true,
    payment_id: payment.id,
    refund_minor: result.refundMinor,
    status: result.status,
    from_settled_bank: result.fromSettledBank,
    journal_id: result.journalId,
  });
});

/** Mark a hosted payout as received, after checking the real bank credit. */
adminRoutes.post("/payments/:paymentId/settle", async (c) => {
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
  const providerRef = typeof input.provider_ref === "string" ? input.provider_ref.trim().slice(0, 120) : "";
  const hasAmount = input.amount_minor !== undefined && input.amount_minor !== null;
  const receivedMinor = hasAmount ? Number(input.amount_minor) : null;
  if (hasAmount && (!Number.isInteger(receivedMinor) || (receivedMinor as number) < 0)) {
    return jsonError(c, 422, "amount_minor must be a non-negative integer (what the bank credited)");
  }

  const payment = await c.env.DB.prepare(
    `SELECT id, workspace_id, plan_id, invoice_id, provider, provider_txn_ref, amount_minor, fee_minor,
            currency, status, settlement_status, refund_minor
     FROM payments WHERE id = ?`
  )
    .bind(paymentId)
    .first<PaymentRow>();
  if (!payment) return jsonError(c, 404, "Payment not found");
  if (!["safepay", "lemonsqueezy"].includes(payment.provider)) {
    return jsonError(c, 409, "Manual receipts are settled at confirmation; only hosted payouts are marked here");
  }

  const result = await settlePayment(c.env, { payment, receivedMinor, providerRef: providerRef || null });
  if (!result.ok) {
    return jsonError(c, 409, `Settlement refused: ${result.reason}`, `net_minor was ${payment.amount_minor - payment.fee_minor - payment.refund_minor}`);
  }

  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: payment.workspace_id,
    action: "admin.payment_settled",
    target_type: "payment",
    target_id: payment.id,
    detail: {
      provider: payment.provider,
      net_minor: result.netMinor,
      received_minor: result.receivedMinor,
      payout_fee_minor: result.payoutFeeMinor,
      provider_ref: providerRef,
      journal_id: result.journalId,
    },
  });

  return c.json({
    ok: true,
    payment_id: payment.id,
    settlement_status: "settled",
    net_minor: result.netMinor,
    received_minor: result.receivedMinor,
    payout_fee_minor: result.payoutFeeMinor,
    journal_id: result.journalId,
  });
});

adminRoutes.get("/settlements", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  const hostedSelect = `SELECT pm.id, pm.workspace_id, pm.plan_id, pm.invoice_id, pm.provider,
            pm.provider_txn_ref, pm.amount_minor, pm.fee_minor, pm.refund_minor, pm.currency,
            pm.amount_minor - pm.fee_minor - pm.refund_minor AS net_minor,
            pm.status, pm.settlement_status, pm.confirmed_at, pm.settled_at,
            w.name AS workspace_name, pl.name AS plan_name, i.number AS invoice_number
     FROM payments pm
     JOIN workspaces w ON w.id = pm.workspace_id
     LEFT JOIN plans pl ON pl.id = pm.plan_id
     LEFT JOIN invoices i ON i.id = pm.invoice_id
     WHERE pm.provider IN ('safepay','lemonsqueezy')`;

  const [bank, pendingHosted, settledHosted] = await Promise.all([
    c.env.DB.prepare(
      `SELECT bs.id, bs.workspace_id, bs.payment_id, bs.provider, bs.reference,
              bs.expected_minor, bs.received_minor, bs.currency, bs.status, bs.settled_at, bs.created_at,
              w.name AS workspace_name
       FROM bank_settlements bs JOIN workspaces w ON w.id = bs.workspace_id
       ORDER BY bs.created_at DESC LIMIT 200`
    ).all(),
    c.env.DB.prepare(
      `${hostedSelect} AND pm.status IN ('confirmed','refunded') AND pm.settlement_status = 'pending'
       ORDER BY pm.confirmed_at DESC LIMIT 200`
    ).all(),
    c.env.DB.prepare(
      `${hostedSelect} AND pm.settlement_status = 'settled' AND pm.settled_at IS NOT NULL
       ORDER BY pm.settled_at DESC LIMIT 100`
    ).all(),
  ]);

  return c.json({
    bank: bank.results,
    pending_hosted: pendingHosted.results,
    settled_hosted: settledHosted.results,
    note: "Hosted payouts are marked settled only after the admin checks the real bank credit. The difference between net held funds and the payout is recorded as payout_fees.",
  });
});

// ---------------------------------------------------------- payout profiles

adminRoutes.get("/payout-profiles", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  const rows = await c.env.DB.prepare(
    `SELECT pp.id, pp.workspace_id, pp.kind, pp.label, pp.approved, pp.details_encrypted, pp.created_at,
            w.name AS workspace_name
     FROM payout_profiles pp JOIN workspaces w ON w.id = pp.workspace_id
     ORDER BY pp.created_at DESC LIMIT 200`
  )
    .all<{
      id: string;
      workspace_id: string;
      kind: PayoutProfileKind;
      label: string;
      approved: number;
      details_encrypted: string;
      created_at: string;
      workspace_name: string;
    }>();

  const encryptionConfigured = isPayoutEncryptionConfigured(c.env);
  const profiles = await Promise.all(
    rows.results.map(async (row) => {
      const details = encryptionConfigured
        ? await decryptPayoutDetails(c.env, row.details_encrypted)
        : null;
      return {
        id: row.id,
        workspace_id: row.workspace_id,
        workspace_name: row.workspace_name,
        kind: row.kind,
        label: row.label,
        approved: row.approved,
        created_at: row.created_at,
        details_preview: payoutDetailsPreview(details),
        decryptable: Boolean(details),
      };
    })
  );

  await audit(c, { actor_user_id: admin.id, action: "admin.payout_profiles_view" });
  return c.json({ profiles, encryption_configured: encryptionConfigured });
});

adminRoutes.post("/payout-profiles/:profileId/approval", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const approved = Boolean((body as Record<string, unknown> | null)?.approved);
  const profile = await c.env.DB.prepare(
    `SELECT id, workspace_id, kind, label, approved FROM payout_profiles WHERE id = ?`
  )
    .bind(c.req.param("profileId"))
    .first<{ id: string; workspace_id: string; kind: string; label: string; approved: number }>();
  if (!profile) return jsonError(c, 404, "Payout profile not found");

  await c.env.DB.prepare(`UPDATE payout_profiles SET approved = ? WHERE id = ?`)
    .bind(approved ? 1 : 0, profile.id)
    .run();
  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: profile.workspace_id,
    action: "admin.payout_profile_approval",
    target_type: "payout_profile",
    target_id: profile.id,
    detail: { kind: profile.kind, label: profile.label, from: profile.approved, to: approved ? 1 : 0 },
  });
  return c.json({ ok: true, id: profile.id, approved: approved ? 1 : 0 });
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

// ---------------------------------------------------------- referral & commissions admin (M7)

adminRoutes.get("/commissions", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.referral_id, c.referrer_user_id, c.basis, c.basis_id, c.currency,
            c.amount_minor, c.status, c.created_at, c.paid_at, r.code AS referral_code,
            r.referred_user_id
       FROM commissions c
       JOIN referrals r ON r.id = c.referral_id
      WHERE (? IS NULL OR c.status = ?)
      ORDER BY c.created_at DESC
      LIMIT 200`
  )
    .bind(status ?? null, status ?? null)
    .all();
  return c.json({ commissions: rows.results });
});

adminRoutes.post("/commissions", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = createCommissionSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, "Invalid commission payload");

  const referral = await c.env.DB.prepare(
    `SELECT id, referrer_user_id FROM referrals WHERE id = ?`
  )
    .bind(parsed.data.referral_id)
    .first<{ id: string; referrer_user_id: string }>();
  if (!referral) return jsonError(c, 404, "Referral not found");
  if (referral.referrer_user_id !== admin.id) return jsonError(c, 403, "Referral belongs to another user");

  const id = uuid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO commissions (id, referral_id, referrer_user_id, basis, basis_id, currency, amount_minor, status, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
  )
    .bind(
      id,
      parsed.data.referral_id,
      referral.referrer_user_id,
      parsed.data.basis,
      parsed.data.basis_id,
      parsed.data.currency,
      parsed.data.amount_minor,
      ts
    )
    .run();

  await audit(c, {
    actor_user_id: admin.id,
    action: "admin.commission_created",
    target_type: "commission",
    target_id: id,
    detail: { referral_id: parsed.data.referral_id, basis: parsed.data.basis, amount_minor: parsed.data.amount_minor },
  });

  return c.json({ commission: { id } }, 201);
});

adminRoutes.post("/commissions/:commissionId/approval", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const commissionId = c.req.param("commissionId");
  const commission = await c.env.DB.prepare(
    `SELECT id, referrer_user_id, basis, amount_minor, status FROM commissions WHERE id = ?`
  )
    .bind(commissionId)
    .first<{ id: string; referrer_user_id: string; basis: string; amount_minor: number; status: string }>();
  if (!commission) return jsonError(c, 404, "Commission not found");
  if (commission.status !== "pending") return jsonError(c, 409, "Only pending commissions can be approved");

  const ts = nowIso();
  await c.env.DB.prepare(`UPDATE commissions SET status = 'approved' WHERE id = ? AND status = 'pending'`)
    .bind(commissionId)
    .run();
  await audit(c, {
    actor_user_id: admin.id,
    action: "admin.commission_approved",
    target_type: "commission",
    target_id: commissionId,
    detail: { basis: commission.basis, amount_minor: commission.amount_minor, from: "pending", to: "approved" },
  });
  return c.json({ ok: true, commission_id: commissionId, status: "approved" });
});

adminRoutes.post("/commissions/:commissionId/pay", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const commissionId = c.req.param("commissionId");
  const commission = await c.env.DB.prepare(
    `SELECT id, referrer_user_id, basis, amount_minor, status FROM commissions WHERE id = ?`
  )
    .bind(commissionId)
    .first<{ id: string; referrer_user_id: string; basis: string; amount_minor: number; status: string }>();
  if (!commission) return jsonError(c, 404, "Commission not found");
  if (commission.status !== "approved") return jsonError(c, 409, "Only approved commissions can be paid");

  const ts = nowIso();
  await c.env.DB.prepare(`UPDATE commissions SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'approved'`)
    .bind(ts, commissionId)
    .run();
  await audit(c, {
    actor_user_id: admin.id,
    action: "admin.commission_paid",
    target_type: "commission",
    target_id: commissionId,
    detail: { basis: commission.basis, amount_minor: commission.amount_minor, from: "approved", to: "paid" },
  });
  return c.json({ ok: true, commission_id: commissionId, status: "paid", paid_at: ts });
});

adminRoutes.post("/commissions/:commissionId/void", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");
  const commissionId = c.req.param("commissionId");
  const commission = await c.env.DB.prepare(
    `SELECT id, status FROM commissions WHERE id = ?`
  )
    .bind(commissionId)
    .first<{ id: string; status: string }>();
  if (!commission) return jsonError(c, 404, "Commission not found");
  if (commission.status !== "pending" && commission.status !== "approved") return jsonError(c, 409, "Only pending or approved commissions can be voided");

  const ts = nowIso();
  await c.env.DB.prepare(`UPDATE commissions SET status = 'void' WHERE id = ? AND status IN ('pending', 'approved')`)
    .bind(commissionId)
    .run();
  await audit(c, {
    actor_user_id: admin.id,
    action: "admin.commission_voided",
    target_type: "commission",
    target_id: commissionId,
    detail: { from: commission.status, to: "void" },
  });
  return c.json({ ok: true, commission_id: commissionId, status: "void" });
});

export default adminRoutes;
