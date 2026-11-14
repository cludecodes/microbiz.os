import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { verifyHmac } from "../lib/crypto";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { confirmPayment, type PaymentRow } from "../lib/billing";
import {
  parseLemonSqueezyEvent,
  parseSafepayEvent,
  type ParseResult,
} from "../lib/payments/adapters";

/**
 * Provider webhook ingestion. The security contract is fixed:
 *   1. verify signature against the server-side secret        (fail closed)
 *   2. require a stable provider event id for idempotency     (unique key)
 *   3. match an EXISTING payment by our reference             (never create)
 *   4. re-check amount + currency against the payment row     (no trust)
 *   5. only then confirm -> activate plan -> post ledger
 *
 * Webhooks can never invent revenue: an event without a matching payment is
 * recorded as unmatched and returned 202 without changing anything.
 */

type HostedProvider = "safepay" | "lemonsqueezy";

async function handleWebhook(
  c: Context<{ Bindings: Env }>,
  provider: HostedProvider,
  secret: string | undefined,
  signature: string,
  parse: (raw: string) => ParseResult
): Promise<Response> {
  if (!secret) {
    return jsonError(
      c,
      501,
      `PAYMENT_PROVIDER_NOT_CONFIGURED:${provider}`,
      `Add ${provider === "safepay" ? "SAFEPAY_WEBHOOK_SECRET" : "LEMON_SQUEEZY_WEBHOOK_SECRET"} via Cloudflare secrets before enabling webhooks.`
    );
  }
  const raw = await c.req.text();
  if (!signature) return jsonError(c, 401, "Missing webhook signature");
  if (!(await verifyHmac(secret, raw, signature))) {
    return jsonError(c, 401, "Invalid webhook signature");
  }

  const parsed = parse(raw);
  if (!parsed.ok) return jsonError(c, 400, `Malformed webhook payload: ${parsed.reason}`);
  const event = parsed.event;
  const ts = nowIso();

  // ---- 1. idempotency -----------------------------------------------------
  const existing = await c.env.DB.prepare(
    `SELECT id FROM payment_events WHERE provider = ? AND event_id = ?`
  )
    .bind(provider, event.eventId)
    .first();
  if (existing) return c.json({ ok: true, duplicate: true });

  // ---- 2. match an existing payment (never create one) --------------------
  let payment: PaymentRow | null = null;
  if (event.reference) {
    payment = await c.env.DB.prepare(
      `SELECT id, workspace_id, plan_id, invoice_id, purchase_id, lead_purchase_id, provider, provider_txn_ref, amount_minor, fee_minor,
              currency, status, settlement_status, refund_minor
       FROM payments WHERE provider = ? AND provider_txn_ref = ?`
    )
      .bind(provider, event.reference)
      .first<PaymentRow>();
  }

  // ---- 3. append-only event record ---------------------------------------
  const eventRowId = uuid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO payment_events (id, provider, event_id, payment_id, event_type, signature_verified, payload, processed_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(eventRowId, provider, event.eventId, payment?.id ?? null, event.eventType, JSON.stringify(event.raw), ts)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) return c.json({ ok: true, duplicate: true });
    throw err;
  }

  await audit(c, {
    action: "payments.webhook_verified",
    target_type: "payment_event",
    target_id: eventRowId,
    detail: {
      provider,
      event_type: event.eventType,
      matched: Boolean(payment),
      amount_minor: event.amountMinor,
      currency: event.currency,
    },
  });

  // ---- 4. unmatched: acknowledge, change nothing --------------------------
  if (!payment) {
    return c.json({ ok: true, recorded: true, matched: false }, 202);
  }

  if (event.status === "failed") {
    const updated = await c.env.DB.prepare(
      `UPDATE payments SET status = 'failed' WHERE id = ? AND status IN ('initiated','awaiting_confirmation')`
    )
      .bind(payment.id)
      .run();
    await audit(c, {
      action: "payments.failed",
      workspace_id: payment.workspace_id,
      target_type: "payment",
      target_id: payment.id,
      detail: { provider, event_type: event.eventType },
    });
    return c.json({ ok: true, matched: true, status: "failed", changed: (updated.meta?.changes ?? 0) > 0 });
  }

  if (event.status !== "succeeded") {
    // Refund notices are recorded for the admin flow; they never move money here.
    return c.json({ ok: true, recorded: true, matched: true, ignored: true }, 202);
  }

  // ---- 5. amount / currency verification ---------------------------------
  if (event.amountMinor === null || event.amountMinor !== payment.amount_minor) {
    await audit(c, {
      action: "payments.amount_mismatch",
      workspace_id: payment.workspace_id,
      target_type: "payment",
      target_id: payment.id,
      detail: { expected_minor: payment.amount_minor, received_minor: event.amountMinor, currency: payment.currency, provider },
    });
    return c.json(
      { ok: false, error: "amount_mismatch", expected_minor: payment.amount_minor, received_minor: event.amountMinor },
      409
    );
  }
  if (event.currency === null || event.currency !== payment.currency) {
    await audit(c, {
      action: "payments.currency_mismatch",
      workspace_id: payment.workspace_id,
      target_type: "payment",
      target_id: payment.id,
      detail: { expected: payment.currency, received: event.currency, provider },
    });
    return c.json({ ok: false, error: "currency_mismatch", expected: payment.currency, received: event.currency }, 409);
  }

  if (payment.status === "confirmed") {
    return c.json({ ok: true, matched: true, already_confirmed: true });
  }

  // ---- 6. confirm (single authoritative path) ----------------------------
  const result = await confirmPayment(c.env, {
    payment,
    feeMinor: event.feeMinor,
    settledDirectly: false,
    reason: `webhook:${provider}`,
  });
  if (!result.ok) {
    return jsonError(c, 409, `Payment could not be confirmed: ${result.reason}`);
  }

  await audit(c, {
    action: "payments.confirmed",
    workspace_id: payment.workspace_id,
    target_type: "payment",
    target_id: payment.id,
    detail: {
      provider,
      amount_minor: payment.amount_minor,
      currency: payment.currency,
      fee_minor: event.feeMinor,
      already_confirmed: result.alreadyConfirmed,
      plan_activated: result.planActivated,
      invoice_paid: result.invoicePaid,
      purchase_delivered: result.purchaseDelivered,
      lead_delivered: result.leadDelivered,
      commission_id: result.commissionId,
      journal_id: result.journalId,
    },
  });

  return c.json({
    ok: true,
    matched: true,
    confirmed: true,
    already_confirmed: result.alreadyConfirmed,
    plan_activated: result.planActivated,
    invoice_paid: result.invoicePaid,
    purchase_delivered: result.purchaseDelivered,
    lead_delivered: result.leadDelivered,
    commission_id: result.commissionId,
    journal_id: result.journalId,
  });
}

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/webhooks/safepay", (c) =>
  handleWebhook(c, "safepay", c.env.SAFEPAY_WEBHOOK_SECRET, c.req.header("X-SFPY-Signature") ?? "", parseSafepayEvent)
);

webhookRoutes.post("/webhooks/lemonsqueezy", (c) =>
  handleWebhook(
    c,
    "lemonsqueezy",
    c.env.LEMON_SQUEEZY_WEBHOOK_SECRET,
    c.req.header("X-Signature") ?? "",
    parseLemonSqueezyEvent
  )
);

// Bank/Raast/Payoneer have no machine webhook: a super admin reconciles the
// real receipt through /api/admin/payments/:id/confirm (see admin.ts).
