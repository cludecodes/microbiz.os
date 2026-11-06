/**
 * Billing domain: plan checkout, subscription periods and the exact ledger
 * postings for money events.
 *
 * Rules:
 * - Amounts are integer minor units, one currency per journal.
 * - A payment is never "successful" because a browser said so — only a
 *   signature-verified provider event (or an explicit admin reconciliation of
 *   a real bank credit) can confirm one. See apps/api/src/routes/webhooks.ts.
 * - Settlement is tracked independently of payment confirmation.
 */

import { z } from "zod";
import type { CurrencyCode } from "./money";
import type { LedgerPosting } from "./ledger";

export const BILLING_PROVIDERS = ["safepay", "lemonsqueezy", "bank", "raast", "payoneer"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export interface ProviderCapability {
  label: string;
  /** Currencies this provider can actually settle in. */
  currencies: CurrencyCode[];
  /** hosted = provider checkout page; manual = customer sends a transfer. */
  mode: "hosted" | "manual";
  /** Env binding that must exist before this provider is enabled. */
  secretEnv: string;
  /** One-line customer guidance. */
  description: string;
}

export const PROVIDER_CAPABILITIES: Record<BillingProvider, ProviderCapability> = {
  safepay: {
    label: "Safepay",
    currencies: ["PKR"],
    mode: "hosted",
    secretEnv: "SAFEPAY_WEBHOOK_SECRET",
    description: "Pakistani cards and wallets via Safepay hosted checkout (sandbox first).",
  },
  lemonsqueezy: {
    label: "Lemon Squeezy",
    currencies: ["USD"],
    mode: "hosted",
    secretEnv: "LEMON_SQUEEZY_WEBHOOK_SECRET",
    description: "International cards via Lemon Squeezy (merchant of record fees apply).",
  },
  bank: {
    label: "Bank transfer",
    currencies: ["PKR"],
    mode: "manual",
    secretEnv: "",
    description: "Transfer to the account on your invoice. A reference code keeps it matched.",
  },
  raast: {
    label: "Raast",
    currencies: ["PKR"],
    mode: "manual",
    secretEnv: "",
    description: "Instant PKR transfer via Raast. Include the reference code in the note.",
  },
  payoneer: {
    label: "Payoneer",
    currencies: ["USD"],
    mode: "manual",
    secretEnv: "",
    description: "USD receipt via Payoneer. Confirmed by an admin against the real receipt.",
  },
};

export const checkoutSchema = z.object({
  plan_id: z.string().trim().min(1).max(64),
  provider: z.enum(BILLING_PROVIDERS),
  /** Client-generated key so a double click never creates two intents. */
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

/**
 * Payout targets the owner can register for each provider. Details are
 * validated AGAINST AN ALLOWLIST and then encrypted (AES-256-GCM) before they
 * touch D1. Card numbers, CVVs, passwords, PINs and OTPs are not possible:
 * unknown keys fail strict validation.
 */
export const PAYOUT_PROFILE_KINDS = ["safepay", "bank_raast", "lemonsqueezy", "payoneer"] as const;
export type PayoutProfileKind = (typeof PAYOUT_PROFILE_KINDS)[number];

export const payoutProfileDetailsSchema = z
  .object({
    account_title: z.string().trim().min(1).max(120),
    account_number: z.string().trim().min(4).max(64).optional(),
    iban: z.string().trim().min(6).max(34).optional(),
    bank_name: z.string().trim().max(120).optional(),
    swift: z.string().trim().max(20).optional(),
    payoneer_email: z.string().trim().email().max(254).optional(),
    country: z.string().trim().max(60).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.account_number && !value.iban && !value.payoneer_email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide an account number, IBAN or Payoneer email",
      });
    }
    if (value.payoneer_email && (value.account_number || value.iban)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A Payoneer email cannot be combined with a bank account number/IBAN",
      });
    }
  });

export const payoutProfileSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    details: payoutProfileDetailsSchema,
  })
  .strict();

export type PayoutProfileDetails = z.infer<typeof payoutProfileDetailsSchema>;

/**
 * Advance an ISO timestamp by one calendar month (UTC), clamping the day to
 * the last day of the target month (31 Jan -> 28/29 Feb).
 */
export function addBillingMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 0-based target month
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTarget);
  const next = new Date(
    Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  );
  return next.toISOString();
}

/**
 * Postings for a verified receipt.
 *
 * Hosted provider (money still at the provider until payout):
 *   DEBIT  available_balance  amount - fee
 *   DEBIT  processing_fees    fee
 *   CREDIT gross_receipts     amount
 *
 * Bank/Raast/Payoneer (money already in the owner's bank account):
 *   DEBIT  settled_bank       amount
 *   CREDIT gross_receipts     amount
 *
 * Debits always equal credits; a fee larger than the amount is refused.
 */
export function receiptPostings(
  amountMinor: number,
  feeMinor: number,
  currency: CurrencyCode,
  opts: { settledDirectly: boolean }
): LedgerPosting[] {
  assertMinor(amountMinor, "amount");
  if (!Number.isInteger(feeMinor) || feeMinor < 0) throw new Error("fee must be a non-negative integer");
  if (feeMinor >= amountMinor) throw new Error("fee must be smaller than the amount");
  if (opts.settledDirectly) {
    return [
      { account: "settled_bank", direction: "DEBIT", currency, amount_minor: amountMinor },
      { account: "gross_receipts", direction: "CREDIT", currency, amount_minor: amountMinor },
    ];
  }
  const net = amountMinor - feeMinor;
  const postings: LedgerPosting[] = [
    { account: "available_balance", direction: "DEBIT", currency, amount_minor: net },
    { account: "gross_receipts", direction: "CREDIT", currency, amount_minor: amountMinor },
  ];
  if (feeMinor > 0) {
    postings.splice(1, 0, {
      account: "processing_fees",
      direction: "DEBIT",
      currency,
      amount_minor: feeMinor,
    });
  }
  return postings;
}

/**
 * Refund: reduce the payer's funds and record a contra-revenue debit.
 *
 * If the receipt was already settled to the owner's bank, the money must come
 * out of `settled_bank`; otherwise it reduces the provider-held balance.
 */
export function refundPostings(
  amountMinor: number,
  currency: CurrencyCode,
  opts: { fromSettledBank?: boolean } = {}
): LedgerPosting[] {
  assertMinor(amountMinor, "refund amount");
  return [
    { account: "refunds", direction: "DEBIT", currency, amount_minor: amountMinor },
    {
      account: opts.fromSettledBank ? "settled_bank" : "available_balance",
      direction: "CREDIT",
      currency,
      amount_minor: amountMinor,
    },
  ];
}

/**
 * Payout from provider to bank: move held funds into settled bank funds.
 *
 * `netMinor` is the amount the ledger says the provider held for us. The real
 * payout may be smaller (fees deducted at payout, e.g. Lemon Squeezy merchant
 * of record). The difference is recorded as a `payout_fees` expense so the
 * journal still balances.
 */
export function settlementPostings(
  netMinor: number,
  currency: CurrencyCode,
  receivedMinor: number = netMinor
): LedgerPosting[] {
  assertMinor(netMinor, "settlement amount");
  if (!Number.isInteger(receivedMinor) || receivedMinor < 0) {
    throw new Error("received amount must be a non-negative integer");
  }
  if (receivedMinor > netMinor) {
    throw new Error("received amount cannot exceed the net held balance");
  }
  const postings: LedgerPosting[] = [
    { account: "settled_bank", direction: "DEBIT", currency, amount_minor: receivedMinor },
  ];
  if (receivedMinor < netMinor) {
    postings.push({
      account: "payout_fees",
      direction: "DEBIT",
      currency,
      amount_minor: netMinor - receivedMinor,
    });
  }
  postings.push({
    account: "available_balance",
    direction: "CREDIT",
    currency,
    amount_minor: netMinor,
  });
  return postings;
}

function assertMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer in minor units`);
  }
}
