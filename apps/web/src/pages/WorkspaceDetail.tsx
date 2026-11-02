import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type WorkspaceDetail } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table } from "../components/ui";

const ROLES = ["admin", "manager", "member"] as const;

export default function WorkspaceDetail() {
  const { workspaceId = "" } = useParams();
  const { refresh } = useAuth();
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<WorkspaceDetail>(`/api/workspaces/${workspaceId}`);
    if (!res.ok) {
      setNotFound(true);
      return;
    }
    setDetail(res.data);
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) load();
  }, [workspaceId, load]);

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.post(`/api/workspaces/${workspaceId}/members`, { email, role });
    if (!res.ok) {
      setError(res.error ?? "Could not add member");
      setBusy(false);
      return;
    }
    setEmail("");
    setBusy(false);
    await load();
  }

  async function changeRole(userId: string, nextRole: string) {
    await api.patch(`/api/workspaces/${workspaceId}/members/${userId}`, { role: nextRole });
    await load();
    await refresh();
  }

  async function removeMember(userId: string) {
    if (!confirm("Remove this member from the workspace?")) return;
    const res = await api.del(`/api/workspaces/${workspaceId}/members/${userId}`);
    if (!res.ok && res.error) setError(res.error);
    await load();
  }

  if (notFound) {
    return (
      <Card title="Workspace unavailable">
        <p className="text-sm text-slate-500">This workspace does not exist or you do not have access.</p>
      </Card>
    );
  }
  if (!detail) return <p className="text-sm text-slate-500">Loading…</p>;

  const myRole = detail.workspace.role;
  const canManage = myRole === "owner" || myRole === "admin";
  const limits: Record<string, number | null> = detail.plan?.limits ? JSON.parse(detail.plan.limits) : {};

  return (
    <div>
      <PageTitle
        title={detail.workspace.name}
        subtitle={`${detail.workspace.currency} · Free plan · Your role: ${myRole}`}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Plan & usage">
          <ul className="space-y-2 text-sm">
            {Object.entries(limits).map(([key, limit]) => {
              const used = detail.usage.find((u) => u.feature_key === key)?.used ?? 0;
              return (
                <li key={key} className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-300">{key}</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {used} / {limit === null ? "∞" : limit}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={`Members (${detail.members.length})`}>
          <Table head={["Member", "Role", "Joined", ""]}>
            {detail.members.map((m) => (
              <tr key={m.user_id}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800 dark:text-slate-200">{m.name}</div>
                  <div className="text-xs text-slate-500">{m.email}</div>
                </td>
                <td className="px-3 py-2">
                  {canManage && m.role !== "owner" ? (
                    <Select
                      value={m.role}
                      onChange={(e) => changeRole(m.user_id, e.target.value)}
                      className="!w-auto text-xs"
                      aria-label={`Role for ${m.email}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge tone={m.role === "owner" ? "blue" : "slate"}>{m.role}</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{m.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right">
                  {canManage && m.role !== "owner" && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs text-rose-600" onClick={() => removeMember(m.user_id)}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>

          {canManage && (
            <form onSubmit={addMember} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <label className="min-w-48 flex-1">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Email of existing account</span>
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@business.com" />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Role</span>
                <Select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" disabled={busy}>
                Add
              </Button>
            </form>
          )}
          <ErrorText>{error}</ErrorText>
          <p className="mt-2 text-xs text-slate-400">
            New members must already have a MicroBiz account (same unified identity across apps).
          </p>
        </Card>
      </div>
    </div>
  );
}
