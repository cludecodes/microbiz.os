-- Phase 2: extend plan limits so the CV generator and PDF tools meter like
-- the Phase 1 products. Feature keys must exist in every plan's limits map
-- (deny by default) — apps.ts maps app id + feature suffix to these keys.
-- Free gets a small taste; Starter gets working allowances; Pro is unlimited.

UPDATE plans SET limits = json_set(
  limits,
  '$."cv-generator.monthly"', 1,
  '$."pdf-tools.monthly"', 2
) WHERE id = 'free';

UPDATE plans SET limits = json_set(
  limits,
  '$."cv-generator.monthly"', 5,
  '$."pdf-tools.monthly"', 10
) WHERE id IN ('starter', 'starter-usd');

UPDATE plans SET limits = json_set(
  limits,
  '$."cv-generator.monthly"', json('null'),
  '$."pdf-tools.monthly"', json('null')
) WHERE id IN ('pro', 'pro-usd');
