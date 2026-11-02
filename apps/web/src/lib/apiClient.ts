/**
 * Same-origin API client. The Vite dev server proxies /api to the Worker;
 * in production the Worker (or `wrangler.toml` route) serves the API at /api.
 * Session cookies and the CSRF cookie are HttpOnly; the CSRF token travels
 * in the X-CSRF-Token header after being returned by GET /api/auth/csrf.
 */

let csrfToken: string | null = null;

async function ensureCsrf(): Promise<string> {
  const cached = csrfToken;
  if (cached) return cached;
  const res = await fetch("/api/auth/csrf");
  const data: { token: string } = await res.json();
  csrfToken = data.token;
  return data.token;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  detail?: string;
}

async function request<T>(
  path: string,
  init: RequestInit & { silent401?: boolean } = {}
): Promise<ApiResult<T>> {
  const { silent401, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (rest.method && rest.method !== "GET" && rest.method !== "HEAD") {
    headers.set("X-CSRF-Token", await ensureCsrf());
  }

  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, credentials: "same-origin" });
  } catch (err) {
    return { ok: false, status: 0, data: null, error: "network_error", detail: String(err) };
  }

  if (res.status === 403 && (await res.clone().json().catch(() => null))?.error === "CSRF token missing or invalid") {
    // One transparent retry with a fresh token (cookie rotation race).
    csrfToken = null;
    headers.set("X-CSRF-Token", await ensureCsrf());
    try {
      res = await fetch(path, { ...rest, headers, credentials: "same-origin" });
    } catch (err) {
      return { ok: false, status: 0, data: null, error: "network_error", detail: String(err) };
    }
  }

  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null;
  return {
    ok: res.ok,
    status: res.status,
    data: data as T,
    error: (data as { error?: string } | null)?.error,
    detail: (data as { detail?: string } | null)?.detail,
  };
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Domain helpers -------------------------------------------------------- */

export interface UserMe {
  id: string;
  email: string;
  name: string;
  locale: "en" | "ur";
  is_super_admin: number;
  created_at?: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  currency: "PKR" | "USD";
  locale: "en" | "ur";
  plan_id: string;
  created_at: string;
  role: string;
  plan_name: string;
  subscription_status: string | null;
  price_minor?: number;
  plan_currency?: string;
}

export interface AppRow {
  id: string;
  name: string;
  description: string;
  phase: number;
  enabled: boolean | number;
  blockReason?: string | null;
  usage?: { feature_key: string; limit: number | null };
}

export interface WorkspaceDetail {
  workspace: WorkspaceRow;
  members: { user_id: string; email: string; name: string; role: string; created_at: string }[];
  plan: { id: string; name: string; price_minor: number; currency: string; limits: string; subscription_status: string | null };
  usage: { feature_key: string; used: number }[];
}

export const auth = {
  logout: () => request("/api/auth/logout", { method: "POST", body: "{}" }),
};
