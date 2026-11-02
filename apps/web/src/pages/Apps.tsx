import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AppRow } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Card, PageTitle, cx } from "../components/ui";

const ICONS: Record<string, string> = {
  "whatsapp-crm": "💬",
  "qr-menu": "🍽️",
  invoices: "🧾",
  appointments: "🗓️",
  "pdf-tools": "📄",
  "cv-generator": "📋",
  "digital-downloads": "📦",
};

export default function Apps() {
  const { workspaces } = useAuth();
  const [apps, setApps] = useState<(AppRow & { usage?: { feature_key: string; limit: number | null } })[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wsId = workspaces[0]?.id;
      if (!wsId) return;
      const res = await api.get<{ apps: typeof apps }>(`/api/apps/workspace/${wsId}`);
      if (!cancelled && res.ok) setApps(res.data!.apps);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  return (
    <div>
      <PageTitle title="Apps" subtitle="Independent micro-apps, one account. Phase 2 and 3 items appear as they ship." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {apps.map((app) => (
          <Card key={app.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-2xl">{ICONS[app.id] ?? "🧩"}</div>
                <h3 className="mt-2 font-semibold text-slate-900 dark:text-slate-100">{app.name}</h3>
              </div>
              <Badge tone={app.enabled ? "green" : "amber"}>Phase {app.phase}</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{app.description}</p>
            {app.enabled ? (
              <Link
                to={`/app/apps/${app.id}`}
                className={cx("mt-4 inline-block text-sm font-medium text-brand-600 dark:text-brand-400")}
              >
                Open →
              </Link>
            ) : (
              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">
                {app.blockReason === "not_available_yet" ? "Coming in a later phase" : "Requires plan upgrade"}
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
