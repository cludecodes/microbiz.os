import { describe, expect, it } from "vitest";
import { formatMoney, toMinorUnits } from "../src/money";
import { checkEntitlement, isSubscriptionActive } from "../src/entitlements";
import { summarizePostings, validateJournal } from "../src/ledger";
import { loginSchema, registerSchema, slugify } from "../src/schemas";

describe("money", () => {
  it("converts major amounts to minor units for PKR and USD", () => {
    expect(toMinorUnits("1500.50", "PKR")).toBe(150050);
    expect(toMinorUnits(45.99, "USD")).toBe(4599);
    expect(toMinorUnits("0.01", "USD")).toBe(1);
    expect(toMinorUnits("15000", "PKR")).toBe(1500000);
  });

  it("rejects invalid amounts", () => {
    expect(() => toMinorUnits("abc", "PKR")).toThrow();
    expect(() => toMinorUnits("1.999", "USD")).toThrow();
    expect(() => toMinorUnits("", "PKR")).toThrow();
  });

  it("formats money for display", () => {
    expect(formatMoney(150050, "PKR")).toBe("₨1,500.50");
    expect(formatMoney(4599, "USD")).toBe("$45.99");
    expect(formatMoney(0, "PKR")).toBe("₨0.00");
    expect(formatMoney(-1250, "USD")).toBe("-$12.50");
  });
});

describe("entitlements", () => {
  const freeLimits = {
    "whatsapp-crm.orders": 50,
    "qr-menu.scans": null,
    "invoices.monthly": 5,
  };

  it("allows usage within limit", () => {
    expect(checkEntitlement(freeLimits, "whatsapp-crm.orders", 49)).toEqual({ allowed: true });
  });

  it("denies when limit reached", () => {
    expect(checkEntitlement(freeLimits, "whatsapp-crm.orders", 50)).toEqual({
      allowed: false,
      reason: "limit_reached",
    });
  });

  it("allows unlimited features and denies unknown features", () => {
    expect(checkEntitlement(freeLimits, "qr-menu.scans", 999_999)).toEqual({ allowed: true });
    expect(checkEntitlement(freeLimits, "leads.marketplace", 0)).toEqual({
      allowed: false,
      reason: "feature_not_in_plan",
    });
  });

  it("classifies subscription status", () => {
    expect(isSubscriptionActive("trialing")).toBe(true);
    expect(isSubscriptionActive("active")).toBe(true);
    expect(isSubscriptionActive("canceled")).toBe(false);
    expect(isSubscriptionActive("past_due")).toBe(false);
  });
});

describe("ledger", () => {
  it("accepts a balanced single-currency journal", () => {
    const result = validateJournal({
      postings: [
        { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 149000 },
        { account: "processing_fees", direction: "DEBIT", currency: "PKR", amount_minor: 1000 },
        { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 150000 },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects unbalanced journals", () => {
    expect(
      validateJournal({
        postings: [
          { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 100 },
          { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 99 },
        ],
      })
    ).toEqual({ ok: false, error: "unbalanced journal: debits=100 credits=99" });
  });

  it("rejects mixed currencies and invalid amounts", () => {
    expect(
      validateJournal({
        postings: [
          { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 100 },
          { account: "gross_receipts", direction: "CREDIT", currency: "USD", amount_minor: 100 },
        ],
      }).ok
    ).toBe(false);
    expect(
      validateJournal({
        postings: [
          { account: "available_balance", direction: "DEBIT", currency: "PKR", amount_minor: 0 },
          { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 0 },
        ],
      }).ok
    ).toBe(false);
  });

  it("summarizes postings per account", () => {
    const summary = summarizePostings([
      { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 150000 },
      { account: "gross_receipts", direction: "CREDIT", currency: "PKR", amount_minor: 50000 },
      { account: "refunds", direction: "DEBIT", currency: "PKR", amount_minor: 20000 },
    ]);
    expect(summary.gross_receipts).toEqual({ debit: 0, credit: 200000 });
    expect(summary.refunds).toEqual({ debit: 20000, credit: 0 });
  });
});

describe("schemas", () => {
  it("validates registration input", () => {
    const ok = registerSchema.parse({
      email: "User@Example.COM",
      password: "longenough1",
      name: "Test User",
    });
    expect(ok.email).toBe("user@example.com");
    expect(ok.locale).toBe("en");
  });

  it("rejects short passwords", () => {
    expect(() =>
      registerSchema.parse({ email: "a@b.co", password: "short", name: "x" })
    ).toThrow();
  });

  it("validates login input", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(true);
  });

  it("slugifies workspace names", () => {
    expect(slugify("Ali's Restaurant")).toBe("ali-s-restaurant");
    expect(slugify("AB")).toBe("ab");
  });
});
