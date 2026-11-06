/** Invoice & quotation schemas (app: invoices). All money is integer minor
 * units; quantities use qty_millis (x1000) like the CRM order items. */

import { z } from "zod";
import { BILLING_PROVIDERS } from "./billing";

export const invoiceTypeSchema = z.enum(["invoice", "quotation"]);

/** A client-payable link always uses one of the supported payment providers. */
export const invoicePaymentLinkSchema = z.object({
  provider: z.enum(BILLING_PROVIDERS),
});

export const invoiceItemCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  qty_millis: z.number().int().positive().max(10_000_000),
  unit_price_minor: z.number().int().min(0).max(1_000_000_000_000),
});

export const invoiceCreateSchema = z.object({
  type: invoiceTypeSchema,
  /** Either a CRM contact id (validated against this workspace) … */
  customer_id: z.string().max(64).optional(),
  /** … or free-typed client details (required when no customer_id). */
  client_name: z.string().trim().max(160).optional(),
  client_email: z.union([z.string().trim().email().max(254), z.literal("")]).default(""),
  client_address: z.string().max(500).default(""),
  tax_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
  notes: z.string().max(2000).default(""),
  /** ISO date (YYYY-MM-DD) — invoices only. */
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD")
    .optional(),
  items: z.array(invoiceItemCreateSchema).min(1).max(100),
});

export const invoiceStatusPatchSchema = z.object({
  status: z.enum(["sent", "paid", "void", "accepted", "declined", "expired"]),
});

/**
 * Per-type lifecycle. Drafts can be discarded; sent documents are financial
 * records — they move forward or are voided/decided, never deleted or
 * rewound. `paid`/`accepted` are terminal (M5 payment confirmation will
 * additionally require a verified provider event before `paid`).
 */
export const DOCUMENT_TRANSITIONS: Record<string, Record<string, string[]>> = {
  invoice: {
    draft: ["sent", "void"],
    sent: ["paid", "void"],
    paid: [],
    void: [],
  },
  quotation: {
    draft: ["sent", "void"],
    sent: ["accepted", "declined", "expired"],
    accepted: [],
    declined: [],
    expired: [],
  },
};

export type InvoiceType = "invoice" | "quotation";
