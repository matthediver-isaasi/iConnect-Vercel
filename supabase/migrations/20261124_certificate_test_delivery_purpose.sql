-- Test mail carries REAL attendee survey credentials, but is not attendee delivery.
-- Existing accepted-delivery grant lookup and atomic submission remain unchanged.
BEGIN;
ALTER TABLE public.attendee_cpd_certificate_delivery
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'attendee'
  CHECK (purpose IN ('attendee','test'));
DROP INDEX IF EXISTS public.attendee_cpd_certificate_delivery_unresolved;
CREATE UNIQUE INDEX attendee_cpd_certificate_delivery_unresolved
  ON public.attendee_cpd_certificate_delivery(tenant_id,booking_source,booking_id,purpose)
  WHERE status IN ('pending','unknown');

-- Remove the old signature to avoid ambiguous default-argument overloads.
DROP FUNCTION IF EXISTS public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean);
CREATE OR REPLACE FUNCTION public.claim_attendee_cpd_certificate_delivery(
  p_tenant_id uuid, p_booking_source text, p_booking_id uuid, p_request_id uuid,
  p_fingerprint text, p_actor text, p_recipient text, p_provenance jsonb,
  p_deliberate_resend boolean DEFAULT false, p_purpose text DEFAULT 'attendee'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE previous public.attendee_cpd_certificate_delivery%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_request_id IS NULL
    OR p_booking_source IS NULL OR p_booking_source NOT IN ('standard','complex')
    OR p_purpose IS NULL OR p_purpose NOT IN ('attendee','test')
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
    OR COALESCE(p_actor,'')='' OR COALESCE(p_recipient,'')=''
    OR p_provenance IS NULL OR jsonb_typeof(p_provenance)<>'object' THEN
    RAISE EXCEPTION 'invalid certificate delivery claim';
  END IF;
  -- Request IDs remain globally unique within the tenant, INCLUDING purpose.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':certificate-request:'||p_request_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':certificate-booking:'||p_booking_source||':'||p_booking_id::text,0));
  SELECT * INTO previous FROM attendee_cpd_certificate_delivery
    WHERE tenant_id=p_tenant_id AND request_id=p_request_id;
  IF FOUND THEN
    IF previous.booking_source<>p_booking_source OR previous.booking_id<>p_booking_id
      OR previous.fingerprint<>p_fingerprint OR previous.recipient<>p_recipient
      OR previous.purpose<>p_purpose THEN
      RETURN jsonb_build_object('claimed',false,'reason','request_conflict');
    END IF;
    RETURN jsonb_build_object('claimed',false,'reason','retry','delivery',to_jsonb(previous));
  END IF;
  IF p_booking_source='standard' THEN
    IF NOT EXISTS (SELECT 1 FROM booking WHERE id=p_booking_id AND tenant_id=p_tenant_id
      AND COALESCE(status,'') NOT IN ('cancelled','canceled','transferred','refunded')) THEN
      RAISE EXCEPTION 'active tenant booking required';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM complex_event_booking WHERE id=p_booking_id AND tenant_id=p_tenant_id
      AND COALESCE(status,'') NOT IN ('cancelled','canceled','transferred','refunded')) THEN
      RAISE EXCEPTION 'active tenant booking required';
    END IF;
  END IF;
  SELECT * INTO previous FROM attendee_cpd_certificate_delivery
    WHERE tenant_id=p_tenant_id AND booking_source=p_booking_source AND booking_id=p_booking_id
      AND purpose=p_purpose
      AND status IN ('pending','unknown') ORDER BY created_at DESC,id DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed',false,'reason','unresolved','delivery',to_jsonb(previous));
  END IF;
  SELECT * INTO previous FROM attendee_cpd_certificate_delivery
    WHERE tenant_id=p_tenant_id AND booking_source=p_booking_source AND booking_id=p_booking_id
      AND purpose='attendee'
      AND status='accepted' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF p_purpose='attendee' AND FOUND AND NOT COALESCE(p_deliberate_resend,false) THEN
    RETURN jsonb_build_object('claimed',false,'reason','resend_required','delivery',to_jsonb(previous));
  END IF;
  INSERT INTO attendee_cpd_certificate_delivery(
    tenant_id,booking_source,booking_id,request_id,fingerprint,actor,recipient,provenance,deliberate_resend,purpose
  ) VALUES (p_tenant_id,p_booking_source,p_booking_id,p_request_id,p_fingerprint,p_actor,p_recipient,p_provenance,COALESCE(p_deliberate_resend,false),p_purpose)
  RETURNING * INTO previous;
  RETURN jsonb_build_object('claimed',true,'delivery',to_jsonb(previous));
END $$;
REVOKE ALL ON FUNCTION public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)
  TO service_role;
COMMIT;