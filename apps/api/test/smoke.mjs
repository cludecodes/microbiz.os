/**
 * Full-stack integration smoke test — platform/auth surface.
 * Boots a REAL `wrangler dev` worker with migrated local D1 and exercises
 * the public HTTP surface end-to-end.
 *
 * Run: node test/smoke.mjs   (also part of `npm test -w @microbiz/api`)
 */

import { execSync } from "node:child_process";
import process from "node:process";
import {
  req,
  check,
  registerUser,
  setPort,
  BASE,
  clearLocalRateLimits,
  bootWrangler,
  waitForHealth,
  printAndExit,
} from "./http.mjs";

async function main() {
  console.log("== smoke test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log("== smoke test: starting wrangler dev ==");
  const kill = bootWrangler(8790);
  try {
    await waitForHealth(BASE());
    console.log("== smoke test: running flow ==");

    const health = await req("api/health");
    check("health ok", health.status === 200);

    const ready = await req("api/ready");
    check("readiness incl D1", ready.status === 200 && ready.json?.status === "ready");

    const apps = await req("api/apps");
    const ids = (apps.json?.apps ?? []).map((a) => a.id);
    check("apps seeded (phase 1 + phase 2/3 registry)", ids.includes("whatsapp-crm") && ids.includes("appointments"));

    // Register rejects bad CSRF.
    const bad = await req("api/auth/register", {
      method: "POST",
      body: { email: "x@example.com", password: "strong-password-1", name: "X" },
      csrf: "wrong-token",
    });
    check("register rejects invalid CSRF", bad.status === 403, `got ${bad.status}`);

    // Register creates user + auto workspace.
    const user = await registerUser("smoke");
    check("register creates account + workspace", Boolean(user.workspace));

    const me = await req("api/auth/me", { jar: user.jar });
    check("me returns owned workspace", me.status === 200 && me.json.workspaces.length === 1);
    check("new user is workspace owner", me.json.workspaces[0]?.role === "owner");
    check("plan is Free", me.json.workspaces[0]?.plan_name === "Free");

    const wsId = user.workspace.id;
    const detail = await req(`api/workspaces/${wsId}`, { jar: user.jar });
    check("workspace detail reachable for member", detail.status === 200);
    check(
      "free plan invoice limit present",
      detail.json?.plan?.limits && JSON.parse(detail.json.plan.limits)["invoices.monthly"] === 5
    );

    const ws2 = await req("api/workspaces", {
      method: "POST",
      jar: user.jar,
      csrf: user.csrf,
      body: { name: "Second Shop", currency: "USD", locale: "en" },
    });
    check("owner can create second workspace", ws2.status === 201, `got ${ws2.status}`);

    const ghost = await req("api/workspaces/not-a-real-id", { jar: user.jar });
    check("workspace access is strictly scoped", ghost.status === 403, `got ${ghost.status}`);

    const addUnknown = await req(`api/workspaces/${wsId}/members`, {
      method: "POST",
      jar: user.jar,
      csrf: user.csrf,
      body: { email: `ghost-${Date.now()}@example.com`, role: "member" },
    });
    check("adding unknown email member fails cleanly", addUnknown.status === 404, `got ${addUnknown.status}`);

    const wsApps = await req(`api/apps/workspace/${wsId}`, { jar: user.jar });
    const appMap = Object.fromEntries((wsApps.json?.apps ?? []).map((a) => [a.id, a]));
    check("whatsapp-crm enabled", appMap["whatsapp-crm"]?.enabled === true);
    check("qr-menu enabled", appMap["qr-menu"]?.enabled === true);
    check("invoices enabled", appMap["invoices"]?.enabled === true);
    check("phase-2 appointments not available yet", appMap["appointments"]?.enabled === false);

    const noCsrf = await req("api/workspaces", { method: "POST", jar: user.jar, body: { name: "no csrf" } });
    check("authenticated POST without CSRF rejected", noCsrf.status === 403, `got ${noCsrf.status}`);

    const admin = await req("api/admin/summary", { jar: user.jar });
    check("admin denied for non-super-admin", admin.status === 403, `got ${admin.status}`);

    const hook = await req("api/webhooks/safepay", {
      method: "POST",
      body: { event: "invoice.voided" },
    });
    check("safepay webhook fails closed without verified signature", [401, 501].includes(hook.status), `got ${hook.status}`);

    // Wrong password rejected (with valid CSRF).
    const failCsrf = await req("api/auth/csrf");
    const badLogin = await req("api/auth/login", {
      method: "POST",
      jar: failCsrf.jar,
      csrf: failCsrf.json.token,
      body: { email: user.email, password: "wrong-password-9" },
    });
    check("wrong password rejected", badLogin.status === 401);

    const goodLogin = await req("api/auth/login", {
      method: "POST",
      jar: failCsrf.jar,
      csrf: failCsrf.json.token,
      body: { email: user.email, password: "strong-password-1" },
    });
    check("correct password accepts login", goodLogin.status === 200);

    const out = await req("api/auth/logout", { method: "POST", jar: user.jar, csrf: user.csrf });
    check("logout ok", out.status === 200 && out.json?.ok === true);
    const meAfter = await req("api/auth/me", { jar: user.jar });
    check("session revoked after logout", meAfter.status === 401);

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
