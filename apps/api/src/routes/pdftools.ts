import { Hono } from "hono";
import type { Env } from "../types";
import { getSessionUser, forbidden, unauthorized, requireWorkspaceAccess } from "../lib/auth";
import { jsonError, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { currentUsage, decideFeature, loadWorkspaceEntitlements, recordUsage } from "../lib/entitlements";

/**
 * PDF tools backend. The heavy lifting (merge/split/compress) runs client-side
 * with pdf-lib so nothing leaves the user's browser. This endpoint only
 * records + meters completed operations so entitlements stay enforced.
 */

const METER_FEATURE = "pdf-tools.monthly";
const APP_ID = "pdf-tools";
const KINDS = ["merge", "split", "compress"] as const;

const wsParam = (c: { req: { param: (k: string) => string | undefined } }) =>
  c.req.param("workspaceId") as string;

export const pdfToolsRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/pdftools/:workspaceId – recent operations history */
pdfToolsRoutes.get("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const ctx = await requireWorkspaceAccess(c, wsParam(c), "member");
  if (!ctx) return forbidden(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, status, input_files, output_file, created_at, completed_at
     FROM pdf_operations WHERE workspace_id = ?
     ORDER BY created_at DESC LIMIT 50`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ operations: rows.results });
});

/** POST /api/pdftools/:workspaceId – record a completed client-side operation */
pdfToolsRoutes.post("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return unauthorized(c);
  const ctx = await requireWorkspaceAccess(c, wsParam(c), "member");
  if (!ctx) return forbidden(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const {
    kind = "",
    input_names = [],
    output_name = "",
    output_bytes = 0,
  } = body as {
    kind?: string;
    input_names?: string[];
    output_name?: string;
    output_bytes?: number;
  };

  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    return jsonError(c, 422, `kind must be one of: ${KINDS.join(", ")}`);
  }
  if (!Array.isArray(input_names) || input_names.length === 0 || input_names.length > 20) {
    return jsonError(c, 422, "input_names must contain 1–20 file names");
  }
  if (typeof output_name !== "string" || !output_name.trim()) {
    return jsonError(c, 422, "output_name is required");
  }

  // Deny-by-default metered entitlement: operations per month vs plan limit.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, METER_FEATURE, monthStart);
  const decision = decideFeature(ents, METER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(
      c,
      403,
      "Plan limit reached for PDF tools",
      decision.reason === "limit_reached"
        ? `Used ${used} of your plan's monthly PDF operation allowance. Upgrade or wait for the next billing month.`
        : decision.reason
    );
  }

  const id = uuid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO pdf_operations (id, workspace_id, kind, status, input_files, output_file, created_at, completed_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`
  )
    .bind(id, ctx.workspace.id, kind, JSON.stringify(input_names.slice(0, 20)), output_name.slice(0, 260), ts, ts)
    .run();

  await recordUsage(c.env, ctx.workspace.id, APP_ID, METER_FEATURE, 1, { operation_id: id, kind });

  await audit(c, {
    actor_user_id: user.id,
    workspace_id: ctx.workspace.id,
    action: "pdftools.operation_completed",
    target_type: "pdf_operation",
    target_id: id,
    detail: { kind, inputs: input_names.length, output_bytes },
  });

  return c.json({ operation: { id } }, 201);
});
