/**
 * M5a integration test: plans, checkout intents, verified webhook confirmation,
 * manual bank reconciliation, plan activation, ledger postings, downgrades.
 *
 * Runs against a real `wrangler dev` with sandbox provider vars injected by
 * bootWrangler() (see TEST_PROVIDER_VARS in http.mjs).
 *
 * Run: node test/billing.mjs
 */

import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
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
  TEST_PROVIDER_VARS,
} from "./http.mjs";

const PORT = 9100 + (Date.now() % 40);

function sign(raw, secret) {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

async function postRaw(path, rawBody, headers = {}) {
  const res = await fetch(`${BASE()}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function safepayEvent({ id, reference, amount_minor, currency = "PKR", status = "succeeded", fee_minor = 0 }) {
  return JSON.stringify({
    id,
    event: `payment.${status}`,
    data: { reference, tracker: `trk_${id}`, amount_minor, currency, fee_minor, status },
  });
}

function lemonEvent({ id, reference, total, currency = "USD", event = "order_created", status = "paid" }) {
  return JSON.stringify({
    meta: { event_id: id, event_name: event, custom_data: { reference } },
    data: { id: `order_${id}`, type: "orders", attributes: { total, currency, status, identifier: reference } },
  });
}

async function main() {
  console.log("== billing test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "ignore", shell: true });

  console.log(`== billing test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== billing test: running flow ==");

    const A = await registerUser("bill");
    const wsPkr = A.workspace.id;
    const wsBase = `api/billing/workspace/${wsPkr}`;
    const m = (path, method, body) => req(`${wsBase}${path}`, { method, body, jar: A.jar, csrf: A.csrf });

    // ---- plan catalog -----------------------------------------------------
    const plans = await req("api/billing/plans");
    const planIds = (plans.json?.plans ?? []).map((p) => p.id);
    check("public plan catalog lists PKR + USD plans", plans.status === 200 && planIds.includes("starter") && planIds.includes("starter-usd"), JSON.stringify(planIds));
    check("plan prices are configuration (no invented revenue)", plans.json?.plans?.every((p) => typeof p.price_minor === "number"));
    check("provider capabilities published (hosted + manual)", (plans.json?.providers ?? []).some((p) => p.mode === "hosted") && (plans.json?.providers ?? []).some((p) => p.mode === "manual"));

    // ---- workspace billing view ------------------------------------------
    const bill = await m("", "GET");
    check("owner sees billing summary", bill.status === 200 && bill.json?.subscription?.plan_id === "free", `got ${bill.status}`);
    check("only workspace-currency plans offered", (bill.json?.plans ?? []).every((p) => p.currency === "PKR"));
    check("owner can manage billing", bill.json?.can_manage_billing === true);
    check("test webhook secrets are configured", (bill.json?.providers ?? []).find((p) => p.id === "safepay")?.configured === true);

    const anon = await req(`${wsBase}`);
    check("billing view requires auth (401)", anon.status === 401, `got ${anon.status}`);

    // ---- checkout validation ---------------------------------------------
    const wrongCurrency = await m("/checkout", "POST", { plan_id: "starter-usd", provider: "safepay" });
    check("workspace-currency mismatch rejected (422)", wrongCurrency.status === 422, `got ${wrongCurrency.status}`);
    const freeCheckout = await m("/checkout", "POST", { plan_id: "free", provider: "bank" });
    check("checkout on Free plan rejected (409)", freeCheckout.status === 409, `got ${freeCheckout.status}`);
    const payoneerPkr = await m("/checkout", "POST", { plan_id: "starter", provider: "payoneer" });
    check("provider/currency mismatch rejected (422)", payoneerPkr.status === 422, `got ${payoneerPkr.status}`);

    // ---- manual bank checkout + idempotency ------------------------------
    const key = `idem-${Date.now()}`;
    const bank = await m("/checkout", "POST", { plan_id: "starter", provider: "bank", idempotency_key: key });
    check("bank checkout creates a pending intent (201)", bank.status === 201, `got ${bank.status} ${JSON.stringify(bank.json)}`);
    const bankPay = bank.json?.payment;
    check("manual checkout carries a transfer reference", bank.json?.checkout?.mode === "manual" && /^MB-[A-Z0-9]{10}$/.test(bankPay?.provider_txn_ref ?? ""), bankPay?.provider_txn_ref);
    check("payment starts awaiting_confirmation", bankPay?.status === "awaiting_confirmation");
    check("amount equals plan price in minor units", bankPay?.amount_minor === 150000, `got ${bankPay?.amount_minor}`);

    const replay = await m("/checkout", "POST", { plan_id: "starter", provider: "bank", idempotency_key: key });
    check("idempotency key replays the same payment", replay.status === 200 && replay.json?.payment?.id === bankPay?.id && replay.json?.replayed === true, `got ${replay.status}`);

    const status = await m(`/payments/${bankPay?.id}`, "GET");
    check("payment status readable by member", status.status === 200 && status.json?.payment?.status === "awaiting_confirmation");

    // ---- hosted checkout (safepay) ---------------------------------------
    const hosted = await m("/checkout", "POST", { plan_id: "starter", provider: "safepay" });
    check("hosted checkout returns a sandbox URL (201)", hosted.status === 201, `got ${hosted.status}`);
    const hostedPay = hosted.json?.payment;
    const hostedUrl = hosted.json?.checkout?.redirectUrl ?? "";
    check("hosted URL includes our reference", hostedUrl.includes(hostedPay?.provider_txn_ref ?? "no-ref"), hostedUrl);
    check("hosted URL is the configured sandbox link", hostedUrl.startsWith("https://sandbox.getsafepay.example/"));

    // ---- webhook security -------------------------------------------------
    const missingSig = await postRaw("api/webhooks/safepay", safepayEvent({ id: "evt-nosig", reference: hostedPay.provider_txn_ref, amount_minor: 150000 }));
    check("webhook without signature rejected (401)", missingSig.status === 401, `got ${missingSig.status}`);

    const badRaw = safepayEvent({ id: "evt-badsig", reference: hostedPay.provider_txn_ref, amount_minor: 150000 });
    const badSig = await postRaw("api/webhooks/safepay", badRaw, { "X-SFPY-Signature": "deadbeef" });
    check("webhook with invalid signature rejected (401)", badSig.status === 401, `got ${badSig.status}`);

    const unknownRaw = safepayEvent({ id: `evt-unknown-${Date.now()}`, reference: "MB-NOTOURS0000", amount_minor: 150000 });
    const unknown = await postRaw("api/webhooks/safepay", unknownRaw, {
      "X-SFPY-Signature": sign(unknownRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("verified event with unknown reference is recorded, never creates a payment (202)", unknown.status === 202 && unknown.json?.matched === false, `got ${unknown.status}`);

    const mismatchRaw = safepayEvent({ id: `evt-amt-${Date.now()}`, reference: hostedPay.provider_txn_ref, amount_minor: 999 });
    const mismatch = await postRaw("api/webhooks/safepay", mismatchRaw, {
      "X-SFPY-Signature": sign(mismatchRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("amount mismatch refuses confirmation (409)", mismatch.status === 409 && mismatch.json?.error === "amount_mismatch", `got ${mismatch.status} ${JSON.stringify(mismatch.json)}`);

    const wrongCurRaw = safepayEvent({ id: `evt-cur-${Date.now()}`, reference: hostedPay.provider_txn_ref, amount_minor: 150000, currency: "USD" });
    const wrongCur = await postRaw("api/webhooks/safepay", wrongCurRaw, {
      "X-SFPY-Signature": sign(wrongCurRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("currency mismatch refuses confirmation (409)", wrongCur.status === 409 && wrongCur.json?.error === "currency_mismatch", `got ${wrongCur.status}`);

    const stillPending = await m(`/payments/${hostedPay.id}`, "GET");
    check("payment stays pending after mismatched events", stillPending.json?.payment?.status === "awaiting_confirmation");

    // ---- verified confirmation + plan activation + ledger -----------------
    const goodRaw = safepayEvent({
      id: `evt-ok-${Date.now()}`,
      reference: hostedPay.provider_txn_ref,
      amount_minor: 150000,
      fee_minor: 30000,
    });
    const good = await postRaw("api/webhooks/safepay", goodRaw, {
      "X-SFPY-Signature": sign(goodRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("verified webhook confirms payment (200)", good.status === 200 && good.json?.confirmed === true, `got ${good.status} ${JSON.stringify(good.json)}`);
    check("confirmed payment activates the paid plan", good.json?.plan_activated === "starter", `got ${good.json?.plan_activated}`);
    check("confirmation posts exactly one ledger journal", typeof good.json?.journal_id === "string" && good.json.journal_id.length > 0);

    const afterUpgrade = await m("", "GET");
    check("subscription now on Starter", afterUpgrade.json?.subscription?.plan_id === "starter");
    check("billing period recorded", Boolean(afterUpgrade.json?.subscription?.current_period_end));
    check("payment history shows the confirmed receipt", afterUpgrade.json?.payments?.some((p) => p.id === hostedPay.id && p.status === "confirmed" && p.fee_minor === 30000));

    const wsDetail = await req(`api/workspaces/${wsPkr}`, { jar: A.jar });
    check("entitlements follow the paid plan", JSON.parse(wsDetail.json?.plan?.limits ?? "{}")["invoices.monthly"] === 100);

    const dupRaw = goodRaw;
    const dup = await postRaw("api/webhooks/safepay", dupRaw, {
      "X-SFPY-Signature": sign(dupRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("duplicate event id acknowledged without reprocessing", dup.status === 200 && dup.json?.duplicate === true, `got ${dup.status}`);

    const replayRaw = safepayEvent({
      id: `evt-replay-${Date.now()}`,
      reference: hostedPay.provider_txn_ref,
      amount_minor: 150000,
      fee_minor: 30000,
    });
    const replayHook = await postRaw("api/webhooks/safepay", replayRaw, {
      "X-SFPY-Signature": sign(replayRaw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("new event id for a confirmed payment does not double-post", replayHook.status === 200 && replayHook.json?.already_confirmed === true, `got ${replayHook.status} ${JSON.stringify(replayHook.json)}`);

    // ---- member RBAC after upgrade ---------------------------------------
    const B = await registerUser("billguest");
    const addB = await req(`api/workspaces/${wsPkr}/members`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { email: B.email, role: "member" },
    });
    check("member added after upgrade (team limit raised)", addB.status === 201, `got ${addB.status}`);

    const bCheckout = await req(`${wsBase}/checkout`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { plan_id: "pro", provider: "bank" },
    });
    check("non-owner member cannot start checkout (403)", bCheckout.status === 403, `got ${bCheckout.status}`);
    const bDowngrade = await req(`${wsBase}/downgrade`, { method: "POST", jar: B.jar, csrf: B.csrf, body: {} });
    check("non-owner member cannot downgrade (403)", bDowngrade.status === 403, `got ${bDowngrade.status}`);
    const bBill = await req(wsBase, { jar: B.jar });
    check("member can still read billing status", bBill.status === 200 && bBill.json?.can_manage_billing === false);

    const stranger = await req(wsBase, { jar: B.jar });
    check("member sees the same subscription plan", stranger.json?.subscription?.plan_id === "starter");

    // ---- admin gating + promotion ----------------------------------------
    const adminDenied = await req("api/admin/payments", { jar: A.jar });
    check("non-admin cannot list platform payments (403)", adminDenied.status === 403, `got ${adminDenied.status}`);

    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${A.email}'"`,
      { stdio: "ignore", shell: true }
    );
    const adminPayments = await req("api/admin/payments", { jar: A.jar });
    check("promoted admin can list payments", adminPayments.status === 200 && (adminPayments.json?.payments ?? []).length >= 2, `got ${adminPayments.status}`);

    const adminPlans = await req("api/admin/plans", { jar: A.jar });
    check("admin plan catalog reachable", adminPlans.status === 200 && (adminPlans.json?.plans ?? []).some((p) => p.id === "starter"));

    // ---- ledger integrity -------------------------------------------------
    const ledger = await req(`api/admin/ledger?workspace_id=${wsPkr}`, { jar: A.jar });
    const journal = (ledger.json?.journals ?? []).find((j) => j.ref_id === hostedPay.id);
    check("ledger journal stored for the confirmed payment", Boolean(journal));
    const debits = (journal?.postings ?? []).filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount_minor, 0);
    const credits = (journal?.postings ?? []).filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount_minor, 0);
    check("journal balances (debits == credits)", debits === credits && debits === 150000, `debits=${debits} credits=${credits}`);
    const accounts = (journal?.postings ?? []).map((p) => p.account).sort();
    check("fee accounted separately from net available balance", accounts.includes("processing_fees") && accounts.includes("available_balance") && accounts.includes("gross_receipts"), JSON.stringify(accounts));
    const gross = (ledger.json?.totals ?? []).find((t) => t.account === "gross_receipts" && t.currency === "PKR");
    check("ledger totals count confirmed receipts only", gross?.credit_minor === 150000, JSON.stringify(gross));

    // ---- hosted provider cannot be admin-confirmed -----------------------
    const hostedPro = await m("/checkout", "POST", { plan_id: "pro", provider: "safepay" });
    check("second hosted checkout created", hostedPro.status === 201, `got ${hostedPro.status}`);
    const adminConfirmHosted = await req(`api/admin/payments/${hostedPro.json?.payment?.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 450000 },
    });
    check("admin cannot confirm a hosted payment manually (409)", adminConfirmHosted.status === 409, `got ${adminConfirmHosted.status}`);

    // ---- manual bank reconciliation to Pro -------------------------------
    const bankPro = await m("/checkout", "POST", { plan_id: "pro", provider: "bank" });
    check("bank checkout for Pro created", bankPro.status === 201, `got ${bankPro.status}`);
    const bankProPay = bankPro.json?.payment;

    const wrongAmount = await req(`api/admin/payments/${bankProPay.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 1000, reference: bankProPay.provider_txn_ref },
    });
    check("reconciliation rejects the wrong amount (409)", wrongAmount.status === 409, `got ${wrongAmount.status}`);

    const paidBank = await req(`api/admin/payments/${bankProPay.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 450000, reference: bankProPay.provider_txn_ref },
    });
    check("admin confirms a real bank receipt (200)", paidBank.status === 200 && paidBank.json?.plan_activated === "pro", `got ${paidBank.status} ${JSON.stringify(paidBank.json)}`);
    check("bank receipt marked settled immediately", paidBank.json?.settlement_status === "settled");

    const subs = await req("api/admin/subscriptions", { jar: A.jar });
    const subRow = (subs.json?.subscriptions ?? []).find((s) => s.workspace_id === wsPkr);
    check("admin subscription view shows Pro", subRow?.plan_id === "pro", JSON.stringify(subRow));
    check("subscription provider recorded as bank", subRow?.provider === "bank");

    const bankLedger = await req(`api/admin/ledger?workspace_id=${wsPkr}`, { jar: A.jar });
    const bankJournal = (bankLedger.json?.journals ?? []).find((j) => j.ref_id === bankProPay.id);
    const bankAccounts = (bankJournal?.postings ?? []).map((p) => p.account).sort();
    check("bank receipt posts directly into settled_bank", bankAccounts.includes("settled_bank") && !bankAccounts.includes("available_balance"), JSON.stringify(bankAccounts));

    // ---- downgrade --------------------------------------------------------
    const down = await m("/downgrade", "POST", {});
    check("owner downgrades to Free", down.status === 200 && down.json?.plan_id === "free", `got ${down.status}`);
    const afterDown = await req(`api/workspaces/${wsPkr}`, { jar: A.jar });
    check("entitlements revert to Free limits", JSON.parse(afterDown.json?.plan?.limits ?? "{}")["invoices.monthly"] === 5);
    const doubleDown = await m("/downgrade", "POST", {});
    check("already-Free downgrade rejected (409)", doubleDown.status === 409, `got ${doubleDown.status}`);

    // ---- USD workspace + Lemon Squeezy -----------------------------------
    const usd = await req("api/workspaces", {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { name: "Invoices US", currency: "USD", locale: "en" },
    });
    check("USD workspace created", usd.status === 201, `got ${usd.status}`);
    const wsUsd = usd.json?.id;
    const usdCheckout = await req(`api/billing/workspace/${wsUsd}/checkout`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { plan_id: "starter-usd", provider: "lemonsqueezy" },
    });
    check("Lemon Squeezy checkout for USD workspace (201)", usdCheckout.status === 201, `got ${usdCheckout.status}`);
    const lsPay = usdCheckout.json?.payment;
    check("Lemon Squeezy URL carries the reference", (usdCheckout.json?.checkout?.redirectUrl ?? "").includes(encodeURIComponent(lsPay?.provider_txn_ref ?? "x")));

    const lsBadSig = await postRaw(
      "api/webhooks/lemonsqueezy",
      lemonEvent({ id: `ls-bad-${Date.now()}`, reference: lsPay.provider_txn_ref, total: 1500 }),
      { "X-Signature": "nope" }
    );
    check("Lemon Squeezy webhook rejects bad signature (401)", lsBadSig.status === 401, `got ${lsBadSig.status}`);

    const lsRaw = lemonEvent({ id: `ls-ok-${Date.now()}`, reference: lsPay.provider_txn_ref, total: 1500 });
    const lsHook = await postRaw("api/webhooks/lemonsqueezy", lsRaw, {
      "X-Signature": sign(lsRaw, TEST_PROVIDER_VARS.LEMON_SQUEEZY_WEBHOOK_SECRET),
    });
    check("Lemon Squeezy webhook confirms USD payment (200)", lsHook.status === 200 && lsHook.json?.confirmed === true, `got ${lsHook.status} ${JSON.stringify(lsHook.json)}`);
    check("USD plan activated", lsHook.json?.plan_activated === "starter-usd", `got ${lsHook.json?.plan_activated}`);

    const usdDetail = await req(`api/workspaces/${wsUsd}`, { jar: A.jar });
    check("USD workspace plan is Starter (USD)", usdDetail.json?.plan?.id === "starter-usd" && usdDetail.json?.plan?.currency === "USD");

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
