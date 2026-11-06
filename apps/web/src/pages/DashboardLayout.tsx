import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Badge, Logo, cx } from "../components/ui";
import { useAuth } from "../lib/authContext";

const NAV = [
  { to: "/app", labelKey: "nav.dashboard", end: true, icon: "🏠" },
  { to: "/app/apps", labelKey: "nav.apps", icon: "🧩" },
  { to: "/app/workspaces", labelKey: "nav.workspaces", icon: "🏬" },
  { to: "/app/billing", labelKey: "nav.billing", icon: "💳" },
  { to: "/app/settings", labelKey: "nav.settings", icon: "⚙️" },
];

export default function DashboardLayout() {
  const { user, workspaces, t, theme, toggleTheme, logout, locale, setLocale } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden dark:border-slate-800 dark:bg-slate-900">
        <Logo className="text-slate-900 dark:text-white" />
        <button onClick={toggleTheme} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Toggle theme">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      <div className="flex">
        {/* Sidebar: mobile bottom nav + desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4 md:flex dark:border-slate-800 dark:bg-slate-900">
          <div className="px-2 pb-4">
            <Logo className="text-slate-900 dark:text-white" />
          </div>

          <div className="mb-2 px-2">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Active workspace</p>
            <WorkspaceSwitcher />
          </div>

          <nav className="flex-1 space-y-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                    isActive
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                  )
                }
              >
                <span aria-hidden>{item.icon}</span>
                {t(item.labelKey)}
              </NavLink>
            ))}
            {user?.is_super_admin === 1 && (
              <NavLink
                to="/app/admin"
                className={({ isActive }) =>
                  cx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                    isActive ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30" : "text-amber-600 hover:bg-amber-50 dark:text-amber-400"
                  )
                }
              >
                🛡 {t("nav.admin")}
              </NavLink>
            )}
          </nav>

          <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <div className="flex items-center justify-between px-2 text-sm">
              <span className="truncate text-slate-500 dark:text-slate-400">{user?.email}</span>
              <div className="flex gap-1">
                <button
                  onClick={toggleTheme}
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="Toggle theme"
                >
                  {theme === "dark" ? "☀️" : "🌙"}
                </button>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as "en" | "ur")}
                  className="rounded-lg border border-slate-200 bg-transparent px-1 py-1 text-xs dark:border-slate-700"
                  aria-label="Language"
                >
                  <option value="en">EN</option>
                  <option value="ur">اردو</option>
                </select>
              </div>
            </div>
            <button
              onClick={async () => {
                await logout();
                navigate("/");
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/20"
            >
              {t("nav.logout")}
            </button>
          </div>
        </aside>

        {/* Mobile bottom navigation */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex justify-around border-t border-slate-200 bg-white py-2 md:hidden dark:border-slate-800 dark:bg-slate-900">
          {NAV.slice(0, 4).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx("flex flex-col items-center px-3 py-1 text-[11px]", isActive ? "text-brand-600" : "text-slate-500")
              }
            >
              <span aria-hidden className="text-lg">
                {item.icon}
              </span>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>

        <main className="min-w-0 flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function WorkspaceSwitcher() {
  const { workspaces } = useAuth();
  const active = workspaces[0];
  if (!active) return null;
  return (
    <div>
      <Link
        to={`/app/workspaces/${active.id}`}
        className="block rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <span className="block truncate font-medium text-slate-800 dark:text-slate-200">{active.name}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
          {active.plan_name}
          <Badge tone={active.subscription_status === "active" ? "green" : "amber"}>{active.currency}</Badge>
        </span>
      </Link>
    </div>
  );
}
