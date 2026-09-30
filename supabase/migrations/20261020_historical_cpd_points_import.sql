-- Task 4580. Staged only: requires explicit target/preflight approval before application.
BEGIN;

CREATE TABLE public.historical_cpd_points_import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE RESTRICT,
  batch_key text NOT NULL CHECK (btrim(batch_key) <> ''),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  rows_snapshot jsonb NOT NULL CHECK (jsonb_typeof(rows_snapshot)='array'),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,batch_key),
  UNIQUE(tenant_id,id)
);
CREATE TRIGGER protect_historical_cpd_points_import_batch
BEFORE UPDATE OR DELETE ON public.historical_cpd_points_import_batch
FOR EACH ROW EXECUTE FUNCTION public.protect_member_cpd_points_ledger();
ALTER TABLE public.historical_cpd_points_import_batch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_cpd_points_import_batch FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.historical_cpd_points_import_batch TO service_role;
CREATE POLICY service_role_read ON public.historical_cpd_points_import_batch
  FOR SELECT TO service_role USING (true);

ALTER TABLE public.member_cpd_points_ledger
  DROP CONSTRAINT member_cpd_points_ledger_entry_kind_check,
  DROP CONSTRAINT member_cpd_points_ledger_check,
  ALTER COLUMN event_type DROP NOT NULL,
  ALTER COLUMN event_id DROP NOT NULL,
  ALTER COLUMN booking_type DROP NOT NULL,
  ALTER COLUMN booking_id DROP NOT NULL,
  ALTER COLUMN award_trigger DROP NOT NULL,
  ALTER COLUMN rule_snapshot DROP NOT NULL,
  ALTER COLUMN occurrence_key DROP NOT NULL,
  ADD COLUMN activity_date date,
  ADD COLUMN activity_title text,
  ADD COLUMN activity_description text,
  ADD COLUMN source_system text,
  ADD COLUMN source_entry_id text,
  ADD COLUMN source_metadata jsonb,
  ADD COLUMN row_hash text,
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT cpd_import_batch_tenant_fk FOREIGN KEY (tenant_id,import_batch_id)
    REFERENCES public.historical_cpd_points_import_batch(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT cpd_entry_kind CHECK (entry_kind IN ('event_award','imported_award','reversal')),
  ADD CONSTRAINT cpd_entry_sign CHECK (
    (entry_kind IN ('event_award','imported_award') AND points_value>=0 AND reversal_of IS NULL)
    OR (entry_kind='reversal' AND points_value<=0 AND reversal_of IS NOT NULL)),
  ADD CONSTRAINT cpd_entry_context CHECK ((
    (entry_kind IN ('event_award','reversal') AND import_batch_id IS NULL
      AND event_type IS NOT NULL AND event_id IS NOT NULL
      AND booking_type IS NOT NULL AND booking_id IS NOT NULL
      AND award_trigger IS NOT NULL AND rule_snapshot IS NOT NULL AND occurrence_key IS NOT NULL
      AND activity_date IS NULL AND activity_title IS NULL AND activity_description IS NULL
      AND source_system IS NULL AND source_entry_id IS NULL AND source_metadata IS NULL AND row_hash IS NULL)
    OR
    (entry_kind IN ('imported_award','reversal') AND import_batch_id IS NOT NULL
      AND event_type IS NULL AND event_id IS NULL AND booking_type IS NULL AND booking_id IS NULL
      AND award_trigger IS NULL AND rule_id IS NULL AND rule_snapshot IS NULL AND occurrence_key IS NULL
      AND ticket_id IS NULL AND ticket_name_snapshot IS NULL
      AND activity_date IS NOT NULL AND activity_title IS NOT NULL AND activity_description IS NOT NULL
      AND source_system IS NOT NULL AND btrim(source_system)<>''
      AND source_entry_id IS NOT NULL AND btrim(source_entry_id)<>''
      AND source_metadata IS NOT NULL AND jsonb_typeof(source_metadata)='object'
      AND row_hash IS NOT NULL AND row_hash ~ '^[0-9a-f]{64}$')
  ) IS TRUE);

CREATE UNIQUE INDEX uq_cpd_import_source ON public.member_cpd_points_ledger
  (tenant_id,source_system,source_entry_id) WHERE entry_kind='imported_award';
CREATE INDEX idx_cpd_import_member_date ON public.member_cpd_points_ledger
  (tenant_id,member_id,activity_date,id) WHERE activity_date IS NOT NULL;
CREATE INDEX idx_cpd_import_batch ON public.member_cpd_points_ledger(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- All imported inserts (including reversals) must retain tenant and provenance identity.
CREATE FUNCTION public.validate_historical_cpd_points_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_original public.member_cpd_points_ledger%ROWTYPE;
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
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_historical_cpd_points_entry BEFORE INSERT ON public.member_cpd_points_ledger
FOR EACH ROW EXECUTE FUNCTION public.validate_historical_cpd_points_entry();

CREATE FUNCTION public.import_historical_cpd_points_batch(
  p_tenant_id uuid,p_batch_key text,p_manifest jsonb,p_rows jsonb,p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_row jsonb; v_existing public.member_cpd_points_ledger%ROWTYPE;
  v_batch public.historical_cpd_points_import_batch%ROWTYPE;
  v_points numeric; v_date date; v_applied integer:=0; v_skipped integer:=0;
  v_applied_points numeric:=0; v_skipped_points numeric:=0; v_total numeric:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR NULLIF(btrim(p_batch_key),'') IS NULL OR NULLIF(btrim(p_actor),'') IS NULL
    OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tenant, batch key, manifest, rows and actor are required';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'chunk must contain 1 to 100 rows'; END IF;
  IF COALESCE(p_manifest->>'workbook_sha256','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_manifest->>'approval_sha256','') !~ '^[0-9a-f]{64}$'
    OR NULLIF(btrim(p_manifest->>'source_system'),'') IS NULL
    OR NULLIF(btrim(p_manifest->>'target'),'') IS NULL
    OR COALESCE(p_manifest->>'row_count','') !~ '^[0-9]+$'
    OR COALESCE(p_manifest->>'points_total','') !~ '^[0-9]+([.][0-9]{1,6})?$' THEN
    RAISE EXCEPTION 'invalid historical CPD manifest';
  END IF;
  IF (p_manifest->>'row_count')::numeric <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'manifest chunk row count mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r GROUP BY r->>'source_entry_id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'duplicate source entry in chunk requires review';
  END IF;
  -- Tenant lock serializes batches and source identities, including concurrent retries.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':historical-cpd-import',0));
  SELECT * INTO v_batch FROM public.historical_cpd_points_import_batch
    WHERE tenant_id=p_tenant_id AND batch_key=p_batch_key;
  IF FOUND AND (v_batch.manifest IS DISTINCT FROM p_manifest OR v_batch.rows_snapshot IS DISTINCT FROM p_rows) THEN
    RAISE EXCEPTION 'existing batch manifest conflict requires review';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object'
      OR NULLIF(btrim(v_row->>'source_entry_id'),'') IS NULL
      OR COALESCE(v_row->>'row_hash','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_row->'points_value') IS DISTINCT FROM 'string'
      OR COALESCE(v_row->>'points_value','') !~ '^[0-9]{1,14}([.][0-9]{1,6})?$'
      OR COALESCE(v_row->>'activity_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR jsonb_typeof(v_row->'activity_title') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_row->'activity_description') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_row->'source_metadata') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid historical CPD row';
    END IF;
    v_points:=(v_row->>'points_value')::numeric;
    v_date:=(v_row->>'activity_date')::date;
    IF NOT EXISTS (SELECT 1 FROM public.member
      WHERE id=(v_row->>'member_id')::uuid AND tenant_id=p_tenant_id) THEN
      RAISE EXCEPTION 'historical CPD member missing or cross-tenant';
    END IF;
    v_total:=v_total+v_points;
    SELECT * INTO v_existing FROM public.member_cpd_points_ledger
      WHERE tenant_id=p_tenant_id AND source_system=p_manifest->>'source_system'
        AND source_entry_id=v_row->>'source_entry_id' AND entry_kind='imported_award';
    IF FOUND THEN
      IF ROW(v_existing.member_id,v_existing.points_value,v_existing.activity_date,
          v_existing.activity_title,v_existing.activity_description,v_existing.source_metadata,v_existing.row_hash)
        IS DISTINCT FROM ROW((v_row->>'member_id')::uuid,v_points,v_date,
          v_row->>'activity_title',v_row->>'activity_description',v_row->'source_metadata',v_row->>'row_hash') THEN
        RAISE EXCEPTION 'source entry % changed; review conflict',v_row->>'source_entry_id';
      END IF;
      v_skipped:=v_skipped+1; v_skipped_points:=v_skipped_points+v_points;
      CONTINUE;
    END IF;
    IF v_batch.id IS NULL THEN
      INSERT INTO public.historical_cpd_points_import_batch(tenant_id,batch_key,manifest,rows_snapshot,created_by)
      VALUES(p_tenant_id,p_batch_key,p_manifest,p_rows,p_actor) RETURNING * INTO v_batch;
    END IF;
    INSERT INTO public.member_cpd_points_ledger(
      tenant_id,member_id,entry_kind,points_value,activity_date,activity_title,activity_description,
      source_system,source_entry_id,source_metadata,row_hash,import_batch_id,created_by
    ) VALUES(p_tenant_id,(v_row->>'member_id')::uuid,'imported_award',v_points,v_date,
      v_row->>'activity_title',v_row->>'activity_description',p_manifest->>'source_system',
      v_row->>'source_entry_id',v_row->'source_metadata',v_row->>'row_hash',v_batch.id,p_actor);
    v_applied:=v_applied+1; v_applied_points:=v_applied_points+v_points;
  END LOOP;
  IF v_total<>(p_manifest->>'points_total')::numeric THEN RAISE EXCEPTION 'manifest chunk points mismatch'; END IF;
  RETURN jsonb_build_object('applied_count',v_applied,'skipped_count',v_skipped,
    'applied_points',v_applied_points::text,'skipped_points',v_skipped_points::text);
END $$;

CREATE FUNCTION public.reverse_historical_cpd_points_award(
  p_tenant_id uuid,p_ledger_entry_id uuid,p_reason text,p_actor text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_award public.member_cpd_points_ledger%ROWTYPE; v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR NULLIF(btrim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'manual reversal reason and actor are required';
  END IF;
  SELECT * INTO v_award FROM public.member_cpd_points_ledger
    WHERE id=p_ledger_entry_id AND tenant_id=p_tenant_id AND entry_kind='imported_award' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant imported CPD award not found'; END IF;
  SELECT id INTO v_id FROM public.member_cpd_points_ledger WHERE reversal_of=v_award.id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO public.member_cpd_points_ledger(
    tenant_id,member_id,entry_kind,points_value,reversal_of,reason,created_by,
    activity_date,activity_title,activity_description,source_system,source_entry_id,
    source_metadata,row_hash,import_batch_id
  ) VALUES(v_award.tenant_id,v_award.member_id,'reversal',-v_award.points_value,v_award.id,p_reason,p_actor,
    v_award.activity_date,v_award.activity_title,v_award.activity_description,v_award.source_system,
    v_award.source_entry_id,v_award.source_metadata,v_award.row_hash,v_award.import_batch_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.member_cpd_points_ledger FROM service_role;
REVOKE ALL ON FUNCTION public.validate_historical_cpd_points_entry() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.import_historical_cpd_points_batch(uuid,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reverse_historical_cpd_points_award(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_historical_cpd_points_batch(uuid,text,jsonb,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_historical_cpd_points_award(uuid,uuid,text,text) TO service_role;
COMMIT;