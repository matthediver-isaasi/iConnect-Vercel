-- Preserve the imported-consent guard, including any prior reviewed exceptions.
-- Only a bound immutable expiry receipt is a permitted additional audit field.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$
DECLARE definition text;
  fields text := 'ARRAY[''status'',''payment_status'',''paid_at'',''updated_at'',''notes'']';
  anchor text := E'ELSE\n    IF NEW.id IS DISTINCT FROM a.history_id';
BEGIN
  IF to_regprocedure('public.bnms_dd_alpha_canonical_guard()') IS NULL THEN RETURN; END IF;
  definition:=pg_get_functiondef('public.bnms_dd_alpha_canonical_guard()'::regprocedure);
  IF (length(definition)-length(replace(definition,fields,'')))/length(fields)<>2
    OR (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'Review the imported membership guard before installing expiry compatibility';
  END IF;
  definition:=replace(definition,fields,
    'ARRAY[''status'',''payment_status'',''paid_at'',''updated_at'',''notes'',''payment_grace_exit_id'']');
  definition:=replace(definition,anchor,$guard$ELSE
    IF NEW.payment_grace_exit_id IS DISTINCT FROM OLD.payment_grace_exit_id
      AND NOT EXISTS (SELECT FROM public.membership_payment_grace_exit e
        WHERE e.id=NEW.payment_grace_exit_id AND e.history_id=OLD.id
          AND e.tenant_id=OLD.tenant_id AND e.member_id=OLD.member_id
          AND e.agreement_id=OLD.billing_agreement_id AND e.config_id=OLD.config_id
          AND e.original_term_start_date=OLD.term_start_date
          AND e.original_term_end_date=OLD.term_end_date
          AND NEW.status='expired' AND OLD.payment_grace_exit_id IS NULL
          AND (to_jsonb(NEW)-ARRAY['status','payment_grace_exit_id','updated_at'])
            = (to_jsonb(OLD)-ARRAY['status','payment_grace_exit_id','updated_at'])) THEN
      RAISE EXCEPTION 'Imported membership expiry requires bound immutable audit evidence';
    END IF;
    IF NEW.id IS DISTINCT FROM a.history_id$guard$);
  EXECUTE definition;
END $$;
COMMIT;
