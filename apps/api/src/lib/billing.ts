import type { Env } from "../types";
import { addBillingMonth, receiptPostings, refundPostings, settlementPostings, type CurrencyCode } from "@microbiz/shared";
import { nowIso, uuid } from "./http";
import { postJournal } from "./ledger";

export interface PaymentRow {
  id: string;
  workspace_id: string;
  plan_id: string | null;
  invoice_id: string | null;
  purchase_id: string | null;
  provider: string;
  provider_txn_ref: string | null;
  amount_minor: number;
  fee_minor: number;
  currency: CurrencyCode;
  status: string;
  settlement_status: string;
  refund_minor: number;
}

export async function getPaymentForWorkspace(
  env: Env,
  workspaceId: string,
  paymentId: string
): Promise<PaymentRow | null> {
  return env.DB.prepare(
    `SELECT id, workspace_id, plan_id, invoice_id, purchase_id, provider, provider_txn_ref, amount_minor, fee_minor,
            currency, status, settlement_status, refund_minor
     FROM payments WHERE id = ? AND workspace_id = ?`
  )
    .bind(paymentId, workspaceId)
    .first<PaymentRow>();
}

export interface ConfirmInput {
  payment: PaymentRow;
  /** Provider-reported fee; 0 when unknown. */
  feeMinor: number;
  /** true = money already in the owner's bank (bank/Raast/Payoneer). */
  settledDirectly: boolean;
  /** Human-readable source, e.g. "webhook:safepay" or "admin:reconcile". */
  reason: string;
}

export type ConfirmResult =
  | {
      ok: true;
      alreadyConfirmed: boolean;
      journalId: string | null;
      planActivated: string | null;
      /** True when this receipt covered the linked invoice's full total. */
      invoicePaid: boolean;
      /** True when this receipt delivered a linked digital purchase. */
      purchaseDelivered: boolean;
      /** Pending affiliate commission (M7) minted for a confirmed digital sale. */
      commissionId: string | null;
    }
  | { ok: false; reason: string };

/**
 * The ONLY path that may turn a payment into 'confirmed'.
 *
 * Callers are the signed-webhook handler and the super-admin bank
 * reconciliation endpoint. The status guard in the UPDATE makes replay
 * attempts idempotent (no double ledger postings, no double activation).
 */
export async function confirmPayment(env: Env, input: ConfirmInput): Promise<ConfirmResult> {
  const { payment } = input;

  // Validate the plan BEFORE touching payment status.
  let plan: { id: string; currency: string; is_active: number } | null = null;
  if (payment.plan_id) {
    plan = await env.DB.prepare(`SELECT id, currency, is_active FROM plans WHERE id = ?`)
      .bind(payment.plan_id)
      .first();
    if (!plan) return { ok: false, reason: "plan_not_found" };
    if (plan.currency !== payment.currency) return { ok: false, reason: "plan_currency_mismatch" };
  }

  const ts = nowIso();
  const settled = input.settledDirectly;
  const update = await env.DB.prepare(
    `UPDATE payments
     SET status = 'confirmed',
         confirmed_at = COALESCE(confirmed_at, ?),
         fee_minor = MAX(fee_minor, ?),
         settlement_status = ?,
         settled_at = ?
     WHERE id = ? AND status IN ('initiated','awaiting_confirmation')`
  )
    .bind(ts, input.feeMinor, settled ? "settled" : "pending", settled ? ts : null, payment.id)
    .run();

  if ((update.meta?.changes ?? 0) === 0) {
    const current = await env.DB.prepare(`SELECT status FROM payments WHERE id = ?`)
      .bind(payment.id)
      .first<{ status: string }>();
    if (current?.status === "confirmed" || current?.status === "refunded") {
      return {
        ok: true,
        alreadyConfirmed: true,
        journalId: null,
        planActivated: null,
        invoicePaid: false,
        purchaseDelivered: false,
        commissionId: null,
      };
    }
    return { ok: false, reason: `payment_status_${current?.status ?? "missing"}` };
  }

  // Plan activation (only after the payment guard succeeded).
  let planActivated: string | null = null;
  if (plan) {
    const periodEnd = addBillingMonth(ts);
    const providerRef = payment.provider_txn_ref ?? payment.id;
    await env.DB.batch([
      env.DB.prepare(`UPDATE workspaces SET plan_id = ? WHERE id = ?`).bind(plan.id, payment.workspace_id),
      env.DB.prepare(
        `UPDATE subscriptions
         SET plan_id = ?, status = 'active', provider = ?, provider_ref = ?,
             current_period_end = ?, canceled_at = NULL, updated_at = ?
         WHERE workspace_id = ?`
      ).bind(plan.id, payment.provider, providerRef, periodEnd, ts, payment.workspace_id),
    ]);
    planActivated = plan.id;
  }

  const journalId = await postJournal(env, {
    workspaceId: payment.workspace_id,
    memo: `Payment ${payment.id} confirmed (${input.reason})`,
    currency: payment.currency,
    refType: "payment",
    refId: payment.id,
    postings: receiptPostings(payment.amount_minor, input.feeMinor, payment.currency, {
      settledDirectly: settled,
    }),
  });

  const invoicePaid = payment.invoice_id
    ? await markInvoicePaidIfCovered(env, payment.invoice_id, payment.workspace_id, payment.currency, ts)
    : false;

  // Digital Downloads (Phase 2): a confirmed receipt delivers the linked
  // purchase automatically. No other code path may release the file.
  let purchaseDelivered = false;
  let commissionId: string | null = null;
  if (payment.purchase_id) {
    const delivered = await env.DB.prepare(
      `UPDATE digital_purchases
          SET status = 'delivered',
              paid_at = COALESCE(paid_at, ?),
              delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ? AND payment_id = ? AND status = 'awaiting_payment'`
    )
      .bind(ts, ts, payment.purchase_id, payment.id)
      .run();
    purchaseDelivered = (delivered.meta?.changes ?? 0) > 0;
    if (purchaseDelivered) {
      commissionId = await createDigitalSaleCommission(
        env,
        payment.workspace_id,
        payment.purchase_id,
        payment.currency,
        payment.amount_minor
      );
    }
  }

  return { ok: true, alreadyConfirmed: false, journalId, planActivated, invoicePaid, purchaseDelivered, commissionId };
}

/**
 * M7 affiliate commission for a confirmed digital sale: when the purchasing
 * workspace's owner registered through a referral code, a PENDING commission
 * (10% of the receipt) is recorded for the referrer. Pending means no money
 * claim — a super-admin must still approve and pay it. Idempotent per
 * purchase: the basis_id lookup makes webhook replays harmless.
 */
async function createDigitalSaleCommission(
  env: Env,
  workspaceId: string,
  purchaseId: string,
  currency: CurrencyCode,
  amountMinor: number
): Promise<string | null> {
  const existing = await env.DB.prepare(
    `SELECT id FROM commissions WHERE basis = 'digital_sale' AND basis_id = ? LIMIT 1`
  )
    .bind(purchaseId)
    .first<{ id: string }>();
  if (existing) return null;

  const referral = await env.DB.prepare(
    `SELECT r.id, r.referrer_user_id
       FROM referrals r
       JOIN memberships m ON m.user_id = r.referred_user_id AND m.role = 'owner'
      WHERE m.workspace_id = ?
      LIMIT 1`
  )
    .bind(workspaceId)
    .first<{ id: string; referrer_user_id: string }>();
  if (!referral) return null;

  const amount = Math.floor(amountMinor * 0.1); // 10% affiliate rate
  if (amount <= 0) return null;

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO commissions (id, referral_id, referrer_user_id, basis, basis_id, currency, amount_minor, status, created_at, paid_at)
     VALUES (?, ?, ?, 'digital_sale', ?, ?, ?, 'pending', ?, NULL)`
  )
    .bind(id, referral.id, referral.referrer_user_id, purchaseId, currency, amount, nowIso())
    .run();
  return id;
}

/**
 * An invoice becomes `paid` ONLY when confirmed receipts cover its full total.
 * A pending manual "owner says paid" status is still available, but a verified
 * payment can never turn a draft/void document into a paid one.
 */
async function markInvoicePaidIfCovered(
  env: Env,
  invoiceId: string,
  workspaceId: string,
  currency: CurrencyCode,
  ts: string
): Promise<boolean> {
  const invoice = await env.DB.prepare(
    `SELECT id, total_minor, currency, status, type FROM invoices
     WHERE id = ? AND workspace_id = ?`
  )
    .bind(invoiceId, workspaceId)
    .first<{ id: string; total_minor: number; currency: string; status: string; type: string }>();
  if (!invoice || invoice.type !== "invoice" || invoice.status !== "sent" || invoice.currency !== currency) {
    return false;
  }
  const received = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
     WHERE invoice_id = ? AND status IN ('confirmed','refunded')`
  )
    .bind(invoice.id)
    .first<{ total: number }>();
  if ((received?.total ?? 0) < invoice.total_minor) return false;

  const updated = await env.DB.prepare(
    `UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?
     WHERE id = ? AND status = 'sent' AND type = 'invoice'`
  )
    .bind(ts, ts, invoice.id)
    .run();
  return (updated.meta?.changes ?? 0) > 0;
}

/** Refund a confirmed receipt. The admin has already executed it offline. */
export interface RefundInput {
  payment: PaymentRow;
  amountMinor: number;
  reason: string;
  providerRef?: string | null;
}

export type RefundResult =
  | {
      ok: true;
      journalId: string;
      refundMinor: number;
      status: string;
      fromSettledBank: boolean;
    }
  | { ok: false; reason: string };

export async function refundPayment(env: Env, input: RefundInput): Promise<RefundResult> {
  const { payment, amountMinor } = input;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { ok: false, reason: "invalid_amount" };
  if (!["confirmed", "refunded"].includes(payment.status)) {
    return { ok: false, reason: `payment_status_${payment.status}` };
  }
  const refundable = payment.amount_minor - payment.refund_minor;
  if (refundable <= 0) return { ok: false, reason: "nothing_refundable" };
  if (amountMinor > refundable) return { ok: false, reason: "refund_exceeds_refundable" };

  const nextRefund = payment.refund_minor + amountMinor;
  const nextStatus = nextRefund === payment.amount_minor ? "refunded" : "confirmed";
  // Funds already in the owner's bank come out of settled_bank; provider-held
  // funds reduce the available balance that will be paid out later.
  const fromSettledBank = payment.settlement_status === "settled";
  const ts = nowIso();

  const updated = await env.DB.prepare(
    `UPDATE payments SET refund_minor = ?, status = ?
     WHERE id = ? AND refund_minor = ? AND status IN ('confirmed','refunded')`
  )
    .bind(nextRefund, nextStatus, payment.id, payment.refund_minor)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) return { ok: false, reason: "concurrent_refund" };

  let journalId: string;
  try {
    journalId = await postJournal(env, {
      workspaceId: payment.workspace_id,
      memo: `Refund ${amountMinor} on payment ${payment.id} (${input.reason})`,
      currency: payment.currency,
      refType: "refund",
      refId: payment.id,
      postings: refundPostings(amountMinor, payment.currency, { fromSettledBank }),
    });
  } catch (err) {
    // Compensate the refund counter so the ledger and payments never diverge.
    await env.DB.prepare(`UPDATE payments SET refund_minor = ?, status = ? WHERE id = ?`)
      .bind(payment.refund_minor, payment.status, payment.id)
      .run();
    throw err;
  }

  return { ok: true, journalId, refundMinor: nextRefund, status: nextStatus, fromSettledBank };
}

/** Mark a hosted payout as received. The admin checks the real bank credit. */
export interface SettleInput {
  payment: PaymentRow;
  /** What actually hit the bank; defaults to the net held balance. */
  receivedMinor?: number | null;
  providerRef?: string | null;
}

export type SettleResult =
  | {
      ok: true;
      journalId: string | null;
      netMinor: number;
      receivedMinor: number;
      payoutFeeMinor: number;
    }
  | { ok: false; reason: string };

export async function settlePayment(env: Env, input: SettleInput): Promise<SettleResult> {
  const { payment } = input;
  if (payment.settlement_status !== "pending") {
    return { ok: false, reason: `settlement_${payment.settlement_status}` };
  }
  if (!["confirmed", "refunded"].includes(payment.status)) {
    return { ok: false, reason: `payment_status_${payment.status}` };
  }

  const netMinor = payment.amount_minor - payment.fee_minor - payment.refund_minor;
  const receivedMinor = input.receivedMinor ?? Math.max(netMinor, 0);
  if (!Number.isInteger(receivedMinor) || receivedMinor < 0) return { ok: false, reason: "invalid_received_amount" };
  if (netMinor > 0 && receivedMinor > netMinor) return { ok: false, reason: "payout_exceeds_net" };
  if (netMinor <= 0 && receivedMinor > 0) return { ok: false, reason: "payout_exceeds_net" };

  const ts = nowIso();
  const updated = await env.DB.prepare(
    `UPDATE payments SET settlement_status = 'settled', settled_at = ?
     WHERE id = ? AND settlement_status = 'pending' AND status IN ('confirmed','refunded')`
  )
    .bind(ts, payment.id)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) return { ok: false, reason: "concurrent_settlement" };

  let journalId: string | null = null;
  if (netMinor > 0) {
    try {
      journalId = await postJournal(env, {
        workspaceId: payment.workspace_id,
        memo:
          `Settlement ${receivedMinor}/${netMinor} for payment ${payment.id}` +
          (input.providerRef ? ` (payout ref ${input.providerRef})` : ""),
        currency: payment.currency,
        refType: "settlement",
        refId: payment.id,
        postings: settlementPostings(netMinor, payment.currency, receivedMinor),
      });
    } catch (err) {
      await env.DB.prepare(`UPDATE payments SET settlement_status = 'pending', settled_at = NULL WHERE id = ?`)
        .bind(payment.id)
        .run();
      throw err;
    }
  }

  return {
    ok: true,
    journalId,
    netMinor,
    receivedMinor,
    payoutFeeMinor: Math.max(netMinor - receivedMinor, 0),
  };
}

/** Generate a short, human-readable transfer reference (bank/Raast). */
export function newTransferReference(): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  return `MB-${token}`;
}

/** Allocate an `MB-…` reference that is unique for this provider. */
export async function newUniquePaymentReference(env: Env, provider: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const reference = newTransferReference();
    const clash = await env.DB.prepare(
      `SELECT 1 FROM payments WHERE provider = ? AND provider_txn_ref = ?`
    )
      .bind(provider, reference)
      .first();
    if (!clash) return reference;
  }
  throw new Error("could not allocate a unique payment reference");
}
