/** Marketing, referrals and affiliate commission domain (M7). */

import { z } from "zod";
import { currencySchema } from "./schemas";

export const commissionBasisSchema = z.enum(["subscription", "lead_sale", "digital_sale"]);
export type CommissionBasis = z.infer<typeof commissionBasisSchema>;

export const commissionStatusSchema = z.enum(["pending", "approved", "paid", "void"]);
export type CommissionStatus = z.infer<typeof commissionStatusSchema>;

export const createCommissionSchema = z.object({
  referral_id: z.string().trim().min(1).max(64),
  basis: commissionBasisSchema,
  /** Payment, lead or digital-product identifier the commission belongs to. */
  basis_id: z.string().trim().min(1).max(128),
  currency: currencySchema,
  /** Commission amount in integer minor units; positive only. */
  amount_minor: z.number().int().positive().max(1_000_000_000_000),
});

export interface ReferralRow {
  id: string;
  code: string;
  referrer_user_id: string;
  referred_user_id: string | null;
  converted_at: string | null;
  created_at: string;
}

export interface CommissionRow {
  id: string;
  referral_id: string;
  referrer_user_id: string;
  basis: CommissionBasis;
  basis_id: string;
  currency: string;
  amount_minor: number;
  status: CommissionStatus;
  created_at: string;
  paid_at: string | null;
}
