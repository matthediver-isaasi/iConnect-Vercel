BEGIN;
CREATE TABLE public.assessment_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  generation bigint NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,round_id,appointment_id) REFERENCES public.assessment_appointment(tenant_id,round_id,id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
CREATE TABLE public.assessment_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  generation bigint NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,round_id,appointment_id) REFERENCES public.assessment_appointment(tenant_id,round_id,id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '12 hours')
);
CREATE INDEX assessment_session_appointment ON public.assessment_session(appointment_id,generation);
CREATE TABLE public.assessment_moderation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  round_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_version_id uuid NOT NULL,
  criteria_version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','discussion','proposed','approved','reopened')),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  UNIQUE (round_id,application_id),
  FOREIGN KEY (tenant_id,award_id,round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,award_id,application_id) REFERENCES public.awards_application(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,application_id,application_version_id) REFERENCES public.awards_application_version(tenant_id,application_id,id),
  FOREIGN KEY (tenant_id,round_id,criteria_version_id) REFERENCES public.assessment_criteria_version(tenant_id,round_id,id)
);
CREATE TABLE public.assessment_moderation_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  moderation_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user','appointment')),
  actor_id uuid NOT NULL,
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,moderation_id) REFERENCES public.assessment_moderation(tenant_id,id)
);
CREATE TABLE public.assessment_moderation_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  moderation_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  action text NOT NULL CHECK (action IN ('proposed','approved','reopened')),
  method text NOT NULL CHECK (method IN ('criterion','overall')),
  criterion_answers jsonb,
  exact_score jsonb NOT NULL,
  original_average jsonb NOT NULL,
  assessment_revision_ids uuid[] NOT NULL CHECK (cardinality(assessment_revision_ids)>0),
  justification text NOT NULL CHECK (length(btrim(justification)) BETWEEN 1 AND 20000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user','appointment')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (moderation_id,revision),
  FOREIGN KEY (tenant_id,moderation_id) REFERENCES public.assessment_moderation(tenant_id,id)
);
CREATE TABLE public.assessment_shortlist_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  round_id uuid NOT NULL,
  application_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('recommended','confirmed','rejected','reopened')),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user','appointment')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id,application_id,revision),
  FOREIGN KEY (tenant_id,award_id,round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,award_id,application_id) REFERENCES public.awards_application(tenant_id,award_id,id)
);
CREATE TABLE public.awards_outcome_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  certificate_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id,award_id,id),
  UNIQUE (award_id,name),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id)
);
CREATE TABLE public.awards_outcome_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  application_id uuid NOT NULL,
  category_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('provisional','recommended','approved','reopened')),
  selection_method text NOT NULL CHECK (selection_method IN ('score','panel','manual')),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user','appointment')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,award_id,id),
  UNIQUE (award_id,application_id,revision),
  FOREIGN KEY (tenant_id,award_id,application_id) REFERENCES public.awards_application(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,award_id,category_id) REFERENCES public.awards_outcome_category(tenant_id,award_id,id)
);
CREATE TABLE public.awards_event_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid,
  programme_id uuid,
  event_id uuid REFERENCES public.event(id) ON DELETE RESTRICT,
  complex_event_id uuid REFERENCES public.complex_event(id) ON DELETE RESTRICT,
  show_information boolean NOT NULL DEFAULT false,
  show_application_link boolean NOT NULL DEFAULT false,
  audience text NOT NULL DEFAULT 'member' CHECK (audience IN ('member','public')),
  presentation_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id),
  FOREIGN KEY (tenant_id,programme_id) REFERENCES public.awards_programme(tenant_id,id),
  CHECK (num_nonnulls(award_id,programme_id)=1),
  CHECK (num_nonnulls(event_id,complex_event_id)=1)
);
CREATE UNIQUE INDEX awards_event_single_link ON public.awards_event_link
  (tenant_id,coalesce(award_id,programme_id),coalesce(event_id,complex_event_id));
CREATE TABLE public.awards_publication_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  outcome_revision_id uuid NOT NULL,
  event_link_id uuid,
  revision integer NOT NULL CHECK (revision>0),
  audience text NOT NULL CHECK (audience IN ('member','public')),
  action text NOT NULL CHECK (action IN ('publish','correct','retract')),
  safe_projection jsonb NOT NULL CHECK (jsonb_typeof(safe_projection)='object'),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,award_id,outcome_revision_id) REFERENCES public.awards_outcome_revision(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,event_link_id) REFERENCES public.awards_event_link(tenant_id,id)
);
CREATE TABLE public.awards_delivery_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  outcome_revision_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user')),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (outcome_revision_id),
  FOREIGN KEY (tenant_id,award_id,outcome_revision_id) REFERENCES public.awards_outcome_revision(tenant_id,award_id,id)
);
CREATE TABLE public.awards_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  release_id uuid,
  deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 300),
  category text NOT NULL CHECK (category IN ('application_confirmation','application_deadline','judge_invitation',
    'judge_invitation_reminder','judging_deadline','incomplete_assessment','moderation_invitation',
    'shortlist','unsuccessful','winner','certificate')),
  recipient_context jsonb NOT NULL CHECK (jsonb_typeof(recipient_context)='object'),
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','delivered','retry','cancelled','attention')),
  claim_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  UNIQUE (tenant_id,deduplication_key),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id),
  FOREIGN KEY (tenant_id,release_id) REFERENCES public.awards_delivery_release(tenant_id,id),
  CHECK (category NOT IN ('shortlist','unsuccessful','winner','certificate') OR release_id IS NOT NULL),
  CHECK ((state='delivered')=(delivered_at IS NOT NULL))
);
CREATE TABLE public.awards_certificate_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  outcome_revision_id uuid NOT NULL,
  template_snapshot jsonb NOT NULL,
  recipient_snapshot jsonb NOT NULL,
  private_path text NOT NULL UNIQUE,
  pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (outcome_revision_id),
  FOREIGN KEY (tenant_id,award_id,outcome_revision_id) REFERENCES public.awards_outcome_revision(tenant_id,award_id,id)
);
CREATE INDEX awards_delivery_due ON public.awards_delivery(state,due_at,id);
CREATE INDEX assessment_moderation_discussion ON public.assessment_moderation_message(tenant_id,moderation_id,created_at,id);

CREATE FUNCTION public.awards_event_owner_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
DECLARE owner_tenant uuid;
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    SELECT e.tenant_id INTO owner_tenant FROM public.event e WHERE e.id=NEW.event_id FOR KEY SHARE;
  ELSE
    SELECT e.tenant_id INTO owner_tenant FROM public.complex_event e WHERE e.id=NEW.complex_event_id FOR KEY SHARE;
  END IF;
  IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Event belongs to another tenant' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER awards_event_owner BEFORE INSERT OR UPDATE ON public.awards_event_link
FOR EACH ROW EXECUTE FUNCTION public.awards_event_owner_guard();
REVOKE ALL ON FUNCTION public.awards_event_owner_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['assessment_invitation','assessment_session','assessment_moderation','assessment_moderation_message',
    'assessment_moderation_revision','assessment_shortlist_decision','awards_outcome_category','awards_outcome_revision',
    'awards_event_link','awards_publication_revision','awards_delivery_release','awards_delivery','awards_certificate_issue']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',tab);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['assessment_moderation_message','assessment_moderation_revision','assessment_shortlist_decision',
    'awards_outcome_revision','awards_publication_revision','awards_delivery_release','awards_certificate_issue']
  LOOP
    EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence()',tab);
  END LOOP;
END $$;
COMMIT;
