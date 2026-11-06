import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/apiClient";
import { Badge, Button, Card, ErrorText, Select, Table } from "../components/ui";
import { formatMoney, type CurrencyCode } from "@microbiz/shared";

interface MoneyByCurrency {
  currency: CurrencyCode;
  gross_minor: number;
  refunds_minor: number;
  net_minor: number;
  processing_fees_minor: number;
  payout_fees_minor: number;
}

interface BankByCurrency {
  currency: CurrencyCode;
  inflow_minor: number;
  outflow_minor: number;
  net_minor: number;
}

interface BalanceByCurrency {
  currency: CurrencyCode;
  available_held_minor: number;
  settled_bank_minor: number;
}

interface PendingByCurrency {
  currency: CurrencyCode;
  count: number;
  net_minor: number;
}

interface ManualByCurrency {
  currency: CurrencyCode;
  count: number;
}

interface Analytics {
  generated_at: string;
  range: {
    days: number;
    from: string;
    to: string;
    workspace_id: string | null;
    currency: CurrencyCode | null;
  };
  definitions: Record<string, string>;
  overview: {
    users_total: number;
    users_new: number;
    workspaces_total: number;
    workspaces_new: number;
    workspaces_archived: number;
    subscriptions: {
      active: number;
      trialing: number;
      past_due: number;
      canceled: number;
      canceled_in_range: number;
    };
    contracted_monthly: { currency: CurrencyCode; active_subs: number; amount_minor: number }[];
    receipts: MoneyByCurrency[];
    bank: BankByCurrency[];
    balances: BalanceByCurrency[];
    pending_hosted: PendingByCurrency[];
    pending_manual: ManualByCurrency[];
    bank_exceptions: {
      status: string;
      currency: CurrencyCode;
      count: number;
      expected_shortfall_minor: number;
    }[];
    support: { status: string; count: number }[];
  };
  revenue_series: {
    date: string;
    currency: CurrencyCode;
    gross_minor: number;
    refunds_minor: number;
    fees_minor: number;
    net_minor: number;
  }[];
  growth_series: { date: string; users: number; workspaces: number }[];
  providers: {
    provider: string;
    currency: CurrencyCode;
    receipts: number;
    gross_minor: number;
    fees_minor: number;
    refunds_minor: number;
    net_minor: number;
  }[];
  payment_status: {
    status: string;
    currency: CurrencyCode;
    count: number;
    amount_minor: number;
    refund_minor: number;
  }[];
  plans: {
    id: string;
    name: string;
    currency: CurrencyCode;
    price_minor: number;
    active_subs: number;
    trialing_subs: number;
    contracted_minor: number;
  }[];
  top_workspaces: {
    workspace_id: string;
    workspace_name: string;
    plan_name: string | null;
    plan_currency: CurrencyCode | null;
    currency: CurrencyCode;
    receipts: number;
    gross_minor: number;
    refunds_minor: number;
    net_minor: number;
  }[];
  usage: {
    app_id: string;
    feature_key: string;
    quantity: number;
    events: number;
    workspaces: number;
  }[];
  product_activity: {
    orders: { currency: CurrencyCode; count: number; value_minor: number }[];
    invoices: {
      type: string;
      status: string;
      currency: CurrencyCode;
      count: number;
      value_minor: number;
    }[];
  };
  audit_activity: { action: string; count: number }[];
}

function moneyList<T extends { currency: CurrencyCode }>(
  rows: T[],
  value: (row: T) => number
): string {
  const active = rows.filter((row) => value(row) !== 0);
  if (!active.length) return "—";
  return active.map((row) => formatMoney(value(row), row.currency)).join(" · ");
}

function countList<T extends { currency: CurrencyCode }>(
  rows: T[],
  value: (row: T) => number
): string {
  const active = rows.filter((row) => value(row) !== 0);
  if (!active.length) return "—";
  return active.map((row) => `${row.currency} ${value(row)}`).join(" · ");
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{value}</div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function DailyBars({
  title,
  rows,
  series,
  ariaLabel,
}: {
  title: string;
  rows: { date: string }[];
  series: { key: string; label: string; className: string }[];
  ariaLabel: string;
}) {
  const max = Math.max(
    1,
    ...rows.flatMap((row) => series.map((item) => Number((row as Record<string, unknown>)[item.key] ?? 0)))
  );
  const hasValues = rows.some((row) =>
    series.some((item) => Number((row as Record<string, unknown>)[item.key] ?? 0) > 0)
  );

  if (!rows.length || !hasValues) {
    return (
      <div>
        <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400 dark:border-slate-800">
          No recorded values in this range.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
        <div className="flex gap-3">
          {series.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <span className={`h-2 w-2 rounded-sm ${item.className}`} />
              {item.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex h-36 items-end gap-[2px]" role="img" aria-label={ariaLabel}>
        {rows.map((row) => {
          const values = series.map((item) => Number((row as Record<string, unknown>)[item.key] ?? 0));
          return (
            <div
              key={row.date}
              className="flex h-full flex-1 items-end justify-center gap-[1px]"
              title={`${row.date}: ${series
                .map((item, idx) => `${item.label} ${values[idx]}`)
                .join(", ")}`}
            >
              {series.map((item, idx) => (
                <span
                  key={item.key}
                  className={`w-full max-w-[7px] rounded-t-sm ${item.className}`}
                  style={{ height: `${(values[idx] / max) * 100}%` }}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{rows[0]?.date}</span>
        <span>{rows[Math.floor(rows.length / 2)]?.date}</span>
        <span>{rows[rows.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export function AdminAnalytics() {
  const [days, setDays] = useState(30);
  const [currency, setCurrency] = useState<"" | CurrencyCode>("");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    const query = new URLSearchParams({ days: String(days) });
    if (currency) query.set("currency", currency);
    const res = await api.get<Analytics>(`/api/admin/analytics?${query.toString()}`);
    if (!res.ok || !res.data) {
      setError(res.detail ?? res.error ?? "Analytics could not be loaded");
    } else {
      setData(res.data);
    }
    setBusy(false);
  }, [days, currency]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportCsv(dataset: "revenue" | "payments") {
    setExporting(dataset);
    setError(undefined);
    const query = new URLSearchParams({ dataset, days: String(days) });
    if (currency) query.set("currency", currency);
    try {
      const res = await fetch(`/api/admin/analytics/export?${query.toString()}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
        setError(payload?.detail ?? payload?.error ?? "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `microbiz-${dataset}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(String(err));
    } finally {
      setExporting(null);
    }
  }

  const chartCurrencies: CurrencyCode[] = currency
    ? [currency]
    : (["PKR", "USD"] as CurrencyCode[]);

  const supportOpen = data?.overview.support.find((row) => row.status === "open")?.count ?? 0;
  const invoiceCount =
    data?.product_activity.invoices.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const orderCount = data?.product_activity.orders.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const hasRevenue = data?.overview.receipts.some(
    (row) => row.gross_minor !== 0 || row.refunds_minor !== 0
  );

  return (
    <section className="mb-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Platform analytics</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Verified ledger and payment data only. Contracted plan value, merchant activity and
            ledger balances are labelled separately from collected receipts.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            <span className="mb-1 block">Range</span>
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </Select>
          </label>
          <label className="text-xs text-slate-500">
            <span className="mb-1 block">Currency</span>
            <Select
              value={currency}
              onChange={(event) => setCurrency(event.target.value as "" | CurrencyCode)}
            >
              <option value="">All</option>
              <option value="PKR">PKR</option>
              <option value="USD">USD</option>
            </Select>
          </label>
          <Button variant="secondary" onClick={() => void load()} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      {!data && busy && <Card title="Analytics">Loading verified analytics…</Card>}
      {!data && !busy && !error && <Card title="Analytics">No analytics data available.</Card>}

      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              {data.range.from.slice(0, 10)} to {data.range.to.slice(0, 10)} · last{" "}
              {data.range.days} days
              {data.range.workspace_id ? ` · workspace ${data.range.workspace_id}` : " · all workspaces"}
            </span>
            <span>Generated {data.generated_at.slice(0, 19).replace("T", " ")} UTC</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Verified gross receipts"
              value={moneyList(data.overview.receipts, (row) => row.gross_minor)}
              hint="Credits to gross receipts from balanced journals"
            />
            <Metric
              label="Refunds"
              value={moneyList(data.overview.receipts, (row) => row.refunds_minor)}
              hint="Contra-revenue, not a fee"
            />
            <Metric
              label="Net receipts"
              value={moneyList(data.overview.receipts, (row) => row.net_minor)}
              hint="Gross receipts minus refunds"
            />
            <Metric
              label="Processing + payout fees"
              value={moneyList(
                data.overview.receipts,
                (row) => row.processing_fees_minor + row.payout_fees_minor
              )}
              hint="Expenses, tracked separately from revenue"
            />
            <Metric
              label="Contracted monthly value"
              value={moneyList(data.overview.contracted_monthly, (row) => row.amount_minor)}
              hint="Plan list price × active subscriptions — not cash collected"
            />
            <Metric
              label="Subscriptions"
              value={`${data.overview.subscriptions.active} active`}
              hint={`${data.overview.subscriptions.trialing} trialing · ${data.overview.subscriptions.past_due} past due · ${data.overview.subscriptions.canceled_in_range} canceled in range`}
            />
            <Metric
              label="New users / workspaces"
              value={`${data.overview.users_new} / ${data.overview.workspaces_new}`}
              hint={`${data.overview.users_total} users · ${data.overview.workspaces_total} active workspaces`}
            />
            <Metric
              label="Pending hosted payouts"
              value={moneyList(data.overview.pending_hosted, (row) => row.net_minor)}
              hint={`${data.overview.pending_hosted.reduce((sum, row) => sum + row.count, 0)} confirmed receipts awaiting settlement`}
            />
            <Metric
              label="Held by providers (ledger)"
              value={moneyList(data.overview.balances, (row) => row.available_held_minor)}
              hint="Derived from recorded events — not a live provider feed"
            />
            <Metric
              label="Settled bank (ledger)"
              value={moneyList(data.overview.balances, (row) => row.settled_bank_minor)}
              hint="Only admin-confirmed receipts and verified payouts"
            />
            <Metric
              label="Bank / Raast exceptions"
              value={data.overview.bank_exceptions.reduce((sum, row) => sum + row.count, 0)}
              hint="Pending, partial or mismatched reconciliations"
            />
            <Metric
              label="Open support tickets"
              value={supportOpen}
              hint="Created in selected range; support queues are not revenue"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Daily verified receipts">
              {!hasRevenue && (
                <p className="mb-3 rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400 dark:border-slate-800">
                  No provider-verified receipts in this range. Nothing is estimated or simulated.
                </p>
              )}
              <div className="space-y-5">
                {chartCurrencies.map((cur) => (
                  <DailyBars
                    key={cur}
                    title={`${cur} receipts`}
                    rows={data.revenue_series.filter((row) => row.currency === cur)}
                    series={[
                      { key: "gross_minor", label: "Gross", className: "bg-brand-500" },
                      { key: "refunds_minor", label: "Refunds", className: "bg-rose-400" },
                    ]}
                    ariaLabel={`Daily ${cur} gross receipts and refunds`}
                  />
                ))}
              </div>
            </Card>

            <Card title="Workspace growth">
              <DailyBars
                title="New accounts per day"
                rows={data.growth_series}
                series={[
                  { key: "users", label: "Users", className: "bg-brand-500" },
                  { key: "workspaces", label: "Workspaces", className: "bg-sky-400" },
                ]}
                ariaLabel="Daily new users and workspaces"
              />
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-xs text-slate-500">Active workspaces</p>
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {data.overview.workspaces_total}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-xs text-slate-500">Archived workspaces</p>
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {data.overview.workspaces_archived}
                  </p>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Provider receipts (confirmed in range)">
              {data.providers.length === 0 ? (
                <p className="text-sm text-slate-500">No provider-verified receipts in this range.</p>
              ) : (
                <Table head={["Provider", "Currency", "Receipts", "Gross", "Fees", "Refunds", "Net"]}>
                  {data.providers.map((row) => (
                    <tr key={`${row.provider}-${row.currency}`}>
                      <td className="px-3 py-2 text-sm font-medium">{row.provider}</td>
                      <td className="px-3 py-2 text-xs">{row.currency}</td>
                      <td className="px-3 py-2 text-sm">{row.receipts}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.gross_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.fees_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.refunds_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm font-medium">{formatMoney(row.net_minor, row.currency)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Plan distribution">
              <Table head={["Plan", "Currency", "Price", "Active", "Trialing", "Contracted / mo"]}>
                {data.plans.map((plan) => (
                  <tr key={plan.id}>
                    <td className="px-3 py-2 text-sm font-medium">{plan.name}</td>
                    <td className="px-3 py-2 text-xs">{plan.currency}</td>
                    <td className="px-3 py-2 text-sm">{formatMoney(plan.price_minor, plan.currency)}</td>
                    <td className="px-3 py-2 text-sm">{plan.active_subs}</td>
                    <td className="px-3 py-2 text-sm">{plan.trialing_subs}</td>
                    <td className="px-3 py-2 text-sm">
                      {formatMoney(plan.contracted_minor, plan.currency)}
                    </td>
                  </tr>
                ))}
              </Table>
              <p className="mt-3 text-xs text-slate-400">
                Contracted value uses current plan list prices. It is not collected cash.
              </p>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Top workspaces by verified receipts">
              {data.top_workspaces.length === 0 ? (
                <p className="text-sm text-slate-500">No confirmed receipts in this range.</p>
              ) : (
                <Table head={["Workspace", "Plan", "Receipts", "Gross", "Refunds", "Net"]}>
                  {data.top_workspaces.map((row) => (
                    <tr key={`${row.workspace_id}-${row.currency}`}>
                      <td className="px-3 py-2 text-sm">
                        <span className="font-medium">{row.workspace_name}</span>
                        <span className="block font-mono text-[10px] text-slate-400">
                          {row.workspace_id}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.plan_name ?? "—"}
                        {row.plan_currency ? ` · ${row.plan_currency}` : ""}
                      </td>
                      <td className="px-3 py-2 text-sm">{row.receipts}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.gross_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.refunds_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm font-medium">{formatMoney(row.net_minor, row.currency)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Module usage (metered events)">
              {data.usage.length === 0 ? (
                <p className="text-sm text-slate-500">No metered usage in this range.</p>
              ) : (
                <Table head={["App", "Feature", "Quantity", "Events", "Workspaces"]}>
                  {data.usage.map((row) => (
                    <tr key={`${row.app_id}-${row.feature_key}`}>
                      <td className="px-3 py-2 text-sm">{row.app_id}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.feature_key}</td>
                      <td className="px-3 py-2 text-sm">{row.quantity}</td>
                      <td className="px-3 py-2 text-sm">{row.events}</td>
                      <td className="px-3 py-2 text-sm">{row.workspaces}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Payment statuses (created in range)">
              {data.payment_status.length === 0 ? (
                <p className="text-sm text-slate-500">No payment intents in this range.</p>
              ) : (
                <Table head={["Status", "Currency", "Count", "Amount", "Refunded"]}>
                  {data.payment_status.map((row) => (
                    <tr key={`${row.status}-${row.currency}`}>
                      <td className="px-3 py-2">
                        <Badge
                          tone={
                            row.status === "confirmed" || row.status === "refunded"
                              ? "green"
                              : row.status === "failed"
                                ? "rose"
                                : "slate"
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">{row.currency}</td>
                      <td className="px-3 py-2 text-sm">{row.count}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.amount_minor, row.currency)}</td>
                      <td className="px-3 py-2 text-sm">{formatMoney(row.refund_minor, row.currency)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Product activity (merchant-side, not platform revenue)">
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Invoices / quotations created" value={invoiceCount} />
                <Metric label="CRM / QR orders created" value={orderCount} />
              </div>
              <div className="mt-3 space-y-1 text-xs text-slate-500">
                {data.product_activity.orders.map((row) => (
                  <p key={row.currency}>
                    Merchant order value ({row.currency}):{" "}
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {formatMoney(row.value_minor, row.currency)}
                    </span>
                  </p>
                ))}
                {data.product_activity.invoices.map((row) => (
                  <p key={`${row.type}-${row.status}-${row.currency}`}>
                    {row.type} / {row.status} ({row.currency}): {row.count} ·{" "}
                    {formatMoney(row.value_minor, row.currency)}
                  </p>
                ))}
                {!data.product_activity.orders.length && !data.product_activity.invoices.length && (
                  <p>No merchant-side activity in this range.</p>
                )}
              </div>
            </Card>
          </div>

          <Card title="Settlement and reconciliation queue">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="Pending hosted payouts"
                value={moneyList(data.overview.pending_hosted, (row) => row.net_minor)}
                hint="Confirmed receipts not yet marked settled"
              />
              <Metric
                label="Manual receipts awaiting confirmation"
                value={countList(data.overview.pending_manual, (row) => row.count)}
                hint="Includes bank, Raast and Payoneer intents"
              />
              <Metric
                label="Reconciliation exceptions"
                value={data.overview.bank_exceptions.reduce((sum, row) => sum + row.count, 0)}
                hint="Pending, partial or mismatched bank settlements"
              />
            </div>
            {data.overview.bank_exceptions.length > 0 && (
              <div className="mt-4">
                <Table head={["Status", "Currency", "Count", "Expected shortfall"]}>
                  {data.overview.bank_exceptions.map((row) => (
                    <tr key={`${row.status}-${row.currency}`}>
                      <td className="px-3 py-2">
                        <Badge tone={row.status === "mismatch" ? "rose" : "amber"}>{row.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">{row.currency}</td>
                      <td className="px-3 py-2 text-sm">{row.count}</td>
                      <td className="px-3 py-2 text-sm">
                        {formatMoney(row.expected_shortfall_minor, row.currency)}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </Card>

          <Card title="Export verified data">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              CSV exports include only confirmed/refunded payments and ledger-derived daily totals.
              CSV cells are sanitized against spreadsheet formula injection.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => void exportCsv("revenue")}
                disabled={exporting !== null}
              >
                {exporting === "revenue" ? "Exporting…" : "Export daily revenue CSV"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void exportCsv("payments")}
                disabled={exporting !== null}
              >
                {exporting === "payments" ? "Exporting…" : "Export confirmed payments CSV"}
              </Button>
            </div>
          </Card>

          <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
              Definitions used by these analytics
            </summary>
            <dl className="mt-3 space-y-2 text-xs text-slate-500">
              {Object.entries(data.definitions).map(([key, text]) => (
                <div key={key}>
                  <dt className="font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                    {key}
                  </dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      )}
    </section>
  );
}
