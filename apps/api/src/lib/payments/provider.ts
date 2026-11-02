/**
 * Payment provider adapter architecture.
 *
 * Ground rules for EVERY adapter:
 *  - Secrets only ever used server-side (env bindings / Cloudflare secrets).
 *  - Webhooks MUST verify signatures; unverified events are rejected.
 *  - Events are idempotent via payment_events(provider, event_id) unique key.
 *  - The browser's success message is advisory ONLY. Payment becomes
 *    'confirmed' solely server-side after provider verification.
 *  - Amount, currency and transaction reference are re-checked server-side.
 *  - A confirmed payment balances the double-entry ledger.
 *  - Settlement is tracked independently of payment confirmation.
 *  - No customer wallet or escrow: we never hold customer balances.
 */

export type ProviderId = "safepay" | "bank" | "raast" | "lemonsqueezy" | "payoneer" | "manual";

export interface PaymentIntentRequest {
  workspaceId: string;
  /** Amount in minor units. */
  amountMinor: number;
  currency: "PKR" | "USD";
  invoiceId?: string;
  orderId?: string;
  idempotencyKey: string;
  /** Sandbox mode: providers must be called in their sandbox environment. */
  sandbox: boolean;
}

export interface PaymentIntentResult {
  paymentId: string;
  /** Redirect URL for hosted checkout providers; null for offline providers. */
  redirectUrl: string | null;
  status: "initiated" | "awaiting_confirmation";
}

export interface WebhookVerificationResult {
  verified: boolean;
  eventType: string | null;
  eventId: string | null;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  readonly requiresSecret: boolean;
  isConfigured(env: unknown): boolean;
  createIntent(req: PaymentIntentRequest): Promise<PaymentIntentResult>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string>
  ): Promise<WebhookVerificationResult>;
  /** Optional: reconcile a manual/offline transaction (bank, RAFAST...). */
  reconcile?(): Promise<void>;
}

/** Shared guard: reject adapters touched without server-side credentials. */
export function assertProviderConfigured(
  configured: boolean,
  providerId: ProviderId
): void {
  if (!configured) {
    throw new Error(
      `PAYMENT_PROVIDER_NOT_CONFIGURED:${providerId} — add its secret via Cloudflare secrets before enabling this provider in production`
    );
  }
}

/** HMAC-SHA256 helpers imported here so adapters share one verified path. */
export { hmacHex, verifyHmac } from "../crypto";
