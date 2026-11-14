/**
 * M7 integration test: referrals & affiliate commissions.
 *
 * Covers: code creation, launcher entitlement, registration conversion
 * (best-effort), code reuse/invalid code handling, ownership rules for
 * commission creation, and the admin approve → pay lifecycle.
 *
 * Run: node test/m7.mjs
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

const PORT = 9400 + (Date.now() % 40);

/** Register with an optional referral code; returns { jar, csrf, email, user }. */
async function registerWithTag(tag, referralCode) {
  const csrfRes = await req("/api/auth/csrf");
  const email = `m7-${tag}-${Date.now() % 1000000}@example.com`;
  const reg = await req("/api/auth/register", {
    method: "POST",
    jar: csrfRes.jar,
    csrf: csrfRes.json.token,
    body: {
      email,
      password: "strong-password-1",
      name: `M7 ${tag}`,
      locale: "en",
      ...(referralCode ? { referral_code: referralCode } : {}),
    },
  });
  return { reg, email, jar: reg.jar, csrf: csrfRes.json.token };
}

async function main() {
  console.log("== M7 test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log(`== M7 test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== M7 test: running flow ==");

    // ---- setup: referrer + code -------------------------------------------------
    const A = await registerUser("m7ref");
    const wsId = A.workspace.id;

    const anonMe = await req("api/referrals/me");
    check("referrals require auth (401 anonymous)", anonMe.status === 401, `got ${anonMe.status}`);

    // Launcher shows the referrals app enabled for the workspace.
    const launcher = await req(`api/apps/workspace/${wsId}`, { jar: A.jar, csrf: A.csrf });
    const referralsApp = (launcher.json?.apps ?? []).find((a) => a.id === "referrals");
    check("launcher lists referrals app as enabled", referralsApp?.enabled === true, JSON.stringify(referralsApp));
    check("referrals feature key present with unlimited allowance", referralsApp?.usage?.feature_key === "referrals.general" && referralsApp?.usage?.limit === null, JSON.stringify(referralsApp?.usage));

    const created = await req("api/referrals", { method: "POST", body: {}, jar: A.jar, csrf: A.csrf });
    check("create referral code returns 201", created.status === 201, `got ${created.status} ${JSON.stringify(created.json)}`);
    const code = created.json?.referral?.code;
    check("referral code uses MBC- format", typeof code === "string" && /^MBC-[A-Z0-9]{6}$/.test(code), `got ${code}`);

    const meBefore = await req("api/referrals/me", { jar: A.jar, csrf: A.csrf });
    check("referrals/me lists the new code", meBefore.status === 200 && meBefore.json?.referrals?.length === 1, `got ${meBefore.status}`);
    check("stats start at zero conversions", meBefore.json?.stats?.total === 1 && meBefore.json?.stats?.converted === 0, JSON.stringify(meBefore.json?.stats));

    // ---- conversion at registration ---------------------------------------------
    const B = await registerWithTag("buddy", code);
    check("registration with referral code returns 201", B.reg.status === 201, `got ${B.reg.status} ${JSON.stringify(B.reg.json)}`);

    const meAfter = await req("api/referrals/me", { jar: A.jar, csrf: A.csrf });
    check("referral converted after registration", meAfter.json?.stats?.converted === 1, JSON.stringify(meAfter.json?.stats));
    const convertedRow = (meAfter.json?.referrals ?? []).find((r) => r.code === code);
    check("converted referral shows the referred user's email", convertedRow?.referred_email === B.email && Boolean(convertedRow?.converted_at), JSON.stringify(convertedRow));

    // ---- reuse + invalid codes never block registration --------------------------
    const C = await registerWithTag("reuse", code);
    check("registering with an already-converted code still succeeds (201)", C.reg.status === 201, `got ${C.reg.status}`);

    const D = await registerWithTag("bogus", "MBC-ZZZZZZ");
    check("registering with an unknown code still succeeds (201)", D.reg.status === 201, `got ${D.reg.status} ${JSON.stringify(D.reg.json)}`);

    const lower = await registerWithTag("lower", code.toLowerCase());
    check("lowercase referral code is normalized and accepted", lower.reg.status === 201, `got ${lower.reg.status}`);

    const meEnd = await req("api/referrals/me", { jar: A.jar, csrf: A.csrf });
    check("conversions stay at exactly one", meEnd.json?.stats?.converted === 1, JSON.stringify(meEnd.json?.stats));

    // ---- commission ownership rules ---------------------------------------------
    const noAuth = await req("api/commissions/me");
    check("commissions require auth (401 anonymous)", noAuth.status === 401, `got ${noAuth.status}`);

    // CSRF middleware rejects the unauthenticated POST before auth runs.
    const anonCreate = await req("api/commissions", { method: "POST", body: { referral_id: convertedRow.id, basis: "subscription", basis_id: "sub-1", currency: "PKR", amount_minor: 5000 } });
    check("commission creation blocked for anonymous (403 CSRF)", anonCreate.status === 403, `got ${anonCreate.status}`);

    // B (the referred user, not the referrer) cannot record commissions on A's referral.
    const notOwner = await req("api/commissions", {
      method: "POST",
      body: { referral_id: convertedRow.id, basis: "subscription", basis_id: "sub-1", currency: "PKR", amount_minor: 5000 },
      jar: B.jar,
      csrf: B.csrf,
    });
    check("non-owner cannot create a commission (403)", notOwner.status === 403, `got ${notOwner.status} ${JSON.stringify(notOwner.json)}`);

    const badPayload = await req("api/commissions", {
      method: "POST",
      body: { referral_id: convertedRow.id, basis: "widgets", basis_id: "x", currency: "PKR", amount_minor: 5000 },
      jar: A.jar,
      csrf: A.csrf,
    });
    check("invalid commission basis rejected (422)", badPayload.status === 422, `got ${badPayload.status}`);

    // A records a commission on their own referral (admin lifecycle).
    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${A.email}'"`,
      { stdio: "ignore", shell: true }
    );

    const mk = await req("api/admin/commissions", {
      method: "POST",
      body: { referral_id: convertedRow.id, basis: "subscription", basis_id: `sub-${Date.now()}`, currency: "PKR", amount_minor: 50000 },
      jar: A.jar,
      csrf: A.csrf,
    });
    check("admin commission creation returns 201", mk.status === 201, `got ${mk.status} ${JSON.stringify(mk.json)}`);
    const commissionId = mk.json?.commission?.id;

    const mine = await req("api/commissions/me", { jar: A.jar, csrf: A.csrf });
    check("referrer sees their commission in /commissions/me", mine.status === 200 && (mine.json?.commissions ?? []).some((c) => c.id === commissionId), `got ${mine.status}`);
    check("summary counts one pending commission", mine.json?.summary?.count === 1 && mine.json?.summary?.pending === 1 && mine.json?.summary?.paid === 0, JSON.stringify(mine.json?.summary));

    // Non-admin cannot use the admin lifecycle.
    const guestApprove = await req(`api/admin/commissions/${commissionId}/approval`, { method: "POST", jar: B.jar, csrf: B.csrf });
    check("admin approval requires super admin (403)", guestApprove.status === 403, `got ${guestApprove.status}`);

    const payBeforeApprove = await req(`api/admin/commissions/${commissionId}/pay`, { method: "POST", jar: A.jar, csrf: A.csrf });
    check("paying a pending commission is rejected (409)", payBeforeApprove.status === 409, `got ${payBeforeApprove.status}`);

    const approve = await req(`api/admin/commissions/${commissionId}/approval`, { method: "POST", jar: A.jar, csrf: A.csrf });
    check("approve moves commission to approved", approve.status === 200 && approve.json?.status === "approved", `got ${approve.status}`);

    const doubleApprove = await req(`api/admin/commissions/${commissionId}/approval`, { method: "POST", jar: A.jar, csrf: A.csrf });
    check("re-approving is rejected (409)", doubleApprove.status === 409, `got ${doubleApprove.status}`);

    const pay = await req(`api/admin/commissions/${commissionId}/pay`, { method: "POST", jar: A.jar, csrf: A.csrf });
    check("pay moves commission to paid", pay.status === 200 && pay.json?.status === "paid", `got ${pay.status}`);

    const minePaid = await req("api/commissions/me", { jar: A.jar, csrf: A.csrf });
    check("summary reflects the paid commission", minePaid.json?.summary?.paid === 1 && minePaid.json?.summary?.pending === 0 && minePaid.json?.summary?.approved === 0, JSON.stringify(minePaid.json?.summary));

    // Void path on a fresh commission.
    const mk2 = await req("api/admin/commissions", {
      method: "POST",
      body: { referral_id: convertedRow.id, basis: "lead_sale", basis_id: `lead-${Date.now()}`, currency: "PKR", amount_minor: 12000 },
      jar: A.jar,
      csrf: A.csrf,
    });
    const voidRes = await req(`api/admin/commissions/${mk2.json?.commission?.id}/void`, { method: "POST", jar: A.jar, csrf: A.csrf });
    check("void moves commission to void", voidRes.status === 200 && voidRes.json?.status === "void", `got ${voidRes.status}`);

    const adminList = await req("api/admin/commissions", { jar: A.jar, csrf: A.csrf });
    check("admin commission list includes both entries", adminList.status === 200 && (adminList.json?.commissions ?? []).length >= 2, `got ${adminList.status}`);

    console.log("== M7 test: finished checks ==");
    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
