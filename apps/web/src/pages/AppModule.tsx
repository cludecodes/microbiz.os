import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type WorkspaceDetail } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Card, PageTitle, Badge, Table } from "../components/ui";

const APP_META: Record<string, { title: string; subtitle: string; icon: string }> = {
  "whatsapp-crm": {
    title: "WhatsApp CRM & Order Manager",
    subtitle: "Contacts, catalogs and order pipeline for chat-first selling.",
    icon: "💬",
  },
  "qr-menu": {
    title: "Restaurant QR Menu & Ordering",
    subtitle: "QR menus with live ordering for guests — no app install needed.",
    icon: "🍽️",
  },
  invoices: {
    title: "Invoice, Quotation & Payment Reminder",
    subtitle: "Invoices, quotations and automated payment reminders.",
    icon: "🧾",
  },
  appointments: { title: "Appointment Booking", subtitle: "Phase 2", icon: "🗓️" },
  "pdf-tools": { title: "PDF Utilities", subtitle: "Phase 2", icon: "📄" },
  "cv-generator": { title: "CV Generator", subtitle: "Phase 2", icon: "📋" },
  "digital-downloads": { title: "Digital Downloads", subtitle: "Phase 2", icon: "📦" },
};

interface AppUsage {
  feature_key: string;
  used: number;
  limit: number | null;
  allowed: boolean;
  reason: string | null;
}

/**
 * Honest module shells for the Phase 1 apps: fully wired for tenancy,
 * entitlements and usage metering, with clearly labelled "No records yet"
 * empty states. The real workflows arrive in the next milestone, built on
 * this exact authorization context.
 */
export default function AppModule() {
  const { appId = "" } = useParams();
  const { workspaces } = useAuth();
  const meta = APP_META[appId];
  const [usage, setUsage] = useState<AppUsage | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wsId = workspaces[0]?.id;
      if (!wsId) return;
      const [uRes, dRes] = await Promise.all([
        api.get<AppUsage>(`/api/apps/workspace/${wsId}/usage/${appId}`),
        api.get<WorkspaceDetail>(`/api/workspaces/${wsId}`),
      ]);
      if (!cancelled) {
        if (uRes.ok) setUsage(uRes.data);
        if (dRes.ok) setDetail(dRes.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, workspaces]);

  if (!meta) {
    return <Card title="Unknown app">No app named “{appId}”.</Card>;
  }

  const isFreePlan = detail?.plan?.id === "free";

  return (
    <div>
      <PageTitle title={`${meta.icon} ${meta.title}`} subtitle={meta.subtitle} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Usage meter" className="lg:col-span-1">
          {usage && (
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-500 dark:text-slate-400">{usage.feature_key}</span>
                <span className="text-2xl font-semibold text-slate-900 dark:text-white">
                  {usage.used}
                  <span className="text-sm font-normal text-slate-400"> / {usage.limit ?? "∞"}</span>
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${usage.limit ? Math.min((usage.used / usage.limit) * 100, 100) : 8}%` }}
                />
              </div>
              <Badge tone={usage.allowed ? "green" : "rose"}>
                {usage.allowed ? "Included in plan" : "Limit reached"}
              </Badge>
            </div>
          )}
        </Card>

        <Card title="Recent activity" className="lg:col-span-2">
          <Table head={["Record", "Date", "Status"]}>
            <tr>
              <td className="px-3 py-4 text-sm text-slate-500" colSpan={3}>
                No records yet — genuine data only. Records you create appear here.
              </td>
            </tr>
          </Table>
          <p className="mt-3 text-xs text-slate-400">
            Demo rows are never shown as genuine business data. The full “{meta.title}” workflow
            ships in the next milestone on this same tenancy and entitlement layer
            {isFreePlan ? " (plan limits are enforced via the billing milestone)" : ""}.
          </p>
        </Card>
      </div>
    </div>
  );
}
