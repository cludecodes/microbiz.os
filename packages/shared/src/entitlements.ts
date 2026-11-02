/**
 * Feature entitlements and plan limits.
 *
 * Entitlements are a simple open JSON map so plans can define arbitrary
 * features without schema churn, with stable well-known keys for the
 * Phase 1 products.
 */

import type { CurrencyCode } from "./money";

/** Well-known Phase 1 applications. */
export type AppId = "whatsapp-crm" | "qr-menu" | "invoices";

export const PHASE1_APP_IDS: AppId[] = ["whatsapp-crm", "qr-menu", "invoices"];

export interface PlanDefinition {
  id: string;
  name: string;
  /** Monthly price in minor units; 0 = free. */
  price_minor: number;
  currency: CurrencyCode;
  /** null = unlimited. */
  limits: Record<string, number | null>;
  features: string[];
}

export interface WorkspaceSubscriptionView {
  plan_id: string;
  status: "active" | "trialing" | "canceled" | "past_due";
}

export type EntitlementDecision =
  | { allowed: true }
  | { allowed: false; reason: "feature_not_in_plan" | "limit_reached" | "no_subscription" | "subscription_inactive" };

/**
 * Check whether an entitlement map of the current plan permits a feature.
 * `limits[feature]` is the max concurrent/periodic usage; null = unlimited.
 * Features not present in the map are denied by default (deny by default).
 */
export function checkEntitlement(
  limits: Record<string, number | null>,
  feature: string,
  currentUsage: number
): EntitlementDecision {
  if (!Object.prototype.hasOwnProperty.call(limits, feature)) {
    return { allowed: false, reason: "feature_not_in_plan" };
  }
  const limit = limits[feature];
  if (limit === null) return { allowed: true };
  if (currentUsage >= limit) return { allowed: false, reason: "limit_reached" };
  return { allowed: true };
}

export function isSubscriptionActive(status: WorkspaceSubscriptionView["status"]): boolean {
  return status === "active" || status === "trialing";
}
