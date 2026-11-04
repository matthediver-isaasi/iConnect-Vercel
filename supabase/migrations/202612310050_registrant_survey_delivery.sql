BEGIN;
CREATE TABLE public.registrant_survey_delivery (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  booking_source text NOT NULL CHECK (booking_source IN ('standard','complex')),
  booking_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES public.event_survey_assignment(id),
  recipient text NOT NULL,
  actor text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','failed','unknown')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX registrant_survey_delivery_unresolved
  ON public.registrant_survey_delivery(tenant_id,booking_source,booking_id,assignment_id)
  WHERE status IN ('pending','unknown');
CREATE INDEX registrant_survey_delivery_history
  ON public.registrant_survey_delivery(tenant_id,booking_source,booking_id,assignment_id,created_at DESC);
ALTER TABLE public.registrant_survey_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registrant_survey_delivery FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.registrant_survey_delivery TO service_role;
GRANT UPDATE(status,provider_message_id,updated_at) ON public.registrant_survey_delivery TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
