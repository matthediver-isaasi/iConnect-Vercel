-- Keep the confirmed claim provenance immutable. Only transport-produced
-- final content is writable alongside the existing outcome columns.
ALTER TABLE public.attendee_cpd_certificate_delivery
  ADD COLUMN IF NOT EXISTS rendered_email jsonb
    CHECK (rendered_email IS NULL OR jsonb_typeof(rendered_email) = 'object');
GRANT UPDATE(rendered_email) ON public.attendee_cpd_certificate_delivery TO service_role;