import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/apiClient";
import { Badge, Card, ErrorText, Logo } from "../components/ui";
import { formatMoney, type CurrencyCode } from "@microbiz/shared";

interface PublicMenu {
  workspace: { name: string; currency: string };
  limited: boolean;
  items: { name: string; description: string | null; price_minor: number; currency: string }[];
}

/** Public page behind the QR sticker — no login, no app shell. */
export default function PublicMenu() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await api.get<PublicMenu>(`/api/public/qrmenu/${workspaceId}`);
      if (!alive) return;
      if (res.ok && res.data) setMenu(res.data);
      else setError(res.error ?? "Menu not found");
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-lg space-y-5">
        <div className="flex flex-col items-center gap-2">
          <Logo className="text-sm text-slate-900 dark:text-white" />
        </div>

        {loading && <Card title="">Loading menu…</Card>}
        <ErrorText>{error}</ErrorText>

        {menu && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">{menu.workspace.name}</h1>
              <p className="mt-1 text-sm text-slate-500">Live menu — prices update in real time</p>
            </div>

            {menu.limited ? (
              <Card title="Menu temporarily unavailable">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  This restaurant's free monthly menu-view allowance is used up. The
                  owner can raise the limit by upgrading the plan. No data is faked
                  and the real menu returns immediately after the limit resets or
                  the plan changes.
                </p>
              </Card>
            ) : menu.items.length === 0 ? (
              <Card title="Nothing on the menu yet">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  The menu hasn't been set up yet. Check back soon.
                </p>
              </Card>
            ) : (
              <Card title="">
                <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                  {menu.items.map((it) => (
                    <li key={it.name} className="flex items-start justify-between gap-3 py-3">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-slate-100">{it.name}</p>
                        {it.description && (
                          <p className="text-sm text-slate-500">{it.description}</p>
                        )}
                      </div>
                      <span className="whitespace-nowrap font-semibold text-slate-900 dark:text-slate-100">
                        {formatMoney(it.price_minor, (it.currency || menu.workspace.currency) as CurrencyCode)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <div className="flex items-center justify-center gap-2 pb-6">
              <Badge tone="slate">Prices in {menu.workspace.currency}</Badge>
              <Link to="/" className="text-xs text-slate-400 hover:underline">
                Powered by MicroBiz OS
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
