import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getSessionUser, requireWorkspaceAccess, unauthorized, forbidden } from "../lib/auth";
import { jsonError, zodMessage, nowIso, uuid } from "../lib/http";
import { audit } from "../lib/ops";
import { recordUsage, currentUsage, loadWorkspaceEntitlements, decideFeature } from "../lib/entitlements";
import { newUniquePaymentReference } from "../lib/billing";
import {
  leadListingCreateSchema,
  leadPurchaseCreateSchema,
  PROVIDER_CAPABILITIES,
  type BillingProvider,
} from "@microbiz/shared";
import {
  createCheckoutSession,
  PaymentProviderNotConfigured,
} from "../lib/payments/adapters";

const METER_FEATURE = "lead-marketplace.monthly";

/** The mount path (`/api/leadmarket/:workspaceId`) provides the param. */
const workspaceIdParam = (c: { req: { param: (k: string) => string | undefined } }) =>
  c.req.param("workspaceId") as string;

async function wsCtx(c: Context<{ Bindings: Env }>, workspaceId: string, minRole: "member" | "admin" | "owner") {
  return requireWorkspaceAccess(c, workspaceId, minRole);
}

export const leadMarketRoutes = new Hono<{ Bindings: Env }>();

// -------------------------------------------------------------------- listings

/** Browse the marketplace: every active listing, masked. Contact details are
 *  NEVER included here — they are released only after a confirmed purchase. */
leadMarketRoutes.get("/listings", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT ll.id, ll.workspace_id AS seller_workspace_id, ll.price_minor, ll.currency,
            ll.status, ll.created_at, ll.sold_at,
            w.name AS seller_workspace_name,
            l.qualification_score
       FROM lead_listings ll
       JOIN workspaces w ON w.id = ll.workspace_id
       JOIN leads l ON l.id = ll.lead_id
      WHERE ll.status = 'active'
      ORDER BY ll.created_at DESC LIMIT 200`
  )
    .all()
    .then((r) => r.results ?? []);
  return c.json({ listings: rows });
});

/** The seller's own qualified + consented leads available for listing. */
leadMarketRoutes.get("/my-leads", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.contact_name, l.qualification_score, l.created_at,
            (SELECT COUNT(*) FROM lead_listings ll WHERE ll.lead_id = l.id AND ll.status = 'active') AS listed
       FROM leads l
      WHERE l.workspace_id = ? AND l.status = 'qualified' AND l.consent_marketing = 1
      ORDER BY l.created_at DESC LIMIT 200`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ leads: rows.results });
});

/** List one of the workspace's own qualified, consented leads for sale. */
leadMarketRoutes.post("/listings", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
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
  const parsed = leadListingCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { lead_id, price_minor, currency } = parsed.data;

  // Deny-by-default metered entitlement: listings published per month.
  const ents = await loadWorkspaceEntitlements(c.env, ctx.workspace.id);
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00Z`;
  const used = await currentUsage(c.env, ctx.workspace.id, METER_FEATURE, monthStart);
  const decision = decideFeature(ents, METER_FEATURE, used);
  if (!decision.allowed) {
    return jsonError(c, 403, `Monthly listing limit reached (${decision.reason}). Upgrade the plan to list more.`);
  }

  const lead = await c.env.DB.prepare(
    `SELECT id, contact_name, status, consent_marketing FROM leads
      WHERE id = ? AND workspace_id = ?`
  )
    .bind(lead_id, ctx.workspace.id)
    .first<{ id: string; contact_name: string; status: string; consent_marketing: number }>();
  if (!lead) return jsonError(c, 404, "Lead not found in this workspace");
  if (lead.status !== "qualified") return jsonError(c, 409, `Only qualified leads can be listed (this one is ${lead.status})`);
  if (lead.consent_marketing !== 1) return jsonError(c, 409, "Only leads with marketing consent can be listed");

  const id = uuid();
  const ts = nowIso();
  try {
    await c.env.DB.prepare(
      `INSERT INTO lead_listings (id, workspace_id, lead_id, price_minor, currency, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
      .bind(id, ctx.workspace.id, lead.id, price_minor, currency, ts)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return jsonError(c, 409, "This lead already has an active listing");
    }
    throw err;
  }
  await recordUsage(c.env, ctx.workspace.id, "lead-marketplace", METER_FEATURE, 1, { listing_id: id });
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "leadmarket.listing_created",
    target_type: "lead_listing",
    target_id: id,
    detail: { lead_id: lead.id, price_minor, currency },
  });

  return c.json({ listing: { id, workspace_id: ctx.workspace.id, lead_id: lead.id, price_minor, currency, status: "active", created_at: ts, sold_at: null } }, 201);
});

leadMarketRoutes.delete("/listings/:listingId", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  const listing = await c.env.DB.prepare(
    `SELECT id, status FROM lead_listings WHERE id = ? AND workspace_id = ?`
  )
    .bind(c.req.param("listingId"), ctx.workspace.id)
    .first<{ id: string; status: string }>();
  if (!listing) return jsonError(c, 404, "Listing not found");
  if (listing.status === "sold") return jsonError(c, 409, "A sold listing cannot be removed");

  const pending = await c.env.DB.prepare(
    `SELECT id FROM lead_purchases WHERE listing_id = ? AND status = 'awaiting_payment' LIMIT 1`
  )
    .bind(listing.id)
    .first<{ id: string }>();
  if (pending) return jsonError(c, 409, "This listing has a purchase awaiting payment — wait for it to resolve");

  await c.env.DB.prepare(`UPDATE lead_listings SET status = 'removed' WHERE id = ?`)
    .bind(listing.id)
    .run();
  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "leadmarket.listing_removed",
    target_type: "lead_listing",
    target_id: listing.id,
    detail: {},
  });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- purchases

leadMarketRoutes.get("/purchases", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
  if (!ctx) {
    const u = await getSessionUser(c);
    return u ? forbidden(c) : unauthorized(c);
  }
  // Contact details are only revealed for DELIVERED purchases (the buyer owns
  // a copy of the lead by then).
  const rows = await c.env.DB.prepare(
    `SELECT lp.id, lp.listing_id, lp.status, lp.created_at, lp.paid_at, lp.delivered_at,
            ll.price_minor, ll.currency, ll.status AS listing_status,
            w.name AS seller_workspace_name, l.qualification_score,
            CASE WHEN lp.status = 'delivered' THEN l.contact_name ELSE NULL END AS contact_name,
            CASE WHEN lp.status = 'delivered' THEN l.contact_email ELSE NULL END AS contact_email,
            CASE WHEN lp.status = 'delivered' THEN l.contact_phone ELSE NULL END AS contact_phone,
            pay.provider AS payment_provider, pay.status AS payment_status, pay.provider_txn_ref
       FROM lead_purchases lp
       JOIN lead_listings ll ON ll.id = lp.listing_id
       JOIN workspaces w ON w.id = ll.workspace_id
       JOIN leads l ON l.id = ll.lead_id
       LEFT JOIN payments pay ON pay.id = lp.payment_id
      WHERE lp.workspace_id = ?
      ORDER BY lp.created_at DESC LIMIT 200`
  )
    .bind(ctx.workspace.id)
    .all();
  return c.json({ purchases: rows.results });
});

leadMarketRoutes.post("/purchases", async (c) => {
  const ctx = await wsCtx(c, workspaceIdParam(c), "member");
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
  const parsed = leadPurchaseCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(c, 422, zodMessage(parsed.error));
  const { listing_id, provider } = parsed.data;

  const listing = await c.env.DB.prepare(
    `SELECT id, workspace_id, price_minor, currency FROM lead_listings
      WHERE id = ? AND status = 'active'`
  )
    .bind(listing_id)
    .first<{ id: string; workspace_id: string; price_minor: number; currency: "PKR" | "USD" }>();
  if (!listing) return jsonError(c, 404, "Active listing not found");
  if (listing.workspace_id === ctx.workspace.id) {
    return jsonError(c, 409, "You cannot buy your own listing");
  }

  // One live purchase per listing: the lead can only be sold once, and a
  // pending (unpaid) intent already reserves it.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM lead_purchases WHERE listing_id = ? AND status != 'canceled' LIMIT 1`
  )
    .bind(listing.id)
    .first<{ id: string }>();
  if (existing) return jsonError(c, 409, "This listing already has a purchase in progress");

  if (!PROVIDER_CAPABILITIES[provider].currencies.includes(listing.currency)) {
    return jsonError(c, 422, `${PROVIDER_CAPABILITIES[provider].label} cannot settle ${listing.currency}`);
  }

  const reference = await newUniquePaymentReference(c.env, provider);
  let checkout;
  try {
    checkout = createCheckoutSession(c.env, provider, {
      reference,
      amountMinor: listing.price_minor,
      currency: listing.currency,
      planName: "lead purchase",
      label: `lead listing ${listing.id}`,
    });
  } catch (err) {
    if (err instanceof PaymentProviderNotConfigured) {
      return jsonError(c, 501, err.message, "Configure the provider secrets and payment-link template before enabling this checkout.");
    }
    throw err;
  }

  const purchaseId = uuid();
  const paymentId = uuid();
  const ts = nowIso();
  await c.env.DB.batch([
    // Payment first: lead_purchases.payment_id references payments(id).
    c.env.DB.prepare(
      `INSERT INTO payments (id, workspace_id, invoice_id, purchase_id, lead_purchase_id, plan_id, provider, provider_txn_ref,
                             amount_minor, fee_minor, currency, status, settlement_status, created_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, ?, 0, ?, 'awaiting_confirmation', 'pending', ?)`
    ).bind(paymentId, ctx.workspace.id, purchaseId, provider, reference, listing.price_minor, listing.currency, ts),
    c.env.DB.prepare(
      `INSERT INTO lead_purchases (id, workspace_id, listing_id, payment_id, status, created_at)
       VALUES (?, ?, ?, ?, 'awaiting_payment', ?)`
    ).bind(purchaseId, ctx.workspace.id, listing.id, paymentId, ts),
  ]);

  await audit(c, {
    actor_user_id: ctx.membership.user_id,
    workspace_id: ctx.workspace.id,
    action: "leadmarket.purchase_created",
    target_type: "lead_purchase",
    target_id: purchaseId,
    detail: { listing_id: listing.id, seller_workspace_id: listing.workspace_id, provider, reference, amount_minor: listing.price_minor },
  });

  return c.json(
    {
      purchase: { id: purchaseId, listing_id: listing.id, status: "awaiting_payment", created_at: ts, paid_at: null, delivered_at: null },
      payment: { id: paymentId, provider, provider_txn_ref: reference, amount_minor: listing.price_minor, currency: listing.currency, status: "awaiting_confirmation" },
      checkout,
    },
    201
  );
});

export default leadMarketRoutes;
