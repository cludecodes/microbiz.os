/**
 * M4c integration test: Invoices & Quotations.
 * Creation with exact integer math, numbering, per-type status lifecycles,
 * monthly metering (Free: 5 documents), tenant isolation. No DELETE exists —
 * financial records are voided, never destroyed.
 *
 * Run: node test/invoices.mjs
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

const PORT = 9000 + (Date.now() % 40); // fresh port each run

async function main() {
  console.log("== invoices test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "ignore", shell: true });

  console.log(`== invoices test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== invoices test: running flow ==");

    const A = await registerUser("invowner");
    const wsId = A.workspace.id;
    const path = `api/invoices/${wsId}`;
    const m = (sub, method, body) => req(`${path}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    // ---- validation ------------------------------------------------------
    const noDue = await m("", "POST", {
      type: "invoice",
      client_name: "Khan Traders",
      items: [{ name: "Design work", qty_millis: 1000, unit_price_minor: 500000 }],
    });
    check("invoice without due_date rejected (422)", noDue.status === 422, `got ${noDue.status}`);

    const noClient = await m("", "POST", {
      type: "invoice",
      due_date: "2026-12-31",
      items: [{ name: "Design work", qty_millis: 1000, unit_price_minor: 500000 }],
    });
    check("invoice without client identity rejected (422)", noClient.status === 422, `got ${noClient.status}`);

    const badMath = await m("", "POST", {
      type: "quotation",
      client_name: "Odd Math Ltd",
      items: [{ name: "Weird qty", qty_millis: 1500, unit_price_minor: 11 }],
    });
    check("non-exact minor-unit line rejected (422)", badMath.status === 422, `got ${badMath.status}`);

    const ghostCustomer = await m("", "POST", {
      type: "quotation",
      customer_id: "no-such-customer",
      items: [{ name: "x", qty_millis: 1000, unit_price_minor: 1000 }],
    });
    check("unknown customer rejected (404)", ghostCustomer.status === 404, `got ${ghostCustomer.status}`);

    // ---- create invoice --------------------------------------------------
    const inv = await m("", "POST", {
      type: "invoice",
      client_name: "Khan Traders",
      client_email: "accounts@khan.example",
      due_date: "2026-12-31",
      tax_minor: 5000,
      notes: "Net 30, bank transfer preferred",
      items: [
        { name: "Brand identity", qty_millis: 1000, unit_price_minor: 250000 }, // 2,500.00
        { name: "Logo variants", qty_millis: 3000, unit_price_minor: 50000 },  // 3 x 500.00 = 1,500.00
      ],
    });
    check("invoice created (201)", inv.status === 201, `got ${inv.status} ${JSON.stringify(inv.json)}`);
    const invDoc = inv.json?.document;
    const expected = 250000 + 150000 + 5000;
    check("server-computed totals correct", invDoc?.total_minor === expected, `got ${invDoc?.total_minor} expected ${expected}`);
    check("invoice number allocated (INV-0001)", invDoc?.number === "INV-0001", `got ${invDoc?.number}`);
    check("starts as draft", invDoc?.status === "draft");
    check("currency pinned to workspace (PKR)", invDoc?.currency === "PKR");
    check("line items returned", inv.json?.items?.length === 2);

    // ---- quotation (separate numbering) ----------------------------------
    const qtn = await m("", "POST", {
      type: "quotation",
      client_name: "Noor Café",
      items: [{ name: "Menu printing x100", qty_millis: 100000, unit_price_minor: 2500 }],
    });
    check("quotation created", qtn.status === 201, `got ${qtn.status}`);
    check("quotation numbered independently (QTN-0001)", qtn.json?.document?.number === "QTN-0001", `got ${qtn.json?.document?.number}`);

    // ---- lists + detail ---------------------------------------------------
    const listAll = await m("", "GET");
    check("list shows both documents", listAll.json?.documents?.length === 2, `got ${listAll.json?.documents?.length}`);
    const listInv = await m("?type=invoice", "GET");
    check("type filter returns only invoices", listInv.json?.documents?.length === 1);
    const detail = await m(`/${invDoc?.id}`, "GET");
    check("detail includes line items", detail.status === 200 && detail.json?.items?.length === 2);

    // ---- metering: 2 of 5 used -------------------------------------------
    const usage = await req(`api/apps/workspace/${wsId}/usage/invoices`, { jar: A.jar });
    check("usage meter counts both documents", usage.json?.used === 2, `got ${usage.json?.used}`);

    // ---- status lifecycles ------------------------------------------------
    const invId = invDoc?.id;
    const sent = await m(`/${invId}`, "PATCH", { status: "sent" });
    check("invoice draft -> sent", sent.status === 200, `got ${sent.status}`);
    const rewind = await m(`/${invId}`, "PATCH", { status: "draft" });
    check("sent -> draft rejected (no rewinding financial records)", rewind.status === 422, `got ${rewind.status}`);
    const acceptedOnInvoice = await m(`/${invId}`, "PATCH", { status: "accepted" });
    check("quotation-only status rejected on invoice (409)", acceptedOnInvoice.status === 409, `got ${acceptedOnInvoice.status}`);
    const paid = await m(`/${invId}`, "PATCH", { status: "paid" });
    check("invoice sent -> paid (manual owner attestation)", paid.status === 200, `got ${paid.status}`);
    const voidPaid = await m(`/${invId}`, "PATCH", { status: "void" });
    check("paid invoice is terminal (409)", voidPaid.status === 409, `got ${voidPaid.status}`);

    const qtnSent = await m(`/${qtn.json?.document?.id}`, "PATCH", { status: "sent" });
    check("quotation draft -> sent", qtnSent.status === 200);
    const qtnAccepted = await m(`/${qtn.json?.document?.id}`, "PATCH", { status: "accepted" });
    check("quotation sent -> accepted", qtnAccepted.status === 200, `got ${qtnAccepted.status}`);

    // ---- no destructive route (financial records are voided) --------------
    const del = await m(`/${invId}`, "DELETE");
    check("no DELETE route for documents (404)", del.status === 404, `got ${del.status}`);

    // ---- monthly limit: Free = 5 ------------------------------------------
    let created = 2;
    let last = null;
    while (created < 10) {
      last = await m("", "POST", {
        type: "invoice",
        client_name: `Limit Test ${created}`,
        due_date: "2026-12-31",
        items: [{ name: "Filler", qty_millis: 1000, unit_price_minor: 10000 }],
      });
      if (last.status !== 201) break;
      created++;
    }
    check("6th document blocked by plan limit (403)", last?.status === 403, `got ${last?.status}`);
    check("exactly 5 documents allowed this month", created === 5, `created ${created}`);
    check("limit response explains the reason", last?.json?.detail?.includes("monthly document allowance") === true, JSON.stringify(last?.json));

    // ---- tenant isolation -------------------------------------------------
    const B = await registerUser("invguest");
    const bList = await req(`api/invoices/${wsId}`, { jar: B.jar });
    check("non-member cannot list documents (403)", bList.status === 403, `got ${bList.status}`);
    const bCreate = await req(`api/invoices/${wsId}`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { type: "quotation", client_name: "Intruder", items: [{ name: "x", qty_millis: 1000, unit_price_minor: 1 }] },
    });
    check("non-member cannot create documents (403)", bCreate.status === 403, `got ${bCreate.status}`);
    const bPatch = await req(`api/invoices/${wsId}/${invId}`, {
      method: "PATCH",
      jar: B.jar,
      csrf: B.csrf,
      body: { status: "void" },
    });
    check("non-member cannot change status (403)", bPatch.status === 403, `got ${bPatch.status}`);

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
