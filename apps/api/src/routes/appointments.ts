import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, forbidden, unauthorized, requireWorkspaceAccess } from "../lib/auth";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { currentUsage, decideFeature, loadWorkspaceEntitlements, recordUsage } from "../lib/entitlements";

const METER_FEATURE = "appointments.monthly";
const APP_ID = "appointments";

// All paths below are mounted under /api/appointments/:workspaceId, so the
// route params are always present on real requests.
const workspaceIdParam = (c: { req: { param: (k: string) => string | undefined } }) =>
  c.req.param("workspaceId") as string;

export const appointmentsRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/appointments/:workspaceId – list appointments for the workspace */
appointmentsRoutes.get("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const wsId = workspaceIdParam(c);
  const ctx = await requireWorkspaceAccess(c, wsId, "member");
  if (!ctx) return forbidden(c);
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.title, a.description, a.start_at, a.end_at, a.status,
            u.name AS owner_name
     FROM appointments a
     JOIN users u ON u.id = a.user_id
     WHERE a.workspace_id = ?
     ORDER BY a.start_at DESC LIMIT 50`
  )
    .bind(wsId)
    .all();
  return c.json({ appointments: rows.results });
});

/** POST /api/appointments/:workspaceId – create a new appointment (owner only) */
appointmentsRoutes.post("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const ctx = await requireWorkspaceAccess(c, workspaceIdParam(c), "owner");
  if (!ctx) return forbidden(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  // Safe destructuring with defaults – the checks below guarantee non‑empty values.
  const { title = "", description = "", start_at = "", end_at = "" } =
    body as {
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
    };
  if (!title.trim()) {
    return jsonError(c, 422, "title is required");
  }
  if (!start_at || !end_at) {
    return jsonError(c, 422, "start_at and end_at are required");
  }
  if (Number.isNaN(Date.parse(start_at)) || Number.isNaN(Date.parse(end_at))) {
    return jsonError(c, 422, "start_at and end_at must be valid ISO date-times");
  }
  if (Date.parse(end_at) <= Date.parse(start_at)) {
    return jsonError(c, 422, "end_at must be after start_at");
  }

  // Deny-by-default metered entitlement: appointments per month vs plan limit.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, METER_FEATURE, monthStart);
  const decision = decideFeature(ents, METER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(
      c,
      403,
      "Plan limit reached for appointments",
      decision.reason === "limit_reached"
        ? `Used ${used} of your plan's monthly appointment allowance. Upgrade or wait for the next billing month.`
        : decision.reason
    );
  }

  const id = uuid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO appointments (id, workspace_id, user_id, title, description, start_at, end_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
  )
    .bind(
      id,
      ctx.workspace.id,
      user.id,
      title,
      description,
      start_at,
      end_at,
      ts,
      ts
    )
    .run();

  await recordUsage(c.env, ctx.workspace.id, APP_ID, METER_FEATURE, 1, { appointment_id: id });

  await audit(c, {
    actor_user_id: user.id,
    workspace_id: ctx.workspace.id,
    action: "appointment.created",
    target_type: "appointment",
    target_id: id,
    detail: { title, start_at, end_at },
  });

  return c.json({ appointment: { id } }, 201);
});

/** PATCH /api/appointments/:appointmentId – update status (owner/admin) */
appointmentsRoutes.patch("/:appointmentId", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const ctx = await requireWorkspaceAccess(c, workspaceIdParam(c), "admin");
  if (!ctx) return forbidden(c);
  const appointmentId = c.req.param("appointmentId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const { status } = body as { status?: string };
  if (!status || !["new", "confirmed", "completed", "canceled"].includes(status)) {
    return jsonError(c, 422, "status must be one of: new, confirmed, completed, canceled");
  }
  const ts = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`
  )
    .bind(status, ts, appointmentId, ctx.workspace.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return jsonError(c, 404, "Appointment not found or not in this workspace");

  await audit(c, {
    actor_user_id: user.id,
    workspace_id: ctx.workspace.id,
    action: "appointment.status_updated",
    target_type: "appointment",
    target_id: appointmentId,
    detail: { from: "unknown", to: status },
  });

  return c.json({ ok: true });
});

/** DELETE /api/appointments/:appointmentId – soft delete (owner) */
appointmentsRoutes.delete("/:appointmentId", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const ctx = await requireWorkspaceAccess(c, workspaceIdParam(c), "owner");
  if (!ctx) return forbidden(c);
  const appointmentId = c.req.param("appointmentId");
  const ts = nowIso();
  await c.env.DB.prepare(
    `DELETE FROM appointments WHERE id = ? AND workspace_id = ?`
  )
    .bind(appointmentId, ctx.workspace.id)
    .run();

  await audit(c, {
    actor_user_id: user.id,
    workspace_id: ctx.workspace.id,
    action: "appointment.deleted",
    target_type: "appointment",
    target_id: appointmentId,
  });

  return c.json({ ok: true });
});

export default appointmentsRoutes;