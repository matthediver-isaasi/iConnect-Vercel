BEGIN;

-- Role access is exclusion-based, so new write capabilities must fail closed.
-- Add only the leaf capability: excluding the parent CPD module would also
-- remove existing certificate-template access.
UPDATE public.role
SET excluded_features = ARRAY(
  SELECT DISTINCT feature
  FROM unnest(
    COALESCE(excluded_features, ARRAY[]::text[])
    || ARRAY['cpd.points-corrections']::text[]
  ) AS feature
)
WHERE NOT COALESCE(excluded_features, ARRAY[]::text[])
  @> ARRAY['cpd.points-corrections']::text[];

ALTER TABLE public.member_cpd_points_ledger
  DROP CONSTRAINT cpd_entry_kind,
  DROP CONSTRAINT cpd_entry_sign,
  DROP CONSTRAINT cpd_entry_context,
  ADD COLUMN correction_of uuid REFERENCES public.member_cpd_points_ledger(id) ON DELETE RESTRICT,
  ADD COLUMN correction_key uuid,
  ADD CONSTRAINT cpd_entry_kind CHECK (
    entry_kind IN ('event_award','imported_award','reversal','manual_adjustment')),
  ADD CONSTRAINT cpd_entry_sign CHECK (
    (entry_kind IN ('event_award','imported_award') AND points_value>=0
      AND reversal_of IS NULL AND correction_of IS NULL)
    OR (entry_kind='reversal' AND points_value<=0
      AND reversal_of IS NOT NULL AND correction_of IS NULL)
    OR (entry_kind='manual_adjustment' AND points_value<>0
      AND reversal_of IS NULL AND correction_of IS NOT NULL)),
  ADD CONSTRAINT cpd_entry_context CHECK ((
    (entry_kind IN ('event_award','reversal','manual_adjustment') AND import_batch_id IS NULL
      AND event_type IS NOT NULL AND event_id IS NOT NULL
      AND booking_type IS NOT NULL AND booking_id IS NOT NULL
      AND award_trigger IS NOT NULL AND rule_snapshot IS NOT NULL AND occurrence_key IS NOT NULL
      AND activity_date IS NULL AND activity_title IS NULL AND activity_description IS NULL
      AND source_system IS NULL AND source_entry_id IS NULL AND source_metadata IS NULL AND row_hash IS NULL)
    OR
    (entry_kind IN ('imported_award','reversal','manual_adjustment') AND import_batch_id IS NOT NULL
      AND event_type IS NULL AND event_id IS NULL AND booking_type IS NULL AND booking_id IS NULL
      AND award_trigger IS NULL AND rule_id IS NULL AND rule_snapshot IS NULL AND occurrence_key IS NULL
      AND ticket_id IS NULL AND ticket_name_snapshot IS NULL
      AND activity_date IS NOT NULL AND activity_title IS NOT NULL AND activity_description IS NOT NULL
      AND source_system IS NOT NULL AND btrim(source_system)<>''
      AND source_entry_id IS NOT NULL AND btrim(source_entry_id)<>''
      AND source_metadata IS NOT NULL AND jsonb_typeof(source_metadata)='object'
      AND row_hash IS NOT NULL AND row_hash ~ '^[0-9a-f]{64}$')
  ) IS TRUE),
  ADD CONSTRAINT cpd_correction_audit CHECK (
    (entry_kind='manual_adjustment' AND correction_key IS NOT NULL
      AND NULLIF(btrim(reason),'') IS NOT NULL AND NULLIF(btrim(created_by),'') IS NOT NULL)
    OR (entry_kind<>'manual_adjustment' AND correction_key IS NULL));

CREATE UNIQUE INDEX uq_member_cpd_points_correction_key
  ON public.member_cpd_points_ledger(tenant_id,correction_key)
  WHERE correction_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_historical_cpd_points_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_original public.member_cpd_points_ledger%ROWTYPE;
BEGIN
  IF NEW.import_batch_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'historical CPD member missing or cross-tenant';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.historical_cpd_points_import_batch
      WHERE id=NEW.import_batch_id AND tenant_id=NEW.tenant_id
        AND manifest->>'source_system'=NEW.source_system) THEN
      RAISE EXCEPTION 'historical CPD batch/source mismatch';
    END IF;
  END IF;
  IF NEW.entry_kind='reversal' THEN
    SELECT * INTO v_original FROM public.member_cpd_points_ledger WHERE id=NEW.reversal_of;
    IF NOT FOUND OR v_original.entry_kind NOT IN ('event_award','imported_award')
      OR NEW.tenant_id IS DISTINCT FROM v_original.tenant_id
      OR NEW.member_id IS DISTINCT FROM v_original.member_id
      OR NEW.points_value IS DISTINCT FROM -v_original.points_value
      OR NEW.import_batch_id IS DISTINCT FROM v_original.import_batch_id THEN
      RAISE EXCEPTION 'invalid linked CPD reversal';
    END IF;
    IF v_original.entry_kind='imported_award' AND
      ROW(NEW.activity_date,NEW.activity_title,NEW.activity_description,NEW.source_system,
          NEW.source_entry_id,NEW.source_metadata,NEW.row_hash)
      IS DISTINCT FROM
      ROW(v_original.activity_date,v_original.activity_title,v_original.activity_description,
          v_original.source_system,v_original.source_entry_id,v_original.source_metadata,v_original.row_hash) THEN
      RAISE EXCEPTION 'imported reversal must retain original provenance';
    END IF;
  ELSIF NEW.entry_kind='manual_adjustment' THEN
    SELECT * INTO v_original FROM public.member_cpd_points_ledger WHERE id=NEW.correction_of;
    IF NOT FOUND OR v_original.entry_kind NOT IN ('event_award','imported_award')
      OR NEW.tenant_id IS DISTINCT FROM v_original.tenant_id
      OR NEW.member_id IS DISTINCT FROM v_original.member_id
      OR NEW.import_batch_id IS DISTINCT FROM v_original.import_batch_id THEN
      RAISE EXCEPTION 'invalid linked CPD correction';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.correct_member_cpd_points(
  p_tenant_id uuid,
  p_member_id uuid,
  p_ledger_entry_id uuid,
  p_action text,
  p_points_value numeric,
  p_reason text,
  p_actor text,
  p_correction_key uuid
) RETURNS public.member_cpd_points_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_award public.member_cpd_points_ledger%ROWTYPE;
  v_result public.member_cpd_points_ledger%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_action NOT IN ('reverse','adjust') THEN RAISE EXCEPTION 'valid CPD correction action is required'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR length(btrim(p_reason))>500
    OR NULLIF(btrim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'CPD correction reason and actor are required';
  END IF;
  IF p_action='adjust' AND (p_points_value IS NULL OR p_points_value=0
    OR abs(p_points_value)>=100000000000000 OR p_correction_key IS NULL) THEN
    RAISE EXCEPTION 'signed non-zero CPD adjustment and correction key are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':cpd-correction:'||COALESCE(p_correction_key::text,p_ledger_entry_id::text),0));
  IF p_action='adjust' THEN
    SELECT * INTO v_result FROM public.member_cpd_points_ledger
      WHERE tenant_id=p_tenant_id AND correction_key=p_correction_key;
    IF FOUND THEN
      IF v_result.member_id IS DISTINCT FROM p_member_id
        OR v_result.correction_of IS DISTINCT FROM p_ledger_entry_id
        OR v_result.points_value IS DISTINCT FROM p_points_value
        OR v_result.reason IS DISTINCT FROM btrim(p_reason) THEN
        RAISE EXCEPTION 'duplicate CPD correction key conflicts with the original correction';
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  SELECT * INTO v_award FROM public.member_cpd_points_ledger
    WHERE id=p_ledger_entry_id AND tenant_id=p_tenant_id AND member_id=p_member_id
      AND entry_kind IN ('event_award','imported_award') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant member CPD award not found'; END IF;

  IF p_action='reverse' THEN
    IF v_award.entry_kind='event_award' THEN
      PERFORM public.reverse_event_cpd_points_award(
        p_tenant_id,v_award.id,btrim(p_reason),p_actor,
        jsonb_build_object('source','admin-correction','memberId',p_member_id));
    ELSE
      PERFORM public.reverse_historical_cpd_points_award(
        p_tenant_id,v_award.id,btrim(p_reason),p_actor);
    END IF;
    SELECT * INTO v_result FROM public.member_cpd_points_ledger WHERE reversal_of=v_award.id;
    RETURN v_result;
  END IF;

  INSERT INTO public.member_cpd_points_ledger(
    tenant_id,member_id,entry_kind,points_value,event_type,event_id,booking_type,booking_id,
    ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,evidence_snapshot,
    rule_id,rule_snapshot,occurrence_key,reason,created_by,
    activity_date,activity_title,activity_description,source_system,source_entry_id,
    source_metadata,row_hash,import_batch_id,correction_of,correction_key
  ) VALUES (
    v_award.tenant_id,v_award.member_id,'manual_adjustment',p_points_value,
    v_award.event_type,v_award.event_id,v_award.booking_type,v_award.booking_id,
    v_award.ticket_id,v_award.ticket_name_snapshot,v_award.award_trigger,
    CASE WHEN v_award.import_batch_id IS NULL THEN 'manual_adjustment' END,
    CASE WHEN v_award.import_batch_id IS NULL THEN v_award.id::text END,
    v_award.evidence_snapshot,
    v_award.rule_id,v_award.rule_snapshot,
    CASE WHEN v_award.import_batch_id IS NULL THEN 'adjustment:'||p_correction_key END,
    btrim(p_reason),p_actor,v_award.activity_date,v_award.activity_title,
    v_award.activity_description,v_award.source_system,v_award.source_entry_id,
    v_award.source_metadata,v_award.row_hash,v_award.import_batch_id,v_award.id,p_correction_key
  ) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.correct_member_cpd_points(uuid,uuid,uuid,text,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_member_cpd_points(uuid,uuid,uuid,text,numeric,text,text,uuid)
  TO service_role;

COMMIT;