import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Logo } from "../components/ui";

interface Delivery {
  status: string;
  delivered_at: string | null;
  product: { name: string; description: string; file_url: string; delivery_note: string };
}

/** Public buyer delivery page: /d/:workspaceId/:purchaseId?token=…
 *  The token is the only credential; the download unlocks once the payment
 *  has been confirmed server-side. */
export default function Delivery() {
  const { workspaceId, purchaseId } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/digital/${workspaceId}/${purchaseId}?token=${encodeURIComponent(token)}`
        );
        const data = (await res.json().catch(() => null)) as
          | (Delivery & { error?: string })
          | null;
        if (cancelled) return;
        if (res.ok && data) setDelivery(data);
        else setError(data?.error ?? "Delivery not available.");
      } catch {
        if (!cancelled) setError("Network error — try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, purchaseId, token]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="justify-center text-lg text-slate-900 dark:text-white" />
        </div>
        <div className="card space-y-4 text-center">
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {!loading && error && (
            <>
              <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Download not available yet</h1>
              <p className="text-sm text-slate-500">{error}</p>
            </>
          )}
          {!loading && delivery && (
            <>
              <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{delivery.product.name}</h1>
              {delivery.product.description && (
                <p className="text-sm text-slate-500">{delivery.product.description}</p>
              )}
              <a
                href={delivery.product.file_url}
                className="inline-block rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white hover:bg-brand-700"
                target="_blank"
                rel="noreferrer"
              >
                Download now
              </a>
              {delivery.product.delivery_note && (
                <p className="text-xs text-slate-500">{delivery.product.delivery_note}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
