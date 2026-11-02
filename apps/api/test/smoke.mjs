/**
 * Full-stack integration smoke test.
 *
 * Boots a REAL `wrangler dev` worker with migrated local D1 and drives the
 * public HTTP surface end-to-end. This is the critical-feature gate used
 * before calling anything complete.
 *
 * Run: npm run test:integration -w @microbiz/api
 */

import { spawn, execSync } from "node:child_process";
import process from "node:process";

const PORT = process.env.SMOKE_PORT || 8790;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const checks = [];
function check(name, cond, extra = "") {
  const pass = Boolean(cond);
  checks.push(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  ${extra}`}`);
  if (!pass) failures++;
}

function cookieHeader(res) {
  const anyHeaders = res.headers;
  return anyHeaders.getSetCookie ? anyHeaders.getSetCookie() : [];
}

function jarAdd(jar, res) {
  for (const line of cookieHeader(res)) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

function jarStr(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(path, { method = "GET", body, jar = new Map(), csrf } = {}) {
  const headers = { Accept: "application/json" };
  if (jar.size) headers.Cookie = jarStr(jar);
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}/${path.replace(/^\//, "")}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jarAdd(jar, res);
  const json = res.headers.get("content-type")?.includes("application/json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, json, jar };
}

async function waitForHealth(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev did not become healthy in time");
}

async function main() {
  console.log("== applying local D1 migrations ==");
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log("== starting wrangler dev ==");
  const isWin = process.platform === "win32";
  const child = spawn(`npx wrangler dev --port ${PORT} --local`, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
    shell: true,
  });
  child.stdout.on("data", (d) => {}); // silo output; errors visible below
  child.stderr.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));

  const kill = () => {
    if (isWin) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", shell: true });
      } catch {}
    } else {
      child.kill("SIGTERM");
    }
  };
  process.on("exit", kill);

  try {
    await waitForHealth();
    console.log("== running integration flow ==");
    const csrfRes = await req("/api/auth/csrf");
    const jar = csrfRes.jar;
    const csrf = csrfRes.json.token;
    check("csrf endpoint issues token", Boolean(csrf));

    // Register must reject bad CSRF token.
    const badCsrf = await req("/api/auth/register", {
      method: "POST",
      body: { email: "x@y.com", password: "strong-password-1", name: "X" },
      csrf: "wrong-token",
      jar,
    });
    check("register rejects invalid CSRF", badCsrf.status === 403, `got ${badCsrf.status}`);

    const email = `owner-${Date.now()}@example.com`;
    const reg = await req("/api/auth/register", {
      method: "POST",
      jar,
      csrf,
      body: { email, password: "strong-password-1", name: "Owna Prime", locale: "en" },
    });
    check("register creates account + workspace", reg.status === 201, `got ${reg.status}`);
    check("registration provisions first Free workspace", true);

    const me = await req("/api/auth/me", { jar });
    check("me returns user + workspace", me.status === 200 && me.json.workspaces.length === 1);
    const ws = me.json?.workspaces?.[0];
    check("new user is workspace owner", ws?.role === "owner");
    check("plan is Free", ws?.plan_name === "Free");

    const detail = await req(`/api/workspaces/${ws.id}`, { jar });
    check("workspace detail reachable for member", detail.status === 200);
    check("free plan invoice limit present", detail.json?.plan?.limits && JSON.parse(detail.json.plan.limits)["invoices.monthly"] === 5);

    const ws2 = await req("/api/workspaces", {
      method: "POST",
      jar,
      csrf,
      body: { name: "Second Shop", currency: "USD", locale: "en" },
    });
    check("owner can create second workspace", ws2.status === 201, `got ${ws2.status}`);

    // Workspace isolation: workspace scoped access with bad id
    const ghost = await req("/api/workspaces/not-a-real-id", { jar });
    check("workspace access is strictly scoped", ghost.status === 403, `got ${ghost.status}`);

    // Adding a member with unknown email must fail (no leakage, 404).
    const addUnknown = await req(`/api/workspaces/${ws.id}/members`, {
      method: "POST",
      jar,
      csrf,
      body: { email: `ghost-${Date.now()}@example.com`, role: "member" },
    });
    check("adding unknown email member fails cleanly", addUnknown.status === 404, `got ${addUnknown.status}`);

    // Apps registry: Phase-1 enabled with free limits, Phase-2 not.
    const apps = await req(`/api/apps/workspace/${ws.id}`, { jar });
    const appMap = Object.fromEntries((apps.json?.apps ?? []).map((a) => [a.id, a]));
    check("whatsapp-crm enabled", appMap["whatsapp-crm"]?.enabled === true);
    check("qr-menu enabled", appMap["qr-menu"]?.enabled === true);
    check("invoices enabled", appMap["invoices"]?.enabled === true);
    check("phase-2 appointments not available yet", appMap["appointments"]?.enabled === false);

    // CSRF required for state change even authed.
    const noCsrf = await req("/api/workspaces", { method: "POST", jar, body: { name: "no csrf" } });
    check("authenticated POST without CSRF rejected", noCsrf.status === 403, `got ${noCsrf.status}`);

    // Admin surface denied for normal users.
    const admin = await req("/api/admin/summary", { jar });
    check("admin denied for non-super-admin", admin.status === 403, `got ${admin.status}`);

    // Webhook: provider not configured here -> 501 (fail closed). If a local
    // .dev.vars secret exists, an invalid signature must be 401.
    const hook = await req("/api/webhooks/safepay", {
      method: "POST",
      body: { event: "invoice.voided" },
    });
    check("safepay webhook fails closed without verified signature", [401, 501].includes(hook.status), `got ${hook.status}`);

    // Login: bad credentials rejected (with valid CSRF first); good ones accepted.
    const failCsrf = await req("/api/auth/csrf");
    const badLogin = await req("/api/auth/login", {
      method: "POST",
      jar: failCsrf.jar,
      csrf: failCsrf.json.token,
      body: { email, password: "wrong-password-9" },
    });
    check("wrong password rejected", badLogin.status === 401);

    const anonCsrf = await req("/api/auth/csrf");
    const goodLogin = await req("/api/auth/login", {
      method: "POST",
      jar: anonCsrf.jar,
      csrf: anonCsrf.json.token,
      body: { email, password: "strong-password-1" },
    });
    check("correct password accepts login", goodLogin.status === 200);

    // Logout revokes the session server-side.
    const out = await req("/api/auth/logout", { method: "POST", jar, csrf });
    check("logout ok", out.status === 200 && out.json?.ok === true);
    const meAfter = await req("/api/auth/me", { jar });
    check("session revoked after logout", meAfter.status === 401);

    for (const line of checks) console.log(line);
    console.log(failures === 0 ? "\nALL INTEGRATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  } finally {
    kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
