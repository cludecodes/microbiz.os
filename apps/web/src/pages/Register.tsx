import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type UserMe } from "../lib/apiClient";
import { Button, ErrorText, Input, Logo, Select } from "../components/ui";
import { useAuth } from "../lib/authContext";

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [locale, setLocale] = useState<"en" | "ur">("en");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const busyRef = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const res = await api.post<{ user: UserMe }>("/api/auth/register", {
      name,
      email,
      password,
      locale,
    });
    if (!res.ok) {
      setError(res.detail ?? res.error ?? "Registration failed");
      setBusy(false);
      busyRef.current = false;
      return;
    }
    await refresh();
    navigate("/app");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="justify-center text-lg text-slate-900 dark:text-white" />
          <h1 className="mt-6 text-2xl font-semibold text-slate-900 dark:text-white">Create your account</h1>
          <p className="mt-1 text-sm text-slate-500">Free plan includes your first workspace</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Full name</span>
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ali Raza" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Email</span>
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Password</span>
            <Input
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="mt-1 block text-xs text-slate-400">At least 10 characters</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Language</span>
            <Select value={locale} onChange={(e) => setLocale(e.target.value as "en" | "ur")}>
              <option value="en">English</option>
              <option value="ur">اُردو (Urdu)</option>
            </Select>
          </label>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Creating account…" : "Create account"}
          </Button>
          <p className="text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link className="font-medium text-brand-600 dark:text-brand-400" to="/login">
              Log in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
