import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table } from "../components/ui";

type PurchaseStatus = "awaiting_payment" | "delivered" | "canceled";

interface Product {
  id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: "PKR" | "USD";
  file_url: string;
  delivery_note: string;
  active: 0 | 1;
  created_at: string;
}

interface Purchase {
  id: string;
  product_id: string;
  product_name: string;
  buyer_email: string;
  status: PurchaseStatus;
  delivery_token: string;
  created_at: string;
  delivered_at: string | null;
  price_minor: number;
  currency: string;
  payment_provider: string | null;
  payment_status: string | null;
  provider_txn_ref: string | null;
}

const STATUS_TONE: Record<PurchaseStatus, "slate" | "green" | "amber" | "rose"> = {
  awaiting_payment: "amber",
  delivered: "green",
  canceled: "rose",
};

const PAYMENT_LABEL: Record<string, string> = {
  safepay: "Safepay",
  lemonsqueezy: "Lemon Squeezy",
  bank: "Bank transfer",
  raast: "Raast",
  payoneer: "Payoneer",
};

function fmtMoney(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: major % 1 === 0 ? 0 : 2,
    }).format(major);
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

export default function DigitalDownloads() {
  const { workspaces } = useAuth();
  const [wsIndex, setWsIndex] = useState(0);
  const ws = workspaces[wsIndex] ?? workspaces[0];

  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [form, setForm] = useState({ name: "", description: "", price: "", currency: "PKR", file_url: "", delivery_note: "" });
  const [saleForm, setSaleForm] = useState({ product_id: "", buyer_email: "", provider: "bank" });

  const load = useCallback(async () => {
    if (!ws) return;
    setError(null);
    const [prod, pur, meter] = await Promise.all([
      api.get<{ products: Product[] }>(`/api/digital/${ws.id}`),
      api.get<{ purchases: Purchase[] }>(`/api/digital/${ws.id}/purchases`),
      api.get<{ used: number; limit: number | null }>(`/api/apps/workspace/${ws.id}/usage/digital-downloads`),
    ]);
    if (prod.ok && prod.data) setProducts(prod.data.products);
    else setError(prod.detail ?? prod.error ?? "Could not load products.");
    if (pur.ok && pur.data) setPurchases(pur.data.purchases);
    if (meter.ok && meter.data) setUsage({ used: meter.data.used, limit: meter.data.limit });
    setLoading(false);
  }, [ws]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return;
    const priceMinor = Math.round(parseFloat(form.price) * 100);
    if (!Number.isFinite(priceMinor) || priceMinor <= 0) {
      setError("Enter a valid price.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/digital/${ws.id}`, {
      name: form.name.trim(),
      description: form.description.trim(),
      price_minor: priceMinor,
      currency: form.currency,
      file_url: form.file_url.trim(),
      delivery_note: form.delivery_note.trim(),
    });
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not create the product.");
      setBusy(false);
      return;
    }
    setForm({ name: "", description: "", price: "", currency: form.currency, file_url: "", delivery_note: "" });
    await load();
    setBusy(false);
  }

  async function toggleActive(p: Product) {
    if (!ws) return;
    setBusy(true);
    setError(null);
    const res = await api.patch(`/api/digital/${ws.id}/${p.id}`, { active: p.active === 1 ? false : true });
    if (!res.ok) setError(res.detail ?? res.error ?? "Could not update the product.");
    await load();
    setBusy(false);
  }

  async function createPurchase(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return;
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/digital/${ws.id}/purchases`, {
      product_id: saleForm.product_id,
      buyer_email: saleForm.buyer_email,
      provider: saleForm.provider,
    });
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not create the purchase.");
      setBusy(false);
      return;
    }
    setSaleForm({ product_id: "", buyer_email: "", provider: "bank" });
    await load();
    setBusy(false);
  }

  function copyDeliveryLink(purchase: Purchase) {
    if (!ws) return;
    const url = `${window.location.origin}/d/${ws.id}/${purchase.id}?token=${purchase.delivery_token}`;
    navigator.clipboard.writeText(url).then(
      () => {
        setCopiedId(purchase.id);
        setTimeout(() => setCopiedId(null), 2000);
      },
      () => setError("Could not copy to clipboard — copy the link manually.")
    );
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="Digital Downloads"
        subtitle="Sell one-time digital products. Files unlock automatically once the payment is confirmed."
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
            {usage ? `${usage.used} products published${usage.limit !== null ? ` of ${usage.limit}` : ""}` : "…"}
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">New digital product</h2>
        <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Name</span>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ebook — Instagram Growth" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Price</span>
            <Input required type="number" min="0.01" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="1500" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Currency</span>
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="PKR">PKR</option>
              <option value="USD">USD</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">File URL (delivered after payment)</span>
            <Input required type="url" value={form.file_url} onChange={(e) => setForm({ ...form, file_url: e.target.value })} placeholder="https://…" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Description</span>
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the buyer gets" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Delivery note (optional)</span>
            <Input value={form.delivery_note} onChange={(e) => setForm({ ...form, delivery_note: e.target.value })} placeholder="Included with the download link" />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>Create product</Button>
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Record a sale</h2>
        <form onSubmit={createPurchase} className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Product</span>
            <Select required value={saleForm.product_id} onChange={(e) => setSaleForm({ ...saleForm, product_id: e.target.value })}>
              <option value="">Select…</option>
              {products.filter((p) => p.active === 1).map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {fmtMoney(p.price_minor, p.currency)}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Buyer email</span>
            <Input required type="email" value={saleForm.buyer_email} onChange={(e) => setSaleForm({ ...saleForm, buyer_email: e.target.value })} placeholder="buyer@example.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Payment provider</span>
            <Select value={saleForm.provider} onChange={(e) => setSaleForm({ ...saleForm, provider: e.target.value })}>
              <option value="bank">Bank transfer</option>
              <option value="raast">Raast</option>
              <option value="payoneer">Payoneer (USD)</option>
              <option value="safepay">Safepay</option>
              <option value="lemonsqueezy">Lemon Squeezy</option>
            </Select>
          </label>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy || !saleForm.product_id}>Create purchase</Button>
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Products</h2>
        {products.length === 0 ? (
          <p className="text-sm text-slate-500">No products yet — create your first digital product above.</p>
        ) : (
          <Table head={["Name", "Price", "Status", "Created", "Actions"]}>
            {products.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="font-medium">{p.name}</span>
                  {p.description && <span className="block text-xs text-slate-500">{p.description}</span>}
                </td>
                <td>{fmtMoney(p.price_minor, p.currency)}</td>
                <td>{p.active === 1 ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Archived</Badge>}</td>
                <td className="text-sm text-slate-500">{fmtDate(p.created_at)}</td>
                <td>
                  <Button variant="ghost" disabled={busy} onClick={() => toggleActive(p)}>
                    {p.active === 1 ? "Archive" : "Restore"}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-slate-900 dark:text-white">Purchases</h2>
        <p className="mb-3 text-xs text-slate-500">
          Record a sale by creating a purchase with the buyer's email and a payment provider. The delivery link only works
          after the payment is confirmed (webhook or admin reconciliation).
        </p>
        {purchases.length === 0 ? (
          <p className="text-sm text-slate-500">No purchases yet.</p>
        ) : (
          <Table head={["Product", "Buyer", "Amount", "Payment", "Status", "Created", "Delivery link"]}>
            {purchases.map((pu) => (
              <tr key={pu.id}>
                <td>{pu.product_name}</td>
                <td className="text-sm">{pu.buyer_email}</td>
                <td>{fmtMoney(pu.price_minor, pu.currency)}</td>
                <td className="text-sm">
                  {pu.payment_provider ? `${PAYMENT_LABEL[pu.payment_provider] ?? pu.payment_provider} · ${pu.payment_status ?? "—"}` : "—"}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[pu.status]}>{pu.status === "delivered" ? "Delivered" : pu.status === "canceled" ? "Canceled" : "Awaiting payment"}</Badge>
                </td>
                <td className="text-sm text-slate-500">{fmtDate(pu.created_at)}</td>
                <td>
                  {pu.status === "delivered" && (
                    <Button variant="secondary" onClick={() => copyDeliveryLink(pu)}>
                      {copiedId === pu.id ? "Copied ✓" : "Copy link"}
                    </Button>
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
