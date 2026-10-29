-- Completed PDFs are independent of mutable/deletable template records.
INSERT INTO storage.buckets(id,name,public)
VALUES ('issued-cpd-certificates','issued-cpd-certificates',false)
ON CONFLICT (id) DO UPDATE SET public=false;
CREATE POLICY issued_cpd_certificates_service_only ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (bucket_id <> 'issued-cpd-certificates')
  WITH CHECK (bucket_id <> 'issued-cpd-certificates');
CREATE TABLE public.issued_cpd_certificate (
  tenant_id uuid NOT NULL,
  certificate_key text NOT NULL,
  source_path text NOT NULL,
  pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  capture_reason text NOT NULL CHECK (capture_reason IN ('member_download','attendee_send')),
  PRIMARY KEY (tenant_id, certificate_key),
  CHECK (certificate_key ~ '^(standard|complex|historic):[0-9a-f-]{36}$'),
  CHECK (source_path LIKE tenant_id::text || '/issued-cpd/%')
);
ALTER TABLE public.issued_cpd_certificate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.issued_cpd_certificate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.issued_cpd_certificate TO service_role;
CREATE POLICY issued_cpd_certificate_service ON public.issued_cpd_certificate
  FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.issued_cpd_certificate IS
  'Immutable first captured PDF, not proof of historical delivery. No template FK: archiving/deleting a template must not remove issued documents. Service-only; API revalidates award ownership and reversals.';
