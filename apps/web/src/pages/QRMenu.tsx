import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Table } from "../components/ui";
import { formatMoney, toMinorUnits, type CurrencyCode } from "@microbiz/shared";

interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price_minor: number;
  currency: string;
  active: number;
  created_at: string;
}

interface ScanUsage {
  used: number | null;
  limit: number | null;
  allowed: boolean;
}

export default function QRMenu() {
  const { workspaces } = useAuth();
  const ws = workspaces[0];
  const [items, setItems] = useState<MenuItem[]>([]);
  const [usage, setUsage] = useState<ScanUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currency = (ws?.currency ?? "PKR") as CurrencyCode;
  const publicUrl = ws ? `${window.location.origin}/menu/${ws.id}` : "";

  const load = useCallback(async () => {
    if (!ws) return;
    const [itemsRes, usageRes] = await Promise.all([
      api.get<{ items: MenuItem[]; currency: string }>(`/api/qrmenu/${ws.id}/menu`),
      api.get<ScanUsage>(`/api/apps/workspace/${ws.id}/usage/qr-menu`),
    ]);
    if (itemsRes.ok && itemsRes.data) setItems(itemsRes.data.items);
    else if (itemsRes.error) setError(itemsRes.error);
    if (usageRes.ok && usageRes.data) setUsage(usageRes.data);
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    load();
  }, [ws, load]);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!publicUrl) return;
    let alive = true;
    QRCode.toDataURL(publicUrl, { width: 256, margin: 2 })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [publicUrl]);

  if (!ws) return <Card title="No workspace">Create a workspace first.</Card>;

  const isManager = ws.role === "owner" || ws.role === "admin" || ws.role === "manager";

  return (
    <div>
      <PageTitle
        title="🍽 QR Restaurant Menu"
        subtitle="Print one QR sticker; customers always see today's live menu."
      />

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card title="Menu QR code" className="text-center">
          {qrDataUrl ? (
            <div className="space-y-3">
              <img src={qrDataUrl} alt="QR code linking to the public menu" className="mx-auto w-48 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700" />
              <p className="break-all text-xs text-slate-500">{publicUrl}</p>
              <div className="flex justify-center gap-2">
                <a href={qrDataUrl} download="menu-qr.png" className="inline-block">
                  <Button variant="secondary">Download PNG</Button>
                </a>
                <Button
                  variant="ghost"
                  onClick={() => navigator.clipboard?.writeText(publicUrl)}
                >
                  Copy link
                </Button>
              </div>
              <p className="text-xs text-slate-400">
                Scans metered: {usage?.used ?? "—"}
                {usage?.limit != null ? ` / ${usage.limit}` : ""} this month
              </p>
            </div>
          ) : (
            <p className="py-10 text-sm text-slate-400">Generating QR…</p>
          )}
        </Card>

        <Card title="Add menu item" className="lg:col-span-2">
          <AddItemForm
            currency={currency}
            busy={busy}
            onSaved={async () => {
              await load();
            }}
            onError={setError}
            wsId={ws.id}
          />
        </Card>
      </div>

      <ErrorText>{error}</ErrorText>

      <Card title={`Live menu (${items.filter((i) => i.active).length} available of ${items.length})`}>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No menu items yet. Add your first dish or drink above.
          </p>
        ) : (
          <Table head={["Item", "Price", "Description", "Status", ""]}>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{it.name}</td>
                <td className="px-3 py-2">{formatMoney(it.price_minor, it.currency as CurrencyCode)}</td>
                <td className="max-w-40 truncate px-3 py-2 text-slate-500">{it.description || "—"}</td>
                <td className="px-3 py-2">
                  <Badge tone={it.active ? "green" : "slate"}>{it.active ? "available" : "sold out"}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {isManager && (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError(null);
                        const res = await api.patch(`/api/qrmenu/${ws.id}/menu/${it.id}`, {
                          is_available: !it.active,
                        });
                        if (!res.ok) setError(res.error ?? "Toggle failed");
                        await load();
                        setBusy(false);
                      }}
                    >
                      {it.active ? "Mark sold out" : "Make available"}
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

function AddItemForm({
  wsId,
  currency,
  busy,
  onSaved,
  onError,
}: {
  wsId: string;
  currency: CurrencyCode;
  busy: boolean;
  onSaved: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await api.post(`/api/qrmenu/${wsId}/menu`, {
          name,
          price_minor: toMinorUnits(price, currency),
          description,
        });
        if (!res.ok) {
          onError(res.detail ?? res.error ?? "Could not add menu item");
          return;
        }
        setName("");
        setPrice("");
        setDescription("");
        await onSaved();
      }}
    >
      <Input placeholder="Dish or drink name" value={name} onChange={(e) => setName(e.target.value)} required />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500">Price ({currency})</span>
        <Input inputMode="decimal" placeholder="950.00" value={price} onChange={(e) => setPrice(e.target.value)} required />
      </label>
      <Input placeholder="Short description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Button type="submit" disabled={busy} className="w-full">
        Add to menu
      </Button>
      <p className="text-xs text-slate-400">
        Prices update instantly for everyone holding the same QR — no reprinting.
      </p>
    </form>
  );
}
