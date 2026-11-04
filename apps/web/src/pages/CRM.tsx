import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table, cx } from "../components/ui";
import { ORDER_STATUS_TRANSITIONS, formatMoney, toMinorUnits, type CurrencyCode } from "@microbiz/shared";

type TabKey = "contacts" | "catalog" | "orders";

interface Contact {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  tags: string;
  created_at: string;
}

interface Product {
  id: string;
  name: string;
  kind: string;
  price_minor: number;
  currency: string;
  stock: number | null;
  active: number;
}

interface Order {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  item_count: number;
  customer_name: string | null;
  created_at: string;
}

interface Summary {
  contacts: number;
  products: number;
  pipeline: Record<string, number>;
  orders_this_month: number;
}

const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "blue" | "rose"> = {
  new: "blue",
  confirmed: "amber",
  preparing: "amber",
  delivering: "blue",
  completed: "green",
  canceled: "rose",
};

interface OrderRow {
  productId: string;
  name: string;
  qty: string;
  price: string;
}

export default function CRM() {
  const { workspaces } = useAuth();
  const ws = workspaces[0];
  const [tab, setTab] = useState<TabKey>("contacts");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);

  const currency = (ws?.currency ?? "PKR") as CurrencyCode;

  const loadSummary = useCallback(async () => {
    if (!ws) return;
    const res = await api.get<Summary>(`/api/crm/${ws.id}/summary`);
    if (res.ok && res.data) setSummary(res.data);
  }, [ws]);

  const loadTab = useCallback(
    async (which: TabKey) => {
      if (!ws) return;
      if (which === "contacts") {
        const res = await api.get<{ contacts: Contact[] }>(`/api/crm/${ws.id}/contacts`);
        if (res.ok) setContacts(res.data!.contacts);
      } else if (which === "catalog") {
        const res = await api.get<{ products: Product[] }>(`/api/crm/${ws.id}/products`);
        if (res.ok) setProducts(res.data!.products);
      } else {
        const res = await api.get<{ orders: Order[] }>(`/api/crm/${ws.id}/orders`);
        if (res.ok) setOrders(res.data!.orders);
      }
    },
    [ws]
  );

  useEffect(() => {
    if (!ws) return;
    loadSummary();
    loadTab(tab);
  }, [ws, tab, loadSummary, loadTab]);

  if (!ws) return <Card title="No workspace">Create a workspace first.</Card>;

  return (
    <div>
      <PageTitle
        title="💬 WhatsApp CRM & Order Manager"
        subtitle="Contacts, catalog and the order pipeline for chat-first selling."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryChip label="Contacts" value={summary?.contacts} />
        <SummaryChip label="Catalog items" value={summary?.products} />
        <SummaryChip label="Orders this month" value={summary?.orders_this_month} />
        <SummaryChip
          label="Active pipeline"
          value={
            summary
              ? (summary.pipeline.new ?? 0) +
                (summary.pipeline.confirmed ?? 0) +
                (summary.pipeline.preparing ?? 0) +
                (summary.pipeline.delivering ?? 0)
              : undefined
          }
        />
      </div>

      <div className="mb-4 flex gap-2">
        {(
          [
            ["contacts", "Contacts"],
            ["catalog", "Catalog"],
            ["orders", "Orders"],
          ] as [TabKey, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              "rounded-lg px-4 py-2 text-sm font-medium transition",
              tab === key
                ? "bg-brand-600 text-white shadow-sm"
                : "bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <ErrorText>{error}</ErrorText>

      {tab === "contacts" && (
        <ContactsTab
          wsId={ws.id}
          contacts={contacts}
          currency={currency}
          busy={busy}
          onChange={async (fn) => {
            setBusy(true);
            setError(null);
            try {
              await fn();
              await loadTab("contacts");
              await loadSummary();
            } finally {
              setBusy(false);
            }
          }}
          onError={setError}
          canDelete={ws.role === "owner" || ws.role === "admin"}
        />
      )}
      {tab === "catalog" && (
        <CatalogTab
          wsId={ws.id}
          products={products}
          currency={currency}
          busy={busy}
          onChange={async (fn) => {
            setBusy(true);
            setError(null);
            try {
              await fn();
              await loadTab("catalog");
              await loadSummary();
            } finally {
              setBusy(false);
            }
          }}
          onError={setError}
          canDelete={ws.role === "owner" || ws.role === "admin"}
        />
      )}
      {tab === "orders" && (
        <OrdersTab
          wsId={ws.id}
          orders={orders}
          contacts={contacts}
          products={products}
          currency={currency}
          busy={busy}
          onChange={async (fn) => {
            setBusy(true);
            setError(null);
            try {
              await fn();
              await loadTab("orders");
              await loadSummary();
            } finally {
              setBusy(false);
            }
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function SummaryChip({ label, value }: { label: string; value?: number }) {
  return (
    <div className="card !p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
        {value === undefined ? "—" : value}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- contacts */

function ContactsTab({
  wsId,
  contacts,
  busy,
  onChange,
  onError,
  canDelete,
}: {
  wsId: string;
  contacts: Contact[];
  currency: CurrencyCode;
  busy: boolean;
  onChange: (fn: () => Promise<void>) => Promise<void>;
  onError: (msg: string | null) => void;
  canDelete: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    await onChange(async () => {
      const res = await api.post(`/api/crm/${wsId}/contacts`, { name, phone, email, locale: "en" });
      if (!res.ok) {
        onError(res.detail ?? res.error ?? "Could not add contact");
        return;
      }
      setName("");
      setPhone("");
      setEmail("");
    });
  }

  async function removeContact(id: string) {
    await onChange(async () => {
      const res = await api.del(`/api/crm/${wsId}/contacts/${id}`);
      if (!res.ok) onError(res.error ?? "Delete failed");
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Add WhatsApp contact">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            addContact(e);
          }}
        >
          <Input placeholder="Name (required)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            placeholder="+923001234567 (international format)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <Input type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" disabled={busy} className="w-full">
            Add contact
          </Button>
          <p className="text-xs text-slate-400">WhatsApp-style pipeline: tag returning customers and track order history.</p>
        </form>
      </Card>

      <Card title={`Contacts (${contacts.length})`} className="lg:col-span-2">
        {contacts.length === 0 ? (
          <EmptyRow text="No contacts yet. WhatsApp orders link back to these customers." />
        ) : (
          <Table head={["Name", "Phone", "Tags", "Added", ""]}>
            {contacts.map((ct) => (
              <tr key={ct.id}>
                <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{ct.name}</td>
                <td className="px-3 py-2 text-slate-500">{ct.phone}</td>
                <td className="px-3 py-2">
                  <Badge>{ct.tags ? JSON.parse(ct.tags).join(", ") : ""}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{ct.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right">
                  {canDelete && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs text-rose-600" onClick={() => removeContact(ct.id)}>
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- catalog */

function CatalogTab({
  wsId,
  products,
  busy,
  onChange,
  onError,
  canDelete,
  currency,
}: {
  wsId: string;
  products: Product[];
  currency: CurrencyCode;
  busy: boolean;
  onChange: (fn: () => Promise<void>) => Promise<void>;
  onError: (msg: string | null) => void;
  canDelete: boolean;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [kind, setKind] = useState<"physical" | "digital">("physical");

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    await onChange(async () => {
      const res = await api.post(`/api/crm/${wsId}/products`, {
        name,
        price_minor: toMinorUnits(price, currency),
        kind,
        active: true,
      });
      if (!res.ok) {
        onError(res.detail ?? res.error ?? "Could not add product");
        return;
      }
      setName("");
      setPrice("");
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Add catalog item">
        <form onSubmit={addProduct} className="space-y-3">
          <Input placeholder="Item name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Price ({currency})</span>
            <Input inputMode="decimal" placeholder="750.00" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "physical" | "digital")}>
            <option value="physical">Physical item</option>
            <option value="digital">Digital item</option>
          </Select>
          <Button type="submit" disabled={busy} className="w-full">
            Add to catalog
          </Button>
        </form>
      </Card>

      <Card title={`Catalog (${products.length})`} className="lg:col-span-2">
        {products.length === 0 ? (
          <EmptyRow text="No catalog items yet. Add products or menu items customers order repeatedly." />
        ) : (
          <Table head={["Item", "Price", "Type", "State", ""]}>
            {products.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{p.name}</td>
                <td className="px-3 py-2 text-slate-500">{formatMoney(p.price_minor, p.currency as CurrencyCode)}</td>
                <td className="px-3 py-2 text-slate-500">{p.kind}</td>
                <td className="px-3 py-2">
                  <Badge tone={p.active ? "green" : "slate"}>{p.active ? "active" : "inactive"}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {canDelete && p.active === 1 ? (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 text-xs text-rose-600"
                      onClick={async () => {
                        await onChange(async () => {
                          await api.del(`/api/crm/${wsId}/products/${p.id}`);
                        });
                      }}
                    >
                      Deactivate
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- orders */

function OrdersTab({
  wsId,
  orders,
  contacts,
  products,
  currency,
  busy,
  onChange,
  onError,
}: {
  wsId: string;
  orders: Order[];
  contacts: Contact[];
  products: Product[];
  currency: CurrencyCode;
  busy: boolean;
  onChange: (fn: () => Promise<void>) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [note, setNote] = useState("");
  const [tax, setTax] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([{ productId: "", name: "", qty: "1", price: "" }]);

  function updateRow(i: number, patch: Partial<OrderRow>) {
    setRows((old) => old.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const totalPreview = (() => {
    let minor = 0;
    for (const r of rows) {
      const qty = Number(r.qty);
      const priceMinor = r.productId ? (products.find((p) => p.id === r.productId)?.price_minor ?? 0) : r.price ? toMinorUnits(r.price, currency) : 0;
      if (qty > 0 && priceMinor > 0) minor += Math.round((qty * 1000 * priceMinor) / 1000);
    }
    const taxMinor = tax ? toMinorUnits(tax, currency) : 0;
    return { subtotal: minor, total: minor + taxMinor };
  })();

  async function createOrder(e: React.FormEvent) {
    e.preventDefault();
    await onChange(async () => {
      const items = rows
        .filter((r) => Number(r.qty) > 0 && (r.productId || r.name))
        .map((r) => {
          const product = products.find((p) => p.id === r.productId);
          const qtyMillis = Math.round(Number(r.qty) * 1000);
          const unitPriceMinor = product ? product.price_minor : r.price ? toMinorUnits(r.price, currency) : 0;
          return {
            product_id: product?.id,
            name: product?.name ?? r.name,
            qty_millis: qtyMillis,
            unit_price_minor: unitPriceMinor,
          };
        });
      if (items.length === 0) {
        onError("Add at least one order line");
        return;
      }
      const res = await api.post(`/api/crm/${wsId}/orders`, {
        customer_id: customerId || undefined,
        tax_minor: tax ? toMinorUnits(tax, currency) : 0,
        note,
        items,
      });
      if (!res.ok) {
        onError(res.detail ?? res.error ?? "Could not create order");
        return;
      }
      setRows([{ productId: "", name: "", qty: "1", price: "" }]);
      setNote("");
      setTax("");
      setCustomerId("");
    });
  }

  async function setStatus(order: Order, next: string) {
    await onChange(async () => {
      const res = await api.patch(`/api/crm/${wsId}/orders/${order.id}`, { status: next });
      if (!res.ok) onError(res.error ?? "Status change rejected");
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <Card title="New WhatsApp order" className="lg:col-span-2">
        <form onSubmit={createOrder} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Customer (optional)</span>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— walk-in customer —</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.name} ({ct.phone})
                </option>
              ))}
            </Select>
          </label>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">Order lines</p>
            {rows.map((row, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                <Select
                  value={row.productId}
                  onChange={(e) => {
                    const productId = e.target.value;
                    const product = products.find((p) => p.id === productId);
                    updateRow(i, {
                      productId,
                      name: product ? product.name : row.name,
                      price: product ? "" : row.price,
                    });
                  }}
                >
                  <option value="">— manual item —</option>
                  {products
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {formatMoney(p.price_minor, p.currency as CurrencyCode)}
                      </option>
                    ))}
                </Select>
                {!row.productId && (
                  <Input
                    className="mt-2"
                    placeholder="Item name"
                    value={row.name}
                    onChange={(e) => updateRow(i, { name: e.target.value })}
                  />
                )}
                <div className="mt-2 flex gap-2">
                  <Input
                    inputMode="decimal"
                    className="!w-24"
                    placeholder="Qty (e.g. 1.5)"
                    value={row.qty}
                    onChange={(e) => updateRow(i, { qty: e.target.value })}
                  />
                  {!row.productId && (
                    <Input
                      inputMode="decimal"
                      className="!w-28"
                      placeholder={`Price (${currency})`}
                      value={row.price}
                      onChange={(e) => updateRow(i, { price: e.target.value })}
                    />
                  )}
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => setRows((old) => old.filter((_, idx) => idx !== i))}
                    >
                      ✕
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setRows((old) => [...old, { productId: "", name: "", qty: "1", price: "" }])}>
              + Add line
            </Button>
          </div>

          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder={`Tax (${currency})`} value={tax} onChange={(e) => setTax(e.target.value)} />
            <Input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <span>{formatMoney(totalPreview.subtotal, currency)}</span>
            </div>
            <div className="flex justify-between font-semibold text-slate-800 dark:text-slate-100">
              <span>Total</span>
              <span>{formatMoney(totalPreview.total, currency)}</span>
            </div>
          </div>

          <Button type="submit" disabled={busy} className="w-full">
            Create order
          </Button>
          <p className="text-xs text-slate-400">Order totals are computed server-side; catalog prices always win over typed prices.</p>
        </form>
      </Card>

      <Card title={`Orders (${orders.length})`} className="lg:col-span-3">
        {orders.length === 0 ? (
          <EmptyRow text="No orders yet. Records you create appear here — never demo data." />
        ) : (
          <Table head={["No.", "Customer", "Lines", "Total", "Status", ""]}>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{o.number}</td>
                <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{o.customer_name ?? "Walk-in"}</td>
                <td className="px-3 py-2 text-slate-500">{o.item_count}</td>
                <td className="px-3 py-2 font-medium">
                  {formatMoney(o.total_minor, o.currency as CurrencyCode)}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[o.status] ?? "slate"}>{o.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {(ORDER_STATUS_TRANSITIONS[o.status] ?? []).length > 0 ? (
                    <Select
                      className="!w-36 !py-1 text-xs"
                      value=""
                      onChange={(e) => setStatus(o, e.target.value)}
                      disabled={busy}
                      aria-label={`Change status of ${o.number}`}
                    >
                      <option value="">Change to…</option>
                      {(ORDER_STATUS_TRANSITIONS[o.status] ?? []).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- helpers */

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{text}</p>;
}
