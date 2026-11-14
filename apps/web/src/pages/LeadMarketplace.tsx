import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table } from "../components/ui";

type ListingStatus = "active" | "sold" | "removed";
type PurchaseStatus = "awaiting_payment" | "delivered" | "canceled";

interface MarketplaceListing {
  id: string;
  seller_workspace_id: string;
  seller_workspace_name: string;
  price_minor: number;
  currency: string;
  status: ListingStatus;
  created_at: string;
  qualification_score: number;
}

interface MyLead {
  id: string;
  contact_name: string;
  qualification_score: number;
  created_at: string;
  listed: number;
}

interface LeadPurchase {
  id: string;
  listing_id: string;
  status: PurchaseStatus;
  created_at: string;
  delivered_at: string | null;
  price_minor: number;
  currency: string;
  seller_workspace_name: string;
  qualification_score: number;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_provider: string | null;
  payment_status: string | null;
}

const STATUS_TONE: Record<PurchaseStatus, "slate" | "green" | "amber" | "rose"> = {
  awaiting_payment: "amber",
  delivered: "green",
  canceled: "rose",
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

export default function LeadMarketplace() {
  const { workspaces } = useAuth();
  const [wsIndex, setWsIndex] = useState(0);
  const ws = workspaces[wsIndex] ?? workspaces[0];

  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [myLeads, setMyLeads] = useState<MyLead[]>([]);
  const [purchases, setPurchases] = useState<LeadPurchase[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [listForm, setListForm] = useState({ lead_id: "", price: "", currency: "PKR" });

  const load = useCallback(async () => {
    if (!ws) return;
    setError(null);
    const [lst, mine, pur, meter] = await Promise.all([
      api.get<{ listings: MarketplaceListing[] }>(`/api/leadmarket/${ws.id}/listings`),
      api.get<{ leads: MyLead[] }>(`/api/leadmarket/${ws.id}/my-leads`),
      api.get<{ purchases: LeadPurchase[] }>(`/api/leadmarket/${ws.id}/purchases`),
      api.get<{ used: number; limit: number | null }>(`/api/apps/workspace/${ws.id}/usage/lead-marketplace`),
    ]);
    if (lst.ok && lst.data) setListings(lst.data.listings);
    else setError(lst.detail ?? lst.error ?? "Could not load the marketplace.");
    if (mine.ok && mine.data) setMyLeads(mine.data.leads);
    if (pur.ok && pur.data) setPurchases(pur.data.purchases);
    if (meter.ok && meter.data) setUsage({ used: meter.data.used, limit: meter.data.limit });
    setLoading(false);
  }, [ws]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function handleList(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return;
    const priceMinor = Math.round(parseFloat(listForm.price) * 100);
    if (!Number.isFinite(priceMinor) || priceMinor <= 0) {
      setError("Enter a valid price.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/leadmarket/${ws.id}/listings`, {
      lead_id: listForm.lead_id,
      price_minor: priceMinor,
      currency: listForm.currency,
    });
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not list the lead.");
      setBusy(false);
      return;
    }
    setListForm({ lead_id: "", price: "", currency: listForm.currency });
    await load();
    setBusy(false);
  }

  async function removeListing(listing: MarketplaceListing) {
    if (!ws) return;
    setBusy(true);
    setError(null);
    const res = await api.del(`/api/leadmarket/${ws.id}/listings/${listing.id}`);
    if (!res.ok) setError(res.detail ?? res.error ?? "Could not remove the listing.");
    await load();
    setBusy(false);
  }

  async function buy(listing: MarketplaceListing, provider: string) {
    if (!ws) return;
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/leadmarket/${ws.id}/purchases`, { listing_id: listing.id, provider });
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not create the purchase.");
      setBusy(false);
      return;
    }
    await load();
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="Lead Marketplace"
        subtitle="List your qualified, consent-given leads for sale — or buy qualified leads. Contact details are released only after a confirmed payment."
      />

      {workspaces.length > 1 && (
        <Select value={wsIndex} onChange={(e) => setWsIndex(Number(e.target.value))} className="max-w-xs">
          {workspaces.map((w, i) => (
            <option key={w.id} value={i}>{w.name}</option>
          ))}
        </Select>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-slate-900 dark:text-white">This month</h2>
          <p className="text-sm text-slate-500">
            {usage ? `${usage.used} listings published${usage.limit !== null ? ` of ${usage.limit}` : ""}` : "…"}
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Marketplace</h2>
        {listings.length === 0 ? (
          <p className="text-sm text-slate-500">No active listings right now.</p>
        ) : (
          <Table head={["Seller", "Qualification", "Price", "Listed", "Actions"]}>
            {listings.map((l) => (
              <tr key={l.id}>
                <td>{l.seller_workspace_name}</td>
                <td>
                  <Badge tone={l.qualification_score >= 70 ? "green" : l.qualification_score >= 40 ? "amber" : "slate"}>
                    score {l.qualification_score}
                  </Badge>
                </td>
                <td>{fmtMoney(l.price_minor, l.currency)}</td>
                <td className="text-sm text-slate-500">{fmtDate(l.created_at)}</td>
                <td>
                  {l.seller_workspace_id === ws?.id ? (
                    <Button variant="ghost" disabled={busy} onClick={() => removeListing(l)}>Remove</Button>
                  ) : (
                    <Button variant="secondary" disabled={busy} onClick={() => buy(l, l.currency === "USD" ? "payoneer" : "bank")}>
                      Buy ({l.currency === "USD" ? "Payoneer" : "Bank transfer"})
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">List one of your qualified leads</h2>
        <p className="mb-3 text-xs text-slate-500">
          Only leads marked <strong>qualified</strong> with marketing consent can be listed. The buyer never sees contact
          details until their payment is confirmed.
        </p>
        <form onSubmit={handleList} className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Lead</span>
            <Select required value={listForm.lead_id} onChange={(e) => setListForm({ ...listForm, lead_id: e.target.value })}>
              <option value="">Select…</option>
              {myLeads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.contact_name} (score {l.qualification_score}){l.listed > 0 ? " — listed" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Price</span>
            <Input required type="number" min="0.01" step="0.01" value={listForm.price} onChange={(e) => setListForm({ ...listForm, price: e.target.value })} placeholder="2500" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Currency</span>
            <Select value={listForm.currency} onChange={(e) => setListForm({ ...listForm, currency: e.target.value })}>
              <option value="PKR">PKR</option>
              <option value="USD">USD</option>
            </Select>
          </label>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy || !listForm.lead_id}>Publish listing</Button>
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Your purchases</h2>
        {purchases.length === 0 ? (
          <p className="text-sm text-slate-500">No purchases yet.</p>
        ) : (
          <Table head={["Seller", "Qualification", "Price", "Payment", "Status", "Contact"]}>
            {purchases.map((p) => (
              <tr key={p.id}>
                <td>{p.seller_workspace_name}</td>
                <td><Badge tone={p.qualification_score >= 70 ? "green" : "slate"}>score {p.qualification_score}</Badge></td>
                <td>{fmtMoney(p.price_minor, p.currency)}</td>
                <td className="text-sm">{p.payment_provider ? `${p.payment_provider} · ${p.payment_status ?? "—"}` : "—"}</td>
                <td><Badge tone={STATUS_TONE[p.status]}>{p.status === "delivered" ? "Delivered" : p.status === "canceled" ? "Canceled" : "Awaiting payment"}</Badge></td>
                <td className="text-sm">
                  {p.status === "delivered" ? (
                    <>
                      <span className="font-medium">{p.contact_name}</span>
                      {p.contact_email && <span className="block text-xs text-slate-500">{p.contact_email}{p.contact_phone ? ` · ${p.contact_phone}` : ""}</span>}
                    </>
                  ) : (
                    <span className="text-slate-400">Unlocked after payment</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
