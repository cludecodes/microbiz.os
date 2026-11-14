/**
 * Lead Marketplace integration test (Phase 3).
 *
 * Covers: launcher entitlement, listing qualified+consented leads (metered on
 * the Free plan), masked marketplace browse, buyer purchase with a payment
 * intent, contact masking before delivery, automatic delivery through the
 * authoritative confirm path (lead copied into the buyer's workspace,
 * listing marked sold), and the auto-minted pending lead_sale commission.
 *
 * Run: node test/lm.mjs
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

const PORT = 9700 + (Date.now() % 40);
const PRICE = 80000; // minor units; 10% commission = 8000

async function registerWithTag(tag, referralCode) {
  const csrfRes = await req("/api/auth/csrf");
  const email = `lm-${tag}-${Date.now() % 1000000}@example.com`;
  const reg = await req("/api/auth/register", {
    method: "POST",
    jar: csrfRes.jar,
    csrf: csrfRes.json.token,
    body: {
      email,
      password: "strong-password-1",
      name: `LM ${tag}`,
      locale: "en",
      ...(referralCode ? { referral_code: referralCode } : {}),
    },
  });
  if (reg.status !== 201) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const me = await req("/api/auth/me", { jar: reg.jar });
  return { jar: reg.jar, csrf: csrfRes.json.token, email, user: me.json.user, workspace: me.json.workspaces[0] };
}

async function main() {
  console.log("== LM test: preparing local database ==");
  clearLocalRateLimits();
  execSync("npx wrangler d1 migrations apply microbiz --local", { stdio: "inherit", shell: true });

  console.log(`== LM test: starting wrangler dev on :${PORT} ==`);
  setPort(PORT);
  const kill = bootWrangler(PORT);

  try {
    await waitForHealth(BASE());
    console.log("== LM test: running flow ==");

    // ---- setup: referrer R -> seller S; seed qualified leads into S -----------
    const R = await registerUser("lmref");
    const codeRes = await req("api/referrals", { method: "POST", body: {}, jar: R.jar, csrf: R.csrf });
    const code = codeRes.json?.referral?.code;
    const S = await registerWithTag("seller", code);
    const B = await registerWithTag("buyer");
    const sWs = S.workspace.id;
    const bWs = B.workspace.id;

    const s = (sub, method, body) => req(`api/leadmarket/${sWs}${sub}`, { method, body, jar: S.jar, csrf: S.csrf });
    const b = (sub, method, body) => req(`api/leadmarket/${bWs}${sub}`, { method, body, jar: B.jar, csrf: B.csrf });

    const seedLeads = (n, qualified, consent) =>
      execSync(
        `npx wrangler d1 execute microbiz --local --command "INSERT INTO leads (id, workspace_id, source, contact_name, contact_email, contact_phone, qualification_score, status, consent_marketing, notes, created_at) VALUES ('${crypto.randomUUID()}', '${sWs}', 'manual', 'Lead ${n}', 'lead${n}@example.com', '+92300${n}000000', ${60 + n}, '${qualified ? "qualified" : "new"}', ${consent ? 1 : 0}, 'Inbound via referral', '2026-01-01T00:00:00Z')"`,
        { stdio: "ignore", shell: true }
      );
    seedLeads(1, true, true);
    seedLeads(2, true, true);
    seedLeads(3, true, true); // hits the Free listing limit
    seedLeads(4, false, true); // not qualified
    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE leads SET consent_marketing = 0 WHERE contact_name = 'Lead 2'"`,
      { stdio: "ignore", shell: true }
    );

    // ---- entitlements ----------------------------------------------------------
    const anon = await req(`api/leadmarket/${sWs}/listings`);
    check("marketplace browse requires auth (401 anonymous)", anon.status === 401, `got ${anon.status}`);

    const launcher = await req(`api/apps/workspace/${sWs}`, { jar: S.jar, csrf: S.csrf });
    const lm = (launcher.json?.apps ?? []).find((a) => a.id === "lead-marketplace");
    check("launcher lists lead-marketplace as enabled", lm?.enabled === true, JSON.stringify(lm));

    // ---- seller listings --------------------------------------------------------
    const myLeads = await s("/my-leads");
    check("my-leads returns only qualified+consented leads", myLeads.status === 200 && (myLeads.json?.leads ?? []).filter((l) => l.contact_name === "Lead 1" || l.contact_name === "Lead 3").length === 2, JSON.stringify(myLeads.json?.leads));

    const l1 = await s("/listings", "POST", { lead_id: (myLeads.json?.leads ?? []).find((l) => l.contact_name === "Lead 1")?.id, price_minor: PRICE, currency: "PKR" });
    check("create listing returns 201", l1.status === 201 && Boolean(l1.json?.listing?.id), `got ${l1.status} ${JSON.stringify(l1.json)}`);
    const listingId = l1.json?.listing?.id;

    const dup = await s("/listings", "POST", { lead_id: (myLeads.json?.leads ?? []).find((l) => l.contact_name === "Lead 1")?.id, price_minor: PRICE, currency: "PKR" });
    check("duplicate active listing rejected (409)", dup.status === 409, `got ${dup.status}`);

    const l3 = await s("/listings", "POST", { lead_id: (myLeads.json?.leads ?? []).find((l) => l.contact_name === "Lead 3")?.id, price_minor: PRICE, currency: "PKR" });
    check("second listing within Free limit (201)", l3.status === 201, `got ${l3.status}`);

    const over = await s("/listings", "POST", { lead_id: crypto.randomUUID(), price_minor: PRICE, currency: "PKR" });
    check("third listing blocked by the Free monthly limit (403)", over.status === 403, `got ${over.status}`);

    const cons = await s("/listings", "POST", { lead_id: crypto.randomUUID(), price_minor: PRICE, currency: "PKR" });
    check("unknown lead is rejected", cons.status === 403 || cons.status === 404, `got ${cons.status}`);

    const usage = await req(`api/apps/workspace/${sWs}/usage/lead-marketplace`, { jar: S.jar, csrf: S.csrf });
    check("usage endpoint counts 2 published listings", usage.json?.used === 2 && usage.json?.limit === 2, JSON.stringify(usage.json));

    const remove = await s(`/listings/${l3.json?.listing?.id}`, "DELETE");
    check("seller can remove their own listing", remove.status === 200, `got ${remove.status}`);

    const foreignRemove = await b(`/listings/${listingId}`, "DELETE");
    check("buyer cannot remove someone else's listing (404)", foreignRemove.status === 404, `got ${foreignRemove.status}`);

    // ---- masked browse ----------------------------------------------------------
    const browse = await b("/listings");
    const row = (browse.json?.listings ?? []).find((x) => x.id === listingId);
    check("marketplace browse shows the listing", Boolean(row), JSON.stringify(browse.json?.listings));
    check("browse payload never leaks contact details", !JSON.stringify(browse.json).includes("lead1@example.com") && !JSON.stringify(browse.json).includes("+923001"), JSON.stringify(browse.json).slice(0, 200));

    // ---- buyer purchase ----------------------------------------------------------
    const own = await s("/purchases", "POST", { listing_id: listingId, provider: "bank" });
    check("seller cannot buy their own listing (409)", own.status === 409, `got ${own.status}`);

    const wrongProvider = await b("/purchases", "POST", { listing_id: listingId, provider: "lemonsqueezy" });
    check("USD-only provider cannot settle PKR listing (422)", wrongProvider.status === 422, `got ${wrongProvider.status}`);

    const pur = await b("/purchases", "POST", { listing_id: listingId, provider: "bank" });
    check("purchase created (201) with payment intent", pur.status === 201 && Boolean(pur.json?.purchase?.id) && pur.json?.purchase?.status === "awaiting_payment", `got ${pur.status} ${JSON.stringify(pur.json)}`);
    const purchaseId = pur.json.purchase.id;
    const paymentId = pur.json.payment.id;
    check("payment reference is a bank reference", String(pur.json.payment.provider_txn_ref).startsWith("MB-"), JSON.stringify(pur.json.payment));

    const soldOut = await b("/purchases", "POST", { listing_id: listingId, provider: "bank" });
    check("the same listing cannot be bought twice while awaiting payment (409)", soldOut.status === 409, `got ${soldOut.status}`);

    // Before confirmation the buyer must NOT see the contact details.
    const pre = await b("/purchases");
    const preRow = (pre.json?.purchases ?? []).find((x) => x.id === purchaseId);
    check("buyer cannot see contact details before delivery", preRow?.contact_name === null && preRow?.contact_email === null, JSON.stringify(preRow));

    // ---- confirm through the authoritative path -----------------------------------
    execSync(
      `npx wrangler d1 execute microbiz --local --command "UPDATE users SET is_super_admin = 1 WHERE email = '${B.email}'"`,
      { stdio: "ignore", shell: true }
    );

    const confirm = await req(`api/admin/payments/${paymentId}/confirm`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { amount_minor: PRICE, reference: pur.json.payment.provider_txn_ref },
    });
    check("admin confirm succeeds and delivers the lead", confirm.status === 200 && confirm.json?.lead_delivered === true, `got ${confirm.status} ${JSON.stringify(confirm.json)}`);

    const post = await b("/purchases");
    const postRow = (post.json?.purchases ?? []).find((x) => x.id === purchaseId);
    check("purchase delivered with contact details revealed", postRow?.status === "delivered" && postRow?.contact_name === "Lead 1" && postRow?.contact_email === "lead1@example.com", JSON.stringify(postRow));

    const browseAfter = await b("/listings");
    check("delivered listing disappears from the marketplace (sold)", !(browseAfter.json?.listings ?? []).some((x) => x.id === listingId), JSON.stringify(browseAfter.json?.listings));

    // The buyer's workspace now owns a copy of the lead.
    const buyerLeads = await b("/my-leads");
    const copied = (buyerLeads.json?.leads ?? []).find((l) => l.contact_name === "Lead 1");
    check("delivered lead exists in the buyer's workspace", Boolean(copied), JSON.stringify(buyerLeads.json?.leads));

    const replay = await req(`api/admin/payments/${paymentId}/confirm`, {
      method: "POST",
      jar: B.jar,
      csrf: B.csrf,
      body: { amount_minor: PRICE, reference: pur.json.payment.provider_txn_ref },
    });
    check("confirm replay is rejected (409 already confirmed)", replay.status === 409, `got ${replay.status}`);

    // ---- auto-minted affiliate commission (M7 lead_sale) ---------------------------
    const comm = await req("api/commissions/me", { jar: R.jar, csrf: R.csrf });
    const auto = (comm.json?.commissions ?? []).find((c) => c.basis === "lead_sale");
    check("referrer has a pending lead_sale commission", Boolean(auto) && auto?.status === "pending", JSON.stringify(comm.json?.commissions));
    check("commission is 10% of the receipt", auto?.amount_minor === PRICE / 10 && auto?.currency === "PKR", JSON.stringify(auto));

    console.log("== LM test: finished checks ==");
    printAndExit();
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
