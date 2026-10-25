BEGIN;
ALTER TABLE public.member_cpd_points_ledger
 ADD COLUMN manual_key uuid,
 ADD COLUMN manual_certificate jsonb;
CREATE UNIQUE INDEX cpd_manual_key ON public.member_cpd_points_ledger(tenant_id,manual_key) WHERE manual_key IS NOT NULL;
-- Retain the exact existing event/import/correction predicates.
DO $$
DECLARE n text; predicate text;
BEGIN
 FOREACH n IN ARRAY ARRAY['cpd_entry_kind','cpd_entry_sign','cpd_entry_context'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT predicate FROM pg_constraint
   WHERE conrelid='public.member_cpd_points_ledger'::regclass AND conname=n;
  EXECUTE format('ALTER TABLE public.member_cpd_points_ledger DROP CONSTRAINT %I',n);
  EXECUTE format('ALTER TABLE public.member_cpd_points_ledger ADD CONSTRAINT %I CHECK (entry_kind=''manual_award'' OR (%s))',n,predicate);
 END LOOP;
END $$;
ALTER TABLE public.member_cpd_points_ledger ADD CONSTRAINT cpd_manual_context CHECK ((
 (entry_kind='manual_award' AND manual_key IS NOT NULL
  AND jsonb_typeof(manual_certificate)='object'
  AND points_value>0 AND points_value<100000000000000
  AND activity_date IS NOT NULL AND length(btrim(activity_title)) BETWEEN 1 AND 300
  AND NULLIF(btrim(created_by),'') IS NOT NULL
  AND event_id IS NULL AND event_type IS NULL AND booking_id IS NULL AND booking_type IS NULL
  AND award_trigger IS NULL AND occurrence_key IS NULL AND rule_id IS NULL AND rule_snapshot IS NULL
  AND import_batch_id IS NULL AND source_system IS NULL AND source_entry_id IS NULL
  AND source_metadata IS NULL AND row_hash IS NULL AND reversal_of IS NULL AND correction_of IS NULL)
 OR (entry_kind<>'manual_award' AND manual_key IS NULL AND manual_certificate IS NULL)
) IS TRUE);
CREATE FUNCTION public.validate_manual_cpd_award() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.entry_kind='manual_award' THEN
  IF NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=NEW.tenant_id AND id=NEW.member_id)
   OR COALESCE(NEW.manual_certificate->>'path','') NOT LIKE NEW.tenant_id::text||'/manual-cpd/'||NEW.member_id::text||'/%'
   OR COALESCE(NEW.manual_certificate->>'sha256','') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'Invalid manual CPD member or certificate scope'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_manual_cpd_award() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER validate_manual_cpd_award BEFORE INSERT ON public.member_cpd_points_ledger
 FOR EACH ROW EXECUTE FUNCTION public.validate_manual_cpd_award();

CREATE FUNCTION public.record_manual_cpd_award(p_tenant_id uuid,p_member_id uuid,p_key uuid,
 p_points numeric,p_title text,p_date date,p_actor text,p_certificate jsonb)
RETURNS public.member_cpd_points_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing public.member_cpd_points_ledger%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required'; END IF;
 IF p_key IS NULL OR p_points IS NULL OR p_points<=0 OR p_points>=100000000000000
  OR p_points<>round(p_points,6) OR p_date IS NULL OR p_title IS NULL
  OR length(btrim(p_title)) NOT BETWEEN 1 AND 300 OR NULLIF(btrim(p_actor),'') IS NULL
  OR COALESCE(jsonb_typeof(p_certificate),'')<>'object'
  OR COALESCE(p_certificate->>'path','') NOT LIKE p_tenant_id::text||'/manual-cpd/'||p_member_id::text||'/%'
  OR COALESCE(p_certificate->>'sha256','') !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'Invalid manual CPD award' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id) THEN
  RAISE EXCEPTION 'Member not found' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':manual-cpd:'||p_key::text,0));
 SELECT * INTO existing FROM public.member_cpd_points_ledger WHERE tenant_id=p_tenant_id AND manual_key=p_key;
 IF FOUND THEN
  IF existing.member_id<>p_member_id OR existing.points_value<>p_points OR existing.activity_title<>btrim(p_title)
   OR existing.activity_date<>p_date OR existing.created_by<>p_actor OR existing.manual_certificate<>p_certificate THEN
   RAISE EXCEPTION 'Manual CPD request key conflicts with the saved award' USING ERRCODE='23505';
  END IF;
  RETURN existing;
 END IF;
 INSERT INTO public.member_cpd_points_ledger(tenant_id,member_id,entry_kind,points_value,
  activity_date,activity_title,created_by,manual_key,manual_certificate,evidence_type)
 VALUES(p_tenant_id,p_member_id,'manual_award',p_points,p_date,btrim(p_title),p_actor,p_key,p_certificate,'manual_admin')
 RETURNING * INTO existing;
 RETURN existing;
END $$;
REVOKE ALL ON FUNCTION public.record_manual_cpd_award(uuid,uuid,uuid,numeric,text,date,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_cpd_award(uuid,uuid,uuid,numeric,text,date,text,jsonb) TO service_role;

CREATE TABLE public.manual_cpd_email_delivery (
 ledger_entry_id uuid PRIMARY KEY REFERENCES public.member_cpd_points_ledger(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 idempotency_key uuid NOT NULL,
 recipient text NOT NULL,
 message_html text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','sent','failed','unknown')),
 provider_message_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.manual_cpd_email_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.manual_cpd_email_delivery FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.manual_cpd_email_delivery TO service_role;
GRANT UPDATE(status,provider_message_id,updated_at) ON public.manual_cpd_email_delivery TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
