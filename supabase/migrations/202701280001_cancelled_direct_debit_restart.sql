-- Restart after a confirmed-cancelled individual GoCardless Direct Debit.
--
-- Owner decision: a confirmed-cancelled individual Direct Debit qualifies for
-- the payment-dated restart journey straight away. No failed payment, grace
-- expiry, approval or recorded payment-grace exit is required.
--
-- The cancelled agreement, plan, unpaid instalments and arrears are retained
-- exactly. The predecessor history keeps its original dates, payment status
-- and debt. A separate insert-only supersession receipt records that a restart
-- has been reserved against it (linked at reservation, so the pending
-- successor may coexist with the still-dated predecessor) and, once the new
-- payment is confirmed, that the predecessor was superseded. At that moment
-- the predecessor's status becomes 'expired'; its dates are never rewritten.
--
-- Every function patch uses a unique-anchor replacement so a drifted live
-- contract fails the migration instead of being silently overwritten. Each
-- patch is skipped when already installed, so the migration is re-runnable.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE IF NOT EXISTS public.membership_dd_restart_supersession(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  history_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  mandate_status text NOT NULL CHECK (mandate_status IN ('cancelled','failed','expired')),
  original_status text,
  original_payment_status text,
  original_term_start_date date NOT NULL,
  original_term_end_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  successor_history_id uuid,
  reservation_id uuid,
  CONSTRAINT membership_dd_restart_supersession_history_key UNIQUE (tenant_id,history_id),
  CONSTRAINT membership_dd_restart_supersession_plan_key UNIQUE (tenant_id,plan_id),
  CONSTRAINT membership_dd_restart_supersession_transition CHECK (
    (superseded_at IS NULL AND successor_history_id IS NULL AND reservation_id IS NULL)
    OR (superseded_at IS NOT NULL AND successor_history_id IS NOT NULL AND reservation_id IS NOT NULL))
);
ALTER TABLE public.membership_dd_restart_supersession ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_dd_restart_supersession FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_dd_restart_supersession TO service_role;

CREATE OR REPLACE FUNCTION public.guard_membership_dd_restart_supersession()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Restart supersession evidence cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'Restart supersession starts unsuperseded'; END IF;
    RETURN NEW;
  END IF;
  -- Only the single confirmed-payment transition is permitted.
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['superseded_at','successor_history_id','reservation_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['superseded_at','successor_history_id','reservation_id']) THEN
    RAISE EXCEPTION 'Restart supersession evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_membership_dd_restart_supersession ON public.membership_dd_restart_supersession;
CREATE TRIGGER guard_membership_dd_restart_supersession
  BEFORE INSERT OR UPDATE OR DELETE ON public.membership_dd_restart_supersession
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_dd_restart_supersession();

ALTER TABLE public.member_membership_history ADD COLUMN IF NOT EXISTS restart_supersession_id uuid
  REFERENCES public.membership_dd_restart_supersession(id);

-- A link is set once, only to a receipt bound to this exact row, and nothing
-- else may change in the same write. A linked predecessor can no longer
-- receive a payment-grace exit: the restart owns its successor.
CREATE OR REPLACE FUNCTION public.guard_membership_restart_supersession_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.restart_supersession_id IS NOT NULL THEN
      RAISE EXCEPTION 'Restart supersession can only be linked to an existing membership';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.restart_supersession_id IS DISTINCT FROM OLD.restart_supersession_id THEN
    IF OLD.restart_supersession_id IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.membership_dd_restart_supersession s
      WHERE s.id=NEW.restart_supersession_id AND s.history_id=OLD.id
        AND s.tenant_id=OLD.tenant_id AND s.member_id=OLD.member_id
        AND s.agreement_id=OLD.billing_agreement_id
        AND s.original_term_start_date=OLD.term_start_date
        AND s.original_term_end_date=OLD.term_end_date
        AND s.original_status IS NOT DISTINCT FROM OLD.status
        AND s.original_payment_status IS NOT DISTINCT FROM OLD.payment_status)
      OR (to_jsonb(NEW)-ARRAY['restart_supersession_id','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['restart_supersession_id','updated_at']) THEN
      RAISE EXCEPTION 'Restart supersession requires bound immutable evidence';
    END IF;
  END IF;
  IF OLD.restart_supersession_id IS NOT NULL
    AND to_jsonb(NEW)->'payment_grace_exit_id' IS DISTINCT FROM to_jsonb(OLD)->'payment_grace_exit_id' THEN
    RAISE EXCEPTION 'A restarted Direct Debit membership cannot receive a payment-grace exit';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_membership_restart_supersession_link ON public.member_membership_history;
CREATE TRIGGER guard_membership_restart_supersession_link
  BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_restart_supersession_link();

-- Shared confirmed-cancelled evidence. Mirrors the GoCardless webhook's
-- terminal confirmation: an API-confirmed cancelled/failed/expired mandate
-- moves both agreement and plan to payment_plan_cancelled.
CREATE OR REPLACE FUNCTION public.membership_cancelled_dd_restart_evidence(
  p_tenant_id uuid,p_member_id uuid,p_history_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h jsonb; a jsonb; p jsonb; s jsonb; mandate_status text; plans integer;
  cancelled text[]:=ARRAY['payment_plan_cancelled','cancelled','canceled'];
BEGIN
  SELECT to_jsonb(x) INTO h FROM public.member_membership_history x
    WHERE id=p_history_id AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF h IS NULL OR h->>'organization_id' IS NOT NULL OR h->>'billing_agreement_id' IS NULL
    OR h->>'payment_grace_exit_id' IS NOT NULL
    OR h->>'term_start_date' IS NULL OR h->>'term_end_date' IS NULL THEN RETURN NULL; END IF;
  IF h->>'restart_supersession_id' IS NOT NULL THEN
    SELECT to_jsonb(x) INTO s FROM public.membership_dd_restart_supersession x
      WHERE id=(h->>'restart_supersession_id')::uuid AND history_id=p_history_id
        AND tenant_id=p_tenant_id AND member_id=p_member_id
        AND agreement_id=(h->>'billing_agreement_id')::uuid
        AND original_term_start_date=(h->>'term_start_date')::date
        AND original_term_end_date=(h->>'term_end_date')::date;
    IF s IS NULL THEN RETURN NULL; END IF;
  ELSIF coalesce(h->>'status','') IN ('cancelled','canceled','void','expired_checkout','replaced','cancelled_by_request') THEN
    RETURN NULL;
  END IF;
  SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x
    WHERE id=(h->>'billing_agreement_id')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF a IS NULL OR a->>'organization_id' IS NOT NULL OR a->>'provider' IS DISTINCT FROM 'gocardless'
    OR a->>'cancelled_for_switch_at' IS NOT NULL OR NOT (a->>'status' = ANY(cancelled))
    OR a->>'gocardless_mandate_id' IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO plans FROM public.membership_payment_plans WHERE billing_agreement_id=(a->>'id')::uuid;
  IF plans<>1 THEN RETURN NULL; END IF;
  SELECT to_jsonb(x) INTO p FROM public.membership_payment_plans x
    WHERE billing_agreement_id=(a->>'id')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF p IS NULL OR p->>'organization_id' IS NOT NULL OR p->>'provider' IS DISTINCT FROM 'gocardless'
    OR NOT (p->>'status' = ANY(cancelled)) THEN RETURN NULL; END IF;
  SELECT m.status INTO mandate_status FROM public.gocardless_mandates m
    WHERE m.tenant_id=p_tenant_id AND m.gocardless_mandate_id=a->>'gocardless_mandate_id'
      AND m.environment IS NOT DISTINCT FROM a->>'environment';
  IF mandate_status IS NULL OR mandate_status NOT IN ('cancelled','failed','expired') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('tenant_id',p_tenant_id,'member_id',p_member_id,'history_id',p_history_id,
    'agreement_id',a->'id','plan_id',p->'id','agreement_status',a->'status','plan_status',p->'status',
    'mandate_status',mandate_status,'supersession',s);
END $$;
REVOKE ALL ON FUNCTION public.membership_cancelled_dd_restart_evidence(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_cancelled_dd_restart_evidence(uuid,uuid,uuid) TO service_role;

-- Bound receipt only (reserved or superseded), for the database gates.
CREATE OR REPLACE FUNCTION public.membership_dd_restart_receipt(
  p_tenant_id uuid,p_member_id uuid,p_history_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT to_jsonb(s) FROM public.membership_dd_restart_supersession s
    JOIN public.member_membership_history h ON h.restart_supersession_id=s.id AND h.id=s.history_id
      AND h.tenant_id=s.tenant_id AND h.member_id=s.member_id AND h.billing_agreement_id=s.agreement_id
      AND h.term_start_date=s.original_term_start_date AND h.term_end_date=s.original_term_end_date
    WHERE s.tenant_id=p_tenant_id AND s.member_id=p_member_id AND s.history_id=p_history_id;
$$;
REVOKE ALL ON FUNCTION public.membership_dd_restart_receipt(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_dd_restart_receipt(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.membership_restart_superseded_history(p_history_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT FROM public.membership_dd_restart_supersession s
    JOIN public.member_membership_history h ON h.restart_supersession_id=s.id AND h.id=s.history_id
    WHERE s.history_id=p_history_id);
$$;
-- Called from the invoker-rights commitment trigger, so writers need EXECUTE.
-- It discloses only whether an exact history row was superseded.
REVOKE ALL ON FUNCTION public.membership_restart_superseded_history(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.membership_restart_superseded_history(uuid) TO authenticated,service_role;

-- The cancelled agreement of a predecessor bound to a restart reservation.
-- Used by the invoker-rights upfront quote guard; discloses only a boolean.
CREATE OR REPLACE FUNCTION public.membership_restart_linked_agreement(p_agreement_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT FROM public.membership_dd_restart_supersession s
    JOIN public.member_membership_history h ON h.restart_supersession_id=s.id AND h.id=s.history_id
      AND h.billing_agreement_id=s.agreement_id
    JOIN public.membership_billing_agreements a ON a.id=s.agreement_id AND a.tenant_id=s.tenant_id
      AND a.member_id=s.member_id AND a.organization_id IS NULL
      AND a.status IN ('payment_plan_cancelled','cancelled','canceled')
    WHERE s.agreement_id=p_agreement_id);
$$;
REVOKE ALL ON FUNCTION public.membership_restart_linked_agreement(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.membership_restart_linked_agreement(uuid) TO authenticated,service_role;

DO $patch$
DECLARE source text; signature text; change jsonb; changes jsonb; definition text;
  fields text; anchor text;
BEGIN
  -- Overlap exclusion: a linked predecessor keeps its original dates.
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='public.member_membership_history'::regclass
      AND conname='member_membership_history_rolling_no_overlap';
  IF definition IS NOT NULL AND position('restart_supersession_id' IN definition)=0 THEN
    IF position('payment_grace_exit_id IS NULL' IN definition)=0 THEN
      RAISE EXCEPTION 'Review the existing membership overlap contract before installing restart supersession';
    END IF;
    ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_rolling_no_overlap;
    EXECUTE 'ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap '
      || replace(definition,'payment_grace_exit_id IS NULL','payment_grace_exit_id IS NULL AND restart_supersession_id IS NULL');
  END IF;

  -- Released imported-consent guard: allow only the bound link.
  IF to_regprocedure('public.bnms_dd_alpha_canonical_guard()') IS NOT NULL THEN
    definition:=pg_get_functiondef('public.bnms_dd_alpha_canonical_guard()'::regprocedure);
    IF position('restart_supersession_id' IN definition)=0 THEN
      fields:='ARRAY[''status'',''payment_status'',''paid_at'',''updated_at'',''notes'',''payment_grace_exit_id'']';
      anchor:=E'IF NEW.id IS DISTINCT FROM a.history_id OR NEW.billing_agreement_id';
      IF (length(definition)-length(replace(definition,fields,'')))/length(fields)<>2
        OR (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
        RAISE EXCEPTION 'Review the imported membership guard before installing restart supersession';
      END IF;
      definition:=replace(definition,fields,
        'ARRAY[''status'',''payment_status'',''paid_at'',''updated_at'',''notes'',''payment_grace_exit_id'',''restart_supersession_id'']');
      definition:=replace(definition,anchor,$guard$IF NEW.restart_supersession_id IS DISTINCT FROM OLD.restart_supersession_id
      AND NOT EXISTS (SELECT FROM public.membership_dd_restart_supersession s
        WHERE s.id=NEW.restart_supersession_id AND s.history_id=OLD.id
          AND s.tenant_id=OLD.tenant_id AND s.member_id=OLD.member_id
          AND s.agreement_id=OLD.billing_agreement_id AND OLD.restart_supersession_id IS NULL
          AND (to_jsonb(NEW)-ARRAY['restart_supersession_id','updated_at'])
            = (to_jsonb(OLD)-ARRAY['restart_supersession_id','updated_at'])) THEN
      RAISE EXCEPTION 'Imported membership restart requires bound immutable audit evidence';
    END IF;
    $guard$||anchor);
      EXECUTE definition;
    END IF;
  END IF;

  -- Agreement-insert commitment overlap: a superseded predecessor is history.
  signature:='public.enforce_rolling_membership_commitment()';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('membership_restart_superseded_history' IN source)=0 THEN
    anchor:='AND billing_agreement_id IS DISTINCT FROM $3';
    IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
      RAISE EXCEPTION 'Rolling commitment contract changed: %',anchor;
    END IF;
    EXECUTE replace(source,anchor,anchor||' AND NOT public.membership_restart_superseded_history(id)');
  END IF;

  -- Upfront quote overlap: the restart's own quote may overlap only the
  -- predecessor (and its cancelled agreement) bound to the restart receipt.
  signature:='public.enforce_rolling_payment_quote()';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('membership_restart_linked_agreement' IN source)=0 THEN
    changes:=jsonb_build_array(
      jsonb_build_array($a$AND term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1', history_table, owner_column)$a$,
        $a$AND term_start_date < $4 AND membership_renewal_date > $3 '
    || CASE WHEN NEW.organization_id IS NULL
      THEN 'AND NOT public.membership_restart_superseded_history(id) ' ELSE '' END
    || 'LIMIT 1', history_table, owner_column)$a$),
      jsonb_build_array($a$AND term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1', owner_column)$a$,
        $a$AND term_start_date < $4 AND membership_renewal_date > $3 '
    || CASE WHEN NEW.organization_id IS NULL
      THEN 'AND NOT public.membership_restart_linked_agreement(id) ' ELSE '' END
    || 'LIMIT 1', owner_column)$a$)
    );
    FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
      IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
        RAISE EXCEPTION 'Upfront quote contract changed: %',change->>0;
      END IF;
      source:=replace(source,change->>0,change->>1);
    END LOOP;
    EXECUTE source;
  END IF;

  signature:='public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('membership_cancelled_dd_restart_evidence' IN source)=0 THEN
    changes:=jsonb_build_array(
      jsonb_build_array('grace integer; payment_exit jsonb;',
        'grace integer; payment_exit jsonb; dd_restart jsonb; supersession uuid;'),
      jsonb_build_array(
        'payment_exit:=public.membership_payment_grace_exit_evidence(p_tenant_id,p_member_id,p_previous_term_id);',
        'payment_exit:=public.membership_payment_grace_exit_evidence(p_tenant_id,p_member_id,p_previous_term_id);
  dd_restart:=CASE WHEN payment_exit IS NULL THEN
    public.membership_cancelled_dd_restart_evidence(p_tenant_id,p_member_id,p_previous_term_id) END;
  IF dd_restart->''supersession''->>''superseded_at'' IS NOT NULL THEN
    RAISE EXCEPTION ''This membership has already been restarted'';
  END IF;'),
      jsonb_build_array('OR prior IS NULL OR (payment_exit IS NULL AND (prior->>''payment_status''',
        'OR prior IS NULL OR (payment_exit IS NULL AND dd_restart IS NULL AND (prior->>''payment_status'''),
      jsonb_build_array('IF payment_exit IS NULL THEN',
        'IF dd_restart IS NOT NULL THEN
    -- Confirmed-cancelled Direct Debit: restart is available immediately.
    grace_end:=start_day-1;
  ELSIF payment_exit IS NULL THEN'),
      jsonb_build_array('AND NOT (payment_exit IS NOT NULL AND id=(payment_exit->>''agreement_id'')::uuid))',
        'AND NOT (payment_exit IS NOT NULL AND id=(payment_exit->>''agreement_id'')::uuid)
        AND NOT (dd_restart IS NOT NULL AND id=(dd_restart->>''agreement_id'')::uuid))'),
      jsonb_build_array('  INSERT INTO public.membership_successor_election',
        '  IF dd_restart IS NOT NULL AND prior->>''restart_supersession_id'' IS NULL THEN
    INSERT INTO public.membership_dd_restart_supersession
      (tenant_id,member_id,history_id,agreement_id,plan_id,mandate_status,original_status,
       original_payment_status,original_term_start_date,original_term_end_date)
      VALUES(p_tenant_id,p_member_id,p_previous_term_id,(dd_restart->>''agreement_id'')::uuid,
        (dd_restart->>''plan_id'')::uuid,dd_restart->>''mandate_status'',prior->>''status'',
        prior->>''payment_status'',(prior->>''term_start_date'')::date,(prior->>''term_end_date'')::date)
      RETURNING id INTO supersession;
    UPDATE public.member_membership_history SET restart_supersession_id=supersession
      WHERE id=p_previous_term_id AND tenant_id=p_tenant_id AND member_id=p_member_id;
  END IF;
  INSERT INTO public.membership_successor_election')
    );
    FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
      IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
        RAISE EXCEPTION 'Post-grace reservation contract changed: %',change->>0;
      END IF;
      source:=replace(source,change->>0,change->>1);
    END LOOP;
    EXECUTE source;
  END IF;

  signature:='public.guard_post_grace_renewal_journal()';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('membership_dd_restart_receipt' IN source)=0 THEN
    changes:=jsonb_build_array(
      jsonb_build_array('expected_grace date; grace integer; payment_exit jsonb;',
        'expected_grace date; grace integer; payment_exit jsonb; dd_restart jsonb;'),
      jsonb_build_array(
        'payment_exit:=public.membership_payment_grace_exit_evidence(NEW.tenant_id,NEW.member_id,NEW.previous_term_id);',
        'payment_exit:=public.membership_payment_grace_exit_evidence(NEW.tenant_id,NEW.member_id,NEW.previous_term_id);
  -- Bound reservation-time receipt plus still-confirmed cancellation evidence.
  dd_restart:=CASE WHEN payment_exit IS NULL
    AND public.membership_cancelled_dd_restart_evidence(NEW.tenant_id,NEW.member_id,NEW.previous_term_id) IS NOT NULL
    THEN public.membership_dd_restart_receipt(NEW.tenant_id,NEW.member_id,NEW.previous_term_id) END;'),
      jsonb_build_array(
        'OR (payment_exit IS NULL AND (h.payment_status IS DISTINCT FROM ''paid'' OR h.billing_agreement_id IS NOT NULL))',
        'OR (payment_exit IS NULL AND dd_restart IS NULL AND (h.payment_status IS DISTINCT FROM ''paid'' OR h.billing_agreement_id IS NOT NULL))'),
      jsonb_build_array('IF payment_exit IS NULL THEN',
        'IF dd_restart IS NOT NULL THEN
    expected_grace:=(NEW.created_at AT TIME ZONE ''UTC'')::date-1;
  ELSIF payment_exit IS NULL THEN')
    );
    FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
      IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
        RAISE EXCEPTION 'Post-grace journal contract changed: %',change->>0;
      END IF;
      source:=replace(source,change->>0,change->>1);
    END LOOP;
    EXECUTE source;
  END IF;

  signature:='public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('membership_dd_restart_receipt' IN source)=0 THEN
    changes:=jsonb_build_array(
      jsonb_build_array(
        'p_tenant_id,p_member_id,x.id) IS NOT NULL)) THEN',
        'p_tenant_id,p_member_id,x.id) IS NOT NULL)
      AND NOT (x.id=r.previous_term_id AND public.membership_dd_restart_receipt(
        p_tenant_id,p_member_id,x.id) IS NOT NULL)) THEN'),
      jsonb_build_array(
        'AND x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled''))) THEN',
        'AND x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled''))
      AND NOT (x.id IS NOT DISTINCT FROM (public.membership_dd_restart_receipt(
        p_tenant_id,p_member_id,r.previous_term_id)->>''agreement_id'')::uuid
        AND x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled''))) THEN'),
      jsonb_build_array(
        '  UPDATE public.membership_post_grace_date_application SET state=''applied''',
        '  -- A restarted cancelled Direct Debit ends here: status only. Original
  -- dates, payment status, debt, agreement and plan are retained as evidence.
  IF public.membership_dd_restart_receipt(p_tenant_id,p_member_id,r.previous_term_id) IS NOT NULL THEN
    UPDATE public.member_membership_history SET status=''expired''
      WHERE id=r.previous_term_id AND tenant_id=p_tenant_id AND member_id=p_member_id
        AND coalesce(status,'''') NOT IN (''expired'',''cancelled'',''canceled'',''void'',
          ''expired_checkout'',''replaced'',''cancelled_by_request'');
    UPDATE public.membership_dd_restart_supersession
      SET superseded_at=now(),successor_history_id=(h->>''id'')::uuid,reservation_id=r.id
      WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND history_id=r.previous_term_id
        AND superseded_at IS NULL;
  END IF;
  UPDATE public.membership_post_grace_date_application SET state=''applied''')
    );
    FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
      IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
        RAISE EXCEPTION 'Post-grace finalizer contract changed: %',change->>0;
      END IF;
      source:=replace(source,change->>0,change->>1);
    END LOOP;
    EXECUTE source;
  END IF;
END $patch$;
COMMIT;
