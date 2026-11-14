/** Digital Downloads schemas (app: digital-downloads). All money is integer
 * minor units. A purchase is delivered ONLY after its payment is confirmed
 * through the single authoritative confirm path (lib/billing.ts). */

import { z } from "zod";
import { BILLING_PROVIDERS } from "./billing";

export const digitalProductCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  price_minor: z.number().int().positive().max(1_000_000_000_000),
  currency: z.enum(["PKR", "USD"]).default("PKR"),
  /** Delivered to the buyer after the payment is confirmed. */
  file_url: z.string().trim().min(1).max(600),
  /** Optional buyer instructions delivered together with the file. */
  delivery_note: z.string().trim().max(1000).default(""),
});

export const digitalProductPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    price_minor: z.number().int().positive().max(1_000_000_000_000).optional(),
    currency: z.enum(["PKR", "USD"]).optional(),
    file_url: z.string().trim().min(1).max(600).optional(),
    delivery_note: z.string().trim().max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const digitalPurchaseCreateSchema = z.object({
  product_id: z.string().trim().min(1).max(64),
  buyer_email: z.string().trim().toLowerCase().email().max(254),
  provider: z.enum(BILLING_PROVIDERS),
});

export interface DigitalProductRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: "PKR" | "USD";
  file_url: string;
  delivery_note: string;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface DigitalPurchaseRow {
  id: string;
  workspace_id: string;
  product_id: string;
  buyer_email: string;
  payment_id: string | null;
  status: "awaiting_payment" | "delivered" | "canceled";
  delivery_token: string;
  created_at: string;
  paid_at: string | null;
  delivered_at: string | null;
}
