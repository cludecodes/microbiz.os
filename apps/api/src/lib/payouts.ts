import type { Env } from "../types";
import type { PayoutProfileDetails } from "@microbiz/shared";
import { decryptField, encryptField, isValidAes256Key } from "./crypto";

/**
 * Payout-profile storage helpers.
 *
 * Only an allowlisted details object (shared `payoutProfileDetailsSchema`) is
 * accepted, then the whole object is AES-256-GCM encrypted before D1 sees it.
 * Reads NEVER return the plaintext back to a client: only a masked preview is
 * exposed. Card numbers, CVVs, passwords and OTPs are rejected by the schema.
 */

export class PayoutEncryptionNotConfigured extends Error {
  constructor() {
    super(
      "PAYOUT_ENCRYPTION_NOT_CONFIGURED: set PAYOUT_ENCRYPTION_KEY to a base64-encoded 32-byte key before saving payout profiles"
    );
    this.name = "PayoutEncryptionNotConfigured";
  }
}

export function payoutEncryptionKey(env: Env): string {
  if (!isValidAes256Key(env.PAYOUT_ENCRYPTION_KEY)) throw new PayoutEncryptionNotConfigured();
  return env.PAYOUT_ENCRYPTION_KEY;
}

export function isPayoutEncryptionConfigured(env: Env): boolean {
  return isValidAes256Key(env.PAYOUT_ENCRYPTION_KEY);
}

export async function encryptPayoutDetails(env: Env, details: PayoutProfileDetails): Promise<string> {
  return encryptField(JSON.stringify(details), payoutEncryptionKey(env));
}

export async function decryptPayoutDetails(env: Env, cipher: string): Promise<PayoutProfileDetails | null> {
  try {
    const key = payoutEncryptionKey(env);
    const text = await decryptField(cipher, key);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PayoutProfileDetails) : null;
  } catch {
    // Wrong/rotated key or corrupted row: fail closed, never leak ciphertext.
    return null;
  }
}

export interface PayoutDetailsPreview {
  account_title: string | null;
  institution: string | null;
  identifier: string | null;
  payoneer_email: string | null;
}

function maskTail(value: string | undefined | null): string | null {
  if (!value) return null;
  const clean = value.replace(/\s+/g, "");
  if (clean.length <= 4) return "••••";
  return `••••${clean.slice(-4)}`;
}

function maskEmail(value: string | undefined | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return "••••";
  return `${local.slice(0, 1)}***@${domain}`;
}

export function payoutDetailsPreview(details: PayoutProfileDetails | null): PayoutDetailsPreview | null {
  if (!details) return null;
  return {
    account_title: details.account_title ?? null,
    institution: details.bank_name ?? details.country ?? null,
    identifier: maskTail(details.iban ?? details.account_number),
    payoneer_email: maskEmail(details.payoneer_email),
  };
}
