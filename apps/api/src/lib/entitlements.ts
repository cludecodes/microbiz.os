import type { Env, PlanRow, SubscriptionRow } from "../types";
import { checkEntitlement } from "@microbiz/shared";
import { nowIso, uuid } from "./http";

export interface WorkspaceEntitlements {
  plan: PlanRow | null;
  subscription: SubscriptionRow | null;
  limits: Record<string, number | null>;
}

export async function loadWorkspaceEntitlements(
  env: Env,
  workspaceId: string
): Promise<WorkspaceEntitlements> {
  const plan = await env.DB.prepare(
    `SELECT p.* FROM plans p
     JOIN workspaces w ON w.plan_id = p.id
     WHERE w.id = ?`
  )
    .bind(workspaceId)
    .first<PlanRow>();

  const subscription = await env.DB.prepare(
    `SELECT workspace_id, plan_id, status FROM subscriptions WHERE workspace_id = ?`
  )
    .bind(workspaceId)
    .first<SubscriptionRow>();

  let limits: Record<string, number | null> = plan ? JSON.parse(plan.limits) : {};

  // Per-workspace overrides stack on top of plan limits.
  const overrides = await env.DB.prepare(
    `SELECT feature_key, limit_value, granted FROM entitlements WHERE workspace_id = ?`
  )
    .bind(workspaceId)
    .all<{ feature_key: string; limit_value: number | null; granted: number }>();
  for (const o of overrides.results) {
    if (!o.granted) {
      limits[o.feature_key] = 0;
    } else {
      limits[o.feature_key] = o.limit_value;
    }
  }

  return { plan, subscription, limits };
}

/**
 * Authoritative server-side entitlement check. Deny by default.
 * `currentUsage` is fetched by the caller (e.g. count of usage_events).
 */
export function decideFeature(
  ents: WorkspaceEntitlements,
  featureKey: string,
  currentUsage: number
): { allowed: true } | { allowed: false; reason: string } {
  if (ents.subscription && (ents.subscription.status === "canceled" || ents.subscription.status === "past_due")) {
    return { allowed: false, reason: "subscription_inactive" };
  }
  const decision = checkEntitlement(ents.limits, featureKey, currentUsage);
  return decision;
}

/** Metering: record a usage event required by pay-per-use credit accounting. */
export async function recordUsage(
  env: Env,
  workspaceId: string,
  appId: string,
  featureKey: string,
  quantity = 1,
  meta: Record<string, unknown> = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_events (id, workspace_id, app_id, feature_key, quantity, occurred_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), workspaceId, appId, featureKey, quantity, nowIso(), JSON.stringify(meta))
    .run();
}

export async function currentUsage(
  env: Env,
  workspaceId: string,
  featureKey: string,
  sinceIso: string
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_events
     WHERE workspace_id = ? AND feature_key = ? AND occurred_at >= ?`
  )
    .bind(workspaceId, featureKey, sinceIso)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
