/** QR menu schemas (app: qr-menu). Menu items live in the products table
 * with app_id = 'qr-menu'; `active` doubles as the availability toggle. */

import { z } from "zod";

export const qrMenuItemCreateSchema = z.object({
  name: z.string().trim().min(1).max(140),
  description: z.string().max(1000).default(""),
  /** Minor units (paisa/cents) — public menus show the workspace currency. */
  price_minor: z.number().int().positive().max(1_000_000_000_000),
});

export const qrMenuItemPatchSchema = z.object({
  is_available: z.boolean(),
});

export type QrMenuItem = {
  id: string;
  name: string;
  description: string | null;
  price_minor: number;
  currency: string;
  active: number;
};
