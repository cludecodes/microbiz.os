import { describe, expect, it } from "vitest";
import { validateJournal } from "@microbiz/shared";

/**
 * Double-entry ledger contract used by the payments milestone:
 * journals must never persist unbalanced or cross-currency postings, and a
 * confirmed payment posts gross receipts minus fees against available balance.
 */
describe("payment ledger postings", () => {
  it("a confirmed checkout balances gross receipts, fees and available balance", () => {
    // Customer pays ₨15,000; provider takes ₨300 fee.
    const journal = validateJournal({
      postings: [
        { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 1470000 },
        { account: "processing_fees", direction: "DEBIT", currency: "PKR", amount_minor: 30000 },
        { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 1500000 },
      ],
    });
    expect(journal).toEqual({ ok: true });
  });

  it("a refund reverses gross receipts without touching settlement", () => {
    const journal = validateJournal({
      postings: [
        { account: "refunds", direction: "DEBIT", currency: "USD", amount_minor: 5000 },
        { account: "available_balance", direction: "CREDIT", currency: "USD", amount_minor: 5000 },
      ],
    });
    expect(journal).toEqual({ ok: true });
  });

  it("settlement posting moves available balance to settled bank funds", () => {
    const journal = validateJournal({
      postings: [
        { account: "settled_bank", direction: "DEBIT", currency: "PKR", amount_minor: 1470000 },
        { account: "available_balance", direction: "CREDIT", currency: "PKR", amount_minor: 1470000 },
      ],
    });
    expect(journal).toEqual({ ok: true });
  });

  it("refuses to balance a missing fee line", () => {
    expect(
      validateJournal({
        postings: [
          { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 1470000 },
          { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 1500000 },
        ],
      }).ok
    ).toBe(false);
  });
});
