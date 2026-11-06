import type { Env } from "../types";
import { addBillingMonth, receiptPostings, type CurrencyCode } from "@microbiz/shared";
import { nowIso } from "./http";
import { postJournal } from "./ledger";

export interface PaymentRow {
  id: string;
  workspace_id: string;
  plan_id: string | null;
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
    `SELECT id, workspace_id, plan_id, provider, provider_txn_ref, amount_minor, fee_minor,
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
  | { ok: true; alreadyConfirmed: boolean; journalId: string | null; planActivated: string | null }
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
    if (current?.status === "confirmed") {
      return { ok: true, alreadyConfirmed: true, journalId: null, planActivated: null };
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

  return { ok: true, alreadyConfirmed: false, journalId, planActivated };
}

/** Generate a short, human-readable transfer reference (bank/Raast). */
export function newTransferReference(): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  return `MB-${token}`;
}
