import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Table } from "../components/ui";
import { formatMoney, toMinorUnits, type CurrencyCode } from "@microbiz/shared";

interface Summary {
  users: number;
  workspaces: number;
  active_subscriptions: { plan_name: string; n: number; currency: string }[];
  confirmed_receipts: { total: number; currency: string }[];
}

interface AuditLog {
  id: string;
  ts: string;
  action: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  detail: string;
}

interface AdminPlan {
  id: string;
  name: string;
  price_minor: number;
  currency: CurrencyCode;
  limits: string;
  features: string;
  is_active: number;
  is_public: number;
  sort: number;
  active_subs: number;
}

interface AdminPayment {
  id: string;
  workspace_id: string;
  workspace_name: string;
  plan_id: string | null;
  plan_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  provider: string;
  provider_txn_ref: string | null;
  amount_minor: number;
  fee_minor: number;
  currency: CurrencyCode;
  status: string;
  settlement_status: string;
  refund_minor: number;
  created_at: string;
  confirmed_at: string | null;
}

interface HostedSettlement {
  id: string;
  workspace_name: string;
  plan_name: string | null;
  invoice_number: string | null;
  provider: string;
  provider_txn_ref: string | null;
  amount_minor: number;
  fee_minor: number;
  refund_minor: number;
  currency: CurrencyCode;
  net_minor: number;
  status: string;
  settlement_status: string;
  confirmed_at: string | null;
  settled_at: string | null;
}

interface BankSettlement {
  id: string;
  workspace_name: string;
  provider: string;
  reference: string;
  expected_minor: number;
  received_minor: number;
  currency: CurrencyCode;
  status: string;
  settled_at: string | null;
  created_at: string;
}

interface AdminSettlements {
  bank: BankSettlement[];
  pending_hosted: HostedSettlement[];
  settled_hosted: HostedSettlement[];
}

interface AdminPayoutProfile {
  id: string;
  workspace_name: string;
  kind: string;
  label: string;
  approved: number;
  details_preview: {
    account_title: string | null;
    institution: string | null;
    identifier: string | null;
    payoneer_email: string | null;
  } | null;
  decryptable: boolean;
}

interface LedgerTotal {
  account: string;
  currency: CurrencyCode;
  debit_minor: number;
  credit_minor: number;
}

interface LedgerPosting {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amount_minor: number;
}

interface LedgerJournal {
  id: string;
  memo: string;
  currency: CurrencyCode;
  ref_type: string | null;
  ref_id: string | null;
  created_at: string;
  postings: LedgerPosting[];
}

const MANUAL_PROVIDERS = ["bank", "raast", "payoneer", "manual"];

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

export default function Admin() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [journals, setJournals] = useState<LedgerJournal[]>([]);
  const [totals, setTotals] = useState<LedgerTotal[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settlements, setSettlements] = useState<AdminSettlements | null>(null);
  const [payoutProfiles, setPayoutProfiles] = useState<AdminPayoutProfile[]>([]);

  const [action, setAction] = useState<{ id: string; mode: "reconcile" | "refund" | "settle" } | null>(null);
  const [actionAmount, setActionAmount] = useState("");
  const [actionRef, setActionRef] = useState("");

  const loadBilling = useCallback(async () => {
    const [p, pm, led, setl, pays] = await Promise.all([
      api.get<{ plans: AdminPlan[] }>("/api/admin/plans"),
      api.get<{ payments: AdminPayment[] }>("/api/admin/payments"),
      api.get<{ journals: LedgerJournal[]; totals: LedgerTotal[] }>("/api/admin/ledger"),
      api.get<AdminSettlements>("/api/admin/settlements"),
      api.get<{ profiles: AdminPayoutProfile[] }>("/api/admin/payout-profiles"),
    ]);
    if (p.ok && p.data) setPlans(p.data.plans);
    if (pm.ok && pm.data) setPayments(pm.data.payments);
    if (led.ok && led.data) {
      setJournals(led.data.journals);
      setTotals(led.data.totals);
    }
    if (setl.ok && setl.data) setSettlements(setl.data);
    if (pays.ok && pays.data) setPayoutProfiles(pays.data.profiles);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, l] = await Promise.all([
        api.get<Summary>("/api/admin/summary"),
        api.get<{ logs: AuditLog[] }>("/api/admin/audit-logs"),
      ]);
      if (cancelled) return;
      if (s.status === 403 || l.status === 403) {
        setForbidden(true);
        return;
      }
      if (s.ok) setSummary(s.data);
      if (l.ok) setLogs(l.data!.logs);
      await loadBilling();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBilling]);

  async function togglePlan(plan: AdminPlan, field: "is_active" | "is_public") {
    setActionError(null);
    setNotice(null);
    const res = await api.patch(`/api/admin/plans/${plan.id}`, { [field]: plan[field] !== 1 });
    if (!res.ok) {
      setActionError(res.detail ?? res.error ?? "Plan update failed");
      return;
    }
    setNotice(`${plan.name}: ${field === "is_active" ? "availability" : "visibility"} updated.`);
    await loadBilling();
  }

  function beginAction(payment: AdminPayment, mode: "reconcile" | "refund" | "settle") {
    setAction({ id: payment.id, mode });
    if (mode === "reconcile") {
      setActionAmount((payment.amount_minor / 100).toString());
      setActionRef(payment.provider_txn_ref ?? "");
    } else if (mode === "refund") {
      setActionAmount(((payment.amount_minor - payment.refund_minor) / 100).toString());
      setActionRef("");
    } else {
      setActionAmount(((payment.amount_minor - payment.fee_minor - payment.refund_minor) / 100).toString());
      setActionRef("");
    }
    setActionError(null);
    setNotice(null);
  }

  async function submitAction(payment: AdminPayment) {
    if (!action) return;
    setActionError(null);
    setNotice(null);
    let amountMinor: number;
    try {
      amountMinor = toMinorUnits(actionAmount, payment.currency);
    } catch {
      setActionError("Enter an exact amount in minor units' major form (e.g. 1500.00).");
      return;
    }

    if (action.mode === "reconcile") {
      const res = await api.post<{ plan_activated: string | null; invoice_paid: boolean; journal_id: string }>(
        `/api/admin/payments/${payment.id}/confirm`,
        { amount_minor: amountMinor, reference: actionRef }
      );
      if (!res.ok) {
        setActionError(res.detail ?? res.error ?? "Reconciliation failed");
        return;
      }
      setNotice(
        `Receipt confirmed for ${payment.workspace_name}. ` +
          (res.data?.plan_activated ? `Plan activated: ${res.data.plan_activated}. ` : "") +
          (res.data?.invoice_paid ? "Invoice marked paid. " : "") +
          "Ledger journal posted."
      );
    } else if (action.mode === "refund") {
      const res = await api.post<{ refund_minor: number; status: string; from_settled_bank: boolean }>(
        `/api/admin/payments/${payment.id}/refund`,
        { amount_minor: amountMinor, reason: actionRef || "admin recorded refund" }
      );
      if (!res.ok) {
        setActionError(res.detail ?? res.error ?? "Refund failed");
        return;
      }
      setNotice(
        `Refund of ${formatMoney(amountMinor, payment.currency)} recorded for ${payment.workspace_name}. ` +
          `Payment status: ${res.data?.status}. ` +
          (res.data?.from_settled_bank ? "Funds came out of settled bank." : "Funds reduced the provider-held balance.")
      );
    } else {
      const res = await api.post<{ net_minor: number; received_minor: number; payout_fee_minor: number }>(
        `/api/admin/payments/${payment.id}/settle`,
        { amount_minor: amountMinor, provider_ref: actionRef || undefined }
      );
      if (!res.ok) {
        setActionError(res.detail ?? res.error ?? "Settlement failed");
        return;
      }
      setNotice(
        `Payout marked settled for ${payment.workspace_name}: ${formatMoney(res.data?.received_minor ?? 0, payment.currency)} received, ` +
          `${formatMoney(res.data?.payout_fee_minor ?? 0, payment.currency)} payout fee. Ledger journal posted.`
      );
    }

    setAction(null);
    await loadBilling();
  }

  async function togglePayoutProfile(profile: AdminPayoutProfile) {
    setActionError(null);
    setNotice(null);
    const res = await api.post(`/api/admin/payout-profiles/${profile.id}/approval`, {
      approved: profile.approved !== 1,
    });
    if (!res.ok) {
      setActionError(res.detail ?? res.error ?? "Approval update failed");
      return;
    }
    setNotice(
      `${profile.workspace_name}: ${profile.label} ${profile.approved === 1 ? "approval revoked" : "approved"}.`
    );
    await loadBilling();
  }

  if (forbidden || user?.is_super_admin !== 1) {
    return (
      <Card title="Admin area">
        <p className="text-sm text-slate-500">Super admin access required.</p>
      </Card>
    );
  }

  const pendingManual = payments.filter(
    (p) => MANUAL_PROVIDERS.includes(p.provider) && ["initiated", "awaiting_confirmation"].includes(p.status)
  );
  const canRefund = (p: AdminPayment) =>
    ["confirmed", "refunded"].includes(p.status) && p.amount_minor - p.refund_minor > 0;
  const canSettle = (p: AdminPayment) =>
    ["safepay", "lemonsqueezy"].includes(p.provider) &&
    p.settlement_status === "pending" &&
    ["confirmed", "refunded"].includes(p.status);

  return (
    <div>
      <PageTitle title="Super admin" subtitle="Platform-wide controls. Server-side super-admin check on every request." />

      <ErrorText>{actionError}</ErrorText>
      {notice && (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-4">
        {summary && (
          <>
            <Card title="Users">{summary.users}</Card>
            <Card title="Workspaces">{summary.workspaces}</Card>
            <Card title="Pending manual receipts">{pendingManual.length}</Card>
            <Card title="Active plans">
              {summary.active_subscriptions.length === 0 ? (
                <p className="text-sm text-slate-500">None yet</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {summary.active_subscriptions.map((s) => (
                    <li key={`${s.plan_name}-${s.currency}`} className="flex justify-between">
                      <span>
                        {s.plan_name} ({s.currency})
                      </span>
                      <span className="font-medium">{s.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Confirmed receipts (provider-verified)" className="lg:col-span-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {summary.confirmed_receipts.length === 0
                  ? "No confirmed payments yet. This figure counts ONLY provider-verified transactions — never demo data."
                  : summary.confirmed_receipts.map((r) => `${r.currency}: ${r.total}`).join(" · ")}
              </p>
            </Card>
          </>
        )}
      </div>

      <Card title={`Payments (${payments.length})`} className="mt-5">
        {payments.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">No payments yet.</p>
        ) : (
          <Table head={["Created", "Workspace", "Plan", "Provider", "Amount", "Payment", "Settlement", "Reference", ""]}>
            {payments.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="px-3 py-2 text-xs text-slate-500">{p.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2">{p.workspace_name}</td>
                <td className="px-3 py-2 text-xs">
                  {p.plan_name ?? (p.invoice_number ? `Invoice ${p.invoice_number}` : "—")}
                </td>
                <td className="px-3 py-2 text-xs">{p.provider}</td>
                <td className="px-3 py-2 font-medium">{formatMoney(p.amount_minor, p.currency)}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[p.status] ?? "slate"}>{p.status}</Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={SETTLEMENT_TONE[p.settlement_status] ?? "slate"}>{p.settlement_status}</Badge>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.provider_txn_ref ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  {action?.id === p.id ? (
                    <div className="flex min-w-[13rem] flex-col gap-2">
                      <Input
                        value={actionAmount}
                        onChange={(e) => setActionAmount(e.target.value)}
                        placeholder={`Amount (${p.currency})`}
                        inputMode="decimal"
                        aria-label={
                          action.mode === "settle" ? "Amount received in the bank" : "Amount for this action"
                        }
                      />
                      <Input
                        value={actionRef}
                        onChange={(e) => setActionRef(e.target.value)}
                        placeholder={
                          action.mode === "reconcile"
                            ? "Transfer reference"
                            : action.mode === "refund"
                              ? "Refund reason / provider ref"
                              : "Payout reference (optional)"
                        }
                        aria-label="Reference or reason"
                      />
                      <div className="flex gap-2">
                        <Button onClick={() => submitAction(p)}>
                          {action.mode === "reconcile" ? "Confirm" : action.mode === "refund" ? "Refund" : "Mark settled"}
                        </Button>
                        <Button variant="ghost" onClick={() => setAction(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-2">
                      {MANUAL_PROVIDERS.includes(p.provider) &&
                        ["initiated", "awaiting_confirmation"].includes(p.status) && (
                          <Button variant="secondary" onClick={() => beginAction(p, "reconcile")}>
                            Reconcile
                          </Button>
                        )}
                      {canSettle(p) && (
                        <Button variant="secondary" onClick={() => beginAction(p, "settle")}>
                          Mark settled
                        </Button>
                      )}
                      {canRefund(p) && (
                        <Button variant="secondary" onClick={() => beginAction(p, "refund")}>
                          Refund
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Hosted provider payments (Safepay, Lemon Squeezy) can only be confirmed by their signed webhook — the
          reconcile action is intentionally hidden for them. Refunds are recorded after the admin executes them in
          the provider dashboard; settlement is marked only after the real bank credit is checked.
        </p>
      </Card>

      <Card title="Settlements" className="mt-5">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Payment status and settlement status are independent. Use “Mark settled” in the payments table above when
          a hosted payout lands in the bank; the difference between net held funds and the bank credit is recorded as
          a payout fee.
        </p>
        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Pending hosted payouts ({settlements?.pending_hosted.length ?? 0})
        </h3>
        {(settlements?.pending_hosted.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500">No hosted payout is waiting for a settlement mark.</p>
        ) : (
          <Table head={["Confirmed", "Workspace", "Subject", "Provider", "Net held", "Reference"]}>
            {settlements!.pending_hosted.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{p.confirmed_at?.slice(0, 10) ?? "—"}</td>
                <td className="px-3 py-2">{p.workspace_name}</td>
                <td className="px-3 py-2 text-xs">
                  {p.plan_name ?? (p.invoice_number ? `Invoice ${p.invoice_number}` : "—")}
                </td>
                <td className="px-3 py-2 text-xs">{p.provider}</td>
                <td className="px-3 py-2 font-medium">{formatMoney(p.net_minor, p.currency)}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.provider_txn_ref ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}

        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Bank / Raast reconciliation
        </h3>
        {(settlements?.bank.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500">No manual bank reconciliation rows yet.</p>
        ) : (
          <Table head={["Created", "Workspace", "Provider", "Reference", "Expected", "Received", "Status"]}>
            {settlements!.bank.slice(0, 20).map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{b.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2">{b.workspace_name}</td>
                <td className="px-3 py-2 text-xs">{b.provider}</td>
                <td className="px-3 py-2 font-mono text-xs">{b.reference}</td>
                <td className="px-3 py-2 text-sm">{formatMoney(b.expected_minor, b.currency)}</td>
                <td className="px-3 py-2 text-sm">{formatMoney(b.received_minor, b.currency)}</td>
                <td className="px-3 py-2">
                  <Badge tone={b.status === "settled" ? "green" : b.status === "mismatch" ? "rose" : "amber"}>
                    {b.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {(settlements?.settled_hosted.length ?? 0) > 0 && (
          <p className="mt-4 text-xs text-slate-400">
            {settlements!.settled_hosted.length} hosted payout(s) already marked settled. Each one posted a balanced
            journal through the ledger.
          </p>
        )}
      </Card>

      <Card title="Payout profiles (masked)" className="mt-5">
        {payoutProfiles.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No workspace has registered a payout target yet.</p>
        ) : (
          <Table head={["Workspace", "Target", "Label", "Account", "Approval", ""]}>
            {payoutProfiles.map((profile) => (
              <tr key={profile.id}>
                <td className="px-3 py-2">{profile.workspace_name}</td>
                <td className="px-3 py-2 text-xs">{profile.kind}</td>
                <td className="px-3 py-2 text-sm">{profile.label}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {profile.details_preview
                    ? [
                        profile.details_preview.account_title,
                        profile.details_preview.institution,
                        profile.details_preview.identifier ?? profile.details_preview.payoneer_email,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Key unavailable"}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={profile.approved === 1 ? "green" : "amber"}>
                    {profile.approved === 1 ? "approved" : "awaiting review"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button variant="ghost" onClick={() => togglePayoutProfile(profile)}>
                    {profile.approved === 1 ? "Revoke" : "Approve"}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Details are AES-256-GCM encrypted and shown masked. Admins can approve or revoke a target; any owner edit
          resets it to awaiting review.
        </p>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Plans">
          <Table head={["Plan", "Price", "Active", "Public", "Subs", ""]}>
            {plans.map((plan) => (
              <tr key={plan.id}>
                <td className="px-3 py-2">
                  <span className="font-medium">{plan.name}</span>
                  <span className="block font-mono text-xs text-slate-500">{plan.id}</span>
                </td>
                <td className="px-3 py-2 text-sm">{formatMoney(plan.price_minor, plan.currency)}</td>
                <td className="px-3 py-2">
                  <Badge tone={plan.is_active === 1 ? "green" : "slate"}>{plan.is_active === 1 ? "yes" : "no"}</Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={plan.is_public === 1 ? "blue" : "slate"}>{plan.is_public === 1 ? "yes" : "no"}</Badge>
                </td>
                <td className="px-3 py-2 text-sm">{plan.active_subs}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={() => togglePlan(plan, "is_active")}>
                      {plan.is_active === 1 ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="ghost" onClick={() => togglePlan(plan, "is_public")}>
                      {plan.is_public === 1 ? "Hide" : "Publish"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Ledger totals (all verified money events)">
          {totals.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">
              No journals yet. They appear only after a verified receipt, refund or settlement.
            </p>
          ) : (
            <Table head={["Currency", "Account", "Debits", "Credits"]}>
              {totals.map((t) => (
                <tr key={`${t.currency}-${t.account}`}>
                  <td className="px-3 py-2 text-xs">{t.currency}</td>
                  <td className="px-3 py-2 font-mono text-xs">{t.account}</td>
                  <td className="px-3 py-2 text-sm">{formatMoney(t.debit_minor, t.currency)}</td>
                  <td className="px-3 py-2 text-sm">{formatMoney(t.credit_minor, t.currency)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Recent ledger journals" className="mt-5">
        {journals.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">No journals yet.</p>
        ) : (
          <div className="space-y-3">
            {journals.slice(0, 12).map((j) => {
              const debits = j.postings
                .filter((p) => p.direction === "DEBIT")
                .reduce((sum, p) => sum + p.amount_minor, 0);
              const credits = j.postings
                .filter((p) => p.direction === "CREDIT")
                .reduce((sum, p) => sum + p.amount_minor, 0);
              return (
                <div key={j.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-slate-500">{j.created_at.replace("T", " ").slice(0, 19)}</span>
                    <Badge tone={debits === credits ? "green" : "rose"}>
                      {debits === credits ? "balanced" : "UNBALANCED"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{j.memo}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    {j.postings.map((p, idx) => (
                      <span key={idx} className="font-mono">
                        {p.direction === "DEBIT" ? "DR" : "CR"} {p.account} {formatMoney(p.amount_minor, j.currency)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Every journal is validated (balanced, single currency) before insert. {journals.length} shown max 12.
        </p>
      </Card>

      <Card title="Security audit log (latest 200)" className="mt-5">
        <Table head={["Time", "Action", "Actor", "Workspace"]}>
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="px-3 py-2 text-xs text-slate-500">{log.ts.replace("T", " ").slice(0, 19)}</td>
              <td className="px-3 py-2 font-mono text-xs">{log.action}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{log.actor_user_id?.slice(0, 8) ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{log.workspace_id?.slice(0, 8) ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
