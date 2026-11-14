BEGIN;
CREATE FUNCTION public.awards_attachment_chunk(p_tenant uuid,p_snapshot uuid,p_attachment uuid,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE file public.awards_review_attachment; chunk bytea;
BEGIN
  IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid attachment range'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.awards_application_version v,jsonb_array_elements(v.attachment_manifest) attachment
    WHERE v.tenant_id=p_tenant AND v.id=p_snapshot AND attachment->>'id'=p_attachment::text) THEN
    RAISE EXCEPTION 'Attachment unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO file FROM public.awards_review_attachment WHERE tenant_id=p_tenant AND id=p_attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attachment unavailable' USING ERRCODE='P0002'; END IF;
  IF p_offset>=octet_length(file.content) THEN RAISE EXCEPTION 'Invalid attachment range'; END IF;
  chunk:=substring(file.content FROM p_offset+1 FOR 1048576);
  RETURN jsonb_build_object('name',file.name,'hex',encode(chunk,'hex'),'sha256',file.digest,
    'offset',p_offset,'total',octet_length(file.content),'bytes',octet_length(chunk));
END $$;
REVOKE ALL ON FUNCTION public.awards_attachment_chunk(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
