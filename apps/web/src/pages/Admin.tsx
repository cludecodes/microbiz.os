import { useEffect, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Card, PageTitle, Table } from "../components/ui";

interface Summary {
  users: number;
  workspaces: number;
  active_subscriptions: { plan_name: string; n: number; currency: string }[];
  confirmed_receipts: { total: number; currency: string }[];
}

interface AuditLog {
  id: string;
  ts: string;
  action: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  detail: string;
}

export default function Admin() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, l] = await Promise.all([
        api.get<Summary>("/api/admin/summary"),
        api.get<{ logs: AuditLog[] }>("/api/admin/audit-logs"),
      ]);
      if (cancelled) return;
      if (s.status === 403 || l.status === 403) setForbidden(true);
      if (s.ok) setSummary(s.data);
      if (l.ok) setLogs(l.data!.logs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (forbidden || user?.is_super_admin !== 1) {
    return (
      <Card title="Admin area">
        <p className="text-sm text-slate-500">Super admin access required.</p>
      </Card>
    );
  }

  return (
    <div>
      <PageTitle title="Super admin" subtitle="Platform-wide controls. Server-side super-admin check on every request." />

      <div className="grid gap-5 lg:grid-cols-4">
        {summary && (
          <>
            <Card title="Users">{summary.users}</Card>
            <Card title="Workspaces">{summary.workspaces}</Card>
            <Card title="Active plans" className="lg:col-span-2">
              {summary.active_subscriptions.length === 0 ? (
                <p className="text-sm text-slate-500">None yet</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {summary.active_subscriptions.map((s) => (
                    <li key={`${s.plan_name}-${s.currency}`} className="flex justify-between">
                      <span>{s.plan_name} ({s.currency})</span>
                      <span className="font-medium">{s.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Confirmed receipts (provider-verified)" className="lg:col-span-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {summary.confirmed_receipts.length === 0
                  ? "No confirmed payments yet. This figure counts ONLY provider-verified transactions — never demo data."
                  : summary.confirmed_receipts.map((r) => `${r.currency}: ${r.total}`).join(" · ")}
              </p>
            </Card>
          </>
        )}
      </div>

      <Card title="Security audit log (latest 200)" className="mt-5">
        <Table head={["Time", "Action", "Actor", "Workspace"]}>
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="px-3 py-2 text-xs text-slate-500">{log.ts.replace("T", " ").slice(0, 19)}</td>
              <td className="px-3 py-2 font-mono text-xs">{log.action}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{log.actor_user_id?.slice(0, 8) ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{log.workspace_id?.slice(0, 8) ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
