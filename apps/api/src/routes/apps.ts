import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { loadWorkspaceEntitlements, decideFeature, currentUsage } from "../lib/entitlements";
import { nowIso } from "../lib/http";

interface AppRow {
  id: string;
  name: string;
  description: string;
  phase: number;
  enabled: number;
}

const FEATURE_BY_APP: Record<string, string> = {
  "whatsapp-crm": "orders",
  "qr-menu": "scans",
  invoices: "monthly",
  appointments: "monthly",
  "cv-generator": "monthly",
  "pdf-tools": "monthly",
  "digital-downloads": "monthly",
  "lead-marketplace": "monthly",
  referrals: "general",
};

export const appRoutes = new Hono<{ Bindings: Env }>();

/** Public application registry. */
appRoutes.get("/", async (c) => {
  const apps = await c.env.DB.prepare(
    `SELECT id, name, description, phase, enabled FROM applications ORDER BY phase, name`
  ).all<AppRow>();
  return c.json({ apps: apps.results });
});

/** Per-workspace app launcher with entitlement gating (deny by default). */
appRoutes.get("/workspace/:workspaceId", async (c) => {
  const wsId = c.req.param("workspaceId");
  const ctx = await requireWorkspaceAccess(c, wsId, "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const ents = await loadWorkspaceEntitlements(c.env, wsId);
  const apps = await c.env.DB.prepare(
    `SELECT id, name, description, phase, enabled FROM applications ORDER BY phase, name`
  ).all<AppRow>();

  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const appViews = apps.results.map((app) => {
    const featureKey = `${app.id}.${FEATURE_BY_APP[app.id] ?? "general"}`;
    const limit = ents.limits[featureKey] ?? null;
    const enabled = app.enabled === 1 && decideFeature(ents, featureKey, 0).allowed;
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      phase: app.phase,
      enabled,
      blockReason: app.enabled === 1 ? null : "not_available_yet",
      usage: { feature_key: featureKey, limit },
    };
  });
  return c.json({ apps: appViews });
});

/** Current period usage for a single feature (used by app meters). */
appRoutes.get("/workspace/:workspaceId/usage/:appId", async (c) => {
  const wsId = c.req.param("workspaceId");
  const appId = c.req.param("appId");
  const ctx = await requireWorkspaceAccess(c, wsId, "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const ents = await loadWorkspaceEntitlements(c.env, wsId);
  const featureKey = `${appId}.${FEATURE_BY_APP[appId] ?? "general"}`;
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, wsId, featureKey, monthStart);
  const decision = decideFeature(ents, featureKey, used);
  return c.json({
    feature_key: featureKey,
    used,
    limit: ents.limits[featureKey] ?? null,
    allowed: decision.allowed,
    reason: "reason" in decision ? decision.reason : null,
  });
});
