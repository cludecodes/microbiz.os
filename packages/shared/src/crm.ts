/** CRM & order manager schemas (app: whatsapp-crm). */

import { z } from "zod";
import { localeSchema } from "./schemas";

export const phoneRegex = /^\+?\d{7,15}$/;

export const contactCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "Phone must be an international number like +923001234567 or +15551234567"),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).default(""),
  locale: localeSchema.default("en"),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  notes: z.string().max(2000).default(""),
});

export const contactPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().regex(phoneRegex).optional(),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  locale: localeSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  notes: z.string().max(2000).optional(),
});

export const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(140),
  description: z.string().max(1000).default(""),
  kind: z.enum(["physical", "digital"]).default("physical"),
  /** Minor units (paisa/cents). Server uses this as the authoritative price. */
  price_minor: z.number().int().positive().max(1_000_000_000_000),
  stock: z.number().int().min(0).max(10_000_000).nullish(),
  active: z.boolean().default(true),
});

export const orderItemSchema = z.object({
  product_id: z.string().max(64).optional(),
  // Optional when product_id is present: the server resolves the catalog name.
  name: z.string().trim().min(1).max(140).optional(),
  /** Quantity x 1000 to keep integer math (e.g. 1.5 kg = 1500). */
  qty_millis: z.number().int().positive().max(10_000_000),
  unit_price_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
});

export const orderCreateSchema = z.object({
  customer_id: z.string().max(64).optional(),
  tax_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
  note: z.string().max(2000).default(""),
  items: z.array(orderItemSchema).min(1).max(50),
});

export const orderStatusPatchSchema = z.object({
  status: z.enum(["confirmed", "preparing", "delivering", "completed", "canceled"]),
});

/**
 * Allowed order lifecycle transitions. Cancellation is possible until
 * completion; completed orders are immutable (financial truth).
 */
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  new: ["confirmed", "canceled"],
  confirmed: ["preparing", "delivering", "canceled"],
  preparing: ["delivering", "canceled"],
  delivering: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

export type OrderStatus = "new" | "confirmed" | "preparing" | "delivering" | "completed" | "canceled";
