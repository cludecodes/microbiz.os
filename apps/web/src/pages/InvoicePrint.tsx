import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText } from "../components/ui";
import { formatMoney, type CurrencyCode } from "@microbiz/shared";

interface DocDetail {
  id: string;
  number: string;
  type: "invoice" | "quotation";
  status: string;
  client_name: string;
  client_email: string | null;
  client_address: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  currency: string;
  notes: string | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

interface Item {
  id: string;
  name: string;
  qty_millis: number;
  unit_price_minor: number;
  total_minor: number;
}

/** Print-ready document view. Browser print dialog = free "PDF export";
 * server-side PDF generation is flagged for approval (see docs/roadmap.md). */
export default function InvoicePrint() {
  const { documentId } = useParams<{ documentId: string }>();
  const { workspaces } = useAuth();
  const ws = workspaces[0];
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws || !documentId) return;
    (async () => {
      const res = await api.get<{ document: DocDetail; items: Item[] }>(`/api/invoices/${ws.id}/${documentId}`);
      if (res.ok && res.data) {
        setDoc(res.data.document);
        setItems(res.data.items);
      } else setError(res.error ?? "Document not found");
    })();
  }, [ws, documentId]);

  if (error) return <div className="p-8"><ErrorText>{error}</ErrorText><Link to="/app/apps/invoices" className="text-sm text-brand-600">Back to invoices</Link></div>;
  if (!doc) return <div className="p-8 text-sm text-slate-500">Loading document…</div>;

  const currency = doc.currency as CurrencyCode;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 dark:bg-slate-950">
      <div className="mx-auto max-w-3xl space-y-4 no-print">
        <div className="flex items-center justify-between">
          <Link to="/app/apps/invoices" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
            ← Back to {doc.type === "invoice" ? "invoices" : "quotations"}
          </Link>
          <Button onClick={() => window.print()}>Print / Save as PDF</Button>
        </div>
        <p className="text-xs text-slate-500">
          PDF export runs through your browser's print dialog (free, no third-party service).
          Server-side PDF generation is a flagged feature awaiting approval.
        </p>
      </div>

      <article className="mx-auto mt-6 max-w-3xl rounded-xl bg-white p-10 text-slate-900 shadow-sm dark:bg-white dark:text-slate-900">
        <header className="flex items-start justify-between border-b border-slate-200 pb-6">
          <div>
            <p className="text-lg font-semibold">MicroBiz OS</p>
            <p className="text-xs text-slate-500">
              {doc.type === "invoice" ? "INVOICE" : "QUOTATION"} · {doc.number}
            </p>
          </div>
          <div className="text-right">
            <Badge tone={doc.status === "paid" || doc.status === "accepted" ? "green" : doc.status === "void" ? "rose" : "blue"}>
              {doc.status}
            </Badge>
            <p className="mt-2 text-xs text-slate-500">Issued {doc.created_at.slice(0, 10)}</p>
            {doc.due_date && <p className="text-xs text-slate-500">Due {doc.due_date}</p>}
          </div>
        </header>

        <section className="mt-6">
          <p className="text-xs uppercase tracking-wide text-slate-400">Bill to</p>
          <p className="mt-1 font-medium">{doc.client_name}</p>
          {doc.client_email && <p className="text-sm text-slate-600">{doc.client_email}</p>}
          {doc.client_address && <p className="text-sm text-slate-600 whitespace-pre-line">{doc.client_address}</p>}
        </section>

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2">Item</th>
              <th className="py-2 text-right">Qty</th>
              <th className="py-2 text-right">Unit</th>
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-b border-slate-100">
                <td className="py-2">{it.name}</td>
                <td className="py-2 text-right">{it.qty_millis / 1000}</td>
                <td className="py-2 text-right">{formatMoney(it.unit_price_minor, currency)}</td>
                <td className="py-2 text-right">{formatMoney(it.total_minor, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 ml-auto w-56 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Subtotal</span>
            <span>{formatMoney(doc.subtotal_minor, currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Tax</span>
            <span>{formatMoney(doc.tax_minor, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-300 pt-2 text-base font-semibold">
            <span>Total</span>
            <span>{formatMoney(doc.total_minor, currency)}</span>
          </div>
        </div>

        {doc.notes && (
          <section className="mt-8 border-t border-slate-200 pt-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">Notes</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{doc.notes}</p>
          </section>
        )}

        <footer className="mt-10 text-center text-xs text-slate-400">
          Generated by MicroBiz OS · {doc.number}
        </footer>
      </article>

      <style>{`@media print {
  .no-print, header, aside, nav { display: none !important; }
  main { padding: 0 !important; }
  body { background: #fff !important; }
}`}</style>
    </div>
  );
}
