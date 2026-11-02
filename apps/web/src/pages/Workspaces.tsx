import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type WorkspaceRow } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table } from "../components/ui";
import { formatMoney } from "@microbiz/shared";

export default function Workspaces() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<"PKR" | "USD">("PKR");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { workspaces } = useAuth();

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.post<{ id: string; slug: string }>("/api/workspaces", { name, currency, locale: "en" });
    if (!res.ok) {
      setError(res.error ?? "Could not create workspace");
      setBusy(false);
      return;
    }
    setName("");
    await refresh();
    navigate(`/app/workspaces/${res.data!.id}`);
  }

  return (
    <div>
      <PageTitle title="Workspaces" subtitle="Each workspace is an isolated tenant with its own data, plan and members." />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="New workspace" className="lg:col-span-1">
          <form onSubmit={onCreate} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Name</span>
              <Input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ali's Restaurant" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Currency</span>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value as "PKR" | "USD")}>
                <option value="PKR">PKR — Pakistani Rupee</option>
                <option value="USD">USD — US Dollar</option>
              </Select>
            </label>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Creating…" : "Create workspace"}
            </Button>
            <p className="text-xs text-slate-400">You will be the owner. Free plan: up to 2 workspaces.</p>
          </form>
        </Card>

        <Card title={`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`} className="lg:col-span-2">
          <Table head={["Name", "Plan", "Currency", "Status", ""]}>
            {workspaces.map((ws: WorkspaceRow) => (
              <tr key={ws.id}>
                <td className="px-3 py-3 font-medium text-slate-800 dark:text-slate-200">{ws.name}</td>
                <td className="px-3 py-3">
                  <Badge tone="blue">{ws.plan_name}</Badge>
                </td>
                <td className="px-3 py-3 text-slate-500">
                  {ws.currency}
                  {typeof ws.price_minor === "number" && ` · ${formatMoney(ws.price_minor, (ws.plan_currency as "PKR" | "USD") ?? ws.currency)}/mo`}
                </td>
                <td className="px-3 py-3">
                  <Badge tone={ws.subscription_status === "active" ? "green" : "amber"}>
                    {ws.subscription_status ?? "—"}
                  </Badge>
                </td>
                <td className="px-3 py-3 text-right">
                  <Link
                    to={`/app/workspaces/${ws.id}`}
                    className="text-sm font-medium text-brand-600 dark:text-brand-400"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
