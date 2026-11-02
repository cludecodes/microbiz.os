import { useState } from "react";
import { useAuth } from "../lib/authContext";
import { Button, Card, PageTitle, Select } from "../components/ui";

export default function Settings() {
  const { user, locale, setLocale, theme, toggleTheme } = useAuth();
  const [saved, setSaved] = useState(false);

  async function onLocale(next: "en" | "ur") {
    setLocale(next);
    setSaved(true);
  }

  return (
    <div className="max-w-2xl">
      <PageTitle title="Settings" subtitle="Profile, language and appearance" />

      <div className="space-y-5">
        <Card title="Profile">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Email</dt>
              <dd className="font-medium text-slate-800 dark:text-slate-200">{user?.email}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Name</dt>
              <dd className="font-medium text-slate-800 dark:text-slate-200">{user?.name}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Language">
          <div className="flex items-center gap-3">
            <Select value={locale} onChange={(e) => onLocale(e.target.value as "en" | "ur")} className="!w-56">
              <option value="en">English (default)</option>
              <option value="ur">اُردو — Urdu (RTL)</option>
            </Select>
            {saved && <span className="text-xs text-emerald-600">Saved</span>}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Urdu switches the interface direction to right-to-left. Documentation strings remain
            English-first; Urdu translations roll out app-by-app.
          </p>
        </Card>

        <Card title="Appearance">
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={toggleTheme}>
              Switch to {theme === "dark" ? "light" : "dark"} mode
            </Button>
            <span className="text-sm text-slate-500">Currently: {theme}</span>
          </div>
        </Card>

        <Card title="Data & privacy">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-500 dark:text-slate-400">
            <li>Sessions end automatically after 30 days of inactivity; logging out revokes the token immediately.</li>
            <li>Passwords use PBKDF2-SHA-256 with per-user salt. No card data is ever stored.</li>
            <li>Workspace data is isolated per tenant; exports and deletion requests are supported via support tickets.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
