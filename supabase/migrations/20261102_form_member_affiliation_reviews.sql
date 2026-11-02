-- Prepared alongside the affiliation execution migrations. Do not enable on a
-- live form until authenticated submission binding and review UI are wired.
BEGIN;
CREATE TABLE public.form_member_affiliation_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 form_id uuid NOT NULL REFERENCES public.form(id),
 submission_id uuid NOT NULL REFERENCES public.form_submission(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 snapshot_id uuid NOT NULL REFERENCES public.form_member_affiliation_snapshot(id),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='array'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,submission_id)
);
ALTER TABLE public.form_member_affiliation_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_member_affiliation_review FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.form_member_affiliation_review TO service_role;

CREATE FUNCTION public.form_member_affiliation_defer(p_token uuid,p_submission uuid,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 s form_member_affiliation_snapshot%ROWTYPE;
 sub form_submission%ROWTYPE;
 item jsonb; cfg jsonb; req jsonb; v_result jsonb; review_id uuid;
BEGIN
 IF jsonb_typeof(p_details) IS DISTINCT FROM 'array' OR jsonb_array_length(p_details)<1
   OR jsonb_array_length(p_details)>500 OR octet_length(p_details::text)>300000 THEN
   RAISE EXCEPTION 'Invalid affiliation review details' USING ERRCODE='22023';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_details) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object'
     OR COALESCE(item->>'kind','') NOT IN('organization','department')
     OR COALESCE(length(btrim(item->>'fieldId')),0)=0
     OR COALESCE(length(btrim(item->>'requestedName')),0) NOT BETWEEN 1 AND 500 THEN
     RAISE EXCEPTION 'Missing affiliation review details' USING ERRCODE='22023';
   END IF;
 END LOOP;
 req:=jsonb_build_object('action','review','details',p_details);
 SELECT * INTO s FROM form_member_affiliation_snapshot WHERE id=p_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Affiliation snapshot unavailable' USING ERRCODE='42501'; END IF;
 IF s.submission_id IS DISTINCT FROM p_submission THEN
   RAISE EXCEPTION 'Authenticated submission binding required' USING ERRCODE='42501';
 END IF;
 IF s.result IS NOT NULL THEN
   IF s.submission_id IS DISTINCT FROM p_submission OR s.request IS DISTINCT FROM req THEN
     RAISE EXCEPTION 'Affiliation snapshot already submitted' USING ERRCODE='23505';
   END IF;
   RETURN s.result||jsonb_build_object('replayed',true);
 END IF;
 IF s.expires_at<now() THEN RAISE EXCEPTION 'Reload your affiliations before submitting' USING ERRCODE='40001'; END IF;
 SELECT * INTO sub FROM form_submission WHERE id=p_submission AND tenant_id=s.tenant_id FOR UPDATE;
 IF NOT FOUND OR sub.form_id<>s.form_id OR sub.created_member_id IS DISTINCT FROM s.member_id THEN
   RAISE EXCEPTION 'Submission identity mismatch' USING ERRCODE='42501';
 END IF;
 SELECT config INTO cfg FROM form_member_affiliation_config WHERE tenant_id=s.tenant_id AND form_id=s.form_id FOR SHARE;
 IF cfg IS DISTINCT FROM s.config OR cfg->>'enabled' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'Form configuration changed; reload before submitting' USING ERRCODE='40001';
 END IF;
 INSERT INTO form_member_affiliation_review(tenant_id,form_id,submission_id,member_id,snapshot_id,details)
   VALUES(s.tenant_id,s.form_id,p_submission,s.member_id,s.id,p_details) RETURNING id INTO review_id;
 v_result:=jsonb_build_object('status','awaiting_review','review_id',review_id,
   'affiliations_changed',false,'blocks_renewal',false,'replayed',false);
 UPDATE form_member_affiliation_snapshot SET submission_id=p_submission,request=req,result=v_result WHERE id=p_token;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_defer(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_affiliation_defer(uuid,uuid,jsonb) TO service_role;
COMMIT;
