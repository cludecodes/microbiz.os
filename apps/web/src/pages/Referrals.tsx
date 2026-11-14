import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { Badge, Button, Card, ErrorText, PageTitle, Table } from "../components/ui";
import { useAuth } from "../lib/authContext";

type CommissionStatus = "pending" | "approved" | "paid" | "void";
type CommissionBasis = "subscription" | "lead_sale" | "digital_sale";

interface Referral {
  id: string;
  code: string;
  referred_user_id: string | null;
  converted_at: string | null;
  created_at: string;
  referred_email: string | null;
  referred_name: string | null;
}

interface Commission {
  id: string;
  referral_id: string;
  basis: CommissionBasis;
  basis_id: string;
  currency: string;
  amount_minor: number;
  status: CommissionStatus;
  created_at: string;
  paid_at: string | null;
  referral_code: string;
}

interface CommissionSummary {
  count: number;
  earned_minor: number;
  pending: number;
  approved: number;
  paid: number;
  void: number;
}

const STATUS_TONE: Record<CommissionStatus, "slate" | "green" | "amber" | "blue" | "rose"> = {
  pending: "amber",
  approved: "blue",
  paid: "green",
  void: "rose",
};

const BASIS_LABEL: Record<CommissionBasis, string> = {
  subscription: "Subscription",
  lead_sale: "Lead sale",
  digital_sale: "Digital sale",
};

function fmtMoney(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: major % 1 === 0 ? 0 : 2 }).format(major);
  } catch {
    return `${major.toLocaleString()} ${currency}`;
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function Referrals() {
  const { user } = useAuth();
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [stats, setStats] = useState<{ total: number; converted: number; pending: number } | null>(null);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const [me, mine] = await Promise.all([
      api.get<{ referrals: Referral[]; stats: { total: number; converted: number; pending: number } }>("/api/referrals/me"),
      api.get<{ commissions: Commission[]; summary: CommissionSummary }>("/api/commissions/me"),
    ]);
    if (me.ok && me.data) {
      setReferrals(me.data.referrals);
      setStats(me.data.stats);
    } else {
      setError(me.detail ?? me.error ?? "Could not load referrals.");
    }
    if (mine.ok && mine.data) {
      setCommissions(mine.data.commissions);
      setSummary(mine.data.summary);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreateCode() {
    setBusy(true);
    setError(null);
    const res = await api.post<{ referral: Referral }>("/api/referrals", {});
    if (!res.ok) setError(res.detail ?? res.error ?? "Could not create a referral code.");
    await load();
    setBusy(false);
  }

  async function copyLink(code: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/register?ref=${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard — copy the link manually.");
    }
  }

  const activeCode = referrals.find((r) => !r.referred_user_id)?.code ?? null;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Referrals & Affiliates"
        subtitle="Share your referral link, track who joined and watch your commissions."
      />

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <Card><p className="text-2xl font-semibold">{stats.total}</p><p className="text-sm text-slate-500">Codes created</p></Card>
          <Card><p className="text-2xl font-semibold">{stats.converted}</p><p className="text-sm text-slate-500">People joined</p></Card>
          <Card>
            <p className="text-2xl font-semibold">
              {commissions.length > 0
                ? fmtMoney(
                    commissions.reduce((sum, c) => sum + c.amount_minor, 0),
                    commissions[0].currency,
                  )
                : "—"}
            </p>
            <p className="text-sm text-slate-500">Commission value ({summary?.count ?? 0} entries)</p>
          </Card>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium text-slate-900 dark:text-white">Your referral link</h2>
            {activeCode ? (
              <p className="mt-1 text-sm text-slate-500">
                Share <code className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{activeCode}</code> — anyone registering with it credits your account.
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">Create a code to start referring.</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={handleCreateCode}>
              {activeCode ? "Create another code" : "Create referral code"}
            </Button>
            {activeCode && (
              <Button disabled={busy} onClick={() => copyLink(activeCode)}>
                {copied ? "Copied ✓" : "Copy share link"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Referral codes</h2>
        {referrals.length === 0 ? (
          <p className="text-sm text-slate-500">No referral codes yet.</p>
        ) : (
          <Table head={["Code", "Referred user", "Status", "Created", "Converted"]}>
            {referrals.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-sm">{r.code}</td>
                <td>{r.referred_email ?? <span className="text-slate-400">—</span>}</td>
                <td>
                  {r.referred_user_id ? <Badge tone="green">Joined</Badge> : <Badge tone="slate">Unused</Badge>}
                </td>
                <td className="text-sm text-slate-500">{fmtDate(r.created_at)}</td>
                <td className="text-sm text-slate-500">{fmtDate(r.converted_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Commissions</h2>
        {commissions.length === 0 ? (
          <p className="text-sm text-slate-500">No commissions yet — they appear once an admin records earnings for your referrals.</p>
        ) : (
          <Table head={["Referral", "Basis", "Amount", "Status", "Created", "Paid"]}>
            {commissions.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-sm">{c.referral_code}</td>
                <td>{BASIS_LABEL[c.basis]}</td>
                <td>{fmtMoney(c.amount_minor, c.currency)}</td>
                <td><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                <td className="text-sm text-slate-500">{fmtDate(c.created_at)}</td>
                <td className="text-sm text-slate-500">{fmtDate(c.paid_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <ErrorText>{error}</ErrorText>
      {!user && <p className="text-sm text-slate-500">Sign in to view your referrals.</p>}
    </div>
  );
}
