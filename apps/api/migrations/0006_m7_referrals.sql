-- M7 (Phase 3): enable the Referral & Affiliate app and add its feature key to
-- every plan's limits map (deny by default). Referrals are a user-level
-- capability rather than a metered workspace feature, so the limit is null
-- (unlimited) everywhere; usage is tracked via the referrals/commissions
-- tables and admin lifecycle instead of usage_events.

UPDATE applications SET enabled = 1 WHERE id = 'referrals';

UPDATE plans SET limits = json_set(limits, '$."referrals.general"', json('null'));
