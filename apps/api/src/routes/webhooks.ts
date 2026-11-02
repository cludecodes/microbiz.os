import { Hono } from "hono";
import type { Env } from "../types";
import { verifyHmac } from "../lib/crypto";
import { assertProviderConfigured } from "../lib/payments/provider";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import type { ApiContext } from "../lib/auth";

/**
 * Provider webhook ingestion. Implements the shared security contract:
 *   1. verify signature against server-side secret  (fail closed)
 *   2. store raw event with unique key -> idempotent processing
 *   3. re-check amount/currency/reference server-side
 *   4. ONLY THEN may the related payment move to 'confirmed'
 *
 * NOTE (milestone 5): actual provider-specific confirmation + ledger postings
 * land with the subscription infrastructure milestone. This handler never
 * marks anything paid until adapters return verified events.
 */

async function ingestEvent(
  c: ApiContext,
  provider: string,
  rawBody: string,
  verified: boolean,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<Response> {
  // 1. Idempotency: unique (provider, event_id). Replays exit quietly with 200.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM payment_events WHERE provider = ? AND event_id = ?`
  )
    .bind(provider, eventId)
    .first();
  if (existing) return c.json({ ok: true, duplicate: true });

  // 2. Append-only record of the verified third-party event.
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO payment_events (id, provider, event_id, event_type, signature_verified, payload, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, provider, eventId, eventType, verified ? 1 : 0, JSON.stringify(payload), nowIso())
    .run();

  await audit(c, {
    action: "payments.webhook_received",
    target_type: "payment_event",
    target_id: id,
    detail: { provider, event_type: eventType, signature_verified: verified },
  });

  // 3. Processing. Only verified events are eligible; everything else is
  //    recorded but MUST NOT change payment status.
  if (!verified) {
    return c.json({ error: "signature_not_verified", recorded: true }, 202);
  }
  return c.json({ ok: true, recorded: true, note: "confirmation logic arrives with payments milestone" });
}

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/webhooks/safepay", async (c) => {
  const secret = c.env.SAFEPAY_WEBHOOK_SECRET;
  assertProviderConfigured(Boolean(secret), "safepay");
  const raw = await c.req.text();
  const signature = c.req.header("X-SFPY-Signature") ?? "";
  const verified = secret ? await verifyHmac(secret, raw, signature) : false;
  if (!verified) return jsonError(c, 401, "Invalid webhook signature");

  let event: { event?: string; id?: string } & Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    return jsonError(c, 400, "Invalid JSON payload");
  }
  return ingestEvent(c, "safepay", raw, true, event.id ?? crypto.randomUUID(), event.event ?? "unknown", event);
});

webhookRoutes.post("/webhooks/lemonsqueezy", async (c) => {
  const secret = c.env.LEMON_SQUEEZE_WEBHOOK_SECRET;
  assertProviderConfigured(Boolean(secret), "lemonsqueezy");
  const raw = await c.req.text();
  const signature = c.req.header("X-Signature") ?? "";
  const verified = secret ? await verifyHmac(secret, raw, signature) : false;
  if (!verified) return jsonError(c, 401, "Invalid webhook signature");

  let event: { meta?: { event_name?: string; event_id?: string } } & Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    return jsonError(c, 400, "Invalid JSON payload");
  }
  const eventId = event.meta?.event_id ?? crypto.randomUUID();
  const eventType = event.meta?.event_name ?? "unknown";
  return ingestEvent(c, "lemonsqueezy", raw, true, eventId, eventType, event);
});

// RAAST / bank reconciliation arrives via admin reconciliation flows in the
// settlement milestone; there is no machine webhook for plain bank transfers.
