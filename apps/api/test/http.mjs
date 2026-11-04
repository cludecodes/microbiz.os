/** Shared fetch helpers for local integration tests (plain Node, no deps). */

import { spawn, execSync } from "node:child_process";
import process from "node:process";

let port = process.env.SMOKE_PORT || 8790;
export function setPort(p) {
  port = p;
}
export function BASE() {
  return `http://127.0.0.1:${port}`;
}

export const checks = [];
export let failures = 0;

export function check(name, cond, extra = "") {
  const pass = Boolean(cond);
  checks.push(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  ${extra}`}`);
  if (!pass) failures++;
}

export function printAndExit() {
  for (const line of checks) console.log(line);
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

export function cookieHeader(res) {
  const anyHeaders = res.headers;
  return anyHeaders.getSetCookie ? anyHeaders.getSetCookie() : [];
}

export function jarAdd(jar, res) {
  for (const line of cookieHeader(res)) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

export function jarStr(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function req(path, { method = "GET", body, jar = new Map(), csrf } = {}) {
  let res;
  // Local workerd occasionally resets an early connection while the dev
  // server settles; retry transport errors only (HTTP errors are results).
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${BASE()}/${path.replace(/^\//, "")}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(jar.size ? { Cookie: jarStr(jar) } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  jarAdd(jar, res);
  const json = res.headers.get("content-type")?.includes("application/json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, json, jar };
}

/** Register a fresh user; returns { jar, csrf, email, user, workspace }. */
export async function registerUser(tag = "") {
  const csrfRes = await retryReq(() => req("/api/auth/csrf"), 5);
  const email = `crm-${tag ? tag : "u"}-${Date.now() % 1000000}@example.com`;
  const reg = await retryReq(() =>
    req("/api/auth/register", {
      method: "POST",
      jar: csrfRes.jar,
      csrf: csrfRes.json.token,
      body: { email, password: "strong-password-1", name: "CRM Owner", locale: "en" },
    })
  );  if (reg.status !== 201) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const me = await req("/api/auth/me", { jar: reg.jar });
  return {
    jar: reg.jar,
    csrf: csrfRes.json.token,
    email,
    user: me.json.user,
    workspace: me.json.workspaces[0],
  };
}

/** Retry a request on transport errors only. */
async function retryReq(fn, times = 5) {
  let lastErr = new Error("request never completed");
  for (let i = 0; i < times; i++) {
    try {
      const res = await fn();
      return res;
    } catch (err) {
      lastErr = err;
      console.error(`[retry ${i + 1}/${times}] ${err instanceof Error ? err.message : String(err)}`);
      if (err && typeof err === "object" && "cause" in err) {
        console.error(`  cause: ${String(err.cause?.message ?? err.cause)}`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

export function clearLocalRateLimits() {
  execSync('npx wrangler d1 execute microbiz --local --command "DELETE FROM rate_limits"', {
    stdio: "ignore",
    shell: true,
    cwd: process.cwd(),
  });
}

export function bootWrangler(portNumber) {
  const isWin = process.platform === "win32";
  const child = spawn(`npx wrangler dev --port ${portNumber} --local`, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
    shell: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.stderr.on("data", (d) => process.stderr.write(`[wrangler-err] ${d}`));
  child.stdout.on("data", (d) => {
    const s = String(d);
    if (s.includes("ERROR") || s.includes("error")) process.stderr.write(`[wrangler-out] ${s}`);
  });
  const kill = () => {
    child.removeAllListeners?.();
    if (isWin) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", shell: true });
      } catch {}
    } else child.kill("SIGTERM");
  };
  process.on("exit", kill);
  child.on("exit", (code) => {
    if (code && code !== 0) process.stderr.write(`[wrangler] exited code=${code}\n`);
  });
  return kill;
}

export async function waitForHealth(base, timeoutMs = 90_000) {
  const start = Date.now();
  const ok = async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  };
  while (Date.now() - start < timeoutMs) {
    if (await ok()) {
      // Require two consecutive successes: workerd sometimes resets early
      // connections while the dev server settles.
      await new Promise((r) => setTimeout(r, 1500));
      if (await ok()) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev did not become healthy");
}
