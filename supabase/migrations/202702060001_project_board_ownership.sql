BEGIN;
SET LOCAL lock_timeout = '5s';

-- New boards and their creator's ownership are one transaction, including
-- legacy two-request creation and the existing atomic Sales creation RPCs.
-- Existing ownerless boards are deliberately not reassigned.
CREATE OR REPLACE FUNCTION public.project_board_seed_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'An authenticated board creator is required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.project_board_member(board_id,identity_id,role,added_by)
    VALUES(NEW.id,NEW.created_by,'owner',NEW.created_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.project_board_protect_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_exists boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM id FROM public.project_board WHERE id=NEW.board_id FOR UPDATE;
    -- Older creation paths insert the creator a second time. Sharing/upsert
    -- operations must never silently downgrade an existing owner either.
    IF EXISTS(SELECT 1 FROM public.project_board_member
      WHERE board_id=NEW.board_id AND identity_id=NEW.identity_id AND role='owner') THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' THEN
    PERFORM id FROM public.project_board
      WHERE id IN (OLD.board_id,NEW.board_id) ORDER BY id FOR UPDATE;
  ELSE
    PERFORM id FROM public.project_board WHERE id=OLD.board_id FOR UPDATE;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.project_board WHERE id=OLD.board_id) INTO source_exists;
  -- Parent deletion legitimately cascades membership deletion.
  IF source_exists AND OLD.role='owner' THEN
    IF TG_OP='DELETE' THEN
      IF NOT EXISTS(SELECT 1 FROM public.project_board_member
        WHERE board_id=OLD.board_id AND role='owner' AND id<>OLD.id) THEN
        RAISE EXCEPTION 'Assign another owner before removing the last board owner.'
          USING ERRCODE='PT409';
      END IF;
    ELSIF NEW.role IS DISTINCT FROM 'owner' OR NEW.board_id IS DISTINCT FROM OLD.board_id THEN
      IF NOT EXISTS(SELECT 1 FROM public.project_board_member
        WHERE board_id=OLD.board_id AND role='owner' AND id<>OLD.id) THEN
        RAISE EXCEPTION 'Assign another owner before changing the last board owner.'
          USING ERRCODE='PT409';
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS project_board_members_keep_owner ON public.project_board_member;
CREATE TRIGGER project_board_members_keep_owner
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_board_member
  FOR EACH ROW EXECUTE FUNCTION public.project_board_protect_owner();
DROP TRIGGER IF EXISTS project_board_create_owner ON public.project_board;
CREATE TRIGGER project_board_create_owner
  AFTER INSERT ON public.project_board
  FOR EACH ROW EXECUTE FUNCTION public.project_board_seed_owner();

-- Recheck the caller's role after taking the same parent lock as every legacy
-- membership writer. An earlier API permission check is not race-safe authority.
CREATE OR REPLACE FUNCTION public.change_project_board_member(
  p_tenant uuid,p_board uuid,p_actor uuid,p_target uuid,p_action text,p_role text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_role text; target_role text; result public.project_board_member%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_target IS NULL OR p_action IS NULL
    OR p_action NOT IN ('add','role','remove') THEN
    RAISE EXCEPTION 'A valid membership change is required' USING ERRCODE='22023';
  END IF;
  IF p_action IN ('add','role') AND (p_role IS NULL OR p_role NOT IN ('owner','admin','member','viewer')) THEN
    RAISE EXCEPTION 'Invalid board role' USING ERRCODE='22023';
  END IF;
  PERFORM id FROM public.project_board WHERE id=p_board AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Board not found' USING ERRCODE='P0002'; END IF;
  SELECT role INTO actor_role FROM public.project_board_member
    WHERE board_id=p_board AND identity_id=p_actor;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Only board owners or administrators can manage members' USING ERRCODE='42501';
  END IF;
  SELECT role INTO target_role FROM public.project_board_member
    WHERE board_id=p_board AND identity_id=p_target;
  IF p_action='add' THEN
    IF FOUND THEN RAISE EXCEPTION 'User is already a member' USING ERRCODE='23505'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.member
      WHERE tenant_id=p_tenant AND identity_id::text=p_target::text) THEN
      RAISE EXCEPTION 'User not found in tenant' USING ERRCODE='P0002';
    END IF;
  ELSIF NOT FOUND THEN
    RAISE EXCEPTION 'Board member not found' USING ERRCODE='P0002';
  END IF;
  IF actor_role<>'owner' AND (target_role='owner' OR p_role='owner') THEN
    RAISE EXCEPTION 'Only board owners can assign or change an owner'
      USING ERRCODE='42501';
  END IF;
  IF p_action='add' THEN
    INSERT INTO public.project_board_member(board_id,identity_id,role,added_by)
      VALUES(p_board,p_target,p_role,p_actor) RETURNING * INTO result;
  ELSIF p_action='role' THEN
    UPDATE public.project_board_member SET role=p_role
      WHERE board_id=p_board AND identity_id=p_target RETURNING * INTO result;
  ELSE
    DELETE FROM public.project_board_member
      WHERE board_id=p_board AND identity_id=p_target RETURNING * INTO result;
  END IF;
  RETURN to_jsonb(result);
END $$;

REVOKE ALL ON FUNCTION public.project_board_seed_owner() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.project_board_protect_owner() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.change_project_board_member(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_board_seed_owner() TO service_role;
GRANT EXECUTE ON FUNCTION public.project_board_protect_owner() TO service_role;
GRANT EXECUTE ON FUNCTION public.change_project_board_member(uuid,uuid,uuid,uuid,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
