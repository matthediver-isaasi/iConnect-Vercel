-- Additive competition foundation. Not the existing engagement Award entity.
-- No browser grants or generic entity registration. Writes are RPC-owned.
BEGIN;

CREATE TABLE public.awards_programme (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  cycle text NOT NULL DEFAULT '',
  archived_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE TABLE public.awards_competition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  programme_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  cycle text NOT NULL DEFAULT '',
  eligibility_information text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'UTC',
  opens_at timestamptz,
  closes_at timestamptz,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','open','closed','judging','moderation','shortlisting','results_approved','completed','archived')),
  amendments_enabled boolean NOT NULL DEFAULT false,
  retention_policy jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,programme_id) REFERENCES public.awards_programme(tenant_id,id),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE TABLE public.awards_form_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE RESTRICT,
  review_field_ids text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id)
);
CREATE UNIQUE INDEX awards_one_active_form ON public.awards_form_binding(award_id) WHERE active;

CREATE TABLE public.assessment_round (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  position integer NOT NULL CHECK (position > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','judging','moderation','closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  required_judges integer NOT NULL DEFAULT 3 CHECK (required_judges BETWEEN 1 AND 100),
  require_all boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'blind' CHECK (visibility IN ('blind','after_submit','open')),
  comments_visible boolean NOT NULL DEFAULT false,
  moderation_required boolean NOT NULL DEFAULT true,
  moderation_methods text[] NOT NULL DEFAULT ARRAY['criterion','overall']::text[]
    CHECK (moderation_methods <@ ARRAY['criterion','overall']::text[] AND cardinality(moderation_methods)>0),
  self_approval boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,award_id,id),
  UNIQUE (award_id,position),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE TABLE public.assessment_criteria_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,round_id,id),
  UNIQUE (round_id,revision),
  FOREIGN KEY (tenant_id,round_id) REFERENCES public.assessment_round(tenant_id,id)
);
CREATE TABLE public.awards_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  member_id uuid REFERENCES public.member(id) ON DELETE RESTRICT,
  eligibility text NOT NULL DEFAULT 'pending' CHECK (eligibility IN ('pending','eligible','ineligible','withdrawn','disqualified')),
  eligibility_reason text,
  duplicate_flag boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,award_id,id),
  UNIQUE (award_id,submission_id),
  UNIQUE (award_id,reference),
  FOREIGN KEY (tenant_id,award_id,binding_id) REFERENCES public.awards_form_binding(tenant_id,award_id,id)
);
CREATE TABLE public.awards_application_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  application_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  form_snapshot jsonb NOT NULL CHECK (jsonb_typeof(form_snapshot)='object'),
  answer_snapshot jsonb NOT NULL CHECK (jsonb_typeof(answer_snapshot)='object'),
  display_snapshot jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(display_snapshot)='object'),
  attachment_manifest jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachment_manifest)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,application_id,id),
  UNIQUE (application_id,revision),
  FOREIGN KEY (tenant_id,application_id) REFERENCES public.awards_application(tenant_id,id)
);
CREATE TABLE public.assessment_appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  member_id uuid REFERENCES public.member(id) ON DELETE RESTRICT,
  contact_id uuid REFERENCES public.organization_contact(id) ON DELETE RESTRICT,
  external_email text,
  external_name text,
  role text NOT NULL DEFAULT 'judge' CHECK (role IN ('judge','chair','approver')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','invited','accepted','declined','revoked','expired')),
  available boolean NOT NULL DEFAULT true,
  capacity integer NOT NULL DEFAULT 100 CHECK (capacity BETWEEN 0 AND 10000),
  expires_at timestamptz,
  credential_generation bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,round_id,id),
  FOREIGN KEY (tenant_id,round_id) REFERENCES public.assessment_round(tenant_id,id),
  CHECK (num_nonnulls(member_id,contact_id,external_email)=1),
  CHECK (external_email IS NULL OR (external_email=lower(btrim(external_email)) AND length(external_email) BETWEEN 3 AND 320))
);
CREATE UNIQUE INDEX assessment_appointment_member ON public.assessment_appointment(round_id,member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX assessment_appointment_contact ON public.assessment_appointment(round_id,contact_id) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX assessment_appointment_external ON public.assessment_appointment(round_id,external_email) WHERE external_email IS NOT NULL;

CREATE TABLE public.assessment_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  round_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_version_id uuid NOT NULL,
  criteria_version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned','declined','removed','recused')),
  included boolean NOT NULL DEFAULT true,
  inclusion_reason text,
  conflict text NOT NULL DEFAULT 'undeclared' CHECK (conflict IN ('undeclared','none','potential','confirmed','cleared')),
  conflict_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  UNIQUE (round_id,appointment_id,application_id),
  FOREIGN KEY (tenant_id,award_id,round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,round_id,appointment_id) REFERENCES public.assessment_appointment(tenant_id,round_id,id),
  FOREIGN KEY (tenant_id,award_id,application_id) REFERENCES public.awards_application(tenant_id,award_id,id),
  FOREIGN KEY (tenant_id,application_id,application_version_id) REFERENCES public.awards_application_version(tenant_id,application_id,id),
  FOREIGN KEY (tenant_id,round_id,criteria_version_id) REFERENCES public.assessment_criteria_version(tenant_id,round_id,id)
);
CREATE TABLE public.assessment_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('draft','submitted','reopened','recused')),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='object'),
  exact_score jsonb,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (assignment_id,revision),
  FOREIGN KEY (tenant_id,assignment_id) REFERENCES public.assessment_assignment(tenant_id,id),
  CHECK ((state='submitted')=(submitted_at IS NOT NULL))
);
CREATE TABLE public.awards_audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  award_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','tenant_user','appointment','system','applicant_access')),
  actor_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  subject_id uuid NOT NULL,
  reason text,
  changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id),
  CHECK (actor_kind='system' OR actor_id IS NOT NULL)
);
CREATE INDEX awards_audit_history ON public.awards_audit_event(tenant_id,award_id,id);
CREATE INDEX assessment_assignment_panel ON public.assessment_assignment(tenant_id,round_id,appointment_id);
CREATE INDEX awards_application_listing ON public.awards_application(tenant_id,award_id,created_at,id);
CREATE INDEX assessment_revision_latest ON public.assessment_revision(assignment_id,revision DESC);

CREATE FUNCTION public.awards_immutable_evidence() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Awards evidence is append-only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER awards_audit_immutable BEFORE UPDATE OR DELETE ON public.awards_audit_event
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE TRIGGER awards_snapshot_immutable BEFORE UPDATE OR DELETE ON public.awards_application_version
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE TRIGGER assessment_criteria_immutable BEFORE UPDATE OR DELETE ON public.assessment_criteria_version
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE TRIGGER assessment_revision_immutable BEFORE UPDATE OR DELETE ON public.assessment_revision
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();

-- Existing models do not all have composite tenant keys. Validate their actual
-- ownership at insertion; FK RESTRICT retains referenced canonical records.
CREATE FUNCTION public.awards_canonical_owner_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
DECLARE owner_tenant uuid; bound_form uuid;
BEGIN
  IF TG_TABLE_NAME='awards_form_binding' THEN
    SELECT f.tenant_id INTO owner_tenant FROM public.form f WHERE f.id=NEW.form_id FOR SHARE;
  ELSIF TG_TABLE_NAME='awards_application' THEN
    SELECT s.tenant_id,s.form_id INTO owner_tenant,bound_form FROM public.form_submission s WHERE s.id=NEW.submission_id FOR SHARE;
    IF NOT EXISTS (SELECT 1 FROM public.awards_form_binding b WHERE b.id=NEW.binding_id AND b.form_id=bound_form AND b.tenant_id=NEW.tenant_id AND b.award_id=NEW.award_id) THEN
      RAISE EXCEPTION 'Submission form does not match award binding' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='assessment_appointment' THEN
    IF NEW.contact_id IS NOT NULL THEN
      SELECT o.tenant_id INTO owner_tenant FROM public.organization_contact c
        JOIN public.organization o ON o.id=c.organization_id WHERE c.id=NEW.contact_id FOR SHARE OF c,o;
    ELSIF NEW.member_id IS NOT NULL THEN
      PERFORM 1 FROM public.member WHERE id=NEW.member_id FOR SHARE;
      PERFORM 1 FROM public.organization o JOIN public.member m ON m.organization_id=o.id WHERE m.id=NEW.member_id FOR SHARE OF o;
      SELECT coalesce(m.tenant_id,o.tenant_id) INTO owner_tenant FROM public.member m
        LEFT JOIN public.organization o ON o.id=m.organization_id WHERE m.id=NEW.member_id;
    ELSE owner_tenant:=NEW.tenant_id;
    END IF;
  END IF;
  IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Canonical record belongs to another tenant' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='awards_application' THEN
    IF NEW.member_id IS NOT NULL THEN
      PERFORM 1 FROM public.member WHERE id=NEW.member_id FOR SHARE;
      PERFORM 1 FROM public.organization o JOIN public.member m ON m.organization_id=o.id WHERE m.id=NEW.member_id FOR SHARE OF o;
      SELECT coalesce(m.tenant_id,o.tenant_id) INTO owner_tenant FROM public.member m
        LEFT JOIN public.organization o ON o.id=m.organization_id WHERE m.id=NEW.member_id;
      IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Applicant belongs to another tenant' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER awards_binding_owner BEFORE INSERT OR UPDATE ON public.awards_form_binding
FOR EACH ROW EXECUTE FUNCTION public.awards_canonical_owner_guard();
CREATE TRIGGER awards_application_owner BEFORE INSERT OR UPDATE ON public.awards_application
FOR EACH ROW EXECUTE FUNCTION public.awards_canonical_owner_guard();
CREATE TRIGGER assessment_appointment_owner BEFORE INSERT OR UPDATE ON public.assessment_appointment
FOR EACH ROW EXECUTE FUNCTION public.awards_canonical_owner_guard();

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['awards_programme','awards_competition','awards_form_binding',
    'assessment_round','assessment_criteria_version','awards_application','awards_application_version',
    'assessment_appointment','assessment_assignment','assessment_revision','awards_audit_event']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',tab);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',tab);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.awards_audit_event_id_seq FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_immutable_evidence() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_canonical_owner_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
