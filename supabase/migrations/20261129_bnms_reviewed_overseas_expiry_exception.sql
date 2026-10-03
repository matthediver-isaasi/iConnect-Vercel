-- Operator-approved exception for one historical record, NOT a tier-wide change.
-- Retain every existing ownership, history, date, immutability and grant check.
DO $migration$
DECLARE
  definition text;
  original text := 'OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(
      ''renewal_open_days'',c.renewal_open_days,''renewal_grace_days'',c.renewal_grace_days,
      ''renewal_disable_login'',c.renewal_disable_login,''renewal_change_role'',c.renewal_change_role,
      ''renewal_fallback_role_id'',c.renewal_fallback_role_id)';
  replacement text;
BEGIN
  replacement := 'OR (NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(
      ''renewal_open_days'',c.renewal_open_days,''renewal_grace_days'',c.renewal_grace_days,
      ''renewal_disable_login'',c.renewal_disable_login,''renewal_change_role'',c.renewal_change_role,
      ''renewal_fallback_role_id'',c.renewal_fallback_role_id)
    AND NOT (
      NEW.tenant_id = ''ff2df806-b321-4254-b651-3af11fccf1db''::uuid
      AND NEW.history_id = ''0ff50f40-15b1-567f-a4d1-c353d9342fae''::uuid
      AND NEW.member_id = ''d91d8aa3-4981-4ba0-b923-ab6ccb092f9f''::uuid
      AND NEW.config_id = ''1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce''::uuid
      AND NEW.config_name = ''2026-2027 Overseas full member''
      AND NEW.expiry_date = DATE ''2026-09-29''
      AND h.tier_label = ''Full Membership Overseas''
      AND NEW.approval_source = ''operator''
      AND NEW.approval_reference = ''BNMS reviewed nine-record expiry repair: operator approved uniform 90-day grace, then login disabled, no role changes; implementation and production application explicitly authorized.''
      AND NEW.policy_snapshot = ''{"renewal_open_days":90,"renewal_grace_days":90,"renewal_disable_login":true,"renewal_change_role":false,"renewal_fallback_role_id":null}''::jsonb
    ))';
  definition := pg_get_functiondef('public.guard_membership_expiry_policy_assignment()'::regprocedure);
  IF strpos(definition, replacement) > 0 THEN RETURN; END IF;
  IF strpos(definition, original) = 0
     OR (length(definition)-length(replace(definition, original, ''))) <> length(original) THEN
    RAISE EXCEPTION 'Expiry guard contract changed; review required before migration';
  END IF;
  EXECUTE replace(definition, original, replacement);
END $migration$;