import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table, cx } from "../components/ui";
import {
  DOCUMENT_TRANSITIONS,
  formatMoney,
  toMinorUnits,
  type CurrencyCode,
  type InvoiceType,
} from "@microbiz/shared";

interface DocumentRow {
  id: string;
  number: string;
  type: InvoiceType;
  status: string;
  currency: string;
  client_name: string;
  client_email: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  item_count: number;
}

interface LineRow {
  name: string;
  qty: string;
  price: string;
}

const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "blue" | "rose"> = {
  draft: "slate",
  sent: "blue",
  paid: "green",
  accepted: "green",
  declined: "rose",
  expired: "slate",
  void: "rose",
};

export default function Invoices() {
  const { workspaces } = useAuth();
  const ws = workspaces[0];
  const [tab, setTab] = useState<InvoiceType>("invoice");
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [usage, setUsage] = useState<{ used: number | null; limit: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currency = (ws?.currency ?? "PKR") as CurrencyCode;

  const load = useCallback(async () => {
    if (!ws) return;
    const [docsRes, usageRes] = await Promise.all([
      api.get<{ documents: DocumentRow[] }>(`/api/invoices/${ws.id}?type=${tab}`),
      api.get<{ used: number | null; limit: number | null }>(`/api/apps/workspace/${ws.id}/usage/invoices`),
    ]);
    if (docsRes.ok && docsRes.data) setDocs(docsRes.data.documents);
    else if (docsRes.error) setError(docsRes.error);
    if (usageRes.ok && usageRes.data) setUsage(usageRes.data);
  }, [ws, tab]);

  useEffect(() => {
    if (!ws) return;
    load();
  }, [ws, load]);

  if (!ws) return <Card title="No workspace">Create a workspace first.</Card>;

  const counts = {
    draft: docs.filter((d) => d.status === "draft").length,
    sent: docs.filter((d) => d.status === "sent").length,
    done: docs.filter((d) => ["paid", "accepted"].includes(d.status)).length,
  };

  return (
    <div>
      <PageTitle
        title="🧾 Invoices & Quotations"
        subtitle="Professional documents in integer money — no rounding drift, no fake PDFs."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Chip label="This month" value={usage ? `${usage.used ?? 0}${usage.limit != null ? ` / ${usage.limit}` : ""}` : "—"} />
        <Chip label="Drafts" value={counts.draft} />
        <Chip label="Sent" value={counts.sent} />
        <Chip label={tab === "invoice" ? "Paid" : "Accepted"} value={counts.done} />
      </div>

      <div className="mb-4 flex gap-2">
        {(
          [
            ["invoice", "Invoices"],
            ["quotation", "Quotations"],
          ] as [InvoiceType, string][]
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

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title={`New ${tab === "invoice" ? "invoice" : "quotation"}`} className="lg:col-span-2">
          <CreateForm
            wsId={ws.id}
            type={tab}
            currency={currency}
            busy={busy}
            onSaved={load}
            onError={setError}
            setBusy={setBusy}
          />
        </Card>

        <Card title={`${tab === "invoice" ? "Invoices" : "Quotations"} (${docs.length})`} className="lg:col-span-3">
          {docs.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              No {tab === "invoice" ? "invoices" : "quotations"} yet. Documents you create appear here — never demo data.
            </p>
          ) : (
            <Table head={["No.", "Client", "Total", "Status", "Actions", ""]}>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{d.number}</td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                    {d.client_name}
                    {d.due_date && <span className="block text-xs text-slate-400">due {d.due_date}</span>}
                  </td>
                  <td className="px-3 py-2 font-medium">{formatMoney(d.total_minor, d.currency as CurrencyCode)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[d.status] ?? "slate"}>{d.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {(DOCUMENT_TRANSITIONS[d.type]?.[d.status] ?? []).length > 0 ? (
                      <Select
                        className="!w-36 !py-1 text-xs"
                        value=""
                        disabled={busy}
                        aria-label={`Change status of ${d.number}`}
                        onChange={async (e) => {
                          if (!e.target.value) return;
                          setBusy(true);
                          setError(null);
                          const res = await api.patch(`/api/invoices/${ws.id}/${d.id}`, { status: e.target.value });
                          if (!res.ok) setError(res.error ?? "Status change rejected");
                          await load();
                          setBusy(false);
                        }}
                      >
                        <option value="">Change to…</option>
                        {(DOCUMENT_TRANSITIONS[d.type]?.[d.status] ?? []).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      to={`/app/invoices/${d.id}/print`}
                      className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                    >
                      Print
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card !p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}

function CreateForm({
  wsId,
  type,
  currency,
  busy,
  onSaved,
  onError,
  setBusy,
}: {
  wsId: string;
  type: InvoiceType;
  currency: CurrencyCode;
  busy: boolean;
  onSaved: () => Promise<void>;
  onError: (msg: string | null) => void;
  setBusy: (b: boolean) => void;
}) {
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [tax, setTax] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<LineRow[]>([{ name: "", qty: "1", price: "" }]);

  function updateRow(i: number, patch: Partial<LineRow>) {
    setRows((old) => old.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const subtotal = rows.reduce((sum, r) => {
    const qty = Number(r.qty);
    const price = r.price ? toMinorUnits(r.price, currency) : 0;
    return qty > 0 && price > 0 ? sum + Math.round(qty * price) : sum;
  }, 0);
  const taxMinor = tax ? toMinorUnits(tax, currency) : 0;

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const items = rows
          .filter((r) => r.name && Number(r.qty) > 0 && r.price)
          .map((r) => ({
            name: r.name,
            qty_millis: Math.round(Number(r.qty) * 1000),
            unit_price_minor: toMinorUnits(r.price, currency),
          }));
        if (items.length === 0) {
          onError("Add at least one line item with a name and price");
          return;
        }
        setBusy(true);
        onError(null);
        const res = await api.post(`/api/invoices/${wsId}`, {
          type,
          client_name: clientName,
          client_email: clientEmail,
          tax_minor: taxMinor,
          notes,
          ...(type === "invoice" ? { due_date: dueDate || undefined } : {}),
          items,
        });
        if (!res.ok) {
          onError(res.detail ?? res.error ?? "Could not create document");
          setBusy(false);
          return;
        }
        setClientName("");
        setClientEmail("");
        setDueDate("");
        setTax("");
        setNotes("");
        setRows([{ name: "", qty: "1", price: "" }]);
        await onSaved();
        setBusy(false);
      }}
    >
      <Input placeholder="Client / business name" value={clientName} onChange={(e) => setClientName(e.target.value)} required />
      <Input type="email" placeholder="Client email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
      {type === "invoice" && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Due date (required)</span>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-slate-500">Line items</p>
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input
              placeholder="Description"
              value={row.name}
              onChange={(e) => updateRow(i, { name: e.target.value })}
            />
            <Input
              inputMode="decimal"
              className="!w-20"
              placeholder="Qty"
              value={row.qty}
              onChange={(e) => updateRow(i, { qty: e.target.value })}
            />
            <Input
              inputMode="decimal"
              className="!w-28"
              placeholder={`Price (${currency})`}
              value={row.price}
              onChange={(e) => updateRow(i, { price: e.target.value })}
            />
            {rows.length > 1 && (
              <Button type="button" variant="ghost" onClick={() => setRows((old) => old.filter((_, idx) => idx !== i))}>
                ✕
              </Button>
            )}
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setRows((old) => [...old, { name: "", qty: "1", price: "" }])}>
          + Add line
        </Button>
      </div>

      <div className="flex gap-2">
        <Input inputMode="decimal" placeholder={`Tax (${currency})`} value={tax} onChange={(e) => setTax(e.target.value)} />
        <Input placeholder="Notes (payment terms, bank details…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
        <div className="flex justify-between text-slate-500">
          <span>Subtotal</span>
          <span>{formatMoney(subtotal, currency)}</span>
        </div>
        <div className="flex justify-between text-slate-500">
          <span>Tax</span>
          <span>{formatMoney(taxMinor, currency)}</span>
        </div>
        <div className="flex justify-between font-semibold text-slate-800 dark:text-slate-100">
          <span>Total</span>
          <span>{formatMoney(subtotal + taxMinor, currency)}</span>
        </div>
      </div>

      <Button type="submit" disabled={busy} className="w-full">
        Create {type}
      </Button>
      <p className="text-xs text-slate-400">
        Totals are computed server-side. PDF export uses your browser's print dialog today —
        server-side PDF generation is flagged for approval before it ships.
      </p>
    </form>
  );
}
