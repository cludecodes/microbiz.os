import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table, cx } from "../components/ui";
import { formatMoney, type CurrencyCode } from "@microbiz/shared";

interface Plan {
  id: string;
  name: string;
  price_minor: number;
  currency: CurrencyCode;
  limits: Record<string, number | null>;
  features: string[];
}

interface Provider {
  id: string;
  label: string;
  mode: "hosted" | "manual";
  currencies: string[];
  description: string;
  configured: boolean;
}

interface Subscription {
  plan_id: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  current_period_end: string | null;
  plan_name: string;
  price_minor: number;
  plan_currency: string;
}

interface Payment {
  id: string;
  provider: string;
  provider_txn_ref: string | null;
  amount_minor: number;
  fee_minor: number;
  currency: string;
  status: string;
  settlement_status: string;
  refund_minor: number;
  plan_id: string | null;
  plan_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  created_at: string;
  confirmed_at: string | null;
}

interface PayoutDetailsPreview {
  account_title: string | null;
  institution: string | null;
  identifier: string | null;
  payoneer_email: string | null;
}

interface PayoutProfile {
  id: string;
  kind: string;
  label: string;
  approved: number;
  created_at: string;
  details_preview: PayoutDetailsPreview | null;
  decryptable?: boolean;
}

interface PayoutData {
  profiles: PayoutProfile[];
  encryption_configured: boolean;
}

const PAYOUT_KIND_LABELS: Record<string, string> = {
  safepay: "Safepay",
  bank_raast: "Bank / Raast",
  lemonsqueezy: "Lemon Squeezy",
  payoneer: "Payoneer",
};

interface BillingData {
  subscription: Subscription;
  plans: Plan[];
  providers: Provider[];
  payments: Payment[];
  can_manage_billing: boolean;
}

interface CheckoutResult {
  payment: Payment;
  checkout: { mode: "hosted" | "manual"; redirectUrl: string | null; instructions: string } | null;
}

const LIMIT_LABELS: Record<string, string> = {
  "whatsapp-crm.orders": "CRM orders / month",
  "qr-menu.scans": "QR menu scans / month",
  "invoices.monthly": "Invoices & quotations / month",
  team_members: "Team members",
};

const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "blue" | "rose"> = {
  confirmed: "green",
  awaiting_confirmation: "amber",
  initiated: "amber",
  failed: "rose",
  refunded: "slate",
  canceled: "slate",
};

const SETTLEMENT_TONE: Record<string, "slate" | "green" | "amber" | "rose"> = {
  settled: "green",
  pending: "amber",
  mismatch: "rose",
  not_applicable: "slate",
};

export default function Billing() {
  const { workspaces } = useAuth();
  const ws = workspaces[0];
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providerFor, setProviderFor] = useState<Record<string, string>>({});
  const [checkout, setCheckout] = useState<CheckoutResult | null>(null);
  const [payouts, setPayouts] = useState<PayoutData | null>(null);
  const [payoutKind, setPayoutKind] = useState("bank_raast");
  const [payoutLabel, setPayoutLabel] = useState("");
  const [payoutTitle, setPayoutTitle] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [payoutBank, setPayoutBank] = useState("");
  const [payoutEmail, setPayoutEmail] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutNotice, setPayoutNotice] = useState<string | null>(null);
  const pollCount = useRef(0);

  const loadPayouts = useCallback(async () => {
    if (!ws) return;
    const res = await api.get<PayoutData>(`/api/billing/workspace/${ws.id}/payout-profiles`);
    if (res.ok && res.data) setPayouts(res.data);
    else if (res.error) setError(res.detail ?? res.error);
  }, [ws]);

  const load = useCallback(async () => {
    if (!ws) return;
    const res = await api.get<BillingData>(`/api/billing/workspace/${ws.id}`);
    if (res.ok && res.data) {
      setData(res.data);
      if (res.data.can_manage_billing) await loadPayouts();
    } else if (res.error) setError(res.detail ?? res.error);
  }, [ws, loadPayouts]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the pending payment while a hosted checkout is open.
  const pending = checkout?.payment;
  useEffect(() => {
    if (!pending || pending.status !== "awaiting_confirmation") return;
    pollCount.current = 0;
    const timer = setInterval(async () => {
      if (!ws || pollCount.current >= 30) {
        clearInterval(timer);
        return;
      }
      pollCount.current++;
      const res = await api.get<{ payment: Payment }>(`/api/billing/workspace/${ws.id}/payments/${pending.id}`);
      if (res.ok && res.data) {
        const p = res.data.payment;
        setCheckout((old) => (old ? { ...old, payment: p } : old));
        if (p.status !== "awaiting_confirmation") {
          clearInterval(timer);
          await load();
        }
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, pending?.status, ws?.id]);

  if (!ws) return <Card title="No workspace">Create a workspace first.</Card>;
  if (!data) {
    return (
      <div>
        <PageTitle title="💳 Billing & plan" subtitle="Upgrade only when a provider verifies the payment." />
        <ErrorText>{error}</ErrorText>
        {!error && <Card>Loading billing…</Card>}
      </div>
    );
  }

  const currency = ws.currency as CurrencyCode;
  const currentPlan = data.subscription?.plan_id ?? "free";
  const providersFor = (plan: Plan) =>
    data.providers.filter((p) => p.currencies.includes(plan.currency));

  async function startCheckout(plan: Plan) {
    const selectable = providersFor(plan).filter((p) => p.mode === "manual" || p.configured);
    const provider = providerFor[plan.id] ?? selectable[0]?.id;
    if (!provider) {
      setError("No payment provider is configured for this plan's currency yet.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.post<CheckoutResult>(`/api/billing/workspace/${ws!.id}/checkout`, {
      plan_id: plan.id,
      provider,
      idempotency_key: `ui-${plan.id}-${Date.now()}`,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Checkout could not be started");
      return;
    }
    setCheckout(res.data);
    await load();
  }

  async function downgrade() {
    if (!window.confirm("Switch this workspace to the Free plan now? Unused paid time is not refunded.")) return;
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/billing/workspace/${ws!.id}/downgrade`, {});
    setBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Downgrade failed");
      return;
    }
    setCheckout(null);
    await load();
  }

  async function savePayout() {
    if (!ws) return;
    setPayoutBusy(true);
    setError(null);
    setPayoutNotice(null);
    const details: Record<string, string> = { account_title: payoutTitle.trim() };
    if (payoutKind === "payoneer") {
      if (payoutEmail.trim()) details.payoneer_email = payoutEmail.trim();
    } else {
      if (payoutAccount.trim()) details.account_number = payoutAccount.trim();
      if (payoutBank.trim()) details.bank_name = payoutBank.trim();
    }
    const res = await api.post(`/api/billing/workspace/${ws.id}/payout-profiles/${payoutKind}`, {
      label: payoutLabel.trim() || PAYOUT_KIND_LABELS[payoutKind],
      details,
    });
    setPayoutBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not save the payout profile");
      return;
    }
    setPayoutNotice("Saved encrypted. Changes reset approval, so an admin must re-approve the target.");
    setPayoutLabel("");
    setPayoutTitle("");
    setPayoutAccount("");
    setPayoutBank("");
    setPayoutEmail("");
    await loadPayouts();
  }

  async function removePayout(kind: string) {
    if (!ws) return;
    if (!window.confirm(`Delete the ${PAYOUT_KIND_LABELS[kind] ?? kind} payout profile?`)) return;
    setPayoutBusy(true);
    setError(null);
    const res = await api.del(`/api/billing/workspace/${ws.id}/payout-profiles/${kind}`);
    setPayoutBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not delete the payout profile");
      return;
    }
    await loadPayouts();
  }

  return (
    <div>
      <PageTitle
        title="💳 Billing & plan"
        subtitle="Plans activate only after a verified provider event or an admin-verified bank receipt."
      />
      <ErrorText>{error}</ErrorText>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Current plan">
          <p className="text-2xl font-semibold text-slate-900 dark:text-white">{data.subscription?.plan_name}</p>
          <p className="mt-1 text-sm text-slate-500">
            {data.subscription?.price_minor
              ? `${formatMoney(data.subscription.price_minor, currency)} / month`
              : "Free forever"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={data.subscription?.status === "active" ? "green" : "amber"}>{data.subscription?.status}</Badge>
            <Badge tone="slate">{data.subscription?.provider}</Badge>
          </div>
          {data.subscription?.current_period_end && (
            <p className="mt-3 text-xs text-slate-500">
              Current period ends {data.subscription.current_period_end.slice(0, 10)}
            </p>
          )}
          {currentPlan !== "free" && data.can_manage_billing && (
            <Button variant="secondary" className="mt-4 w-full" onClick={downgrade} disabled={busy}>
              Switch to Free (no partial refund)
            </Button>
          )}
          {!data.can_manage_billing && (
            <p className="mt-3 text-xs text-slate-400">Only the workspace owner can change the plan.</p>
          )}
        </Card>

        <Card title="How money flows here" className="lg:col-span-2">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>
              A browser "success" page never activates anything. Hosted providers confirm through
              <span className="font-medium"> signed webhooks</span> with amount and currency re-checked server-side.
            </li>
            <li>
              Bank / Raast / Payoneer receipts are confirmed by an admin against the real statement,
              with the transfer reference matched.
            </li>
            <li>
              Every confirmed receipt posts a balanced double-entry journal; settlement is tracked
              separately from payment status.
            </li>
          </ul>
        </Card>
      </div>

      {data.can_manage_billing && (
        <Card title="Payout profiles (encrypted at rest)" className="mt-5">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Register the bank, Raast, Safepay, Lemon Squeezy or Payoneer target where real payouts land.
            Details are AES-256-GCM encrypted and never shown back in full.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Provider target</span>
              <Select value={payoutKind} onChange={(e) => setPayoutKind(e.target.value)}>
                {Object.entries(PAYOUT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <Input
              placeholder="Label (e.g. Main bank)"
              value={payoutLabel}
              onChange={(e) => setPayoutLabel(e.target.value)}
            />
            <Input
              placeholder="Account title"
              value={payoutTitle}
              onChange={(e) => setPayoutTitle(e.target.value)}
            />
            {payoutKind === "payoneer" ? (
              <Input
                type="email"
                placeholder="Payoneer email"
                value={payoutEmail}
                onChange={(e) => setPayoutEmail(e.target.value)}
              />
            ) : (
              <>
                <Input
                  placeholder="Account number / IBAN"
                  value={payoutAccount}
                  onChange={(e) => setPayoutAccount(e.target.value)}
                />
                <Input
                  placeholder="Bank name (optional)"
                  value={payoutBank}
                  onChange={(e) => setPayoutBank(e.target.value)}
                />
              </>
            )}
          </div>
          <div className="mt-3">
            <Button onClick={savePayout} disabled={payoutBusy || !payoutTitle.trim()}>
              {payoutBusy ? "Saving…" : "Save encrypted profile"}
            </Button>
          </div>
          {payouts && !payouts.encryption_configured && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Server encryption key is missing. Saving fails closed with 501 until PAYOUT_ENCRYPTION_KEY is set.
            </p>
          )}
          {payoutNotice && (
            <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              {payoutNotice}
            </p>
          )}
          {payouts && payouts.profiles.length > 0 && (
            <div className="mt-4">
              <Table head={["Target", "Label", "Account", "Approval", ""]}>
                {payouts.profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td className="px-3 py-2 text-xs">{PAYOUT_KIND_LABELS[profile.kind] ?? profile.kind}</td>
                    <td className="px-3 py-2">{profile.label}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {profile.details_preview
                        ? [profile.details_preview.account_title, profile.details_preview.institution, profile.details_preview.identifier ?? profile.details_preview.payoneer_email]
                            .filter(Boolean)
                            .join(" · ")
                        : "Key unavailable — re-enter the profile"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={profile.approved ? "green" : "amber"}>
                        {profile.approved ? "approved" : "awaiting review"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" onClick={() => removePayout(profile.kind)} disabled={payoutBusy}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-400">
            Never enter card numbers, CVVs, banking passwords or OTPs. Only account metadata is accepted; the API
            rejects unknown fields. Updating a profile sets it back to “awaiting review”.
          </p>
        </Card>
      )}

      {checkout && (
        <Card title="Checkout in progress" className="mt-5">
          <p className="text-sm text-slate-600 dark:text-slate-300">{checkout.checkout?.instructions}</p>
          {checkout.checkout?.redirectUrl && (
            <a
              href={checkout.checkout.redirectUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Open secure checkout →
            </a>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-500">Reference</span>
            <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs dark:bg-slate-800">
              {checkout.payment.provider_txn_ref}
            </code>
            <Badge tone={STATUS_TONE[checkout.payment.status] ?? "slate"}>{checkout.payment.status}</Badge>
            <span className="text-xs text-slate-400">
              {checkout.payment.status === "awaiting_confirmation"
                ? "Waiting for verified confirmation — this page refreshes itself."
                : "Confirmed."}
            </span>
          </div>
        </Card>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {currency} plans
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.plans.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          const options = providersFor(plan);
          const selectable = options.filter((p) => p.mode === "manual" || p.configured);
          const selectedProvider = providerFor[plan.id] ?? selectable[0]?.id ?? "";
          const notes = Object.entries(plan.limits).filter(([key]) => LIMIT_LABELS[key]);
          return (
            <div
              key={plan.id}
              className={cx(
                "card flex flex-col",
                isCurrent && "ring-2 ring-brand-500/60"
              )}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white">{plan.name}</h3>
                  <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
                    {plan.price_minor === 0 ? "Free" : formatMoney(plan.price_minor, plan.currency)}
                    {plan.price_minor > 0 && <span className="text-sm font-normal text-slate-400"> /mo</span>}
                  </p>
                </div>
                {isCurrent && <Badge tone="green">Current</Badge>}
              </div>

              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
                {notes.map(([key, value]) => (
                  <li key={key} className="flex justify-between gap-3">
                    <span>{LIMIT_LABELS[key]}</span>
                    <span className="font-medium">{value === null ? "Unlimited" : value}</span>
                  </li>
                ))}
                {plan.features.map((f) => (
                  <li key={f} className="text-slate-500">
                    ✓ {f.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>

              {!isCurrent && plan.price_minor > 0 && data.can_manage_billing && (
                <div className="mt-4 space-y-2">
                  <Select
                    value={selectedProvider}
                    onChange={(e) => setProviderFor((old) => ({ ...old, [plan.id]: e.target.value }))}
                    aria-label={`Payment provider for ${plan.name}`}
                  >
                    {options.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.mode === "hosted" && !p.configured}>
                        {p.label}
                        {p.mode === "hosted" && !p.configured ? " — not configured" : ""}
                      </option>
                    ))}
                  </Select>
                  <Button className="w-full" onClick={() => startCheckout(plan)} disabled={busy || !selectedProvider}>
                    Continue
                  </Button>
                  <p className="text-xs text-slate-400">{options.find((p) => p.id === selectedProvider)?.description}</p>
                </div>
              )}
              {!isCurrent && plan.price_minor === 0 && data.can_manage_billing && (
                <Button variant="secondary" className="mt-4 w-full" onClick={downgrade} disabled={busy}>
                  Switch to Free
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <Card title={`Payment history (${data.payments.length})`} className="mt-6">
        {data.payments.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">
            No payments yet. This table only ever shows real intents and provider-verified receipts — never demo rows.
          </p>
        ) : (
          <Table head={["Date", "Plan", "Provider", "Amount", "Payment", "Settlement", "Reference"]}>
            {data.payments.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{p.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2">
                  {p.plan_name ?? (p.invoice_number ? `Invoice ${p.invoice_number}` : "—")}
                </td>
                <td className="px-3 py-2 text-xs">{p.provider}</td>
                <td className="px-3 py-2 font-medium">
                  {formatMoney(p.amount_minor, p.currency as CurrencyCode)}
                  {p.refund_minor > 0 && (
                    <span className="block text-xs text-rose-500">
                      −{formatMoney(p.refund_minor, p.currency as CurrencyCode)} refunded
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[p.status] ?? "slate"}>{p.status}</Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={SETTLEMENT_TONE[p.settlement_status] ?? "slate"}>{p.settlement_status}</Badge>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.provider_txn_ref ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
