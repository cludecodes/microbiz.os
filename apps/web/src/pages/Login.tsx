import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, type UserMe, type WorkspaceRow } from "../lib/apiClient";
import { Button, ErrorText, Input, Logo } from "../components/ui";
import { useAuth } from "../lib/authContext";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.post<{ user: UserMe }>("/api/auth/login", { email, password });
    if (!res.ok) {
      setError(res.error === "Invalid email or password" ? "Invalid email or password" : (res.error ?? "Login failed"));
      setBusy(false);
      return;
    }
    await refresh();
    const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
    navigate(from && from.startsWith("/app") ? from : "/app");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="justify-center text-lg text-slate-900 dark:text-white" />
          <h1 className="mt-6 text-2xl font-semibold text-slate-900 dark:text-white">Welcome back</h1>
          <p className="mt-1 text-sm text-slate-500">Log in to your unified MicroBiz account</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Email</span>
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Password</span>
            <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Signing in…" : "Log in"}
          </Button>
          <p className="text-center text-sm text-slate-500">
            Need an account?{" "}
            <Link className="font-medium text-brand-600 dark:text-brand-400" to="/register">
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
