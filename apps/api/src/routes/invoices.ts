import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { recordUsage, currentUsage, loadWorkspaceEntitlements, decideFeature } from "../lib/entitlements";
import {
  invoiceCreateSchema,
  invoiceStatusPatchSchema,
  DOCUMENT_TRANSITIONS,
  type InvoiceType,
} from "@microbiz/shared";

const METER_FEATURE = "invoices.monthly";
const PREFIX: Record<InvoiceType, string> = { invoice: "INV", quotation: "QTN" };

async function wsCtx(c: Context<{ Bindings: Env }>, workspaceId: string, minRole: "member" | "admin" | "owner") {
  return requireWorkspaceAccess(c, workspaceId, minRole);
}

export const invoiceRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------- list/create

invoiceRoutes.get("/:workspaceId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const type = c.req.query("type"); // optional filter: invoice | quotation
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.number, i.type, i.status, i.currency, i.client_name, i.client_email,
            i.subtotal_minor, i.tax_minor, i.total_minor, i.due_date, i.sent_at, i.paid_at,
            i.created_at, c.name AS customer_name,
            (SELECT COUNT(*) FROM invoice_line_items li WHERE li.invoice_id = i.id) AS item_count
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.workspace_id = ? ${type === "invoice" || type === "quotation" ? "AND i.type = ?" : ""}
     ORDER BY i.created_at DESC LIMIT 200`
  )
    .bind(...(type === "invoice" || type === "quotation" ? [ctx.workspace.id, type] : [ctx.workspace.id]))
    .all();
  return c.json({ documents: rows.results });
});

invoiceRoutes.post("/:workspaceId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = invoiceCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const data = parsed.data;

  // Deny-by-default metered entitlement: documents per month vs plan limit.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, METER_FEATURE, monthStart);
  const decision = decideFeature(ents, METER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(
      c,
      403,
      "Plan limit reached for invoices & quotations",
      decision.reason === "limit_reached"
        ? `Used ${used} of your plan's monthly document allowance. Upgrade or wait for the next billing month.`
        : decision.reason
    );
  }

  // Client identity: either a contact of THIS workspace or typed details.
  let customerId: string | null = null;
  let clientName = data.client_name ?? "";
  if (data.customer_id) {
    const customer = await c.env.DB.prepare(
      `SELECT id, name, email FROM customers WHERE id = ? AND workspace_id = ?`
    )
      .bind(data.customer_id, ctx.workspace.id)
      .first<{ id: string; name: string; email: string | null }>();
    if (!customer) return jsonError(c, 404, "Customer not found in this workspace");
    customerId = customer.id;
    clientName = clientName || customer.name;
  }
  if (!clientName) {
    return jsonError(c, 422, "Provide client_name or a customer_id from this workspace");
  }
  if (data.type === "invoice" && !data.due_date) {
    // Invoices need a due date; quotations don't.
    return jsonError(c, 422, "Invoices require a due_date (YYYY-MM-DD)");
  }

  // Line items: exact integer math only (same rule as CRM orders).
  const resolved: { name: string; qty_millis: number; unit_price_minor: number; total_minor: number }[] = [];
  for (const item of data.items) {
    const total = item.unit_price_minor * item.qty_millis;
    if (total % 1000 !== 0) {
      return jsonError(c, 422, `Item "${item.name}" has no exact minor-unit total (price x quantity must be divisible by 1000)`);
    }
    resolved.push({
      name: item.name,
      qty_millis: item.qty_millis,
      unit_price_minor: item.unit_price_minor,
      total_minor: Math.floor(total / 1000),
    });
  }
  const subtotal = resolved.reduce((sum, r) => sum + r.total_minor, 0);
  const total = subtotal + data.tax_minor;

  // Sequential per-workspace, per-type number with collision retries.
  const counter = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM invoices WHERE workspace_id = ? AND type = ?`
  )
    .bind(ctx.workspace.id, data.type)
    .first<{ n: number }>();
  let suffix = (counter?.n ?? 0) + 1;
  const docId = uuid();
  const createdAt = nowIso();
  let number = "";
  let inserted = false;
  for (let attempt = 0; attempt < 4 && !inserted; attempt++) {
    number = `${PREFIX[data.type]}-${String(suffix).padStart(4, "0")}`;
    try {
      await c.env.DB.prepare(
        `INSERT INTO invoices (id, workspace_id, customer_id, number, type, status,
                               client_name, client_email, client_address,
                               subtotal_minor, tax_minor, total_minor, currency, notes,
                               due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          docId,
          ctx.workspace.id,
          customerId,
          number,
          data.type,
          clientName,
          data.client_email || null,
          data.client_address || null,
          subtotal,
          data.tax_minor,
          total,
          ctx.workspace.currency,
          data.notes,
          data.due_date ?? null,
          createdAt,
          createdAt
        )
        .run();
      inserted = true;
    } catch (err) {
      if (String(err).includes("UNIQUE")) suffix++;
      else throw err;
    }
  }
  if (!inserted) return jsonError(c, 409, "Could not allocate a document number, try again");

  await c.env.DB.batch(
    resolved.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO invoice_line_items (id, invoice_id, name, qty_millis, unit_price_minor, total_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), docId, r.name, r.qty_millis, r.unit_price_minor, r.total_minor, createdAt)
    )
  );

  await recordUsage(c.env, ctx.workspace.id, "invoices", METER_FEATURE, 1, {
    document_id: docId,
    type: data.type,
    total_minor: total,
  });
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "invoice.create",
    target_type: "invoice",
    target_id: docId,
    detail: { number, type: data.type, total_minor: total, currency: ctx.workspace.currency },
  });

  return c.json(
    {
      document: {
        id: docId,
        number,
        type: data.type,
        status: "draft",
        client_name: clientName,
        currency: ctx.workspace.currency,
        subtotal_minor: subtotal,
        tax_minor: data.tax_minor,
        total_minor: total,
        due_date: data.due_date ?? null,
        created_at: createdAt,
      },
      items: resolved,
    },
    201
  );
});

// --------------------------------------------------------------- detail/status

invoiceRoutes.get("/:workspaceId/:documentId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const doc = await c.env.DB.prepare(
    `SELECT i.*, c.name AS customer_name FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = ? AND i.workspace_id = ?`
  )
    .bind(c.req.param("documentId"), ctx.workspace.id)
    .first();
  if (!doc) return jsonError(c, 404, "Document not found");
  const items = await c.env.DB.prepare(
    `SELECT id, name, qty_millis, unit_price_minor, total_minor FROM invoice_line_items
     WHERE invoice_id = ? ORDER BY rowid`
  )
    .bind(String(doc.id))
    .all();
  return c.json({ document: doc, items: items.results });
});

invoiceRoutes.patch("/:workspaceId/:documentId", async (c) => {
  const ctx = await wsCtx(c, c.req.param("workspaceId"), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const parsed = invoiceStatusPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const next = parsed.data.status;

  const doc = await c.env.DB.prepare(
    `SELECT id, number, type, status FROM invoices WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("documentId"), ctx.workspace.id)
    .first<{ id: string; number: string; type: InvoiceType; status: string }>();
  if (!doc) return jsonError(c, 404, "Document not found");

  const allowed = DOCUMENT_TRANSITIONS[doc.type]?.[doc.status] ?? [];
  if (!allowed.includes(next)) {
    return jsonError(c, 409, `Cannot move ${doc.number} from ${doc.status} to ${next}`);
  }

  const now = nowIso();
  const sentAt = next === "sent" ? now : null;
  const paidAt = next === "paid" ? now : null;
  await c.env.DB.prepare(
    `UPDATE invoices SET status = ?, sent_at = COALESCE(?, sent_at), paid_at = COALESCE(?, paid_at), updated_at = ?
     WHERE id = ?`
  )
    .bind(next, sentAt, paidAt, now, doc.id)
    .run();

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "invoice.status_change",
    target_type: "invoice",
    target_id: doc.id,
    detail: { from: doc.status, to: next, number: doc.number },
  });
  return c.json({ ok: true, status: next });
});
