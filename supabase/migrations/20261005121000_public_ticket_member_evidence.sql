-- PREPARED ONLY; not an activation migration. Requires the preceding policy
-- migration and completed, reviewed purchase-finalizer integration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.public_ticket_member_purchase (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('simple', 'complex')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'ready', 'completed', 'conflict', 'retryable', 'excluded')),
  stripe_payment_intent_id text,
  booking_ids uuid[] NOT NULL DEFAULT '{}',
  completion_evidence jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, stripe_payment_intent_id)
);

CREATE TABLE IF NOT EXISTS public.public_ticket_member_link (
  purchase_id uuid NOT NULL REFERENCES public.public_ticket_member_purchase(id),
  normalized_email text NOT NULL,
  member_id uuid NOT NULL,
  participation jsonb NOT NULL CHECK (jsonb_typeof(participation) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_id, normalized_email),
  UNIQUE (member_id)
);

ALTER TABLE public.public_ticket_member_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_ticket_member_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_ticket_member_purchase, public.public_ticket_member_link
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.public_ticket_member_purchase TO service_role;
GRANT SELECT ON public.public_ticket_member_link TO service_role;

CREATE INDEX IF NOT EXISTS public_ticket_member_recovery
  ON public.public_ticket_member_purchase(state, updated_at, id)
  WHERE state IN ('ready', 'retryable');

CREATE OR REPLACE FUNCTION public.guard_public_ticket_member_purchase()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id)
     OR (cardinality(OLD.booking_ids) > 0 AND NEW.booking_ids IS DISTINCT FROM OLD.booking_ids)
     OR (OLD.completion_evidence IS NOT NULL
         AND NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence)
     OR (OLD.state = 'completed' AND NEW.state <> 'completed')
  THEN
    RAISE EXCEPTION 'Purchase evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS public_ticket_member_purchase_immutable ON public.public_ticket_member_purchase;
CREATE TRIGGER public_ticket_member_purchase_immutable
  BEFORE UPDATE ON public.public_ticket_member_purchase
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_ticket_member_purchase();
REVOKE ALL ON FUNCTION public.guard_public_ticket_member_purchase() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.prepare_public_ticket_member_purchase(
  p_id uuid, p_tenant_id uuid, p_event_id uuid, p_event_kind text, p_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing public.public_ticket_member_purchase%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_tenant_id IS NULL OR p_event_id IS NULL
     OR p_event_kind IS NULL OR p_event_kind NOT IN ('simple', 'complex')
     OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->>'tenant_id' IS DISTINCT FROM p_tenant_id::text
     OR p_snapshot->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(p_snapshot->'people') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_snapshot->'people') NOT BETWEEN 1 AND 101
  THEN
    RAISE EXCEPTION 'Invalid purchase snapshot' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.public_ticket_member_purchase(id,tenant_id,event_id,event_kind,snapshot)
    VALUES(p_id,p_tenant_id,p_event_id,p_event_kind,p_snapshot)
    ON CONFLICT (id) DO NOTHING;
  SELECT p.* INTO existing FROM public.public_ticket_member_purchase AS p
    WHERE p.id = p_id FOR UPDATE;
  IF existing.tenant_id IS DISTINCT FROM p_tenant_id
     OR existing.event_id IS DISTINCT FROM p_event_id
     OR existing.event_kind IS DISTINCT FROM p_event_kind
     OR existing.snapshot IS DISTINCT FROM p_snapshot
  THEN
    RAISE EXCEPTION 'Purchase details changed; start a new checkout' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('id',existing.id,'state',existing.state);
END $$;
REVOKE ALL ON FUNCTION public.prepare_public_ticket_member_purchase(uuid,uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_public_ticket_member_purchase(uuid,uuid,uuid,text,jsonb)
  TO service_role;

-- This function is deliberately not exposed through the generic entity API.
-- Only a trusted finalizer may transition a receipt to ready after recording
-- the complete batch and verified captured/free evidence.
CREATE OR REPLACE FUNCTION public.provision_public_ticket_members(p_purchase_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  purchase public.public_ticket_member_purchase%ROWTYPE;
  person jsonb;
  selected_role public.role%ROWTYPE;
  created_member_id uuid;
  person_email text;
  created_count integer := 0;
  error_code text;
  booking_source text;
  confirmed_count integer;
  participation jsonb;
BEGIN
  SELECT p.* INTO purchase
    FROM public.public_ticket_member_purchase AS p
    WHERE p.id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = '22023';
  END IF;
  IF purchase.state = 'completed' THEN
    RETURN jsonb_build_object('state', 'completed', 'replayed', true);
  END IF;
  IF purchase.state NOT IN ('ready', 'retryable') THEN
    RETURN jsonb_build_object('state', purchase.state, 'created', 0);
  END IF;

  UPDATE public.public_ticket_member_purchase
    SET attempts = attempts + 1, updated_at = now()
    WHERE id = p_purchase_id;
  -- An exception in this inner block rolls back all new members and links,
  -- while the outer receipt records the outcome durably.
  BEGIN
    IF purchase.snapshot->>'tenant_id' IS DISTINCT FROM purchase.tenant_id::text
       OR purchase.snapshot->>'version' IS DISTINCT FROM '1'
       OR jsonb_typeof(purchase.snapshot->'people') IS DISTINCT FROM 'array'
       OR jsonb_array_length(purchase.snapshot->'people') NOT BETWEEN 1 AND 101
       OR cardinality(purchase.booking_ids) < 1
       OR coalesce(purchase.completion_evidence->>'status', '') NOT IN ('paid', 'free')
       OR purchase.completion_evidence->>'complete_batch' IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'Invalid purchase evidence' USING ERRCODE = 'P1001';
    END IF;
    booking_source := CASE purchase.event_kind WHEN 'simple' THEN 'booking' ELSE 'complex_event_booking' END;
    -- Lock the complete confirmed batch against concurrent cancellation. A
    -- previously confirmed receipt is not proof its bookings remain eligible.
    EXECUTE format(
      'SELECT count(*) FROM (SELECT b.id FROM public.%I b WHERE b.id=ANY($1) AND b.tenant_id=$2 AND b.event_id=$3 AND b.status=''confirmed'' AND b.member_id IS NULL AND b.organization_id IS NULL AND (($4=''free'' AND b.payment_method=''free'' AND $5 IS NULL) OR ($4=''paid'' AND b.payment_method=''card'' AND b.stripe_payment_intent_id=$5)) FOR SHARE) confirmed',
      booking_source
    ) INTO confirmed_count USING purchase.booking_ids,purchase.tenant_id,purchase.event_id,
      purchase.completion_evidence->>'status',purchase.stripe_payment_intent_id;
    IF confirmed_count<>cardinality(purchase.booking_ids) THEN
      RAISE EXCEPTION 'Invalid purchase evidence' USING ERRCODE = 'P1001';
    END IF;

    FOR person IN SELECT value FROM jsonb_array_elements(purchase.snapshot->'people')
      ORDER BY value->'identity'->>'email'
    LOOP
      person_email := lower(btrim(person->'identity'->>'email'));
      IF coalesce(person_email, '') = ''
         OR person_email IS DISTINCT FROM person->'identity'->>'email'
         OR coalesce(btrim(person->'identity'->>'first_name'), '') = ''
         OR coalesce(btrim(person->'identity'->>'last_name'), '') = ''
         OR coalesce(btrim(person->'identity'->>'organization'), '') = ''
         OR jsonb_typeof(person->'links') IS DISTINCT FROM 'array'
      THEN
        RAISE EXCEPTION 'Invalid contact snapshot' USING ERRCODE = 'P1001';
      END IF;

      SELECT r.* INTO selected_role FROM public.role AS r
        WHERE r.id = (person->>'role_id')::uuid
          AND r.tenant_id = purchase.tenant_id FOR SHARE;
      IF NOT FOUND OR coalesce(selected_role.is_admin, false)
         OR selected_role.is_tenant_admin
         OR coalesce(selected_role.requires_effective_from_date, false)
         OR selected_role.max_members IS NOT NULL
      THEN
        RAISE EXCEPTION 'Role no longer provisionable' USING ERRCODE = 'P1002';
      END IF;

      -- Never adopt or overwrite an existing person. The existing tenant/email
      -- unique index arbitrates simultaneous inserts by other purchases/imports.
      INSERT INTO public.member (
        tenant_id, email, first_name, last_name, supplied_organization_name,
        organization_id, role_id, login_enabled, show_in_directory
      ) VALUES (
        purchase.tenant_id, person_email,
        person->'identity'->>'first_name', person->'identity'->>'last_name',
        person->'identity'->>'organization', NULL, selected_role.id, false, false
      ) RETURNING public.member.id INTO created_member_id;

      SELECT jsonb_agg(CASE WHEN link->>'kind'='attendee' THEN
        link||jsonb_build_object('booking_id',purchase.booking_ids[
          1 + (link->>'index')::integer + coalesce((
            SELECT sum(jsonb_array_length(item->'attendees'))::integer
            FROM jsonb_array_elements(purchase.snapshot->'booking_items') WITH ORDINALITY AS prior(item,pos)
            WHERE pos<=coalesce((link->>'item_index')::integer,0)
          ),0)
        ]) ELSE link END)
      INTO participation FROM jsonb_array_elements(person->'links') AS links(link);
      INSERT INTO public.public_ticket_member_link(
        purchase_id, normalized_email, member_id, participation
      ) VALUES (purchase.id, person_email, created_member_id, participation);
      created_count := created_count + 1;
    END LOOP;
  EXCEPTION
    WHEN unique_violation THEN error_code := 'external_duplicate';
    WHEN SQLSTATE 'P1001' THEN error_code := 'invalid_completion_evidence';
    WHEN SQLSTATE 'P1002' THEN error_code := 'role_policy_conflict';
    WHEN OTHERS THEN error_code := 'retryable_database_error';
  END;

  IF error_code IS NOT NULL THEN
    UPDATE public.public_ticket_member_purchase
      SET state = CASE WHEN error_code = 'retryable_database_error' THEN 'retryable' ELSE 'conflict' END,
          last_error_code = error_code, updated_at = now()
      WHERE id = purchase.id;
    RETURN jsonb_build_object(
      'state', CASE WHEN error_code = 'retryable_database_error' THEN 'retryable' ELSE 'conflict' END,
      'code', error_code, 'created', 0
    );
  END IF;
  UPDATE public.public_ticket_member_purchase
    SET state = 'completed', last_error_code = NULL, completed_at = now(), updated_at = now()
    WHERE id = purchase.id;
  RETURN jsonb_build_object('state', 'completed', 'created', created_count);
END $$;

REVOKE ALL ON FUNCTION public.provision_public_ticket_members(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_public_ticket_members(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
