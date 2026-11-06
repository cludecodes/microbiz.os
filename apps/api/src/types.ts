// Cloudflare Workers environment bindings.
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string; // "development" | "production"
  // Payment provider webhook secrets. Fine to be absent until the payments
  // milestone; webhooks/checkouts for unconfigured providers fail closed.
  SAFEPAY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  // Owner-configured payment-link templates (one link per plan, sandbox first).
  SAFEPAY_CHECKOUT_URL_TEMPLATE?: string;
  LEMON_SQUEEZY_CHECKOUT_URL_TEMPLATE?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  locale: "en" | "ur";
  is_super_admin: 0 | 1;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  currency: "PKR" | "USD";
  locale: "en" | "ur";
  plan_id: string;
  archived: 0 | 1;
  created_at: string;
}

export interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "manager" | "member";
  created_at: string;
}

export interface PlanRow {
  id: string;
  name: string;
  price_minor: number;
  currency: "PKR" | "USD";
  limits: string;
  features: string;
}

export interface SubscriptionRow {
  workspace_id: string;
  plan_id: string;
  status: "active" | "trialing" | "canceled" | "past_due";
}
