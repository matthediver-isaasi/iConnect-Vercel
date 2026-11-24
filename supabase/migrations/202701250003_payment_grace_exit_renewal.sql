-- Extend existing financial guards only for a bound, immutable grace-exit
-- receipt. Ordinary paid-upfront renewal paths retain their existing checks.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE source text; signature text; change jsonb; changes jsonb;
BEGIN
  signature:='public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)';
  source:=pg_get_functiondef(signature::regprocedure);
  changes:=jsonb_build_array(
    jsonb_build_array('grace integer;','grace integer; payment_exit jsonb;'),
    jsonb_build_array(
      'IF owner IS NULL OR coalesce((owner->>''membership_paused'')::boolean,false)',
      'payment_exit:=public.membership_payment_grace_exit_evidence(p_tenant_id,p_member_id,p_previous_term_id);
  IF owner IS NULL OR coalesce((owner->>''membership_paused'')::boolean,false)'),
    jsonb_build_array(
      'OR prior IS NULL OR prior->>''payment_status'' IS DISTINCT FROM ''paid''
    OR prior->>''billing_agreement_id'' IS NOT NULL OR prior->>''organization_id'' IS NOT NULL',
      'OR prior IS NULL OR (payment_exit IS NULL AND (prior->>''payment_status'' IS DISTINCT FROM ''paid''
    OR prior->>''billing_agreement_id'' IS NOT NULL)) OR prior->>''organization_id'' IS NOT NULL'),
    jsonb_build_array('policy:=coalesce(nullif(prior->''renewal_policy_snapshot''',
      'IF payment_exit IS NULL THEN
  policy:=coalesce(nullif(prior->''renewal_policy_snapshot'''),
    jsonb_build_array(
      'IF grace NOT BETWEEN 0 AND 366 OR start_day<=grace_end THEN RAISE EXCEPTION ''Membership is not after grace''; END IF;',
      'IF grace NOT BETWEEN 0 AND 366 OR start_day<=grace_end THEN RAISE EXCEPTION ''Membership is not after grace''; END IF;
  ELSE
    grace_end:=(payment_exit->>''grace_expires_at'')::timestamptz AT TIME ZONE ''UTC'';
    IF start_day<=grace_end THEN RAISE EXCEPTION ''Payment grace day has not ended''; END IF;
  END IF;'),
    jsonb_build_array(
      'AND (status IS NULL OR status NOT IN (''cancelled'',''canceled'',''completed'',''expired'')))',
      'AND (status IS NULL OR status NOT IN (''cancelled'',''canceled'',''completed'',''expired''))
        AND NOT (payment_exit IS NOT NULL AND id=(payment_exit->>''agreement_id'')::uuid))')
  );
  FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
      RAISE EXCEPTION 'Post-grace reservation contract changed: %',change->>0;
    END IF;
    source:=replace(source,change->>0,change->>1);
  END LOOP;
  EXECUTE source;

  signature:='public.guard_post_grace_renewal_journal()';
  source:=pg_get_functiondef(signature::regprocedure);
  changes:=jsonb_build_array(
    jsonb_build_array('expected_grace date; grace integer;','expected_grace date; grace integer; payment_exit jsonb;'),
    jsonb_build_array('IF e.id IS NULL OR h.id IS NULL OR c.id IS NULL',
      'payment_exit:=public.membership_payment_grace_exit_evidence(NEW.tenant_id,NEW.member_id,NEW.previous_term_id);
  IF e.id IS NULL OR h.id IS NULL OR c.id IS NULL'),
    jsonb_build_array(
      'OR h.payment_status IS DISTINCT FROM ''paid'' OR h.billing_agreement_id IS NOT NULL',
      'OR (payment_exit IS NULL AND (h.payment_status IS DISTINCT FROM ''paid'' OR h.billing_agreement_id IS NOT NULL))'),
    jsonb_build_array('policy := coalesce(h.renewal_policy_snapshot',
      'IF payment_exit IS NULL THEN
  policy := coalesce(h.renewal_policy_snapshot'),
    jsonb_build_array(
      'IF NEW.grace_end_date IS DISTINCT FROM expected_grace',
      'ELSE
    expected_grace:=(payment_exit->>''grace_expires_at'')::timestamptz AT TIME ZONE ''UTC'';
  END IF;
  IF NEW.grace_end_date IS DISTINCT FROM expected_grace')
  );
  FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
      RAISE EXCEPTION 'Post-grace journal contract changed: %',change->>0;
    END IF;
    source:=replace(source,change->>0,change->>1);
  END LOOP;
  EXECUTE source;

  signature:='public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)';
  source:=pg_get_functiondef(signature::regprocedure);
  changes:=jsonb_build_array(
    jsonb_build_array(
      'AND term_start_date<=end_day AND term_end_date>=start_day) THEN
    RAISE EXCEPTION ''Confirmed dates overlap another membership'';',
      'AND term_start_date<=end_day AND term_end_date>=start_day
      AND NOT (x.id=r.previous_term_id AND public.membership_payment_grace_exit_evidence(
        p_tenant_id,p_member_id,x.id) IS NOT NULL)) THEN
    RAISE EXCEPTION ''Confirmed dates overlap another membership'';'),
    jsonb_build_array(
      'AND term_start_date<=end_day AND term_end_date>=start_day) THEN
    RAISE EXCEPTION ''Confirmed dates overlap another payment arrangement'';',
      'AND term_start_date<=end_day AND term_end_date>=start_day
      AND NOT (public.membership_payment_grace_exit_evidence(p_tenant_id,p_member_id,r.previous_term_id) IS NOT NULL
        AND x.id=(public.membership_payment_grace_exit_evidence(
        p_tenant_id,p_member_id,r.previous_term_id)->>''agreement_id'')::uuid
        AND x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled''))) THEN
    RAISE EXCEPTION ''Confirmed dates overlap another payment arrangement'';')
  );
  FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF (length(source)-length(replace(source,change->>0,'')))/length(change->>0)<>1 THEN
      RAISE EXCEPTION 'Post-grace finalizer contract changed: %',change->>0;
    END IF;
    source:=replace(source,change->>0,change->>1);
  END LOOP;
  EXECUTE source;
END $patch$;
COMMIT;
