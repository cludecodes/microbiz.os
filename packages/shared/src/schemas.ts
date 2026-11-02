/** Zod schemas for API input validation (shared server-side). */

import { z } from "zod";

export const localeSchema = z.enum(["en", "ur"]);
export const currencySchema = z.enum(["PKR", "USD"]);

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(120),
  locale: localeSchema.default("en"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(200),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  currency: currencySchema.default("PKR"),
  locale: localeSchema.default("en"),
});

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["admin", "manager", "member"]).default("member"),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "manager", "member"]),
});

export const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length >= 2 ? base : "workspace";
}
