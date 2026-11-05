-- Admin Start may begin before today, but must never activate an expired term.
-- Keep the owner lock, policy snapshots, confirmation and financial safeguards.
BEGIN;
DO $migration$
DECLARE definition text; old text; replacement text;
BEGIN
  SELECT pg_get_functiondef('public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure) INTO definition;
  old := 'starts IS NULL OR starts<today OR ends IS NULL OR ends<starts';
  replacement := 'starts IS NULL OR ends<today OR ends IS NULL OR ends<starts';
  IF position(old IN definition)>0 THEN
    definition := replace(definition,old,replacement);
  ELSIF position(replacement IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected member Start date authority';
  END IF;
  old := 'SELECT to_jsonb(t) INTO vat FROM system_settings t WHERE tenant_id=p_tenant_id AND setting_key=''xero_vat_rates_''||p_tenant_id::text;';
  replacement := $vat$
  -- This exact suffixed key is tenant-owned even when the legacy writer leaves
  -- tenant_id null. Do not fall back to a global unsuffixed cache.
  IF (SELECT count(*) FROM system_settings WHERE setting_key='xero_vat_rates_'||p_tenant_id::text)>1
    OR EXISTS (SELECT FROM system_settings WHERE setting_key='xero_vat_rates_'||p_tenant_id::text
      AND tenant_id IS NOT NULL AND tenant_id<>p_tenant_id) THEN
    RAISE EXCEPTION 'Ambiguous or incorrectly owned membership tax rates';
  END IF;
  SELECT to_jsonb(t) INTO vat FROM system_settings t WHERE setting_key='xero_vat_rates_'||p_tenant_id::text;
  $vat$;
  IF position(old IN definition)>0 THEN
    definition := replace(definition,old,replacement);
  ELSIF position('Ambiguous or incorrectly owned membership tax rates' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected member Start tax authority';
  END IF;
  old := 'INSERT INTO member_membership_history (tenant_id,member_id,membership_year,config_id,band_id,tier_label,';
  replacement := $overlap$
  IF EXISTS (SELECT FROM member_membership_history WHERE tenant_id=p_tenant_id AND member_id=p_member_id
    AND payment_status IS DISTINCT FROM 'voided'
    AND term_start_date<=ends AND term_end_date>=starts) THEN
    RAISE EXCEPTION 'Membership dates overlap an existing purchase';
  END IF;
  INSERT INTO member_membership_history (tenant_id,member_id,membership_year,config_id,band_id,tier_label,$overlap$;
  IF position('Membership dates overlap an existing purchase' IN definition)=0 THEN
    IF position(old IN definition)=0 THEN RAISE EXCEPTION 'Unexpected member Start insert authority'; END IF;
    definition := replace(definition,old,replacement);
  END IF;
  EXECUTE definition;
END $migration$;
COMMIT;
