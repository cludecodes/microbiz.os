/**
 * M5b integration test: hosted settlement marking, refunds (partial/full),
 * encrypted payout profiles, and invoice payment links that become `paid`
 * only through a verified webhook or an admin-verified bank receipt.
 *
 * Run: node test/m5b.mjs
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

const PORT = 9200 + (Date.now() % 40);
const DUE = "2026-12-31";
const TOTAL = 100000;

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

function safepayEvent({ id, reference, amount_minor, currency = "PKR", fee_minor = 0 }) {
  return JSON.stringify({
    id,
    event: "payment.succeeded",
    data: { reference, tracker: `trk_${id}`, amount_minor, currency, fee_minor, status: "succeeded" },
  });
}

async function main() {
  console.log("== M5b test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "ignore", shell: true });

  console.log(`== M5b test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== M5b test: running flow ==");

    const A = await registerUser("m5b");
    const wsId = A.workspace.id;
    const invBase = `api/invoices/${wsId}`;
    const m = (sub, method, body) => req(`${invBase}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    async function createInvoice(client) {
      const res = await m("", "POST", {
        type: "invoice",
        client_name: client,
        due_date: DUE,
        items: [{ name: "Consulting", qty_millis: 1000, unit_price_minor: TOTAL }],
      });
      if (res.status !== 201) throw new Error(`invoice create failed: ${res.status} ${JSON.stringify(res.json)}`);
      return res.json.document;
    }
    async function sendInvoice(doc) {
      return m(`/${doc.id}`, "PATCH", { status: "sent" });
    }
    async function paymentLink(doc, provider) {
      return m(`/${doc.id}/payment-link`, "POST", { provider });
    }

    // ---- documents --------------------------------------------------------
    const invBank = await createInvoice("Khan Traders");
    const invHosted = await createInvoice("Noor Cafe");
    const invManual = await createInvoice("Manual Close Ltd");
    const invDraft = await createInvoice("Draft Client");
    const qtn = await m("", "POST", {
      type: "quotation",
      client_name: "Quote Client",
      items: [{ name: "Scoped work", qty_millis: 1000, unit_price_minor: TOTAL }],
    });
    check("five documents created within the Free limit", qtn.status === 201, `got ${qtn.status}`);

    await sendInvoice(invBank);
    await sendInvoice(invHosted);
    await sendInvoice(invManual);
    const qtnDoc = qtn.json.document;
    await m(`/${qtnDoc.id}`, "PATCH", { status: "sent" });

    // ---- payment-link validation -----------------------------------------
    const draftLink = await paymentLink(invDraft, "bank");
    check("draft invoice cannot get a payment link (409)", draftLink.status === 409, `got ${draftLink.status}`);
    const quoteLink = await paymentLink(qtnDoc, "bank");
    check("quotation cannot get a payment link (409)", quoteLink.status === 409, `got ${quoteLink.status}`);
    const wrongCurrency = await paymentLink(invBank, "lemonsqueezy");
    check("USD provider on a PKR invoice rejected (422)", wrongCurrency.status === 422, `got ${wrongCurrency.status}`);
    const unknownProvider = await paymentLink(invBank, "paypal");
    check("unknown provider rejected (422)", unknownProvider.status === 422, `got ${unknownProvider.status}`);

    // ---- manual invoice link ---------------------------------------------
    const bankLink = await paymentLink(invBank, "bank");
    check("bank payment link created for a sent invoice (201)", bankLink.status === 201, `got ${bankLink.status} ${JSON.stringify(bankLink.json)}`);
    const bankPay = bankLink.json.payment;
    check("invoice payment has no plan_id", bankPay?.plan_id === null);
    check("invoice payment is linked to the invoice", bankPay?.invoice_id === invBank.id);
    check("invoice payment equals the full invoice total", bankPay?.amount_minor === TOTAL, `got ${bankPay?.amount_minor}`);
    check("manual invoice link carries a transfer reference", /^MB-[A-Z0-9]{10}$/.test(bankPay?.provider_txn_ref ?? ""), bankPay?.provider_txn_ref);
    check("manual instructions mention the invoice", String(bankLink.json?.checkout?.instructions ?? "").includes(invBank.number), bankLink.json?.checkout?.instructions);

    const replayed = await paymentLink(invBank, "bank");
    check("sharing the link again replays the same intent (200)", replayed.status === 200 && replayed.json?.payment?.id === bankPay.id && replayed.json?.replayed === true, `got ${replayed.status}`);

    const detailBefore = await m(`/${invBank.id}`, "GET");
    check("invoice detail lists its payment intents", detailBefore.json?.payments?.some((p) => p.id === bankPay.id && p.status === "awaiting_confirmation"));

    // ---- promote admin ----------------------------------------------------
    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${A.email}'"`,
      { stdio: "ignore", shell: true }
    );

    const wrongAmount = await req(`api/admin/payments/${bankPay.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 5000, reference: bankPay.provider_txn_ref },
    });
    check("invoice receipt with the wrong amount refused (409)", wrongAmount.status === 409, `got ${wrongAmount.status}`);

    const bankPaid = await req(`api/admin/payments/${bankPay.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL, reference: bankPay.provider_txn_ref },
    });
    check("verified bank receipt confirms the invoice payment", bankPaid.status === 200 && bankPaid.json?.invoice_paid === true, `got ${bankPaid.status} ${JSON.stringify(bankPaid.json)}`);

    const paidDetail = await m(`/${invBank.id}`, "GET");
    check("invoice becomes paid only after the verified receipt", paidDetail.json?.document?.status === "paid", paidDetail.json?.document?.status);
    check("invoice records paid_at", Boolean(paidDetail.json?.document?.paid_at));
    check("invoice payment history is confirmed", paidDetail.json?.payments?.some((p) => p.id === bankPay.id && p.status === "confirmed"));

    const wsDetail = await req(`api/workspaces/${wsId}`, { jar: A.jar });
    check("invoice payment never activates a plan", wsDetail.json?.plan?.id === "free", wsDetail.json?.plan?.id);

    const paidAgain = await paymentLink(invBank, "bank");
    check("paid invoice cannot get another payment link (409)", paidAgain.status === 409, `got ${paidAgain.status}`);

    const bankLedger = await req(`api/admin/ledger?workspace_id=${wsId}`, { jar: A.jar });
    const bankJournal = (bankLedger.json?.journals ?? []).find((j) => j.ref_id === bankPay.id);
    check("invoice receipt posts a ledger journal", Boolean(bankJournal));
    check("invoice receipt lands in settled_bank (manual path)", (bankJournal?.postings ?? []).some((p) => p.account === "settled_bank"));

    // ---- hosted invoice link + verified webhook --------------------------
    const hostedLink = await paymentLink(invHosted, "safepay");
    check("hosted invoice link created (201)", hostedLink.status === 201, `got ${hostedLink.status} ${JSON.stringify(hostedLink.json)}`);
    const hostedPay = hostedLink.json.payment;
    check("hosted invoice link returns the configured sandbox URL", String(hostedLink.json?.checkout?.redirectUrl ?? "").includes(hostedPay.provider_txn_ref), hostedLink.json?.checkout?.redirectUrl);

    const raw = safepayEvent({ id: `inv-ok-${Date.now()}`, reference: hostedPay.provider_txn_ref, amount_minor: TOTAL });
    const hook = await postRaw("api/webhooks/safepay", raw, {
      "X-SFPY-Signature": sign(raw, TEST_PROVIDER_VARS.SAFEPAY_WEBHOOK_SECRET),
    });
    check("signed webhook confirms the hosted invoice payment", hook.status === 200 && hook.json?.confirmed === true, `got ${hook.status} ${JSON.stringify(hook.json)}`);
    check("webhook reports the invoice as paid", hook.json?.invoice_paid === true, JSON.stringify(hook.json));

    const hostedDetail = await m(`/${invHosted.id}`, "GET");
    check("hosted invoice becomes paid after webhook", hostedDetail.json?.document?.status === "paid");

    // ---- settlement marking ----------------------------------------------
    const settlementsBefore = await req("api/admin/settlements", { jar: A.jar });
    check("admin settlement view lists pending hosted payouts", settlementsBefore.status === 200 && (settlementsBefore.json?.pending_hosted ?? []).some((p) => p.id === hostedPay.id), `got ${settlementsBefore.status}`);
    check("bank settlements are listed separately", (settlementsBefore.json?.bank ?? []).some((b) => b.payment_id === bankPay.id));

    const oversettle = await req(`api/admin/payments/${hostedPay.id}/settle`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL + 1000, provider_ref: "payout-test" },
    });
    check("payout larger than net held funds refused (409)", oversettle.status === 409, `got ${oversettle.status}`);

    const settled = await req(`api/admin/payments/${hostedPay.id}/settle`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL - 5000, provider_ref: "payout-test" },
    });
    check("hosted payout marked settled after bank check (200)", settled.status === 200 && settled.json?.settlement_status === "settled", `got ${settled.status} ${JSON.stringify(settled.json)}`);
    check("net held funds are tracked", settled.json?.net_minor === TOTAL, `got ${settled.json?.net_minor}`);
    check("payout fee recorded for the shortfall", settled.json?.payout_fee_minor === 5000, `got ${settled.json?.payout_fee_minor}`);

    const settleTwice = await req(`api/admin/payments/${hostedPay.id}/settle`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 1000 },
    });
    check("double settlement refused (409)", settleTwice.status === 409, `got ${settleTwice.status}`);

    const settleLedger = await req(`api/admin/ledger?workspace_id=${wsId}`, { jar: A.jar });
    const settleJournal = (settleLedger.json?.journals ?? []).find((j) => j.ref_type === "settlement" && j.ref_id === hostedPay.id);
    check("settlement posts a journal", Boolean(settleJournal));
    const settleAccounts = (settleJournal?.postings ?? []).map((p) => p.account).sort();
    check("settlement moves available balance into bank and records payout fees", settleAccounts.includes("settled_bank") && settleAccounts.includes("available_balance") && settleAccounts.includes("payout_fees"), JSON.stringify(settleAccounts));
    const settleDebits = (settleJournal?.postings ?? []).filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount_minor, 0);
    const settleCredits = (settleJournal?.postings ?? []).filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount_minor, 0);
    check("settlement journal balances", settleDebits === settleCredits);

    const settlementsAfter = await req("api/admin/settlements", { jar: A.jar });
    check("settled payout leaves the pending queue", !(settlementsAfter.json?.pending_hosted ?? []).some((p) => p.id === hostedPay.id));
    check("settled payout appears in settled history", (settlementsAfter.json?.settled_hosted ?? []).some((p) => p.id === hostedPay.id));

    // ---- refunds ----------------------------------------------------------
    const zeroRefund = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 0 },
    });
    check("zero refund rejected (422)", zeroRefund.status === 422, `got ${zeroRefund.status}`);

    const overRefund = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL + 1, reason: "too much" },
    });
    check("refund beyond the payment refused (409)", overRefund.status === 409, `got ${overRefund.status}`);

    const partial = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 20000, reason: "customer goodwill", provider_ref: "refund-test-1" },
    });
    check("partial refund recorded (200)", partial.status === 200 && partial.json?.refund_minor === 20000, `got ${partial.status} ${JSON.stringify(partial.json)}`);
    check("partial refund leaves the payment confirmed", partial.json?.status === "confirmed", partial.json?.status);
    check("settled payment refunds from settled bank funds", partial.json?.from_settled_bank === true);

    const refundLedger = await req(`api/admin/ledger?workspace_id=${wsId}`, { jar: A.jar });
    const refundJournal = (refundLedger.json?.journals ?? []).find((j) => j.ref_type === "refund" && j.ref_id === hostedPay.id);
    const refundPostings = (refundJournal?.postings ?? []);
    check("refund posts a contra-revenue journal", Boolean(refundJournal));
    check("refund debits refunds and credits settled_bank", refundPostings.some((p) => p.account === "refunds" && p.direction === "DEBIT" && p.amount_minor === 20000) && refundPostings.some((p) => p.account === "settled_bank" && p.direction === "CREDIT" && p.amount_minor === 20000), JSON.stringify(refundPostings));

    const tooBig = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 90000, reason: "over remaining" },
    });
    check("refund beyond the remaining refundable refused (409)", tooBig.status === 409, `got ${tooBig.status}`);

    const full = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 80000, reason: "full refund" },
    });
    check("remaining refund completes the refund (200)", full.status === 200 && full.json?.refund_minor === TOTAL && full.json?.status === "refunded", `got ${full.status} ${JSON.stringify(full.json)}`);

    const afterFull = await req(`api/admin/payments/${hostedPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 1 },
    });
    check("fully refunded payment cannot be refunded again (409)", afterFull.status === 409, `got ${afterFull.status}`);

    // ---- manual attestation cancels pending intents ----------------------
    const manualLink = await paymentLink(invManual, "bank");
    check("manual invoice link created for cancel test (201)", manualLink.status === 201, `got ${manualLink.status}`);
    const manualPay = manualLink.json.payment;
    const manualPaid = await m(`/${invManual.id}`, "PATCH", { status: "paid" });
    check("manual paid status cancels the pending online intent", manualPaid.status === 200 && manualPaid.json?.canceled_payment_intents === 1, `got ${manualPaid.status} ${JSON.stringify(manualPaid.json)}`);

    const manualConfirm = await req(`api/admin/payments/${manualPay.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL, reference: manualPay.provider_txn_ref },
    });
    check("canceled intent can never be confirmed (no double count)", manualConfirm.status === 409, `got ${manualConfirm.status}`);

    const unconfirmedRefund = await req(`api/admin/payments/${manualPay.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: 1000 },
    });
    check("refund on an unconfirmed payment refused (409)", unconfirmedRefund.status === 409, `got ${unconfirmedRefund.status}`);

    // ---- encrypted payout profiles ---------------------------------------
    const profiles0 = await req(`api/billing/workspace/${wsId}/payout-profiles`, { jar: A.jar });
    check("owner can read payout profiles (empty, encryption configured)", profiles0.status === 200 && profiles0.json?.profiles?.length === 0 && profiles0.json?.encryption_configured === true, JSON.stringify(profiles0.json));

    const profileBody = {
      label: "Main bank",
      details: {
        account_title: "MicroBiz Demo",
        iban: "PK36SCBL0000001123456702",
        bank_name: "Standard Chartered",
        country: "PK",
      },
    };
    const createdProfile = await req(`api/billing/workspace/${wsId}/payout-profiles/bank_raast`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: profileBody,
    });
    check("payout profile saved (201)", createdProfile.status === 201, `got ${createdProfile.status} ${JSON.stringify(createdProfile.json)}`);
    check("saved profile is masked, never echoed in plaintext", JSON.stringify(createdProfile.json).includes("PK36SCBL0000001123456702") === false && createdProfile.json?.details_preview?.identifier === "••••6702", JSON.stringify(createdProfile.json));
    check("new payout profile requires admin approval", createdProfile.json?.approved === 0);

    const updatedProfile = await req(`api/billing/workspace/${wsId}/payout-profiles/bank_raast`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { label: "Main bank (new)", details: { account_title: "MicroBiz Demo", account_number: "1234567890123", bank_name: "HBL" } },
    });
    check("updating a payout profile keeps one row and resets approval", updatedProfile.status === 200 && updatedProfile.json?.approved === 0, `got ${updatedProfile.status}`);

    const badProfile = await req(`api/billing/workspace/${wsId}/payout-profiles/bank_raast`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { label: "Bad", details: { account_title: "X", account_number: "1234", cvv: "123" } },
    });
    check("card/CVV fields are rejected by the allowlist (422)", badProfile.status === 422, `got ${badProfile.status}`);

    const missingIdentifier = await req(`api/billing/workspace/${wsId}/payout-profiles/payoneer`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { label: "No target", details: { account_title: "X" } },
    });
    check("payout profile without an account identifier rejected (422)", missingIdentifier.status === 422, `got ${missingIdentifier.status}`);

    const adminProfiles = await req("api/admin/payout-profiles", { jar: A.jar });
    const adminProfile = (adminProfiles.json?.profiles ?? []).find((p) => p.workspace_id === wsId);
    check("admin can review a masked payout profile", adminProfiles.status === 200 && Boolean(adminProfile) && JSON.stringify(adminProfile).includes("1234567890123") === false);
    const approval = await req(`api/admin/payout-profiles/${adminProfile.id}/approval`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { approved: true },
    });
    check("admin approves the payout target", approval.status === 200 && approval.json?.approved === 1);
    const profilesAfter = await req(`api/billing/workspace/${wsId}/payout-profiles`, { jar: A.jar });
    check("owner sees the approved flag", (profilesAfter.json?.profiles ?? []).find((p) => p.kind === "bank_raast")?.approved === 1);

    const B = await registerUser("m5bguest");
    const bProfile = await req(`api/billing/workspace/${wsId}/payout-profiles/payoneer`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { label: "Intruder", details: { account_title: "X", payoneer_email: "x@example.com" } },
    });
    check("non-owner cannot write payout profiles (403)", bProfile.status === 403, `got ${bProfile.status}`);
    const bRefund = await req(`api/admin/payments/${bankPay.id}/refund`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { amount_minor: 1000 },
    });
    check("non-admin cannot refund payments (403)", bRefund.status === 403, `got ${bRefund.status}`);
    const bSettle = await req(`api/admin/payments/${hostedPay.id}/settle`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: {},
    });
    check("non-admin cannot mark settlements (403)", bSettle.status === 403, `got ${bSettle.status}`);

    const deleted = await req(`api/billing/workspace/${wsId}/payout-profiles/bank_raast`, {
      method: "DELETE",
      jar: A.jar,
      csrf: A.csrf,
    });
    check("owner can delete a payout profile (200)", deleted.status === 200, `got ${deleted.status}`);
    const profilesEmpty = await req(`api/billing/workspace/${wsId}/payout-profiles`, { jar: A.jar });
    check("deleted profile is gone", profilesEmpty.json?.profiles?.length === 0);

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
