import { describe, expect, it } from "vitest";
import {
  addBillingMonth,
  receiptPostings,
  refundPostings,
  settlementPostings,
  validateJournal,
} from "@microbiz/shared";

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

  it("builds a balanced hosted-receipt journal including the provider fee", () => {
    const postings = receiptPostings(1500000, 30000, "PKR", { settledDirectly: false });
    expect(validateJournal({ postings })).toEqual({ ok: true });
    const net = postings.find((p) => p.account === "available_balance");
    expect(net?.amount_minor).toBe(1470000);
  });

  it("builds a balanced direct receipt for bank transfers without a fee line", () => {
    const postings = receiptPostings(1500000, 0, "PKR", { settledDirectly: true });
    expect(validateJournal({ postings })).toEqual({ ok: true });
    expect(postings.map((p) => p.account)).toEqual(["settled_bank", "gross_receipts"]);
  });

  it("refuses a fee that exceeds the receipt", () => {
    expect(() => receiptPostings(1000, 1000, "PKR", { settledDirectly: false })).toThrow();
    expect(() => receiptPostings(1000, 1500, "PKR", { settledDirectly: false })).toThrow();
  });

  it("builds balanced refund and settlement journals", () => {
    expect(validateJournal({ postings: refundPostings(5000, "USD") })).toEqual({ ok: true });
    expect(validateJournal({ postings: settlementPostings(1470000, "PKR") })).toEqual({ ok: true });
  });

  it("refunds from settled bank funds when the payout already landed", () => {
    const postings = refundPostings(5000, "USD", { fromSettledBank: true });
    expect(validateJournal({ postings })).toEqual({ ok: true });
    expect(postings.find((p) => p.direction === "CREDIT")?.account).toBe("settled_bank");
  });

  it("records a payout fee when the bank credit is smaller than net held funds", () => {
    // ₨14,700 was held; the payout credited ₨14,000 and took ₨700 at payout.
    const postings = settlementPostings(1470000, "PKR", 1400000);
    expect(validateJournal({ postings })).toEqual({ ok: true });
    expect(postings).toContainEqual({
      account: "settled_bank",
      direction: "DEBIT",
      currency: "PKR",
      amount_minor: 1400000,
    });
    expect(postings).toContainEqual({
      account: "payout_fees",
      direction: "DEBIT",
      currency: "PKR",
      amount_minor: 70000,
    });
  });

  it("refuses a payout larger than the net held balance", () => {
    expect(() => settlementPostings(1000, "PKR", 1001)).toThrow();
    expect(() => settlementPostings(1000, "PKR", -1)).toThrow();
  });

  it("adds a calendar month and clamps month-end dates", () => {
    expect(addBillingMonth("2026-01-31T10:00:00.000Z")).toBe("2026-02-28T10:00:00.000Z");
    expect(addBillingMonth("2024-01-31T00:00:00.000Z")).toBe("2024-02-29T00:00:00.000Z");
    expect(addBillingMonth("2026-11-06T08:30:00.000Z")).toBe("2026-12-06T08:30:00.000Z");
    expect(addBillingMonth("2026-12-15T08:30:00.000Z")).toBe("2027-01-15T08:30:00.000Z");
  });
});
