/**
 * Double-entry-style ledger invariants.
 *
 * Accounts (account namespaced by workspace):
 *   gross_receipts   - total money received from customers (per provider)
 *   processing_fees  - fees paid to payment providers (contra account)
 *   refunds          - money returned to customers (contra account)
 *   available_balance- what the business actually holds = receipts - fees - refunds
 *   settled_bank     - funds confirmed settled into a bank account
 *
 * Rules:
 *  - Every posting forms a balanced journal: sum(debits) == sum(credits)
 *    for the SAME currency.
 *  - Settlement is tracked independently of payment status.
 *  - This is NOT a customer wallet: customers do not hold balances here.
 */

export type LedgerDirection = "DEBIT" | "CREDIT";

export type LedgerAccount =
  | "gross_receipts"
  | "processing_fees"
  | "refunds"
  | "available_balance"
  | "settled_bank"
  | "payout_fees"
  | "commission_expense";

export interface LedgerPosting {
  account: LedgerAccount;
  direction: LedgerDirection;
  currency: string;
  amount_minor: number;
}

export interface LedgerJournal {
  postings: LedgerPosting[];
}

/**
 * Validate a journal: non-empty, all positive amounts, single currency,
 * and balanced (sum debits == sum credits).
 */
export function validateJournal(journal: LedgerJournal): { ok: true } | { ok: false; error: string } {
  if (journal.postings.length < 2) {
    return { ok: false, error: "journal must contain at least two postings" };
  }
  const currencies = new Set(journal.postings.map((p) => p.currency));
  if (currencies.size > 1) {
    return { ok: false, error: "journal mixes currencies" };
  }
  let debits = 0;
  let credits = 0;
  for (const p of journal.postings) {
    if (!Number.isInteger(p.amount_minor) || p.amount_minor <= 0) {
      return { ok: false, error: "posting amounts must be positive integers" };
    }
    if (p.direction === "DEBIT") debits += p.amount_minor;
    else credits += p.amount_minor;
  }
  if (debits !== credits) {
    return { ok: false, error: `unbalanced journal: debits=${debits} credits=${credits}` };
  }
  return { ok: true };
}

/**
 * Net effect of postings on a running balance per account.
 * Convention: assets (available_balance, settled_bank) increase with DEBIT;
 * expense/fee accounts increase with CREDIT by default here the caller
 * decides - we simply expose raw sums to keep ledger semantics explicit.
 */
export function summarizePostings(
  postings: LedgerPosting[]
): Record<LedgerAccount, { debit: number; credit: number }> {
  const map = new Map<LedgerAccount, { debit: number; credit: number }>();
  for (const p of postings) {
    const entry = map.get(p.account) ?? { debit: 0, credit: 0 };
    if (p.direction === "DEBIT") entry.debit += p.amount_minor;
    else entry.credit += p.amount_minor;
    map.set(p.account, entry);
  }
  return Object.fromEntries(map) as Record<LedgerAccount, { debit: number; credit: number }>;
}
