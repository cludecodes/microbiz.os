/**
 * M4 integration test: WhatsApp CRM & Order Manager.
 * Contacts, catalog, orders (server-computed totals), status pipeline,
 * usage metering vs the Free plan limit, RBAC and tenant isolation.
 *
 * Run: node test/crm.mjs   (also part of `npm test -w @microbiz/api`)
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

const PORT = 8800 + (Date.now() % 40); // fresh port each run: stale workerd can keep an old one bound

async function main() {
  console.log("== CRM test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log("== CRM test: starting wrangler dev ==");
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== CRM test: running CRM flow ==");

    console.log("== state: registering owner A ==");
    const A = await registerUser("ownera");
    console.log("== state: owner registered ==");
    const wsId = A.workspace.id;
    const crmPath = `api/crm/${wsId}`;
    const m = (sub, method, body) => req(`${crmPath}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    // ---------------------------------------------------------- validation
    const badContact = await m("/contacts", "POST", { name: "Bilal", phone: "0300-123" });
    check("contact with local-format phone rejected (422)", badContact.status === 422, `got ${badContact.status}`);

    const contact = await m("/contacts", "POST", {
      name: "Bilal Ahmed",
      phone: "+923001234567",
      email: "bilal@example.com",
      locale: "en",
      tags: ["returning"],
      notes: "Prefers evening delivery",
    });
    check("contact created", contact.status === 201, `got ${contact.status}`);
    const contactId = contact.json?.contact?.id;

    const list = await m("/contacts", "GET");
    check("contact appears in list", list.status === 200 && list.json.contacts.length === 1);

    // ------------------------------------------------------------- catalog
    const badProduct = await m("/products", "POST", { name: "Bad Price", price_minor: -5 });
    check("negative price rejected (422)", badProduct.status === 422, `got ${badProduct.status}`);

    const product = await m("/products", "POST", {
      name: "Chicken Biryani (Family Pack)",
      kind: "physical",
      price_minor: 75000, // ₨750.00
      stock: 40,
    });
    check("product created", product.status === 201, `got ${product.status}`);
    const productId = product.json?.product?.id;

    // -------------------------------------------------------------- orders
    const orderRes = await m("/orders", "POST", {
      customer_id: contactId,
      tax_minor: 5000, // ₨50
      note: "Extra raita please",
      items: [
        { product_id: productId, qty_millis: 2000 },                       // 2 x ₨750 = ₨1500
        { name: "Garlic Naan", qty_millis: 3000, unit_price_minor: 8000 }, // 3 x ₨80  = ₨240
        { name: "Soda", qty_millis: 1000, unit_price_minor: 15000 },       // ₨150
      ],
    });
    check("order created", orderRes.status === 201, `got ${orderRes.status} ${JSON.stringify(orderRes.json)}`);
    const order = orderRes.json?.order;
    const expectedTotal = 150000 + 24000 + 15000 + 5000;
    check("server-computed total correct", order?.total_minor === expectedTotal, `got ${order?.total_minor} expected ${expectedTotal}`);
    check("order starts in new status", order?.status === "new");
    check("order number allocated", /^ORD-\d{4}$/.test(order?.number ?? ""));
    check("catalog item price is server-authoritative", orderRes.json?.items?.[0]?.unit_price_minor === 75000);

    const orderId = order?.id;

    const listOrders = await m("/orders", "GET");
    check(
      "orders list returns the created order",
      listOrders.status === 200 &&
        listOrders.json?.orders?.length === 1 &&
        listOrders.json?.orders?.[0]?.number === order?.number,
      `got ${listOrders.status}`
    );

    const usage = await req(`api/apps/workspace/${wsId}/usage/whatsapp-crm`, { jar: A.jar });
    check("usage meter counts the order", usage.json?.used === 1, `got ${usage.json?.used}`);

    // ------------------------------------------------------ status pipeline
    const toConfirmed = await m(`/orders/${orderId}`, "PATCH", { status: "confirmed" });
    check("new -> confirmed allowed", toConfirmed.status === 200, `got ${toConfirmed.status}`);
    const backToNew = await m(`/orders/${orderId}`, "PATCH", { status: "new" });
    check("confirmed -> new rejected", [409, 422].includes(backToNew.status), `got ${backToNew.status}`);
    const toCanceled = await m(`/orders/${orderId}`, "PATCH", { status: "canceled" });
    check("confirmed -> canceled allowed", toCanceled.status === 200);
    const afterCancel = await m(`/orders/${orderId}`, "PATCH", { status: "completed" });
    check("canceled -> completed rejected", afterCancel.status === 409);

    const ghostOrder = await m("/orders", "POST", {
      items: [{ product_id: "no-such-product", name: "x", qty_millis: 1000 }],
    });
    check("unknown product rejected (422)", ghostOrder.status === 422, `got ${ghostOrder.status}`);

    // ---------------------------------------------- monthly Free plan limit
    let created = 1;
    let last = null;
    while (created < 60) {
      last = await m("/orders", "POST", {
        items: [{ name: "Quick Sale", qty_millis: 1000, unit_price_minor: 100000 }],
      });
      if (last.status !== 201) break;
      created++;
    }
    check("order beyond Free plan limit blocked (403)", last?.status === 403, `got ${last?.status}`);
    check("exactly 50 orders permitted this month", created === 50, `created ${created}`);

    // -------------------------------------------------- RBAC + isolation
    const B = await registerUser("memberb");
    // Free plan allows 1 seat; in production a super-admin grants extra seats
    // via the entitlements table (documented admin action). Mirror that here.
    execSync(
      `npx wrangler d1 execute microbiz --local --command "INSERT INTO entitlements (workspace_id, feature_key, limit_value, granted, source, created_at) VALUES ('${wsId}', 'team_members', 3, 1, 'override', '${new Date().toISOString()}')"`,
      { stdio: "ignore", shell: true }
    );
    const addB = await req(`api/workspaces/${wsId}/members`, {
      method: "POST",
      jar: A.jar,
      csrf: A.csrf,
      body: { email: B.email, role: "member" },
    });
    check("member added to workspace", addB.status === 201, `got ${addB.status}`);

    const bRead = await req(`${crmPath}/contacts`, { jar: B.jar });
    check("member can read contacts", bRead.status === 200);
    const bDelete = await req(`${crmPath}/contacts/${contactId}`, { method: "DELETE", jar: B.jar, csrf: B.csrf });
    check("member cannot delete contacts (admin+ required)", bDelete.status === 403, `got ${bDelete.status}`);

    const C = await registerUser("guestc");
    const cRead = await req(`${crmPath}/contacts`, { jar: C.jar });
    check("non-member blocked from workspace data (tenant isolation)", cRead.status === 403, `got ${cRead.status}`);

    // -------------------------------------------------------- honest summary
    const summary = await m("/summary", "GET");
    check("summary counts contacts", summary.json?.contacts === 1, `got ${summary.json?.contacts}`);
    check("summary counts active products", summary.json?.products === 1, `got ${summary.json?.products}`);
    check("summary pipeline includes canceled", typeof summary.json?.pipeline?.canceled === "number");
    check("summary orders_this_month = 50", summary.json?.orders_this_month === 50, `got ${summary.json?.orders_this_month}`);

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR type:", typeof err, "keys:", err && Object.keys(err));
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
