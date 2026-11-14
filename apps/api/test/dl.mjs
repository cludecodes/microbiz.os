/**
 * Digital Downloads integration test (Phase 2).
 *
 * Covers: app enablement + launcher entitlement, metered product publishing
 * (Free plan limit 2), product patch/archive, purchase creation with a
 * payment intent, token-gated delivery before/after confirmation, automatic
 * delivery through the authoritative confirm path, and the auto-minted
 * pending affiliate commission (M7 digital_sale).
 *
 * Run: node test/dl.mjs
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

const PORT = 9500 + (Date.now() % 40);
const PRICE = 100000; // minor units; 10% commission = 10000

async function registerWithTag(tag, referralCode) {
  const csrfRes = await req("/api/auth/csrf");
  const email = `dl-${tag}-${Date.now() % 1000000}@example.com`;
  const reg = await req("/api/auth/register", {
    method: "POST",
    jar: csrfRes.jar,
    csrf: csrfRes.json.token,
    body: {
      email,
      password: "strong-password-1",
      name: `DL ${tag}`,
      locale: "en",
      ...(referralCode ? { referral_code: referralCode } : {}),
    },
  });
  if (reg.status !== 201) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const me = await req("/api/auth/me", { jar: reg.jar });
  return { jar: reg.jar, csrf: csrfRes.json.token, email, user: me.json.user, workspace: me.json.workspaces[0] };
}

async function main() {
  console.log("== DL test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log(`== DL test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== DL test: running flow ==");

    // ---- setup: referrer R -> owner A (so a digital sale mints a commission) --
    const R = await registerUser("dlref");
    const codeRes = await req("api/referrals", { method: "POST", body: {}, jar: R.jar, csrf: R.csrf });
    const code = codeRes.json?.referral?.code;
    const A = await registerWithTag("owner", code);
    const wsId = A.workspace.id;
    const m = (sub, method, body) => req(`api/digital/${wsId}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    // ---- launcher entitlements ----------------------------------------------
    const anon = await req(`api/digital/${wsId}`);
    check("digital products require auth (401 anonymous)", anon.status === 401, `got ${anon.status}`);

    const launcher = await req(`api/apps/workspace/${wsId}`, { jar: A.jar, csrf: A.csrf });
    const dl = (launcher.json?.apps ?? []).find((a) => a.id === "digital-downloads");
    check("launcher lists digital-downloads as enabled", dl?.enabled === true, JSON.stringify(dl));

    const usage = await req(`api/apps/workspace/${wsId}/usage/digital-downloads`, { jar: A.jar, csrf: A.csrf });
    check("usage endpoint meters digital-downloads.monthly with Free limit 2", usage.json?.used === 0 && usage.json?.limit === 2, JSON.stringify(usage.json));

    // ---- product CRUD + metering ---------------------------------------------
    const p1 = await m("", "POST", { name: "Ebook Growth", description: "Guide", price_minor: PRICE, currency: "PKR", file_url: "https://files.example.com/ebook.pdf", delivery_note: "Thanks!" });
    check("create product returns 201", p1.status === 201 && Boolean(p1.json?.product?.id), `got ${p1.status} ${JSON.stringify(p1.json)}`);

    const bad = await m("", "POST", { name: "Freebie", price_minor: -5, currency: "PKR", file_url: "https://x.example.com/f.pdf" });
    check("non-positive price rejected (422)", bad.status === 422, `got ${bad.status}`);

    const noUrl = await m("", "POST", { name: "No file", price_minor: 1000, currency: "PKR" });
    check("missing file_url rejected (422)", noUrl.status === 422, `got ${noUrl.status}`);

    const p2 = await m("", "POST", { name: "Pack Two", price_minor: 50000, currency: "PKR", file_url: "https://files.example.com/pack.zip" });
    check("second product within Free limit (201)", p2.status === 201, `got ${p2.status}`);

    const p3 = await m("", "POST", { name: "Pack Three", price_minor: 70000, currency: "PKR", file_url: "https://files.example.com/p3.zip" });
    check("third product blocked by monthly limit (403)", p3.status === 403, `got ${p3.status} ${JSON.stringify(p3.json)}`);

    const patch = await m(`/${p1.json.product.id}`, "PATCH", { name: "Ebook Growth v2" });
    check("patch updates the product", patch.status === 200 && patch.json?.product?.name === "Ebook Growth v2", `got ${patch.status}`);

    const archive = await m(`/${p2.json.product.id}`, "DELETE");
    check("archive returns ok", archive.status === 200, `got ${archive.status}`);

    const foreign = await req(`api/digital/${A.workspace.id}`, { jar: R.jar, csrf: R.csrf });
    check("non-member of the workspace is forbidden (403)", foreign.status === 403, `got ${foreign.status}`);

    // ---- purchase + payment intent --------------------------------------------
    const purArchived = await m("/purchases", "POST", { product_id: p2.json.product.id, buyer_email: "buyer@example.com", provider: "bank" });
    check("purchase of an archived product rejected (404)", purArchived.status === 404, `got ${purArchived.status}`);

    const wrongProvider = await m("/purchases", "POST", { product_id: p1.json.product.id, buyer_email: "buyer@example.com", provider: "lemonsqueezy" });
    check("USD-only provider cannot settle PKR product (422)", wrongProvider.status === 422, `got ${wrongProvider.status}`);

    const pur = await m("/purchases", "POST", { product_id: p1.json.product.id, buyer_email: "buyer@example.com", provider: "bank" });
    if (pur.status !== 201) console.error("PURCHASE FAILED:", pur.status, JSON.stringify(pur.json));
    check("purchase created (201) with payment intent", pur.status === 201 && Boolean(pur.json?.purchase?.id) && pur.json?.purchase?.status === "awaiting_payment", `got ${pur.status} ${JSON.stringify(pur.json)}`);
    const purchaseId = pur.json.purchase.id;
    const token = pur.json.purchase.delivery_token;
    const paymentId = pur.json.payment.id;
    check("bank checkout is a manual session", Boolean(pur.json.checkout), JSON.stringify(pur.json.checkout));

    const badToken = await req(`api/public/digital/${wsId}/${purchaseId}?token=wrong-token`);
    check("delivery with wrong token is 404", badToken.status === 404, `got ${badToken.status}`);

    const locked = await req(`api/public/digital/${wsId}/${purchaseId}?token=${token}`);
    check("delivery locked until payment confirmed (403)", locked.status === 403, `got ${locked.status} ${JSON.stringify(locked.json)}`);

    // ---- confirm through the authoritative path --------------------------------
    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${A.email}'"`,
      { stdio: "ignore", shell: true }
    );

    const confirm = await req(`api/admin/payments/${paymentId}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: PRICE, reference: pur.json.payment.provider_txn_ref },
    });
    check("admin confirm succeeds", confirm.status === 200 && confirm.json?.purchase_delivered === true, `got ${confirm.status} ${JSON.stringify(confirm.json)}`);

    const list = await m("/purchases");
    const row = (list.json?.purchases ?? []).find((x) => x.id === purchaseId);
    check("purchase shows delivered with timestamps", row?.status === "delivered" && Boolean(row?.delivered_at) && Boolean(row?.paid_at), JSON.stringify(row));

    const unlocked = await req(`api/public/digital/${wsId}/${purchaseId}?token=${token}`);
    check("delivery unlocked with the correct token", unlocked.status === 200 && unlocked.json?.product?.file_url === "https://files.example.com/ebook.pdf", JSON.stringify(unlocked.json));
    check("delivery payload includes the delivery note", unlocked.json?.product?.delivery_note === "Thanks!", JSON.stringify(unlocked.json?.product));

    // Idempotency: replaying the confirm is rejected (already confirmed) and
    // must not double-deliver or re-mint the commission.
    const replay = await req(`api/admin/payments/${paymentId}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: PRICE, reference: pur.json.payment.provider_txn_ref },
    });
    check("confirm replay is rejected (409 already confirmed)", replay.status === 409, `got ${replay.status} ${JSON.stringify(replay.json)}`);

    // ---- auto-minted affiliate commission (M7 digital_sale) --------------------
    const comm = await req("api/commissions/me", { jar: R.jar, csrf: R.csrf });
    const auto = (comm.json?.commissions ?? []).find((c) => c.basis === "digital_sale");
    check("referrer has a pending digital_sale commission", Boolean(auto) && auto?.status === "pending", JSON.stringify(comm.json?.commissions));
    check("commission is 10% of the receipt", auto?.amount_minor === PRICE / 10 && auto?.currency === "PKR", JSON.stringify(auto));
    check("summary counts the pending commission", comm.json?.summary?.pending === 1, JSON.stringify(comm.json?.summary));

    const adminList = await req("api/admin/commissions?status=pending", { jar: A.jar, csrf: A.csrf });
    check("admin can filter pending commissions", adminList.status === 200 && (adminList.json?.commissions ?? []).some((c) => c.basis === "digital_sale"), JSON.stringify(adminList.json?.commissions));

    console.log("== DL test: finished checks ==");
    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
