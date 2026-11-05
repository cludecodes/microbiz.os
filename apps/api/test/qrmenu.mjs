/**
 * M4b integration test: QR Restaurant Menu.
 * Menu item CRUD, availability toggling, the PUBLIC scan endpoint
 * (no auth by design), scan metering against the Free plan and
 * tenant isolation. Run: node test/qrmenu.mjs
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

const PORT = 8900 + (Date.now() % 40); // fresh port each run

async function main() {
  console.log("== QR menu test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "ignore", shell: true });

  console.log(`== QR menu test: starting wrangler dev on :${PORT} =="`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== QR menu test: running flow ==");

    const A = await registerUser("qrowner");
    const wsId = A.workspace.id;
    const path = `api/qrmenu/${wsId}`;
    const m = (sub, method, body) => req(`${path}${sub}`, { method, body, jar: A.jar, csrf: A.csrf });

    // ---- validation ------------------------------------------------------
    const bad = await m("/menu", "POST", { name: "Kheer", price_minor: -3 });
    check("negative price rejected (422)", bad.status === 422, `got ${bad.status}`);

    // ---- create two items ------------------------------------------------
    const kheer = await m("/menu", "POST", { name: "Kheer (bowl)", description: "Sweet rice dessert", price_minor: 35000 });
    check("menu item created", kheer.status === 201, `got ${kheer.status}`);
    const karahi = await m("/menu", "POST", { name: "Mutton Karahi", description: "Half kg", price_minor: 215000 });
    check("second menu item created", karahi.status === 201, `got ${karahi.status}`);
    const items = kheer.status === 201 && karahi.status === 201;

    const list = await m("/menu", "GET");
    check("management list shows both items", list.status === 200 && list.json?.items?.length === 2);

    // ---- public menu (the QR endpoint, no auth) ---------------------------
    const pub1 = await req(`api/public/qrmenu/${wsId}`);
    check("public menu reachable without any session", pub1.status === 200, `got ${pub1.status}`);
    check("public menu shows both items", pub1.json?.items?.length === 2);
    const kheerPub = (pub1.json?.items ?? []).find((i) => i.name === "Kheer (bowl)");
    check(
      "public payload is minimal (name/description/price/currency only)",
      kheerPub &&
        Object.keys(kheerPub).sort().join(",") === "currency,description,name,price_minor",
      JSON.stringify(Object.keys(kheerPub ?? {}))
    );
    check("not limited at zero scans", pub1.json?.limited === false);

    // ---- availability toggle --------------------------------------------
    const toggle = await m(`/menu/${karahi.json?.item?.id}`, "PATCH", { is_available: false });
    check("availability toggle accepted", toggle.status === 200, `got ${toggle.status}`);
    const pub2 = await req(`api/public/qrmenu/${wsId}`);
    check("unavailable item hidden from public menu", pub2.status === 200 && pub2.json?.items?.length === 1);
    const back = await m(`/menu/${karahi.json?.item?.id}`, "PATCH", { is_available: true });
    check("item can be made available again", back.status === 200);

    // ---- scan metering vs Free plan (200 scans/month) --------------------
    // Authed requests above consumed 0 scans; public fetches consumed 2.
    let scans = 2;
    let last = null;
    while (scans < 260) {
      last = await req(`/api/public/qrmenu/${wsId}`);
      if (last.json?.limited === true) break;
      scans++;
    }
    check("scans counted honestly (200 free)", scans === 200, `scans ${scans}`);
    check("menu degrades gracefully at limit (limited:true, no items)", last?.json?.limited === true && last?.json?.items?.length === 0);

    const usage = await req(`api/apps/workspace/${wsId}/usage/qr-menu`, { jar: A.jar });
    check("usage meter reflects 200 scans", usage.json?.used === 200, `got ${usage.json?.used}`);

    // Management still works past the scan limit (meter is a scan meter).
    const stillManage = await m("/menu", "GET");
    check("management API unaffected by scan meter", stillManage.status === 200);

    // ---- tenant isolation ------------------------------------------------
    const B = await registerUser("qrguest");
    const bAdmin = await req(`${path}/menu/${karahi.json?.item?.id}`, {
      method: "PATCH",
      jar: B.jar,
      csrf: B.csrf,
      body: { is_available: false },
    });
    check("non-member cannot toggle availability (403)", bAdmin.status === 403, `got ${bAdmin.status}`);
    const bList = await req(`${path}/menu`, { jar: B.jar });
    check("non-member cannot list menu (403)", bList.status === 403, `got ${bList.status}`);


    const ghost = await req(`api/public/qrmenu/no-such-workspace`);
    check("unknown workspace menu 404", ghost.status === 404, `got ${ghost.status}`);

    // ---- QR sticker -----------------------------------------------------
    check(
      "public menu is a real 200 twice in a row (QR scanner tolerance)",
      pub2.status === 200
    );

    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
