-- Manual report delivery only: no attendance or award mutations.
CREATE TABLE IF NOT EXISTS public.attendee_cpd_certificate_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE RESTRICT,
  booking_source text NOT NULL CHECK (booking_source IN ('standard','complex')),
  booking_id uuid NOT NULL,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL,
  recipient text NOT NULL,
  provenance jsonb NOT NULL,
  deliberate_resend boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','failed','unknown')),
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id)
);
CREATE INDEX IF NOT EXISTS attendee_cpd_certificate_delivery_booking
  ON public.attendee_cpd_certificate_delivery(tenant_id,booking_source,booking_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS attendee_cpd_certificate_delivery_unresolved
  ON public.attendee_cpd_certificate_delivery(tenant_id,booking_source,booking_id)
  WHERE status IN ('pending','unknown');
ALTER TABLE public.attendee_cpd_certificate_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendee_cpd_certificate_delivery FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.attendee_cpd_certificate_delivery TO service_role;
GRANT UPDATE(status,provider_message_id,error,updated_at) ON public.attendee_cpd_certificate_delivery TO service_role;

CREATE OR REPLACE FUNCTION public.claim_attendee_cpd_certificate_delivery(
  p_tenant_id uuid, p_booking_source text, p_booking_id uuid, p_request_id uuid,
  p_fingerprint text, p_actor text, p_recipient text, p_provenance jsonb,
  p_deliberate_resend boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE previous public.attendee_cpd_certificate_delivery%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_request_id IS NULL
    OR p_booking_source IS NULL OR p_booking_source NOT IN ('standard','complex')
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
    OR COALESCE(p_actor,'')='' OR COALESCE(p_recipient,'')=''
    OR p_provenance IS NULL OR jsonb_typeof(p_provenance)<>'object' THEN
    RAISE EXCEPTION 'invalid certificate delivery claim';
  END IF;
  -- Request lock first prevents the same request UUID racing across bookings.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':certificate-request:'||p_request_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':certificate-booking:'||p_booking_source||':'||p_booking_id::text,0));
  SELECT * INTO previous FROM attendee_cpd_certificate_delivery
    WHERE tenant_id=p_tenant_id AND request_id=p_request_id;
  IF FOUND THEN
    IF previous.booking_source<>p_booking_source OR previous.booking_id<>p_booking_id
      OR previous.fingerprint<>p_fingerprint OR previous.recipient<>p_recipient THEN
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
      AND status IN ('pending','unknown') ORDER BY created_at DESC,id DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed',false,'reason','unresolved','delivery',to_jsonb(previous));
  END IF;
  SELECT * INTO previous FROM attendee_cpd_certificate_delivery
    WHERE tenant_id=p_tenant_id AND booking_source=p_booking_source AND booking_id=p_booking_id
      AND status='accepted' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF FOUND AND NOT COALESCE(p_deliberate_resend,false) THEN
    RETURN jsonb_build_object('claimed',false,'reason','resend_required','delivery',to_jsonb(previous));
  END IF;
  INSERT INTO attendee_cpd_certificate_delivery(
    tenant_id,booking_source,booking_id,request_id,fingerprint,actor,recipient,provenance,deliberate_resend
  ) VALUES (p_tenant_id,p_booking_source,p_booking_id,p_request_id,p_fingerprint,p_actor,p_recipient,p_provenance,COALESCE(p_deliberate_resend,false))
  RETURNING * INTO previous;
  RETURN jsonb_build_object('claimed',true,'delivery',to_jsonb(previous));
END $$;
REVOKE ALL ON FUNCTION public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean)
  TO service_role;