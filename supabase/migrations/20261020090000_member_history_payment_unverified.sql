-- Display-only historical evidence is not a purchase, payment or collection authority.
-- Preserve the existing NOT NULL, default and four financial payment statuses.
ALTER TABLE public.member_membership_history
  DROP CONSTRAINT member_membership_history_payment_status_chk;
ALTER TABLE public.member_membership_history
  ADD CONSTRAINT member_membership_history_payment_status_chk
  CHECK (payment_status IN ('unpaid', 'paid', 'partial', 'voided', 'unverified'));

CREATE FUNCTION public.guard_member_history_payment_unverified()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  payload jsonb;
  source_notes jsonb;
  field text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.payment_status = 'unverified' THEN
      RAISE EXCEPTION 'Unverified history cannot be deleted or replaced without a future reviewed correction'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- Retain the approved display-only source guard even if a writer (or an
  -- earlier/later BEFORE trigger) tries to re-label the source as financial.
  BEGIN
    source_notes := NEW.notes::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    IF NEW.payment_status = 'unverified' THEN
      RAISE EXCEPTION 'Unverified history notes must contain valid source JSON'
        USING ERRCODE = '23514';
    END IF;
    source_notes := NULL;
  END;
  IF source_notes->>'approvalScope' = 'two_unverified_display_only_histories'
    AND NEW.payment_status IS DISTINCT FROM 'unverified' THEN
    RAISE EXCEPTION 'Unverified source cannot be used as financial history'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (OLD.payment_status = 'unverified' OR NEW.payment_status = 'unverified')
      AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
      RAISE EXCEPTION 'Unverified payment status cannot transition without a future reviewed correction'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.payment_status = 'unverified' THEN
      -- Keep source evidence and ownership immutable, including through generic APIs.
      IF (to_jsonb(NEW) - ARRAY['status','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN
        RAISE EXCEPTION 'Unverified history source, dates, identity and financial fields are immutable'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status = 'active' AND NEW.status = 'expired') THEN
        RAISE EXCEPTION 'Unverified history may expire but cannot activate'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.payment_status = 'unverified' THEN
    IF NEW.status IS NULL OR NEW.status NOT IN ('active','expired') THEN
      RAISE EXCEPTION 'Unverified history must be display-only active or expired'
        USING ERRCODE = '23514';
    END IF;
    -- Fail closed for future columns too. Explicit NULLs suppress existing defaults;
    -- even zero amounts are not evidence of a free or paid purchase.
    payload := to_jsonb(NEW) - ARRAY[
      'id','tenant_id','member_id','membership_year','tier_label',
      'term_start_date','term_end_date','status','payment_status',
      'notes','created_at','updated_at'
    ];
    FOR field IN SELECT key FROM jsonb_each(payload) WHERE value <> 'null'::jsonb LOOP
      RAISE EXCEPTION 'Unverified history cannot carry financial or billing authority: %', field
        USING ERRCODE = '23514';
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_member_history_payment_unverified() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_member_history_payment_unverified() TO service_role;

-- BEFORE rejects direct malicious changes; AFTER also checks the final tuple after
-- ALL existing BEFORE triggers (including successor/rolling source guards).
CREATE TRIGGER member_history_payment_unverified_before
BEFORE INSERT OR UPDATE OR DELETE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.guard_member_history_payment_unverified();
CREATE TRIGGER member_history_payment_unverified_after
AFTER INSERT OR UPDATE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.guard_member_history_payment_unverified();
