BEGIN;
CREATE TABLE public.awards_review_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  submission_id uuid NOT NULL REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  field_id text NOT NULL,
  cell_id text NOT NULL DEFAULT '',
  source_path text NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 26214400),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(submission_id,field_id,cell_id,source_path)
);
ALTER TABLE public.awards_review_attachment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_review_attachment FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_review_attachment TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.awards_review_attachment
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE FUNCTION public.awards_capture_attachment(p_tenant uuid,p_submission uuid,p_field text,p_path text,p_name text,p_hex text,p_digest text,p_cell text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE capture public.awards_intake_capture; existing public.awards_review_attachment; bytes bytea;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO capture FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission FOR UPDATE;
  IF NOT FOUND OR NOT (capture.form_snapshot->'review_field_ids' ? p_field)
    OR p_path NOT LIKE p_tenant::text||'/form-submissions/'||p_submission::text||'/%'
    OR p_path ~ '[%\\?#]' OR p_path LIKE '%..%' OR cardinality(string_to_array(p_path,'/'))<>4 THEN
    RAISE EXCEPTION 'Attachment is not part of this application review'; END IF;
  IF length(p_hex)>52428800 THEN RAISE EXCEPTION 'Attachment exceeds the upload size limit'; END IF;
  bytes:=decode(p_hex,'hex');
  IF encode(sha256(bytes),'hex') IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'Attachment checksum mismatch'; END IF;
  IF public.awards_review_file_cell(capture.form_snapshot,capture.answer_snapshot,p_field,p_cell) IS NULL THEN
    RAISE EXCEPTION 'File cell unavailable'; END IF;
  IF p_cell<>'' THEN p_cell:=(p_cell::jsonb)::text; END IF;
  SELECT * INTO existing FROM public.awards_review_attachment WHERE submission_id=p_submission AND field_id=p_field AND cell_id=p_cell AND source_path=p_path;
  IF FOUND THEN
    IF existing.digest<>p_digest THEN RAISE EXCEPTION 'Original attachment changed; retained evidence cannot be replaced'; END IF;
  ELSE
    INSERT INTO public.awards_review_attachment(tenant_id,submission_id,field_id,cell_id,source_path,name,content,digest)
      VALUES(p_tenant,p_submission,p_field,p_cell,p_path,p_name,bytes,p_digest) RETURNING * INTO existing;
  END IF;
  RETURN jsonb_build_object('id',existing.id,'field_id',existing.field_id,'name',existing.name,'sha256',existing.digest);
END $$;
REVOKE ALL ON FUNCTION public.awards_capture_attachment(uuid,uuid,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_capture_attachment(uuid,uuid,text,text,text,text,text,text) TO service_role;
COMMIT;
