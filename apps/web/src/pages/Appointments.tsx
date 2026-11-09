import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table } from "../components/ui";

type AppointmentStatus = "new" | "confirmed" | "completed" | "canceled";

interface Appointment {
  id: string;
  title: string;
  description: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  owner_name: string;
}

type FilterKey = "upcoming" | "all" | "completed" | "canceled";

const STATUS_TONE: Record<AppointmentStatus, "slate" | "green" | "amber" | "blue" | "rose"> = {
  new: "amber",
  confirmed: "blue",
  completed: "green",
  canceled: "rose",
};

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  new: "New",
  confirmed: "Confirmed",
  completed: "Completed",
  canceled: "Canceled",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Appointments() {
  const { workspaces } = useAuth();
  const [wsIndex, setWsIndex] = useState(0);
  const ws = workspaces[wsIndex] ?? workspaces[0];

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);
  const [filter, setFilter] = useState<FilterKey>("upcoming");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", date: "", start: "09:00", end: "10:00" });

  const load = useCallback(async () => {
    if (!ws) return;
    setError(null);
    const [list, meter] = await Promise.all([
      api.get<{ appointments: Appointment[] }>(`/api/appointments/${ws.id}`),
      api.get<{ used: number; limit: number | null }>(`/api/apps/workspace/${ws.id}/usage/appointments`),
    ]);
    if (list.ok && list.data) setAppointments(list.data.appointments);
    else setError(list.error === "forbidden" ? "You do not have access to this workspace." : list.error ?? "Could not load appointments.");
    if (meter.ok && meter.data) setUsage({ used: meter.data.used, limit: meter.data.limit });
    setLoading(false);
  }, [ws]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const visible = useMemo(() => {
    const now = Date.now();
    const rows = appointments.filter((a) => {
      if (filter === "upcoming") return a.status !== "completed" && a.status !== "canceled" && Date.parse(a.end_at) >= now;
      if (filter === "completed") return a.status === "completed";
      if (filter === "canceled") return a.status === "canceled";
      return true;
    });
    return filter === "upcoming"
      ? [...rows].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
      : [...rows].sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  }, [appointments, filter]);

  const stats = useMemo(() => {
    const now = Date.now();
    return {
      total: appointments.length,
      upcoming: appointments.filter((a) => a.status !== "completed" && a.status !== "canceled" && Date.parse(a.end_at) >= now).length,
      confirmed: appointments.filter((a) => a.status === "confirmed").length,
      completed: appointments.filter((a) => a.status === "completed").length,
    };
  }, [appointments]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return;
    setBusy(true);
    setError(null);
    const startAt = new Date(`${form.date}T${form.start}`);
    const endAt = new Date(`${form.date}T${form.end}`);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      setError("Pick a valid date and time.");
      setBusy(false);
      return;
    }
    if (endAt <= startAt) {
      setError("The end time must be after the start time.");
      setBusy(false);
      return;
    }
    const res = await api.post(`/api/appointments/${ws.id}`, {
      title: form.title.trim(),
      description: form.description.trim(),
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not create the appointment.");
      return;
    }
    setIsModalOpen(false);
    setForm({ title: "", description: "", date: "", start: "09:00", end: "10:00" });
    await load();
  }

  async function updateStatus(appointmentId: string, status: AppointmentStatus) {
    if (!ws) return;
    setBusy(true);
    setError(null);
    const res = await api.patch(`/api/appointments/${ws.id}/${appointmentId}`, { status });
    setBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not update the appointment.");
      return;
    }
    await load();
  }

  async function remove(appointmentId: string) {
    if (!ws) return;
    if (!window.confirm("Delete this appointment? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    const res = await api.del(`/api/appointments/${ws.id}/${appointmentId}`);
    setBusy(false);
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Could not delete the appointment.");
      return;
    }
    await load();
  }

  if (!ws) return <Card title="No workspace">Create a workspace first to start booking appointments.</Card>;

  return (
    <div>
      <PageTitle
        title="🗓️ Appointment Booking"
        subtitle="Take bookings, confirm slots and keep every client's schedule in one place."
      />

      {workspaces.length > 1 && (
        <div className="mb-4 max-w-sm">
          <label className="mb-1 block text-xs font-medium text-slate-500">Workspace</label>
          <Select value={wsIndex} onChange={(e) => setWsIndex(Number(e.target.value))}>
            {workspaces.map((w, i) => (
              <option key={w.id} value={i}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={stats.total} />
        <Stat label="Upcoming" value={stats.upcoming} />
        <Stat label="Confirmed" value={stats.confirmed} />
        <Stat label="Completed" value={stats.completed} />
      </div>

      <Card
        title="Schedule"
        action={
          <div className="flex items-center gap-3">
            {usage && (
              <span className="hidden text-xs text-slate-500 sm:inline">
                {usage.used}
                {usage.limit === null ? " bookings this month" : ` / ${usage.limit} bookings this month`}
              </span>
            )}
            <Button onClick={() => setIsModalOpen(true)} disabled={busy}>
              + New appointment
            </Button>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          {(["upcoming", "all", "completed", "canceled"] as FilterKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition " +
                (filter === key
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300")
              }
            >
              {key}
            </button>
          ))}
        </div>

        <ErrorText>{error}</ErrorText>

        {loading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading appointments…</p>
        ) : (
          <Table head={["Appointment", "When", "Status", "Actions"]}>
            {visible.map((appt) => (
              <tr key={appt.id}>
                <td className="px-3 py-3">
                  <p className="font-medium text-slate-900 dark:text-slate-100">{appt.title}</p>
                  {appt.description && (
                    <p className="max-w-xs truncate text-xs text-slate-500 dark:text-slate-400">{appt.description}</p>
                  )}
                  <p className="text-[11px] text-slate-400">Booked by {appt.owner_name}</p>
                </td>
                <td className="px-3 py-3 text-slate-600 dark:text-slate-300">
                  <div>{fmtDate(appt.start_at)}</div>
                  <div className="text-xs text-slate-400">
                    {fmtTime(appt.start_at)} – {fmtTime(appt.end_at)}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={STATUS_TONE[appt.status]}>{STATUS_LABEL[appt.status]}</Badge>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {appt.status === "new" && (
                      <Action onClick={() => updateStatus(appt.id, "confirmed")} disabled={busy}>
                        Confirm
                      </Action>
                    )}
                    {appt.status === "confirmed" && (
                      <Action onClick={() => updateStatus(appt.id, "completed")} disabled={busy}>
                        Complete
                      </Action>
                    )}
                    {(appt.status === "new" || appt.status === "confirmed") && (
                      <Action onClick={() => updateStatus(appt.id, "canceled")} disabled={busy} tone="rose">
                        Cancel
                      </Action>
                    )}
                    {(appt.status === "canceled" || appt.status === "completed") && (
                      <Action onClick={() => updateStatus(appt.id, "new")} disabled={busy}>
                        Reopen
                      </Action>
                    )}
                    <Action onClick={() => remove(appt.id)} disabled={busy} tone="slate">
                      Delete
                    </Action>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">
                  {filter === "upcoming" ? "No upcoming appointments. Create one to get started." : "Nothing here yet."}
                </td>
              </tr>
            )}
          </Table>
        )}
      </Card>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-lg">
            <h2 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-100">New appointment</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Title</label>
                <Input
                  required
                  maxLength={120}
                  placeholder="Consultation with Ahmed"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Notes (optional)</label>
                <textarea
                  className="input min-h-[72px]"
                  maxLength={500}
                  placeholder="Location, service, phone number…"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Date</label>
                <Input
                  type="date"
                  required
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">Start time</label>
                  <Input
                    type="time"
                    required
                    value={form.start}
                    onChange={(e) => setForm({ ...form, start: e.target.value })}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">End time</label>
                  <Input
                    type="time"
                    required
                    value={form.end}
                    onChange={(e) => setForm({ ...form, end: e.target.value })}
                  />
                </div>
              </div>
              <ErrorText>{error}</ErrorText>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setIsModalOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Create appointment"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card py-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

function Action({
  children,
  onClick,
  disabled,
  tone = "brand",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "brand" | "rose" | "slate";
}) {
  const tones = {
    brand: "text-brand-600 hover:text-brand-700 dark:text-brand-400",
    rose: "text-rose-600 hover:text-rose-700 dark:text-rose-400",
    slate: "text-slate-500 hover:text-slate-700 dark:text-slate-400",
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={"text-xs font-medium hover:underline disabled:opacity-50 " + tones[tone]}>
      {children}
    </button>
  );
}
