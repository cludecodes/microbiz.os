import type { Env } from "../types";
import type { ReferralRow } from "@microbiz/shared";
import { nowIso, uuid } from "./http";

/** Referral codes look like `MBC-ABC123` (uppercase, 3-32 chars). */
export function generateReferralCode(): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `MBC-${token}`;
}

export async function newUniqueReferralCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const clash = await env.DB.prepare(`SELECT 1 FROM referrals WHERE code = ?`).bind(code).first();
    if (!clash) return code;
  }
  throw new Error("could not allocate a unique referral code");
}

/** Create an unused personal referral code for a user. */
export async function createReferral(env: Env, referrerUserId: string): Promise<ReferralRow> {
  const id = uuid();
  const code = await newUniqueReferralCode(env);
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO referrals (id, referrer_user_id, code, referred_user_id, converted_at, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?)`
  )
    .bind(id, referrerUserId, code, ts)
    .run();

  return {
    id,
    code,
    referrer_user_id: referrerUserId,
    referred_user_id: null,
    converted_at: null,
    created_at: ts,
  };
}

export async function findUnusedReferralByCode(
  env: Env,
  code: string
): Promise<{ id: string; code: string; referrer_user_id: string; referred_user_id: string | null } | null> {
  return env.DB.prepare(
    `SELECT id, code, referrer_user_id, referred_user_id
     FROM referrals
     WHERE code = ? AND referred_user_id IS NULL
     LIMIT 1`
  )
    .bind(code)
    .first<{ id: string; code: string; referrer_user_id: string; referred_user_id: string | null }>();
}
