-- Task #3878: tenant-isolated opportunity pipeline and immutable history.
CREATE TABLE public.opportunity_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  position integer NOT NULL,
  color varchar(20) NOT NULL DEFAULT '#64748b',
  probability integer NOT NULL DEFAULT 0,
  is_won boolean NOT NULL DEFAULT false,
  is_lost boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  opportunity_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (position >= 0),
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  CHECK (probability BETWEEN 0 AND 100),
  CHECK (opportunity_count >= 0),
  CHECK (NOT (is_won AND is_lost))
);

CREATE TABLE public.opportunity_loss_reason (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (position >= 0)
);

CREATE TABLE public.opportunity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  loss_reason_id uuid,
  primary_contact_id uuid,
  owner_kind varchar(20) NOT NULL,
  owner_id uuid NOT NULL,
  name varchar(240) NOT NULL,
  description text,
  value_minor bigint,
  currency varchar(3) NOT NULL DEFAULT 'GBP',
  expected_close_date date,
  source varchar(160),
  priority varchar(20) NOT NULL DEFAULT 'medium',
  won_at timestamptz,
  lost_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by_kind varchar(20) NOT NULL,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (organization_id) REFERENCES public.organization(id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES public.opportunity_stage(tenant_id, id),
  FOREIGN KEY (tenant_id, loss_reason_id) REFERENCES public.opportunity_loss_reason(tenant_id, id),
  FOREIGN KEY (primary_contact_id) REFERENCES public.member(id),
  CHECK (owner_kind IN ('tenant_user', 'member')),
  CHECK (created_by_kind IN ('tenant_user', 'member')),
  CHECK (value_minor IS NULL OR value_minor >= 0),
  CHECK (currency ~ '^[A-Z]{3}$'),
  CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  CHECK (version > 0)
);

CREATE TABLE public.opportunity_collaborator (
  opportunity_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  principal_kind varchar(20) NOT NULL,
  principal_id uuid NOT NULL,
  added_by_kind varchar(20) NOT NULL,
  added_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, principal_kind, principal_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  CHECK (principal_kind IN ('tenant_user', 'member')),
  CHECK (added_by_kind IN ('tenant_user', 'member'))
);

CREATE TABLE public.opportunity_contact_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  member_id uuid NOT NULL,
  role varchar(120) NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, member_id, role),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES public.member(id)
);

CREATE TABLE public.opportunity_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  body text NOT NULL,
  author_kind varchar(20) NOT NULL,
  author_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  CHECK (author_kind IN ('tenant_user', 'member')),
  CHECK (length(body) BETWEEN 1 AND 20000)
);

CREATE TABLE public.opportunity_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  title varchar(240) NOT NULL,
  description text,
  due_at timestamptz,
  completed_at timestamptz,
  assignee_kind varchar(20),
  assignee_id uuid,
  created_by_kind varchar(20) NOT NULL,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  CHECK (assignee_kind IS NULL OR assignee_kind IN ('tenant_user', 'member')),
  CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL)),
  CHECK (created_by_kind IN ('tenant_user', 'member'))
);

CREATE TABLE public.opportunity_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  bucket varchar(100) NOT NULL DEFAULT 'private-uploads',
  storage_path text NOT NULL,
  mime_type varchar(255),
  size_bytes bigint,
  uploaded_by_kind varchar(20) NOT NULL,
  uploaded_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  CHECK (bucket = 'private-uploads'),
  CHECK (storage_path <> ''),
  CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CHECK (uploaded_by_kind IN ('tenant_user', 'member')),
  UNIQUE (tenant_id, storage_path)
);

CREATE TABLE public.opportunity_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  loss_reason_id uuid,
  actor_kind varchar(20) NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_stage_id) REFERENCES public.opportunity_stage(tenant_id, id),
  FOREIGN KEY (tenant_id, to_stage_id) REFERENCES public.opportunity_stage(tenant_id, id),
  FOREIGN KEY (tenant_id, loss_reason_id) REFERENCES public.opportunity_loss_reason(tenant_id, id),
  CHECK (actor_kind IN ('tenant_user', 'member'))
);

CREATE TABLE public.opportunity_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  member_id uuid,
  event_id uuid,
  actor_kind varchar(20) NOT NULL,
  actor_id uuid NOT NULL,
  action varchar(100) NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES public.organization(id),
  FOREIGN KEY (member_id) REFERENCES public.member(id),
  FOREIGN KEY (event_id) REFERENCES public.event(id),
  CHECK (actor_kind IN ('tenant_user', 'member', 'system')),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX opportunity_tenant_stage_idx ON public.opportunity (tenant_id, stage_id, updated_at DESC);
CREATE INDEX opportunity_tenant_owner_idx ON public.opportunity (tenant_id, owner_kind, owner_id, updated_at DESC);
CREATE INDEX opportunity_tenant_org_idx ON public.opportunity (tenant_id, organization_id, updated_at DESC);
CREATE INDEX opportunity_collaborator_principal_idx ON public.opportunity_collaborator (tenant_id, principal_kind, principal_id);
CREATE INDEX opportunity_contact_member_idx ON public.opportunity_contact_role (tenant_id, member_id);
CREATE INDEX opportunity_activity_org_idx ON public.opportunity_activity (tenant_id, organization_id, created_at DESC);
CREATE INDEX opportunity_activity_member_idx ON public.opportunity_activity (tenant_id, member_id, created_at DESC);
CREATE INDEX opportunity_activity_opportunity_idx ON public.opportunity_activity (tenant_id, opportunity_id, created_at DESC);
CREATE INDEX opportunity_history_idx ON public.opportunity_stage_history (tenant_id, opportunity_id, created_at DESC);

-- Maintained transactionally below. This statement is also the required
-- backfill when the complete migration is adapted to an existing schema.
UPDATE public.opportunity_stage s
SET opportunity_count = counts.opportunity_count
FROM (
  SELECT tenant_id, stage_id, count(*)::integer AS opportunity_count
  FROM public.opportunity
  GROUP BY tenant_id, stage_id
) counts
WHERE s.tenant_id=counts.tenant_id AND s.id=counts.stage_id;

-- Polymorphic principals and optional CRM event links are tenant checked here.
CREATE OR REPLACE FUNCTION public.guard_opportunity_tenant_links()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'opportunity' THEN
    IF NOT EXISTS
      (SELECT 1 FROM organization WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Opportunity organisation does not belong to tenant' USING ERRCODE='23503';
    END IF;
    IF NEW.owner_kind = 'member' AND NOT EXISTS
      (SELECT 1 FROM member WHERE id=NEW.owner_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Opportunity owner does not belong to tenant' USING ERRCODE='23503';
    ELSIF NEW.owner_kind = 'tenant_user' AND NOT EXISTS
      (SELECT 1 FROM tenant_user WHERE id=NEW.owner_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Opportunity owner does not belong to tenant' USING ERRCODE='23503';
    END IF;
    IF NEW.primary_contact_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM member WHERE id=NEW.primary_contact_id AND tenant_id=NEW.tenant_id
        AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'Primary contact does not belong to opportunity organisation' USING ERRCODE='23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'opportunity_collaborator' THEN
    IF NEW.principal_kind = 'member' AND NOT EXISTS
      (SELECT 1 FROM member WHERE id=NEW.principal_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Collaborator does not belong to tenant' USING ERRCODE='23503';
    ELSIF NEW.principal_kind = 'tenant_user' AND NOT EXISTS
      (SELECT 1 FROM tenant_user WHERE id=NEW.principal_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Collaborator does not belong to tenant' USING ERRCODE='23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'opportunity_contact_role' AND NOT EXISTS
    (SELECT 1 FROM member m JOIN opportunity o ON o.id=NEW.opportunity_id AND o.tenant_id=NEW.tenant_id
      WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id AND m.organization_id=o.organization_id) THEN
    RAISE EXCEPTION 'Contact does not belong to tenant' USING ERRCODE='23503';
  ELSIF TG_TABLE_NAME = 'opportunity_activity' THEN
    IF NOT EXISTS (SELECT 1 FROM organization WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id)
      OR (NEW.member_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id))
      OR (NEW.event_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id)) THEN
      RAISE EXCEPTION 'Activity CRM link does not belong to tenant' USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_tenant_links BEFORE INSERT OR UPDATE ON public.opportunity
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_tenant_links();
CREATE TRIGGER opportunity_collaborator_tenant_links BEFORE INSERT OR UPDATE ON public.opportunity_collaborator
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_tenant_links();
CREATE TRIGGER opportunity_contact_tenant_links BEFORE INSERT OR UPDATE ON public.opportunity_contact_role
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_tenant_links();
CREATE TRIGGER opportunity_activity_tenant_links BEFORE INSERT OR UPDATE ON public.opportunity_activity
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_tenant_links();

-- Stage assignment and deactivation both UPDATE the same stage row. PostgreSQL
-- row locking therefore serializes assignment, move, deletion, and deactivation
-- without relying on a raceable existence query.
CREATE OR REPLACE FUNCTION public.maintain_opportunity_stage_count()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE affected integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.opportunity_stage SET opportunity_count=opportunity_count+1
      WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id AND is_active;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'An active tenant stage is required for assignment' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN RETURN NEW; END IF;
    -- Increment first. If the old-stage decrement or any later trigger fails,
    -- the entire statement (including this increment) rolls back.
    UPDATE public.opportunity_stage SET opportunity_count=opportunity_count+1
      WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id AND is_active;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'An active tenant stage is required for assignment' USING ERRCODE='23514';
    END IF;
    UPDATE public.opportunity_stage SET opportunity_count=opportunity_count-1
      WHERE tenant_id=OLD.tenant_id AND id=OLD.stage_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'Previous opportunity stage was not found' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  -- During parent cascades the stage may already have been removed. Otherwise
  -- the nonnegative CHECK catches any counter drift and aborts the delete.
  UPDATE public.opportunity_stage SET opportunity_count=opportunity_count-1
    WHERE tenant_id=OLD.tenant_id AND id=OLD.stage_id;
  RETURN OLD;
END $$;
CREATE TRIGGER opportunity_stage_count_trigger
  BEFORE INSERT OR UPDATE OF stage_id OR DELETE ON public.opportunity
  FOR EACH ROW EXECUTE FUNCTION public.maintain_opportunity_stage_count();

CREATE OR REPLACE FUNCTION public.guard_opportunity_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Opportunity history and activity are append-only'
      USING ERRCODE='23514';
  END IF;

  -- Direct deletion remains forbidden while the parent opportunity is alive.
  -- During an opportunity delete (including a tenant -> opportunity cascade),
  -- the parent row is no longer visible to the cascading child DELETE, so the
  -- immutable child rows may be removed with their owning aggregate.
  IF EXISTS (
    SELECT 1 FROM public.opportunity
    WHERE tenant_id=OLD.tenant_id AND id=OLD.opportunity_id
  ) THEN
    RAISE EXCEPTION 'Opportunity history and activity are append-only'
      USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER opportunity_history_immutable BEFORE UPDATE OR DELETE ON public.opportunity_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_immutable();
CREATE TRIGGER opportunity_activity_immutable BEFORE UPDATE OR DELETE ON public.opportunity_activity
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_immutable();

CREATE OR REPLACE FUNCTION public.guard_opportunity_lifecycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE destination public.opportunity_stage%ROWTYPE;
BEGIN
  -- Assignment/reassignment takes the destination row lock before evaluating
  -- classification. The count trigger later updates this same row, thereby
  -- serializing a first assignment with stage reclassification/deactivation.
  -- Ordinary edits keep their historical-stage compatibility without locking.
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    SELECT * INTO destination FROM opportunity_stage
      WHERE id=NEW.stage_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  ELSE
    SELECT * INTO destination FROM opportunity_stage
      WHERE id=NEW.stage_id AND tenant_id=NEW.tenant_id;
  END IF;
  IF destination.id IS NULL THEN
    RAISE EXCEPTION 'A tenant stage is required' USING ERRCODE='23514';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id)
    AND NOT destination.is_active THEN
    RAISE EXCEPTION 'An active tenant stage is required for a new stage assignment' USING ERRCODE='23514';
  END IF;
  IF destination.is_lost <> (NEW.loss_reason_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Loss reason is required exactly when the stage is lost' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.won_at := CASE WHEN destination.is_won THEN now() ELSE NULL END;
    NEW.lost_at := CASE WHEN destination.is_lost THEN now() ELSE NULL END;
  ELSE
    NEW.won_at := CASE WHEN destination.is_won THEN COALESCE(OLD.won_at, now()) ELSE NULL END;
    NEW.lost_at := CASE WHEN destination.is_lost THEN COALESCE(OLD.lost_at, now()) ELSE NULL END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_lifecycle BEFORE INSERT OR UPDATE ON public.opportunity
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_lifecycle();

CREATE OR REPLACE FUNCTION public.record_opportunity_created()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE stage_name text;
BEGIN
  SELECT name INTO stage_name FROM opportunity_stage
    WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id;
  INSERT INTO opportunity_stage_history
    (tenant_id,opportunity_id,from_stage_id,to_stage_id,loss_reason_id,actor_kind,actor_id)
    VALUES (NEW.tenant_id,NEW.id,NULL,NEW.stage_id,NEW.loss_reason_id,
      NEW.created_by_kind,NEW.created_by_id);
  INSERT INTO opportunity_activity
    (tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary)
    VALUES (NEW.tenant_id,NEW.id,NEW.organization_id,NEW.created_by_kind,NEW.created_by_id,
      'opportunity.created','Opportunity created in '||stage_name);
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_created AFTER INSERT ON public.opportunity
  FOR EACH ROW EXECUTE FUNCTION public.record_opportunity_created();

CREATE OR REPLACE FUNCTION public.create_opportunity_primary_contact()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.primary_contact_id IS NOT NULL THEN
    INSERT INTO opportunity_contact_role (tenant_id, opportunity_id, member_id, role, is_primary)
      VALUES (NEW.tenant_id, NEW.id, NEW.primary_contact_id, 'Primary contact', true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_primary_contact AFTER INSERT ON public.opportunity
  FOR EACH ROW EXECUTE FUNCTION public.create_opportunity_primary_contact();

-- One tenant-wide version makes a complete Kanban reorder an optimistic,
-- atomic operation rather than a sequence of collision-prone row updates.
CREATE TABLE public.opportunity_pipeline_config (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
  order_version integer NOT NULL DEFAULT 1 CHECK (order_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.guard_opportunity_stage_position()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.position IS DISTINCT FROM OLD.position
    AND current_setting('opportunity.reordering', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Stage positions must be changed with reorder_opportunity_stages'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_stage_position_guard BEFORE UPDATE ON public.opportunity_stage
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_stage_position();

-- A pipeline stage with live opportunities is historical workflow state and
-- cannot be removed from the active pipeline until those opportunities move.
CREATE OR REPLACE FUNCTION public.guard_opportunity_stage_deactivation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active AND OLD.opportunity_count > 0 THEN
    RAISE EXCEPTION 'Cannot deactivate a stage used by opportunities'
      USING ERRCODE='P0001', CONSTRAINT='opportunity_stage_referenced_active';
  END IF;
  IF OLD.opportunity_count > 0 AND (
    NEW.is_lost IS DISTINCT FROM OLD.is_lost
    OR NEW.is_won IS DISTINCT FROM OLD.is_won
  ) THEN
    RAISE EXCEPTION 'Cannot change won/lost classification of a stage used by opportunities'
      USING ERRCODE='P0001', CONSTRAINT='opportunity_stage_occupied_classification';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_stage_deactivation_guard BEFORE UPDATE ON public.opportunity_stage
  FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_stage_deactivation();

CREATE OR REPLACE FUNCTION public.bump_opportunity_stage_order_version()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE scope_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    scope_tenant := OLD.tenant_id;
  ELSE
    scope_tenant := NEW.tenant_id;
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    INSERT INTO public.opportunity_pipeline_config (tenant_id) VALUES (scope_tenant)
      ON CONFLICT (tenant_id) DO UPDATE SET order_version=opportunity_pipeline_config.order_version+1,
        updated_at=now();
  ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    INSERT INTO public.opportunity_pipeline_config (tenant_id) VALUES (scope_tenant)
      ON CONFLICT (tenant_id) DO UPDATE SET order_version=opportunity_pipeline_config.order_version+1,
        updated_at=now();
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_stage_order_version AFTER INSERT OR UPDATE OR DELETE ON public.opportunity_stage
  FOR EACH ROW EXECUTE FUNCTION public.bump_opportunity_stage_order_version();

CREATE OR REPLACE FUNCTION public.create_opportunity_stage(
  p_tenant_id uuid, p_name text, p_color text, p_probability integer,
  p_is_won boolean, p_is_lost boolean
) RETURNS SETOF public.opportunity_stage
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE created_stage public.opportunity_stage%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' OR length(btrim(p_name)) > 120
    OR p_color IS NULL OR p_color !~ '^#[0-9A-Fa-f]{6}$'
    OR p_probability IS NULL OR p_probability NOT BETWEEN 0 AND 100
    OR COALESCE(p_is_won,false) AND COALESCE(p_is_lost,false) THEN
    RAISE EXCEPTION 'Invalid opportunity stage fields' USING ERRCODE='22023';
  END IF;
  -- This is deliberately the same lock as reorder_opportunity_stages, so a
  -- stage append cannot race a complete reorder or another stage append.
  INSERT INTO public.opportunity_pipeline_config (tenant_id) VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
  PERFORM 1 FROM public.opportunity_pipeline_config WHERE tenant_id=p_tenant_id FOR UPDATE;
  INSERT INTO public.opportunity_stage
    (tenant_id,name,position,color,probability,is_won,is_lost)
    VALUES (p_tenant_id,btrim(p_name),
      COALESCE((SELECT max(position)+1 FROM public.opportunity_stage WHERE tenant_id=p_tenant_id),0),
      p_color,p_probability,COALESCE(p_is_won,false),COALESCE(p_is_lost,false))
    RETURNING * INTO created_stage;
  RETURN NEXT created_stage;
END $$;

CREATE OR REPLACE FUNCTION public.reorder_opportunity_stages(
  p_tenant_id uuid, p_stage_ids uuid[], p_expected_order_version integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_version integer;
DECLARE active_count integer;
DECLARE supplied_count integer;
BEGIN
  IF p_tenant_id IS NULL OR p_expected_order_version IS NULL OR p_expected_order_version < 1 THEN
    RAISE EXCEPTION 'Tenant and expected order version are required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.opportunity_pipeline_config (tenant_id) VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
  SELECT order_version INTO current_version FROM public.opportunity_pipeline_config
    WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF current_version <> p_expected_order_version THEN
    RAISE EXCEPTION 'Pipeline order version conflict' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO active_count FROM public.opportunity_stage
    WHERE tenant_id=p_tenant_id AND is_active;
  SELECT count(DISTINCT stage_id) INTO supplied_count FROM unnest(p_stage_ids) AS stage_id;
  IF cardinality(p_stage_ids) <> active_count OR supplied_count <> active_count
    OR EXISTS (
      SELECT s.id FROM public.opportunity_stage s WHERE s.tenant_id=p_tenant_id AND s.is_active
      EXCEPT SELECT stage_id FROM unnest(p_stage_ids) AS stage_id
    ) THEN
    RAISE EXCEPTION 'Reorder must contain each active tenant stage exactly once' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('opportunity.reordering', 'on', true);
  UPDATE public.opportunity_stage s SET position=ordered.ordinality-1, updated_at=now()
    FROM unnest(p_stage_ids) WITH ORDINALITY AS ordered(stage_id, ordinality)
    WHERE s.tenant_id=p_tenant_id AND s.id=ordered.stage_id;
  -- The bypass is strictly limited to the atomic reorder UPDATE above; do not
  -- leave it enabled for unrelated statements in the caller transaction.
  PERFORM set_config('opportunity.reordering', 'off', true);
  UPDATE public.opportunity_pipeline_config SET order_version=order_version+1, updated_at=now()
    WHERE tenant_id=p_tenant_id RETURNING order_version INTO current_version;
  RETURN current_version;
END $$;

-- Optimistic move, history, and activity are one transaction. "Won" is only
-- the destination stage classification and has no commercial-sale side effect.
CREATE OR REPLACE FUNCTION public.move_opportunity(
  p_tenant_id uuid, p_opportunity_id uuid, p_stage_id uuid,
  p_loss_reason_id uuid, p_expected_version integer,
  p_actor_kind text, p_actor_id uuid
) RETURNS SETOF public.opportunity
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_row public.opportunity%ROWTYPE;
DECLARE new_row public.opportunity%ROWTYPE;
DECLARE destination public.opportunity_stage%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM public.opportunity
    WHERE tenant_id=p_tenant_id AND id=p_opportunity_id FOR UPDATE;
  IF old_row.id IS NULL THEN RAISE EXCEPTION 'Opportunity not found' USING ERRCODE='P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Opportunity version conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO destination FROM public.opportunity_stage
    WHERE tenant_id=p_tenant_id AND id=p_stage_id AND is_active;
  IF destination.id IS NULL THEN RAISE EXCEPTION 'Active stage not found' USING ERRCODE='22023'; END IF;
  IF destination.is_lost <> (p_loss_reason_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Loss reason is required exactly for lost stages' USING ERRCODE='22023';
  END IF;
  IF p_loss_reason_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.opportunity_loss_reason
    WHERE tenant_id=p_tenant_id AND id=p_loss_reason_id AND is_active
  ) THEN RAISE EXCEPTION 'Active loss reason not found' USING ERRCODE='22023'; END IF;

  UPDATE public.opportunity SET stage_id=p_stage_id, loss_reason_id=p_loss_reason_id,
    version=version+1, updated_at=now()
    WHERE tenant_id=p_tenant_id AND id=p_opportunity_id RETURNING * INTO new_row;
  INSERT INTO public.opportunity_stage_history
    (tenant_id,opportunity_id,from_stage_id,to_stage_id,loss_reason_id,actor_kind,actor_id)
    VALUES (p_tenant_id,p_opportunity_id,old_row.stage_id,p_stage_id,p_loss_reason_id,p_actor_kind,p_actor_id);
  INSERT INTO public.opportunity_activity
    (tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES (p_tenant_id,p_opportunity_id,new_row.organization_id,p_actor_kind,p_actor_id,
      'stage.changed','Stage changed to '||destination.name,
      jsonb_build_object('fromStageId',old_row.stage_id,'toStageId',p_stage_id));
  RETURN NEXT new_row;
END $$;

ALTER TABLE public.opportunity_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_loss_reason ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_collaborator ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_contact_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_pipeline_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.opportunity_stage, public.opportunity_loss_reason,
  public.opportunity, public.opportunity_collaborator, public.opportunity_contact_role,
  public.opportunity_note, public.opportunity_task, public.opportunity_document,
  public.opportunity_stage_history, public.opportunity_activity FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.opportunity_pipeline_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.move_opportunity(uuid,uuid,uuid,uuid,integer,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reorder_opportunity_stages(uuid,uuid[],integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_opportunity_stage(uuid,text,text,integer,boolean,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.opportunity_stage, public.opportunity_loss_reason,
  public.opportunity, public.opportunity_collaborator, public.opportunity_contact_role,
  public.opportunity_note, public.opportunity_task, public.opportunity_document,
  public.opportunity_stage_history, public.opportunity_activity TO service_role;
GRANT ALL ON TABLE public.opportunity_pipeline_config TO service_role;
GRANT EXECUTE ON FUNCTION public.move_opportunity(uuid,uuid,uuid,uuid,integer,text,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reorder_opportunity_stages(uuid,uuid[],integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_opportunity_stage(uuid,text,text,integer,boolean,boolean)
  TO service_role;