import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyLocale, translate, type AppLocale } from "./i18n";
import { api, auth as authApi, type UserMe, type WorkspaceRow } from "./apiClient";

type Theme = "light" | "dark";

interface AuthState {
  user: UserMe | null;
  workspaces: WorkspaceRow[];
  loading: boolean;
  locale: AppLocale;
  t: (key: string) => string;
  setLocale: (lang: AppLocale) => void;
  theme: Theme;
  toggleTheme: () => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function readLocale(user: UserMe | null): AppLocale {
  const stored = localStorage.getItem("mb_locale");
  if (stored === "en" || stored === "ur") return stored;
  if (user?.locale === "ur") return "ur";
  return "en";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserMe | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [locale, setLocaleState] = useState<AppLocale>(() => readLocale(null));
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem("mb_theme") as Theme) ??
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("mb_theme", theme);
  }, [theme]);

  useEffect(() => {
    applyLocale(locale);
    localStorage.setItem("mb_locale", locale);
  }, [locale]);

  const refresh = useCallback(async () => {
    const res = await api.get<{ user: UserMe; workspaces: WorkspaceRow[] }>("/api/auth/me");
    if (res.ok && res.data) {
      setUser(res.data.user);
      setWorkspaces(res.data.workspaces);
      setLocaleState(readLocale(res.data.user));
    } else if (res.status === 401) {
      setUser(null);
      setWorkspaces([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setWorkspaces([]);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      workspaces,
      loading,
      locale,
      t: (key: string) => translate(locale, key),
      setLocale: setLocaleState,
      theme,
      toggleTheme: () => setTheme((th) => (th === "dark" ? "light" : "dark")),
      refresh,
      logout,
    }),
    [user, workspaces, loading, locale, theme, refresh, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
