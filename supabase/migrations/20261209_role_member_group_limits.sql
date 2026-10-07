-- Run transactionally. Existing roles remain unlimited; never rewrite provenance.
ALTER TABLE public.role ADD COLUMN IF NOT EXISTS max_member_groups integer
  CHECK (max_member_groups >= 0);
ALTER TABLE public.role ADD COLUMN IF NOT EXISTS exclude_auto_joined_groups_from_limit boolean NOT NULL DEFAULT false;

-- Only the reconciliation wrapper can authorize automatic provenance. Neither
-- browser roles nor service_role can write this table or call the inner worker.
CREATE TABLE IF NOT EXISTS public.member_group_automatic_write_context (
  transaction_id bigint NOT NULL,
  group_id uuid NOT NULL,
  PRIMARY KEY(transaction_id, group_id)
);
ALTER TABLE public.member_group_automatic_write_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_group_automatic_write_context FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.reconcile_automatic_membership_inner(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)') IS NULL THEN
    ALTER FUNCTION public.reconcile_automatic_membership(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)
      RENAME TO reconcile_automatic_membership_inner;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.reconcile_automatic_membership_inner(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_automatic_membership(
  p_group_id uuid, p_tenant_id uuid, p_role text, p_batch_member_ids uuid[],
  p_full_target_ids uuid[], p_is_final_batch boolean DEFAULT true,
  p_next_cursor text DEFAULT NULL, p_full_match_count integer DEFAULT NULL,
  p_expected_generation bigint DEFAULT NULL, p_expected_cursor text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; mid uuid;
BEGIN
  FOR mid IN
    SELECT member_id FROM (
      SELECT unnest(coalesce(p_batch_member_ids,'{}'::uuid[])) member_id
      UNION SELECT a.member_id FROM public.member_group_assignment a WHERE a.group_id=p_group_id
    ) affected WHERE member_id IS NOT NULL ORDER BY member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('member-group-limit:' || mid::text,0));
  END LOOP;
  INSERT INTO public.member_group_automatic_write_context VALUES(txid_current(), p_group_id);
  result := public.reconcile_automatic_membership_inner(
    p_group_id,p_tenant_id,p_role,p_batch_member_ids,p_full_target_ids,
    p_is_final_batch,p_next_cursor,p_full_match_count,p_expected_generation,p_expected_cursor);
  DELETE FROM public.member_group_automatic_write_context
    WHERE transaction_id=txid_current() AND group_id=p_group_id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.reconcile_automatic_membership(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_automatic_membership(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_member_group_automatic_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.assignment_source='automatic' AND
    (TG_OP='INSERT' OR ROW(NEW.member_id,NEW.group_id,NEW.tenant_id,NEW.assignment_source)
      IS DISTINCT FROM ROW(OLD.member_id,OLD.group_id,OLD.tenant_id,OLD.assignment_source))
    AND NOT EXISTS(SELECT 1 FROM public.member_group_automatic_write_context
      WHERE transaction_id=txid_current() AND group_id=NEW.group_id)
  THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Automatic group membership can only be assigned by automatic reconciliation.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_group_automatic_provenance ON public.member_group_assignment;
CREATE TRIGGER member_group_automatic_provenance BEFORE INSERT OR UPDATE ON public.member_group_assignment
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_group_automatic_provenance();

-- Transition tables let multi-member statements lock their entire affected set
-- in deterministic order. A fresh READ COMMITTED snapshot after waiting sees
-- the previous writer's committed memberships, including other groups.
CREATE OR REPLACE FUNCTION public.enforce_member_group_role_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE
  affected record; target record; policy record;
  old_rows jsonb := '[]'; new_rows jsonb := '[]';
  before_count integer; after_count integer; manual_increase boolean;
  at_time timestamptz := statement_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN SELECT coalesce(jsonb_agg(to_jsonb(o)), '[]') INTO old_rows FROM old_assignments o; END IF;
  IF TG_OP <> 'DELETE' THEN SELECT coalesce(jsonb_agg(to_jsonb(n)), '[]') INTO new_rows FROM new_assignments n; END IF;
  FOR affected IN
    SELECT DISTINCT (r->>'member_id')::uuid member_id FROM jsonb_array_elements(old_rows || new_rows) r
    WHERE r->>'member_id' IS NOT NULL ORDER BY member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('member-group-limit:' || affected.member_id::text,0));
  END LOOP;
  FOR affected IN
    SELECT DISTINCT (r->>'member_id')::uuid member_id, (r->>'tenant_id')::uuid tenant_id
    FROM jsonb_array_elements(new_rows) r WHERE r->>'member_id' IS NOT NULL
    ORDER BY member_id, tenant_id
  LOOP
    SELECT m.role_id, coalesce(m.tenant_id,o.tenant_id) tenant_id INTO target
      FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id WHERE m.id=affected.member_id;
    IF NOT FOUND OR target.tenant_id IS DISTINCT FROM affected.tenant_id THEN
      RAISE EXCEPTION 'Cannot resolve the target member in this tenant';
    END IF;
    IF target.role_id IS NULL THEN CONTINUE; END IF;
    SELECT r.max_member_groups,r.exclude_auto_joined_groups_from_limit INTO policy
      FROM public.role r WHERE r.id=target.role_id AND r.tenant_id=affected.tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cannot resolve the target member role in this tenant'; END IF;
    IF policy.max_member_groups IS NULL THEN CONTINUE; END IF;
    -- Provisioned guests have member IDs but remain outside member limits.
    IF EXISTS(SELECT 1 FROM public.member_group_guest g WHERE g.member_id=affected.member_id AND g.tenant_id=affected.tenant_id) THEN CONTINUE; END IF;
    WITH current_rows AS (
      SELECT a.id,a.group_id,a.assignment_source,a.expires_at,a.guest_id
      FROM public.member_group_assignment a
      WHERE a.member_id=affected.member_id AND a.tenant_id=affected.tenant_id
    ), previous_rows AS (
      SELECT c.* FROM current_rows c WHERE NOT EXISTS
        (SELECT 1 FROM jsonb_array_elements(new_rows) n WHERE (n->>'id')::uuid=c.id)
      UNION ALL
      SELECT (o->>'id')::uuid,(o->>'group_id')::uuid,o->>'assignment_source',
        (o->>'expires_at')::timestamptz,(o->>'guest_id')::uuid
      FROM jsonb_array_elements(old_rows) o
      WHERE (o->>'member_id')::uuid=affected.member_id AND (o->>'tenant_id')::uuid=affected.tenant_id
    ), previous_groups AS (
      SELECT DISTINCT group_id FROM previous_rows
      WHERE guest_id IS NULL AND (expires_at IS NULL OR expires_at::timestamptz>at_time)
        AND (NOT policy.exclude_auto_joined_groups_from_limit OR assignment_source IS DISTINCT FROM 'automatic')
    ), current_groups AS (
      SELECT DISTINCT group_id FROM current_rows
      WHERE guest_id IS NULL AND (expires_at IS NULL OR expires_at::timestamptz>at_time)
        AND (NOT policy.exclude_auto_joined_groups_from_limit OR assignment_source IS DISTINCT FROM 'automatic')
    )
    SELECT (SELECT count(*) FROM previous_groups),(SELECT count(*) FROM current_groups),
      EXISTS(SELECT 1 FROM jsonb_array_elements(new_rows) n
        WHERE (n->>'member_id')::uuid=affected.member_id AND (n->>'tenant_id')::uuid=affected.tenant_id
          AND n->>'guest_id' IS NULL AND n->>'assignment_source' IS DISTINCT FROM 'automatic'
          AND (n->>'expires_at' IS NULL OR (n->>'expires_at')::timestamptz>at_time)
          AND NOT EXISTS(SELECT 1 FROM previous_groups p WHERE p.group_id=(n->>'group_id')::uuid))
      INTO before_count,after_count,manual_increase;
    IF manual_increase AND after_count>before_count AND after_count>policy.max_member_groups THEN
      RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE=format('Member group limit reached (%s). Leave a counted group or ask a role administrator to change the limit before adding another group.',policy.max_member_groups),
        DETAIL='MEMBER_GROUP_LIMIT_REACHED';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS member_group_limit_insert ON public.member_group_assignment;
DROP TRIGGER IF EXISTS member_group_limit_update ON public.member_group_assignment;
DROP TRIGGER IF EXISTS member_group_limit_delete ON public.member_group_assignment;
CREATE TRIGGER member_group_limit_insert AFTER INSERT ON public.member_group_assignment
  REFERENCING NEW TABLE AS new_assignments FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_member_group_role_limit();
CREATE TRIGGER member_group_limit_update AFTER UPDATE ON public.member_group_assignment
  REFERENCING NEW TABLE AS new_assignments OLD TABLE AS old_assignments FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_member_group_role_limit();
CREATE TRIGGER member_group_limit_delete AFTER DELETE ON public.member_group_assignment
  REFERENCING OLD TABLE AS old_assignments FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_member_group_role_limit();

CREATE OR REPLACE FUNCTION public.lock_member_group_role_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mid uuid;
BEGIN
  FOR mid IN SELECT n.id FROM new_members n JOIN old_members o ON o.id=n.id
    WHERE ROW(n.role_id,n.tenant_id,n.organization_id) IS DISTINCT FROM ROW(o.role_id,o.tenant_id,o.organization_id)
    ORDER BY n.id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('member-group-limit:' || mid::text,0));
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS member_group_role_changes ON public.member;
CREATE TRIGGER member_group_role_changes AFTER UPDATE ON public.member
  REFERENCING NEW TABLE AS new_members OLD TABLE AS old_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_member_group_role_changes();
REVOKE ALL ON FUNCTION public.enforce_member_group_role_limit(),public.guard_member_group_automatic_provenance(),
  public.lock_member_group_role_changes() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.apply_group_invitation_decision(p_id uuid,p_action text,p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE invitation public.member_group_role_invitation; aid uuid; snapshot public.member_group_assignment;
BEGIN
  IF p_action NOT IN ('accept','decline') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO STRICT invitation FROM public.member_group_role_invitation WHERE id=p_id FOR UPDATE;
  IF invitation.status<>'pending' OR (invitation.expires_at IS NOT NULL AND invitation.expires_at<=now()) THEN
    RETURN to_jsonb(invitation);
  END IF;
  IF p_action='accept' THEN
    snapshot := jsonb_populate_record(NULL::public.member_group_assignment,coalesce(p_snapshot,'{}'));
    SELECT id INTO aid FROM public.member_group_assignment
      WHERE tenant_id=invitation.tenant_id AND group_id=invitation.group_id AND member_id=invitation.member_id FOR UPDATE;
    IF aid IS NULL THEN
      INSERT INTO public.member_group_assignment(tenant_id,group_id,member_id,group_role,assignment_source,
        term_start_date,term_end_date,term_number,term_length_value,term_length_unit,max_terms)
      VALUES(invitation.tenant_id,invitation.group_id,invitation.member_id,invitation.group_role,'manual',
        snapshot.term_start_date,snapshot.term_end_date,snapshot.term_number,snapshot.term_length_value,snapshot.term_length_unit,snapshot.max_terms)
      RETURNING id INTO aid;
    ELSE
      UPDATE public.member_group_assignment SET group_role=invitation.group_role,assignment_source='manual',
        term_start_date=snapshot.term_start_date,term_end_date=snapshot.term_end_date,term_number=snapshot.term_number,
        term_length_value=snapshot.term_length_value,term_length_unit=snapshot.term_length_unit,max_terms=snapshot.max_terms
      WHERE id=aid;
    END IF;
  END IF;
  UPDATE public.member_group_role_invitation SET status=CASE WHEN p_action='accept' THEN 'accepted' ELSE 'declined' END,
    decided_at=now(),assignment_id=aid WHERE id=p_id RETURNING * INTO invitation;
  RETURN to_jsonb(invitation);
END $$;

CREATE OR REPLACE FUNCTION public.award_group_vacancy(p_tenant uuid,p_group uuid,p_vacancy uuid,p_member uuid,
  p_role text,p_source_type text,p_source_id uuid,p_actor uuid,p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE capacity integer; aid uuid; snapshot public.member_group_assignment;
BEGIN
  SELECT greatest(1,coalesce(positions_available,1)) INTO STRICT capacity FROM public.vacancy
    WHERE id=p_vacancy AND tenant_id=p_tenant AND member_group_id=p_group FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.vacancy_award WHERE vacancy_id=p_vacancy AND awarded_member_id=p_member) THEN RETURN; END IF;
  IF (SELECT count(*) FROM public.vacancy_award WHERE vacancy_id=p_vacancy)>=capacity THEN
    RAISE EXCEPTION 'All positions for this vacancy are already filled.';
  END IF;
  snapshot := jsonb_populate_record(NULL::public.member_group_assignment,coalesce(p_snapshot,'{}'));
  SELECT id INTO aid FROM public.member_group_assignment
    WHERE tenant_id=p_tenant AND group_id=p_group AND member_id=p_member FOR UPDATE;
  IF aid IS NULL THEN
    INSERT INTO public.member_group_assignment(tenant_id,group_id,member_id,group_role,assignment_source,
      term_start_date,term_end_date,term_number,term_length_value,term_length_unit,max_terms)
    VALUES(p_tenant,p_group,p_member,coalesce(nullif(p_role,''),'Member'),'manual',
      snapshot.term_start_date,snapshot.term_end_date,snapshot.term_number,snapshot.term_length_value,snapshot.term_length_unit,snapshot.max_terms);
  ELSE
    UPDATE public.member_group_assignment SET group_role=coalesce(nullif(p_role,''),group_role),assignment_source='manual',
      term_start_date=snapshot.term_start_date,term_end_date=snapshot.term_end_date,term_number=snapshot.term_number,
      term_length_value=snapshot.term_length_value,term_length_unit=snapshot.term_length_unit,max_terms=snapshot.max_terms
    WHERE id=aid;
  END IF;
  INSERT INTO public.vacancy_award(tenant_id,member_group_id,vacancy_id,awarded_member_id,source_type,source_id,awarded_by_member_id)
    VALUES(p_tenant,p_group,p_vacancy,p_member,p_source_type,p_source_id,p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.merge_member_group_assignments(p_tenant uuid,p_source uuid,p_target uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mid uuid;
BEGIN
  IF p_source IS NULL OR p_target IS NULL OR p_source=p_target THEN RAISE EXCEPTION 'Invalid merge members'; END IF;
  FOR mid IN SELECT id FROM public.member WHERE id IN(p_source,p_target) ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('member-group-limit:' || mid::text,0));
  END LOOP;
  IF (SELECT count(*) FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
    WHERE m.id IN(p_source,p_target) AND coalesce(m.tenant_id,o.tenant_id)=p_tenant)<>2 THEN
    RAISE EXCEPTION 'Merge members must belong to this tenant';
  END IF;
  -- Move everything non-duplicate in one statement; the limit failure rolls
  -- back all moves, and duplicates are deleted only after it succeeds.
  UPDATE public.member_group_assignment a SET member_id=p_target,assignment_source='manual'
    WHERE a.member_id=p_source AND a.tenant_id=p_tenant
    AND NOT EXISTS(SELECT 1 FROM public.member_group_assignment t
      WHERE t.member_id=p_target AND t.group_id=a.group_id AND t.tenant_id=p_tenant);
  DELETE FROM public.member_group_assignment WHERE member_id=p_source AND tenant_id=p_tenant;
END $$;
REVOKE ALL ON FUNCTION public.apply_group_invitation_decision(uuid,text,jsonb),
  public.award_group_vacancy(uuid,uuid,uuid,uuid,text,text,uuid,uuid,jsonb),
  public.merge_member_group_assignments(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_group_invitation_decision(uuid,text,jsonb),
  public.award_group_vacancy(uuid,uuid,uuid,uuid,text,text,uuid,uuid,jsonb),
  public.merge_member_group_assignments(uuid,uuid,uuid) TO service_role;

-- Preserve the existing copy function's authorization and category semantics.
DO $$
DECLARE definition text;
BEGIN
  IF to_regprocedure('public.copy_role_access_settings(uuid,uuid,uuid,boolean)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.copy_role_access_settings(uuid,uuid,uuid,boolean)'::regprocedure) INTO definition;
    IF position('max_member_groups = source_role.max_member_groups' IN definition)=0 THEN
      IF position('UPDATE public.role SET' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected role settings copy contract'; END IF;
      EXECUTE replace(definition,'UPDATE public.role SET',
        'UPDATE public.role SET max_member_groups = source_role.max_member_groups, exclude_auto_joined_groups_from_limit = source_role.exclude_auto_joined_groups_from_limit,');
    END IF;
  END IF;
END $$;
