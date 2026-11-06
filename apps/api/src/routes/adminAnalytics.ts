import { Hono } from "hono";
import type { Env } from "../types";
import type { ApiContext } from "../lib/auth";
import { requireSuperAdmin } from "../lib/adminAuth";
import { jsonError } from "../lib/http";
import { audit } from "../lib/ops";

/**
 * Super-admin analytics. Everything here is derived from recorded data:
 * balanced ledger journals, provider-verified payments, usage events and
 * workspace/subscription rows. There are no estimated or mock financials.
 */
export const adminAnalyticsRoutes = new Hono<{ Bindings: Env }>();

type Currency = "PKR" | "USD";
const CURRENCIES: Currency[] = ["PKR", "USD"];

export interface AnalyticsOptions {
  days: number;
  from: string;
  to: string;
  currency: Currency | null;
  workspaceId: string | null;
}

function parseOptions(c: ApiContext): AnalyticsOptions | null {
  const days = Number(c.req.query("days") ?? "30");
  if (!Number.isInteger(days) || days < 1 || days > 366) return null;

  const currencyRaw = (c.req.query("currency") ?? "").trim().toUpperCase();
  if (currencyRaw && currencyRaw !== "PKR" && currencyRaw !== "USD") return null;

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return {
    days,
    from: start.toISOString(),
    to: now.toISOString(),
    currency: (currencyRaw as Currency) || null,
    workspaceId: c.req.query("workspace_id")?.trim() || null,
  };
}

function dayKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(from);
  const end = new Date(to);
  cursor.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function n(value: unknown): number {
  return Number(value ?? 0);
}

interface ReceiptRow {
  currency: Currency;
  gross_minor: number;
  refunds_minor: number;
  processing_fees_minor: number;
  payout_fees_minor: number;
}

interface BankRow {
  currency: Currency;
  inflow_minor: number;
  outflow_minor: number;
}

interface BalanceRow {
  currency: Currency;
  available_held_minor: number;
  settled_bank_minor: number;
}

interface SeriesRow {
  day: string;
  currency: Currency;
  gross_minor: number;
  refunds_minor: number;
  fees_minor: number;
}

async function buildAnalytics(db: Env["DB"], opts: AnalyticsOptions) {
  const { from, to, workspaceId, currency } = opts;
  const currencies = currency ? [currency] : CURRENCIES;
  const days = dayKeys(from, to);

  const [
    head,
    subscriptionCounts,
    contracted,
    receiptRows,
    bankRows,
    balanceRows,
    revenueRows,
    growthUsers,
    growthWorkspaces,
    providerRows,
    paymentStatusRows,
    planRows,
    topWorkspaceRows,
    usageRows,
    orderRows,
    invoiceRows,
    pendingHostedRows,
    pendingManualRows,
    bankExceptionRows,
    supportRows,
    auditRows,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users_total,
           (SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ?) AS users_new,
           (SELECT COUNT(*) FROM workspaces WHERE archived = 0) AS workspaces_total,
           (SELECT COUNT(*) FROM workspaces WHERE archived = 1) AS workspaces_archived,
           (SELECT COUNT(*) FROM workspaces WHERE created_at >= ? AND created_at < ?) AS workspaces_new`
      )
      .bind(from, to, from, to)
      .first<Record<string, number>>(),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'trialing' THEN 1 ELSE 0 END) AS trialing,
           SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END) AS past_due,
           SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
           SUM(CASE WHEN status = 'canceled' AND canceled_at >= ? AND canceled_at < ? THEN 1 ELSE 0 END) AS canceled_in_range
         FROM subscriptions
         WHERE (? IS NULL OR workspace_id = ?)`
      )
      .bind(from, to, workspaceId, workspaceId)
      .first<Record<string, number>>(),
    db
      .prepare(
        `SELECT p.currency, COUNT(*) AS active_subs, SUM(p.price_minor) AS amount_minor
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.status = 'active'
           AND (? IS NULL OR s.workspace_id = ?)
           AND (? IS NULL OR p.currency = ?)
         GROUP BY p.currency`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<{ currency: Currency; active_subs: number; amount_minor: number }>(),
    db
      .prepare(
        `SELECT lj.currency,
                SUM(CASE WHEN lp.account = 'gross_receipts' AND lp.direction = 'CREDIT' THEN lp.amount_minor ELSE 0 END) AS gross_minor,
                SUM(CASE WHEN lp.account = 'refunds' AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS refunds_minor,
                SUM(CASE WHEN lp.account = 'processing_fees' AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS processing_fees_minor,
                SUM(CASE WHEN lp.account = 'payout_fees' AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS payout_fees_minor
         FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
         WHERE lj.created_at >= ? AND lj.created_at < ?
           AND (? IS NULL OR lj.workspace_id = ?)
           AND (? IS NULL OR lj.currency = ?)
         GROUP BY lj.currency`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<ReceiptRow>(),
    db
      .prepare(
        `SELECT lj.currency,
                SUM(CASE WHEN lp.account = 'settled_bank' AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS inflow_minor,
                SUM(CASE WHEN lp.account = 'settled_bank' AND lp.direction = 'CREDIT' THEN lp.amount_minor ELSE 0 END) AS outflow_minor
         FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
         WHERE lj.created_at >= ? AND lj.created_at < ?
           AND (? IS NULL OR lj.workspace_id = ?)
           AND (? IS NULL OR lj.currency = ?)
         GROUP BY lj.currency`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<BankRow>(),
    db
      .prepare(
        `SELECT lj.currency,
                SUM(CASE WHEN lp.account = 'available_balance'
                         THEN (CASE lp.direction WHEN 'DEBIT' THEN lp.amount_minor ELSE -lp.amount_minor END)
                         ELSE 0 END) AS available_held_minor,
                SUM(CASE WHEN lp.account = 'settled_bank'
                         THEN (CASE lp.direction WHEN 'DEBIT' THEN lp.amount_minor ELSE -lp.amount_minor END)
                         ELSE 0 END) AS settled_bank_minor
         FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
         WHERE (? IS NULL OR lj.workspace_id = ?)
           AND (? IS NULL OR lj.currency = ?)
         GROUP BY lj.currency`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<BalanceRow>(),
    db
      .prepare(
        `SELECT substr(lj.created_at, 1, 10) AS day, lj.currency,
                SUM(CASE WHEN lp.account = 'gross_receipts' AND lp.direction = 'CREDIT' THEN lp.amount_minor ELSE 0 END) AS gross_minor,
                SUM(CASE WHEN lp.account = 'refunds' AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS refunds_minor,
                SUM(CASE WHEN lp.account IN ('processing_fees', 'payout_fees') AND lp.direction = 'DEBIT' THEN lp.amount_minor ELSE 0 END) AS fees_minor
         FROM ledger_postings lp JOIN ledger_journals lj ON lj.id = lp.journal_id
         WHERE lj.created_at >= ? AND lj.created_at < ?
           AND (? IS NULL OR lj.workspace_id = ?)
           AND (? IS NULL OR lj.currency = ?)
         GROUP BY day, lj.currency
         ORDER BY day`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<SeriesRow>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
         FROM users WHERE created_at >= ? AND created_at < ?
         GROUP BY day ORDER BY day`
      )
      .bind(from, to)
      .all<{ day: string; n: number }>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
         FROM workspaces WHERE created_at >= ? AND created_at < ?
         GROUP BY day ORDER BY day`
      )
      .bind(from, to)
      .all<{ day: string; n: number }>(),
    db
      .prepare(
        `SELECT provider, currency, COUNT(*) AS receipts,
                SUM(amount_minor) AS gross_minor,
                SUM(fee_minor) AS fees_minor,
                SUM(refund_minor) AS refunds_minor,
                SUM(amount_minor - fee_minor - refund_minor) AS net_minor
         FROM payments
         WHERE status IN ('confirmed', 'refunded')
           AND confirmed_at >= ? AND confirmed_at < ?
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY provider, currency
         ORDER BY gross_minor DESC`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT status, currency, COUNT(*) AS count,
                SUM(amount_minor) AS amount_minor,
                SUM(refund_minor) AS refund_minor
         FROM payments
         WHERE created_at >= ? AND created_at < ?
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY status, currency
         ORDER BY count DESC`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT p.id, p.name, p.currency, p.price_minor, p.sort,
                SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS active_subs,
                SUM(CASE WHEN s.status = 'trialing' THEN 1 ELSE 0 END) AS trialing_subs,
                SUM(CASE WHEN s.status = 'active' THEN p.price_minor ELSE 0 END) AS contracted_minor
         FROM plans p
         LEFT JOIN subscriptions s ON s.plan_id = p.id AND (? IS NULL OR s.workspace_id = ?)
         WHERE p.is_active = 1 AND (? IS NULL OR p.currency = ?)
         GROUP BY p.id
         ORDER BY p.currency, p.sort, p.name`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT pm.workspace_id, w.name AS workspace_name, pl.name AS plan_name,
                pl.currency AS plan_currency, pm.currency,
                COUNT(*) AS receipts,
                SUM(pm.amount_minor) AS gross_minor,
                SUM(pm.refund_minor) AS refunds_minor,
                SUM(pm.amount_minor - pm.fee_minor - pm.refund_minor) AS net_minor
         FROM payments pm
         JOIN workspaces w ON w.id = pm.workspace_id
         LEFT JOIN plans pl ON pl.id = w.plan_id
         WHERE pm.status IN ('confirmed', 'refunded')
           AND pm.confirmed_at >= ? AND pm.confirmed_at < ?
           AND (? IS NULL OR pm.workspace_id = ?)
           AND (? IS NULL OR pm.currency = ?)
         GROUP BY pm.workspace_id, pm.currency
         ORDER BY gross_minor DESC
         LIMIT 10`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT app_id, feature_key, SUM(quantity) AS quantity, COUNT(*) AS events,
                COUNT(DISTINCT workspace_id) AS workspaces
         FROM usage_events
         WHERE occurred_at >= ? AND occurred_at < ?
           AND (? IS NULL OR workspace_id = ?)
         GROUP BY app_id, feature_key
         ORDER BY quantity DESC
         LIMIT 20`
      )
      .bind(from, to, workspaceId, workspaceId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT currency, COUNT(*) AS count, SUM(total_minor) AS value_minor
         FROM orders
         WHERE created_at >= ? AND created_at < ?
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY currency
         ORDER BY currency`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT type, status, currency, COUNT(*) AS count, SUM(total_minor) AS value_minor
         FROM invoices
         WHERE created_at >= ? AND created_at < ?
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY type, status, currency
         ORDER BY type, status, currency`
      )
      .bind(from, to, workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT currency, COUNT(*) AS count,
                SUM(amount_minor - fee_minor - refund_minor) AS net_minor
         FROM payments
         WHERE provider IN ('safepay', 'lemonsqueezy')
           AND status IN ('confirmed', 'refunded')
           AND settlement_status = 'pending'
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY currency
         ORDER BY currency`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT currency, COUNT(*) AS count
         FROM payments
         WHERE provider IN ('bank', 'raast', 'payoneer')
           AND status IN ('initiated', 'awaiting_confirmation')
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY currency
         ORDER BY currency`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT status, currency, COUNT(*) AS count,
                SUM(expected_minor - received_minor) AS expected_shortfall_minor
         FROM bank_settlements
         WHERE status IN ('pending', 'partial', 'mismatch')
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR currency = ?)
         GROUP BY status, currency
         ORDER BY status, currency`
      )
      .bind(workspaceId, workspaceId, currency, currency)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM support_tickets
         WHERE created_at >= ? AND created_at < ?
           AND (? IS NULL OR workspace_id = ?)
         GROUP BY status
         ORDER BY count DESC`
      )
      .bind(from, to, workspaceId, workspaceId)
      .all<{ status: string; count: number }>(),
    db
      .prepare(
        `SELECT action, COUNT(*) AS count
         FROM audit_logs
         WHERE ts >= ? AND ts < ?
           AND (? IS NULL OR workspace_id = ?)
         GROUP BY action
         ORDER BY count DESC
         LIMIT 15`
      )
      .bind(from, to, workspaceId, workspaceId)
      .all<{ action: string; count: number }>(),
  ]);

  const receiptMap = new Map((receiptRows.results ?? []).map((r) => [r.currency, r]));
  const bankMap = new Map((bankRows.results ?? []).map((r) => [r.currency, r]));
  const balanceMap = new Map((balanceRows.results ?? []).map((r) => [r.currency, r]));
  const contractedMap = new Map((contracted.results ?? []).map((r) => [r.currency, r]));
  const pendingHostedMap = new Map((pendingHostedRows.results ?? []).map((r) => [r.currency, r]));
  const pendingManualMap = new Map((pendingManualRows.results ?? []).map((r) => [r.currency, r]));

  const receipts = currencies.map((cur) => {
    const row = receiptMap.get(cur);
    const gross = n(row?.gross_minor);
    const refunds = n(row?.refunds_minor);
    return {
      currency: cur,
      gross_minor: gross,
      refunds_minor: refunds,
      net_minor: gross - refunds,
      processing_fees_minor: n(row?.processing_fees_minor),
      payout_fees_minor: n(row?.payout_fees_minor),
    };
  });

  const bank = currencies.map((cur) => {
    const row = bankMap.get(cur);
    const inflow = n(row?.inflow_minor);
    const outflow = n(row?.outflow_minor);
    return { currency: cur, inflow_minor: inflow, outflow_minor: outflow, net_minor: inflow - outflow };
  });

  const balances = currencies.map((cur) => {
    const row = balanceMap.get(cur);
    return {
      currency: cur,
      available_held_minor: n(row?.available_held_minor),
      settled_bank_minor: n(row?.settled_bank_minor),
    };
  });

  const contractedMonthly = currencies.map((cur) => {
    const row = contractedMap.get(cur);
    return {
      currency: cur,
      active_subs: n(row?.active_subs),
      amount_minor: n(row?.amount_minor),
    };
  });

  const seriesMap = new Map(
    (revenueRows.results ?? []).map((r) => [`${r.day}|${r.currency}`, r])
  );
  const revenueSeries = days.flatMap((day) =>
    currencies.map((cur) => {
      const row = seriesMap.get(`${day}|${cur}`);
      const gross = n(row?.gross_minor);
      const refunds = n(row?.refunds_minor);
      return {
        date: day,
        currency: cur,
        gross_minor: gross,
        refunds_minor: refunds,
        fees_minor: n(row?.fees_minor),
        net_minor: gross - refunds,
      };
    })
  );

  const usersByDay = new Map((growthUsers.results ?? []).map((r) => [r.day, n(r.n)]));
  const workspacesByDay = new Map((growthWorkspaces.results ?? []).map((r) => [r.day, n(r.n)]));
  const growthSeries = days.map((date) => ({
    date,
    users: usersByDay.get(date) ?? 0,
    workspaces: workspacesByDay.get(date) ?? 0,
  }));

  const pendingHosted = currencies.map((cur) => {
    const row = pendingHostedMap.get(cur);
    return { currency: cur, count: n(row?.count), net_minor: n(row?.net_minor) };
  });
  const pendingManual = currencies.map((cur) => {
    const row = pendingManualMap.get(cur);
    return { currency: cur, count: n(row?.count) };
  });

  return {
    generated_at: new Date().toISOString(),
    range: {
      days: opts.days,
      from,
      to,
      workspace_id: workspaceId,
      currency,
    },
    definitions: {
      revenue:
        "Verified gross receipts and refunds from balanced ledger journals. Net receipts = gross - refunds. Processing and payout fees are expenses, not revenue reductions.",
      contracted:
        "Plan list price x active subscriptions. Contracted value is not collected cash and can differ from receipts.",
      merchant:
        "Merchant order and invoice totals are customer activity inside workspaces, not MicroBiz revenue.",
      balances:
        "Ledger-derived balances from recorded events, not a live bank feed. Settled bank only includes admin-confirmed manual receipts and payouts marked from verified provider reports.",
    },
    overview: {
      users_total: n(head?.users_total),
      users_new: n(head?.users_new),
      workspaces_total: n(head?.workspaces_total),
      workspaces_new: n(head?.workspaces_new),
      workspaces_archived: n(head?.workspaces_archived),
      subscriptions: {
        active: n(subscriptionCounts?.active),
        trialing: n(subscriptionCounts?.trialing),
        past_due: n(subscriptionCounts?.past_due),
        canceled: n(subscriptionCounts?.canceled),
        canceled_in_range: n(subscriptionCounts?.canceled_in_range),
      },
      contracted_monthly: contractedMonthly,
      receipts,
      bank,
      balances,
      pending_hosted: pendingHosted,
      pending_manual: pendingManual,
      bank_exceptions: (bankExceptionRows.results ?? []).map((r) => ({
        status: String(r.status),
        currency: String(r.currency) as Currency,
        count: n(r.count),
        expected_shortfall_minor: n(r.expected_shortfall_minor),
      })),
      support: (supportRows.results ?? []).map((r) => ({ status: r.status, count: n(r.count) })),
    },
    revenue_series: revenueSeries,
    growth_series: growthSeries,
    providers: (providerRows.results ?? []).map((r) => ({
      provider: String(r.provider),
      currency: String(r.currency) as Currency,
      receipts: n(r.receipts),
      gross_minor: n(r.gross_minor),
      fees_minor: n(r.fees_minor),
      refunds_minor: n(r.refunds_minor),
      net_minor: n(r.net_minor),
    })),
    payment_status: (paymentStatusRows.results ?? []).map((r) => ({
      status: String(r.status),
      currency: String(r.currency) as Currency,
      count: n(r.count),
      amount_minor: n(r.amount_minor),
      refund_minor: n(r.refund_minor),
    })),
    plans: (planRows.results ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      currency: String(r.currency) as Currency,
      price_minor: n(r.price_minor),
      active_subs: n(r.active_subs),
      trialing_subs: n(r.trialing_subs),
      contracted_minor: n(r.contracted_minor),
    })),
    top_workspaces: (topWorkspaceRows.results ?? []).map((r) => ({
      workspace_id: String(r.workspace_id),
      workspace_name: String(r.workspace_name),
      plan_name: r.plan_name === null ? null : String(r.plan_name),
      plan_currency: r.plan_currency === null ? null : (String(r.plan_currency) as Currency),
      currency: String(r.currency) as Currency,
      receipts: n(r.receipts),
      gross_minor: n(r.gross_minor),
      refunds_minor: n(r.refunds_minor),
      net_minor: n(r.net_minor),
    })),
    usage: (usageRows.results ?? []).map((r) => ({
      app_id: String(r.app_id),
      feature_key: String(r.feature_key),
      quantity: n(r.quantity),
      events: n(r.events),
      workspaces: n(r.workspaces),
    })),
    product_activity: {
      orders: (orderRows.results ?? []).map((r) => ({
        currency: String(r.currency) as Currency,
        count: n(r.count),
        value_minor: n(r.value_minor),
      })),
      invoices: (invoiceRows.results ?? []).map((r) => ({
        type: String(r.type),
        status: String(r.status),
        currency: String(r.currency) as Currency,
        count: n(r.count),
        value_minor: n(r.value_minor),
      })),
    },
    audit_activity: (auditRows.results ?? []).map((r) => ({ action: r.action, count: n(r.count) })),
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula injection from workspace/provider-supplied text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

adminAnalyticsRoutes.get("/", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  const opts = parseOptions(c);
  if (!opts) {
    return jsonError(c, 422, "Invalid analytics range", "days must be 1-366, currency must be PKR or USD");
  }

  const data = await buildAnalytics(c.env.DB, opts);
  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: opts.workspaceId,
    action: "admin.analytics_view",
    target_type: "analytics",
    detail: { days: opts.days, currency: opts.currency },
  });
  return c.json(data);
});

adminAnalyticsRoutes.get("/export", async (c) => {
  const admin = await requireSuperAdmin(c);
  if (!admin) return jsonError(c, 403, "Super admin access required");

  const dataset = c.req.query("dataset") ?? "revenue";
  if (dataset !== "revenue" && dataset !== "payments") {
    return jsonError(c, 422, "Invalid export dataset", "dataset must be revenue or payments");
  }

  const opts = parseOptions(c);
  if (!opts) {
    return jsonError(c, 422, "Invalid analytics range", "days must be 1-366, currency must be PKR or USD");
  }

  let body: string;
  if (dataset === "revenue") {
    const data = await buildAnalytics(c.env.DB, opts);
    body = csv([
      ["date", "currency", "gross_minor", "refunds_minor", "fees_minor", "net_minor"],
      ...data.revenue_series.map((r) => [
        r.date,
        r.currency,
        r.gross_minor,
        r.refunds_minor,
        r.fees_minor,
        r.net_minor,
      ]),
    ]);
  } else {
    const rows = await c.env.DB.prepare(
      `SELECT pm.confirmed_at, pm.workspace_id, w.name AS workspace_name,
              pm.provider, pm.provider_txn_ref, pm.currency,
              pm.amount_minor, pm.fee_minor, pm.refund_minor,
              (pm.amount_minor - pm.fee_minor - pm.refund_minor) AS net_minor,
              pm.status, pm.settlement_status,
              pl.name AS plan_name, inv.number AS invoice_number
       FROM payments pm
       JOIN workspaces w ON w.id = pm.workspace_id
       LEFT JOIN plans pl ON pl.id = pm.plan_id
       LEFT JOIN invoices inv ON inv.id = pm.invoice_id
       WHERE pm.status IN ('confirmed', 'refunded')
         AND pm.confirmed_at >= ? AND pm.confirmed_at < ?
         AND (? IS NULL OR pm.workspace_id = ?)
         AND (? IS NULL OR pm.currency = ?)
       ORDER BY pm.confirmed_at DESC
       LIMIT 10000`
    )
      .bind(opts.from, opts.to, opts.workspaceId, opts.workspaceId, opts.currency, opts.currency)
      .all<Record<string, unknown>>();

    body = csv([
      [
        "confirmed_at",
        "workspace_id",
        "workspace_name",
        "provider",
        "provider_txn_ref",
        "currency",
        "amount_minor",
        "fee_minor",
        "refund_minor",
        "net_minor",
        "status",
        "settlement_status",
        "plan_name",
        "invoice_number",
      ],
      ...(rows.results ?? []).map((r) => [
        r.confirmed_at,
        r.workspace_id,
        r.workspace_name,
        r.provider,
        r.provider_txn_ref,
        r.currency,
        r.amount_minor,
        r.fee_minor,
        r.refund_minor,
        r.net_minor,
        r.status,
        r.settlement_status,
        r.plan_name,
        r.invoice_number,
      ]),
    ]);
  }

  await audit(c, {
    actor_user_id: admin.id,
    workspace_id: opts.workspaceId,
    action: "admin.analytics_export",
    target_type: "analytics",
    detail: { dataset, days: opts.days, currency: opts.currency },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="microbiz-${dataset}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
