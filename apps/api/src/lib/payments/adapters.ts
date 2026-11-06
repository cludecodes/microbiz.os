/**
 * Payment adapter layer (M5).
 *
 * Two kinds of providers:
 *  - hosted (safepay, lemonsqueezy): customer is redirected to a provider
 *    checkout page; confirmation arrives ONLY via a signature-verified webhook.
 *  - manual (bank, raast, payoneer): customer sends a transfer with a
 *    reference code; an admin confirms against the real bank/provider receipt.
 *
 * Hosted checkout requires BOTH the webhook secret and a checkout URL template
 * configured by the owner (payment-link per plan). Without them the adapter
 * fails closed — there is no fake checkout URL in this codebase.
 *
 * Webhook payload contracts:
 *  - Lemon Squeezy: official shape (meta.event_id/event_name, data.id,
 *    data.attributes.total in cents, custom reference in meta.custom_data).
 *  - Safepay: normalized contract documented in docs/providers.md; the exact
 *    live payload must be re-verified against Safepay docs during sandbox
 *    onboarding before enabling in production.
 */

import type { Env } from "../../types";
import { PROVIDER_CAPABILITIES, formatMoney, type BillingProvider, type CurrencyCode } from "@microbiz/shared";

export class PaymentProviderNotConfigured extends Error {
  constructor(provider: BillingProvider, what: string) {
    super(`PAYMENT_PROVIDER_NOT_CONFIGURED:${provider} — ${what}`);
    this.name = "PaymentProviderNotConfigured";
  }
}

export interface CheckoutInput {
  reference: string;
  amountMinor: number;
  currency: CurrencyCode;
  /** Plan name (subscriptions) or a short subject (invoice payments). */
  planName: string;
  /** Optional human label used in manual instructions, e.g. "invoice INV-0001". */
  label?: string;
}

export interface CheckoutSession {
  mode: "hosted" | "manual";
  redirectUrl: string | null;
  instructions: string;
}

export function isProviderConfigured(env: Env, provider: BillingProvider): boolean {
  if (provider === "bank" || provider === "raast" || provider === "payoneer") return true;
  if (provider === "safepay") {
    return Boolean(env.SAFEPAY_WEBHOOK_SECRET && env.SAFEPAY_CHECKOUT_URL_TEMPLATE);
  }
  return Boolean(env.LEMON_SQUEEZY_WEBHOOK_SECRET && env.LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE);
}

export function createCheckoutSession(env: Env, provider: BillingProvider, input: CheckoutInput): CheckoutSession {
  const cap = PROVIDER_CAPABILITIES[provider];
  if (!cap.currencies.includes(input.currency)) {
    throw new Error(`PROVIDER_CURRENCY_MISMATCH:${provider} does not settle ${input.currency}`);
  }

  if (cap.mode === "manual") {
    const subject = input.label ?? `${input.planName} plan`;
    const after = input.label
      ? "The invoice is marked paid only after an admin verifies the real receipt."
      : "The plan activates only after an admin verifies the real receipt.";
    return {
      mode: "manual",
      redirectUrl: null,
      instructions:
        `Send ${formatMoney(input.amountMinor, input.currency)} for ${subject} via ${cap.label}, ` +
        `using reference ${input.reference}. ${after}`,
    };
  }

  if (!isProviderConfigured(env, provider)) {
    throw new PaymentProviderNotConfigured(
      provider,
      "webhook secret and checkout URL template must be configured before hosted checkout is enabled"
    );
  }

  const template =
    provider === "safepay" ? env.SAFEPAY_CHECKOUT_URL_TEMPLATE! : env.LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE!;
  const url = new URL(template);
  if (provider === "lemonsqueezy") {
    url.searchParams.set("checkout[custom][reference]", input.reference);
  } else {
    url.searchParams.set("reference", input.reference);
  }
  return {
    mode: "hosted",
    redirectUrl: url.toString(),
    instructions: "You will be redirected to the provider's secure checkout. The plan activates after their signed webhook confirms payment.",
  };
}

// ------------------------------------------------------------------ webhooks

export interface NormalizedEvent {
  eventId: string;
  eventType: string;
  /** Our reference code, used to match the payment row. */
  reference: string | null;
  /** Provider-side transaction id, stored for support/reconciliation. */
  providerTxnRef: string | null;
  amountMinor: number | null;
  currency: CurrencyCode | null;
  feeMinor: number;
  status: "succeeded" | "failed" | "refunded" | "other";
  raw: Record<string, unknown>;
}

export type ParseResult = { ok: true; event: NormalizedEvent } | { ok: false; reason: string };

const CURRENCY_SET = new Set(["PKR", "USD"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asMinor(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function asCurrency(value: unknown): CurrencyCode | null {
  const s = asString(value)?.toUpperCase();
  return s && CURRENCY_SET.has(s) ? (s as CurrencyCode) : null;
}

function statusFrom(value: string | null): NormalizedEvent["status"] {
  const s = (value ?? "").toLowerCase();
  if (["succeeded", "success", "paid", "completed", "captured", "confirmed"].includes(s)) return "succeeded";
  if (["failed", "declined", "canceled", "cancelled", "void", "expired"].includes(s)) return "failed";
  if (["refunded", "refund"].includes(s)) return "refunded";
  return "other";
}

/**
 * Safepay normalized sandbox contract (see docs/providers.md):
 * {
 *   "id": "evt_...", "event": "payment.succeeded",
 *   "data": { "reference": "MB-XXXXXXXX", "tracker": "track_...",
 *             "amount_minor": 150000, "amount": "1500.00",
 *             "currency": "PKR", "fee_minor": 30000, "status": "succeeded" }
 * }
 */
export function parseSafepayEvent(rawBody: string): ParseResult {
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(rawBody));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const eventId = asString(payload.id);
  if (!eventId) return { ok: false, reason: "missing_event_id" };
  const data = asRecord(payload.data);
  const currency = asCurrency(data.currency);
  const amountMinor = asMinor(data.amount_minor) ?? asMinor(data.amount);
  const status = statusFrom(asString(data.status) ?? asString(payload.event)?.split(".").pop() ?? null);

  return {
    ok: true,
    event: {
      eventId,
      eventType: asString(payload.event) ?? "unknown",
      reference: asString(data.reference) ?? asString(data.order_id),
      providerTxnRef: asString(data.tracker) ?? asString(data.transaction_id),
      amountMinor,
      currency,
      feeMinor: asMinor(data.fee_minor) ?? 0,
      status,
      raw: payload,
    },
  };
}

/**
 * Lemon Squeezy official webhook shape:
 * { meta: { event_id, event_name, custom_data?: { reference } },
 *   data: { id, type, attributes: { total (cents), currency, status, identifier } } }
 */
export function parseLemonSqueezyEvent(rawBody: string): ParseResult {
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(rawBody));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const meta = asRecord(payload.meta);
  const eventId = asString(meta.event_id);
  if (!eventId) return { ok: false, reason: "missing_event_id" };
  const data = asRecord(payload.data);
  const attrs = asRecord(data.attributes);
  const custom = asRecord(meta.custom_data);
  const eventName = asString(meta.event_name) ?? "unknown";
  const status = eventName.startsWith("refund")
    ? "refunded"
    : statusFrom(asString(attrs.status) ?? eventName);

  return {
    ok: true,
    event: {
      eventId,
      eventType: eventName,
      reference: asString(custom.reference) ?? asString(attrs.identifier),
      providerTxnRef: asString(data.id),
      amountMinor: asMinor(attrs.total),
      currency: asCurrency(attrs.currency),
      // Lemon Squeezy is merchant of record; its fee is deducted at payout,
      // not itemized per order webhook. Recorded as 0 here, reconciled on payout.
      feeMinor: 0,
      status,
      raw: payload,
    },
  };
}
