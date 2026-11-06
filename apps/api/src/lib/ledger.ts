import type { Env } from "../types";
import { validateJournal, type LedgerPosting } from "@microbiz/shared";
import { nowIso, uuid } from "./http";

/**
 * Persist a balanced double-entry journal.
 *
 * The shared validateJournal() runs BEFORE any INSERT: unbalanced,
 * cross-currency or non-positive postings can never reach D1. Postings are
 * inserted in the same batch as their journal header.
 */
export class LedgerError extends Error {}

export interface PostJournalInput {
  workspaceId: string | null;
  memo: string;
  currency: "PKR" | "USD";
  refType?: string | null;
  refId?: string | null;
  postings: LedgerPosting[];
}

export async function postJournal(env: Env, input: PostJournalInput): Promise<string> {
  const check = validateJournal({ postings: input.postings });
  if (!check.ok) throw new LedgerError(`refusing unbalanced journal: ${check.error}`);
  if (input.postings.some((p) => p.currency !== input.currency)) {
    throw new LedgerError("refusing journal: posting currency differs from journal currency");
  }

  const journalId = uuid();
  const ts = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO ledger_journals (id, workspace_id, memo, currency, ref_type, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      journalId,
      input.workspaceId,
      input.memo,
      input.currency,
      input.refType ?? null,
      input.refId ?? null,
      ts
    ),
    ...input.postings.map((p) =>
      env.DB.prepare(
        `INSERT INTO ledger_postings (id, journal_id, workspace_id, account, direction, amount_minor, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        uuid(),
        journalId,
        input.workspaceId,
        p.account,
        p.direction,
        p.amount_minor,
        input.refType ?? null,
        input.refId ?? null,
        ts
      )
    ),
  ];
  await env.DB.batch(statements);
  return journalId;
}
