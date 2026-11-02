import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AppRow, type WorkspaceRow } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Card, PageTitle, cx } from "../components/ui";
import { PHASE1_APP_IDS } from "@microbiz/shared";

interface MeResponse {
  user: { email: string; name: string; locale: string; id: string };
  workspaces: WorkspaceRow[];
}

interface AppUsage {
  apps: (AppRow & { usage: { feature_key: string; limit: number | null } })[];
}

export default function Home() {
  const { user, workspaces: ctxWorkspaces } = useAuth();
  const [apps, setApps] = useState<AppUsage["apps"]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wsId = ctxWorkspaces[0]?.id;
      if (!wsId) return;
      const res = await api.get<AppUsage>(`/api/apps/workspace/${wsId}`);
      if (!cancelled && res.ok && res.data) setApps(res.data.apps);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctxWorkspaces]);

  const phase1 = apps.filter((a) => PHASE1_APP_IDS.includes(a.id as never) && a.enabled);
  const pending = apps.filter((a) => !a.enabled);

  return (
    <div>
      <PageTitle title="Dashboard" subtitle={`Signed in as ${user?.email}`} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Workspaces" className="lg:col-span-1">
          <ul className="space-y-2">
            {ctxWorkspaces.map((w) => (
              <li key={w.id}>
                <Link
                  to={`/app/workspaces/${w.id}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                >
                  <span className="truncate font-medium">{w.name}</span>
                  <Badge tone="blue">{w.plan_name}</Badge>
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/app/workspaces" className="mt-3 block text-sm font-medium text-brand-600 dark:text-brand-400">
            Manage workspaces →
          </Link>
        </Card>

        <Card title="Your apps" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            {phase1.map((app) => (
              <Link
                key={app.id}
                to={`/app/apps/${app.id}`}
                className={cx(
                  "rounded-xl border border-slate-200 p-4 transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-slate-800 dark:hover:bg-slate-800/50"
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100">{app.name}</h3>
                  <Badge tone="green">Open</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{app.description}</p>
                {app.usage?.limit !== null && app.usage?.limit !== undefined && (
                  <p className="mt-2 text-xs text-slate-400">
                    Plan limit: {app.usage.limit} per month
                  </p>
                )}
              </Link>
            ))}
          </div>
          {pending.length > 0 && (
            <p className="mt-4 text-xs text-slate-400">
              Coming in later phases: {pending.map((a) => a.name).join(", ")}
            </p>
          )}
        </Card>
      </div>

      <Card title="Honest numbers" className="mt-5">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          This dashboard only counts provider-verified activity. No demo or sample figures are shown
          as real revenue — charts and financial reports appear once real (or sandbox-verified) data
          flows through the platform.
        </p>
      </Card>
    </div>
  );
}
