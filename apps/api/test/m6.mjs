/**
 * M6 integration test: super-admin analytics reads, definitions and verified CSV exports.
 *
 * Run: node test/m6.mjs
 */

import { execSync } from "node:child_process";
import process from "node:process";
import { jarStr, req, check, registerUser, setPort, BASE, clearLocalRateLimits, bootWrangler, waitForHealth, printAndExit } from "./http.mjs";

const PORT = 9300 + (Date.now() % 40);
const DUE = "2026-12-31";
const TOTAL = 123400;
const REFUND = 23400;

async function main() {
  console.log("== M6 test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "ignore", shell: true });

  console.log(`== M6 test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== M6 test: running flow ==");

    const A = await registerUser("m6");
    const wsId = A.workspace.id;
    const m = (sub, method, body) => req(`api/invoices/${wsId}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    async function createInvoice(client, amount) {
      const res = await m("", "POST", {
        type: "invoice",
        client_name: client,
        due_date: DUE,
        items: [{ name: "M6 audit", qty_millis: 1000, unit_price_minor: amount }],
      });
      if (res.status !== 201) throw new Error(`invoice create failed: ${res.status} ${JSON.stringify(res.json)}`);
      return res.json.document;
    }

    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${A.email}'"`,
      { stdio: "ignore", shell: true }
    );

    const doc1 = await createInvoice("Khan Analytics", TOTAL);
    await m(`/${doc1.id}`, "PATCH", { status: "sent" });
    const bankLink = await m(`/${doc1.id}/payment-link`, "POST", { provider: "bank" });
    const payment = bankLink.json.payment;
    const confirm = await req(`api/admin/payments/${payment.id}/confirm`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: TOTAL, reference: payment.provider_txn_ref },
    });
    check("M6 setup: verified invoice receipt confirmed", confirm.status === 200 && confirm.json?.invoice_paid === true, `got ${confirm.status} ${JSON.stringify(confirm.json)}`);
    const refund = await req(`api/admin/payments/${payment.id}/refund`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { amount_minor: REFUND, reason: "analytics test" },
    });
    check("M6 setup: partial refund recorded", refund.status === 200 && refund.json?.refund_minor === REFUND, `got ${refund.status}`);

    const doc2 = await createInvoice("Noor Analytics", TOTAL - 73000);
    await m(`/${doc2.id}`, "PATCH", { status: "sent" });

    const B = await registerUser("m6guest");

    // ---- auth / validation -------------------------------------------------
    const anonAnalytics = await req("api/admin/analytics");
    check("analytics requires super admin (403 for anonymous)", anonAnalytics.status === 403, `got ${anonAnalytics.status}`);

    const guestAnalytics = await req("api/admin/analytics", { jar: B.jar, csrf: B.csrf });
    check("analytics requires super admin (403 for member)", guestAnalytics.status === 403, `got ${guestAnalytics.status}`);

    const invalidDays = await req("api/admin/analytics?days=0", { jar: A.jar, csrf: A.csrf });
    check("analytics rejects invalid range (422)", invalidDays.status === 422, `got ${invalidDays.status}`);

    const invalidCurrency = await req(`api/admin/analytics?days=30&currency=EUR`, { jar: A.jar, csrf: A.csrf });
    check("analytics rejects unknown currency (422)", invalidCurrency.status === 422, `got ${invalidCurrency.status}`);

    // ---- verified analytics -------------------------------------------------
    const analytics = await req(`api/admin/analytics?days=30&workspace_id=${wsId}&currency=PKR`, { jar: A.jar, csrf: A.csrf });
    check("super admin analytics returns 200", analytics.status === 200, `got ${analytics.status} ${JSON.stringify(analytics.json)}`);
    const data = analytics.json ?? {};
    const ov = data.overview ?? {};

    check("analytics gross receipts equal the verified receipt", ov.receipts?.[0]?.gross_minor === TOTAL, JSON.stringify(ov.receipts));
    check("analytics refunds equal the recorded refund", ov.receipts?.[0]?.refunds_minor === REFUND, JSON.stringify(ov.receipts));
    check("analytics net receipts subtract refunds", ov.receipts?.[0]?.net_minor === TOTAL - REFUND, JSON.stringify(ov.receipts));
    check("analytics fees are zero for this test receipt", ov.receipts?.[0]?.processing_fees_minor === 0 && ov.receipts?.[0]?.payout_fees_minor === 0, JSON.stringify(ov.receipts));

    check("analytics bank inflow is the verified receipt", ov.bank?.[0]?.inflow_minor === TOTAL, JSON.stringify(ov.bank));
    check("analytics bank outflow is the refund", ov.bank?.[0]?.outflow_minor === REFUND, JSON.stringify(ov.bank));
    check("analytics bank net equals net receipts", ov.bank?.[0]?.net_minor === TOTAL - REFUND, JSON.stringify(ov.bank));
    check("analytics settled bank balance reflects receipt minus refund", ov.balances?.[0]?.settled_bank_minor === TOTAL - REFUND, JSON.stringify(ov.balances));
    check("analytics provider-held ledger balance is zero for manual bank", ov.balances?.[0]?.available_held_minor === 0, JSON.stringify(ov.balances));

    check("analytics has no pending hosted payouts", (ov.pending_hosted ?? []).every((row) => row.count === 0), JSON.stringify(ov.pending_hosted));
    check("analytics has no pending manual receipts", (ov.pending_manual ?? []).every((row) => row.count === 0), JSON.stringify(ov.pending_manual));
    check("analytics has no bank reconciliation exceptions", (ov.bank_exceptions ?? []).length === 0, JSON.stringify(ov.bank_exceptions));

    check("analytics subscription status is one active free plan", ov.subscriptions?.active === 1, JSON.stringify(ov.subscriptions));
    check("analytics free plan contracted value is zero", ov.contracted_monthly?.[0]?.amount_minor === 0, JSON.stringify(ov.contracted_monthly));

    const seriesPKR = (data.revenue_series ?? []).filter((row) => row.currency === "PKR");
    const seriesGross = seriesPKR.reduce((sum, row) => sum + row.gross_minor, 0);
    const seriesRefunds = seriesPKR.reduce((sum, row) => sum + row.refunds_minor, 0);
    const seriesNet = seriesPKR.reduce((sum, row) => sum + row.net_minor, 0);
    check("analytics daily series gross matches gross receipts", seriesGross === TOTAL, `got ${seriesGross}`);
    check("analytics daily series refunds match refunds", seriesRefunds === REFUND, `got ${seriesRefunds}`);
    check("analytics daily series net matches net receipts", seriesNet === TOTAL - REFUND, `got ${seriesNet}`);
    check("analytics series covers the requested range", (data.revenue_series ?? []).length === 30, `got ${(data.revenue_series ?? []).length}`);
    check("analytics growth series covers the requested range", (data.growth_series ?? []).length === 30, `got ${(data.growth_series ?? []).length}`);

    const provider = (data.providers ?? []).find((row) => row.provider === "bank" && row.currency === "PKR");
    check("analytics provider breakdown identifies bank receipts", provider?.gross_minor === TOTAL && provider?.refunds_minor === REFUND && provider?.net_minor === TOTAL - REFUND, JSON.stringify(data.providers));
    const paymentStatus = (data.payment_status ?? []).find((row) => row.status === "confirmed" && row.currency === "PKR");
    check("analytics payment status counts the confirmed receipt", paymentStatus?.count === 1 && paymentStatus?.amount_minor === TOTAL && paymentStatus?.refund_minor === REFUND, JSON.stringify(data.payment_status));

    const plan = (data.plans ?? []).find((row) => row.name === "Free");
    check("analytics plan distribution shows the active free plan", plan?.active_subs === 1 && plan?.contracted_minor === 0, JSON.stringify(data.plans));

    const top = (data.top_workspaces ?? []).find((row) => row.workspace_id === wsId && row.currency === "PKR");
    check("analytics top workspace uses verified net receipts", top?.gross_minor === TOTAL && top?.net_minor === TOTAL - REFUND, JSON.stringify(top));

    const usage = (data.usage ?? []).find((row) => row.app_id === "invoices" && row.feature_key === "invoices.monthly");
    check("analytics usage includes invoice document events", usage?.quantity === 2, JSON.stringify(data.usage));

    check(
      "analytics merchant activity includes created invoices",
      (data.product_activity?.invoices ?? []).reduce((sum, row) => sum + row.count, 0) === 2,
      JSON.stringify(data.product_activity)
    );

    // ---- verified exports ---------------------------------------------------
    const revenueExportRes = await fetch(`${BASE()}/api/admin/analytics/export?${new URLSearchParams({
      dataset: "revenue",
      days: "30",
      workspace_id: wsId,
      currency: "PKR",
    })}`, { headers: { Cookie: jarStr(A.jar), "X-CSRF-Token": A.csrf, Accept: "text/csv" } });
    const revenueExportText = await revenueExportRes.text();
    check("analytics revenue CSV export returns CSV", revenueExportRes.status === 200 && revenueExportRes.headers.get("content-type")?.includes("text/csv"), `got ${revenueExportRes.status}`);
    check("analytics revenue CSV includes verified totals", revenueExportText.includes("123400") && revenueExportText.includes("23400") && revenueExportText.includes("date"), revenueExportText.slice(0, 120));

    const paymentExportRes = await fetch(`${BASE()}/api/admin/analytics/export?${new URLSearchParams({
      dataset: "payments",
      days: "30",
      workspace_id: wsId,
      currency: "PKR",
    })}`, { headers: { Cookie: jarStr(A.jar), "X-CSRF-Token": A.csrf, Accept: "text/csv" } });
    const paymentExportText = await paymentExportRes.text();
    check("analytics payments CSV export returns confirmed rows", paymentExportRes.status === 200 && paymentExportText.includes("bank") && paymentExportText.includes(payment.provider_txn_ref), `got ${paymentExportRes.status}`);

    console.log("== M6 test: finished checks ==");
    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
