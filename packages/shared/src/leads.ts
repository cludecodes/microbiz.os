/** Lead Marketplace schemas (app: lead-marketplace, Phase 3). Sellers list
 *  their own qualified + consented leads; buyers pay through the standard
 *  payment intent path and receive the lead on confirmed payment. All money
 *  is integer minor units. */

import { z } from "zod";
import { BILLING_PROVIDERS } from "./billing";

export const leadListingCreateSchema = z.object({
  lead_id: z.string().trim().min(1).max(64),
  price_minor: z.number().int().positive().max(1_000_000_000_000),
  currency: z.enum(["PKR", "USD"]).default("PKR"),
});

export const leadPurchaseCreateSchema = z.object({
  listing_id: z.string().trim().min(1).max(64),
  provider: z.enum(BILLING_PROVIDERS),
});

export interface LeadListingRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  price_minor: number;
  currency: "PKR" | "USD";
  status: "active" | "sold" | "removed";
  created_at: string;
  sold_at: string | null;
}

export interface LeadPurchaseRow {
  id: string;
  workspace_id: string;
  listing_id: string;
  payment_id: string | null;
  status: "awaiting_payment" | "delivered" | "canceled";
  created_at: string;
  paid_at: string | null;
  delivered_at: string | null;
}
