-- Opportunity task choice is fixed when the opportunity is created.
-- Additive and replay-safe: adds one service-only table, replaces one
-- service-only function and adds two. Existing opportunities, links, boards
-- and tasks are not modified.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Permanent record that an opportunity has had a board attached. It has no
-- foreign key to the board, so deleting a linked board (which cascades the
-- link away) cannot turn the opportunity back into an attachable state.
CREATE TABLE IF NOT EXISTS public.sales_opportunity_board_attachment(
  opportunity_id uuid PRIMARY KEY REFERENCES public.opportunity(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  first_board_id uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sales_opportunity_board_attachment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_opportunity_board_attachment FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.sales_opportunity_board_attachment TO service_role;
-- Every currently linked opportunity has already used its attachment.
INSERT INTO public.sales_opportunity_board_attachment(opportunity_id,tenant_id,first_board_id)
  SELECT opportunity_id,tenant_id,board_id FROM public.sales_opportunity_project
  ON CONFLICT (opportunity_id) DO NOTHING;

-- Shared board attach logic (previously inline in change_sales_project).
-- Caller must hold the opportunity row lock (or have just inserted the row).
CREATE OR REPLACE FUNCTION public.sales_project_attach_board(
  p_tenant uuid,p_opportunity uuid,p_name text,p_kind text,p_actor uuid,p_identity uuid,
  p_action text,p_board uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE b public.project_board%ROWTYPE; v_board uuid; v_role text; v_identity text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('create','link') THEN
    RAISE EXCEPTION 'Invalid project action' USING ERRCODE='22023';
  END IF;
  IF p_kind='member' THEN
    SELECT identity_id INTO v_identity FROM public.member WHERE tenant_id=p_tenant AND id=p_actor;
  ELSIF p_kind='tenant_user' THEN
    SELECT identity_id INTO v_identity FROM public.tenant_user WHERE tenant_id=p_tenant AND id=p_actor;
  END IF;
  IF p_identity IS NULL OR v_identity IS DISTINCT FROM p_identity::text THEN
    RAISE EXCEPTION 'Project identity not available' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sales_opportunity_project WHERE opportunity_id=p_opportunity)
    OR EXISTS(SELECT 1 FROM public.sales_opportunity_board_attachment WHERE opportunity_id=p_opportunity) THEN
    RAISE EXCEPTION 'This opportunity already has a project board' USING ERRCODE='23505';
  END IF;
  IF p_action='create' THEN
    INSERT INTO public.project_board(tenant_id,name,color,visibility,created_by)
      VALUES(p_tenant,p_name,'#6366f1','private',p_identity) RETURNING id INTO v_board;
    INSERT INTO public.project_board_member(board_id,identity_id,role,added_by)
      VALUES(v_board,p_identity,'owner',p_identity);
    -- Match existing Projects board creation defaults; no invented tasks.
    INSERT INTO public.project_label(board_id,name,color) VALUES
      (v_board,'High Priority','#ef4444'),(v_board,'Medium Priority','#f59e0b'),
      (v_board,'Low Priority','#22c55e'),(v_board,'Bug','#dc2626'),
      (v_board,'Feature','#3b82f6'),(v_board,'Enhancement','#8b5cf6');
  ELSE
    SELECT * INTO b FROM public.project_board WHERE tenant_id=p_tenant AND id=p_board FOR UPDATE;
    IF NOT FOUND OR b.is_archived IS TRUE THEN
      RAISE EXCEPTION 'Board not available' USING ERRCODE='42501';
    END IF;
    SELECT role INTO v_role FROM public.project_board_member
      WHERE board_id=b.id AND identity_id=p_identity FOR UPDATE;
    IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
      RAISE EXCEPTION 'Only board owners or administrators can link this board' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM public.sales_opportunity_project WHERE board_id=b.id) THEN
      RAISE EXCEPTION 'This board is already linked to another opportunity' USING ERRCODE='23505';
    END IF;
    v_board:=b.id;
  END IF;
  INSERT INTO public.sales_opportunity_project(tenant_id,opportunity_id,board_id)
    VALUES(p_tenant,p_opportunity,v_board);
  INSERT INTO public.sales_opportunity_board_attachment(opportunity_id,tenant_id,first_board_id)
    VALUES(p_opportunity,p_tenant,v_board);
  RETURN v_board;
END $$;

-- Task settings are locked after creation. The only permitted change is the
-- one-time create/link for a legacy opportunity left in project mode that has
-- never had a board attached (deleting a linked board does not reopen it). Mode switches and unlinking are always rejected.
CREATE OR REPLACE FUNCTION public.change_sales_project(
  p_tenant uuid,p_opportunity uuid,p_kind text,p_actor uuid,p_admin boolean,
  p_identity uuid,p_expected_version integer,p_action text,p_mode text DEFAULT NULL,p_board uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o public.opportunity%ROWTYPE; v_board uuid;
BEGIN
  SELECT * INTO o FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
  IF NOT FOUND OR NOT public.sales_project_opportunity_visible(p_tenant,p_opportunity,p_kind,p_actor,p_admin) THEN
    RAISE EXCEPTION 'Opportunity not available' USING ERRCODE='42501';
  END IF;
  IF p_expected_version IS NULL OR o.version<>p_expected_version THEN
    RAISE EXCEPTION 'Opportunity changed; reload before trying again' USING ERRCODE='40001';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('mode','create','link','unlink') THEN
    RAISE EXCEPTION 'Invalid project action' USING ERRCODE='22023';
  END IF;
  IF p_action IN ('mode','unlink') OR o.task_mode IS DISTINCT FROM 'project'
    OR EXISTS(SELECT 1 FROM public.sales_opportunity_project WHERE opportunity_id=p_opportunity)
    OR EXISTS(SELECT 1 FROM public.sales_opportunity_board_attachment WHERE opportunity_id=p_opportunity) THEN
    RAISE EXCEPTION 'Task settings are fixed when the opportunity is created' USING ERRCODE='55000';
  END IF;
  v_board:=public.sales_project_attach_board(p_tenant,p_opportunity,o.name,p_kind,p_actor,p_identity,p_action,p_board);
  UPDATE public.opportunity SET version=version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_opportunity;
  INSERT INTO public.opportunity_activity(tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES(p_tenant,p_opportunity,o.organization_id,p_kind,p_actor,'project.'||p_action,
      CASE p_action WHEN 'create' THEN 'Project board created' ELSE 'Project board linked' END,
      jsonb_build_object('taskMode','project','boardId',v_board));
  RETURN jsonb_build_object('success',true);
END $$;

-- Creates the opportunity and its project board/link in one transaction.
-- Every input is validated and derived by the authenticated server.
CREATE OR REPLACE FUNCTION public.create_sales_opportunity_with_project(
  p_tenant uuid,p_kind text,p_actor uuid,p_identity uuid,p_opportunity jsonb,p_action text,p_board uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o public.opportunity%ROWTYPE; v_board uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('create','link') THEN
    RAISE EXCEPTION 'Invalid task choice' USING ERRCODE='22023';
  END IF;
  IF p_opportunity IS NULL OR jsonb_typeof(p_opportunity)<>'object' THEN
    RAISE EXCEPTION 'Opportunity details are required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.opportunity(tenant_id,organization_id,stage_id,loss_reason_id,primary_contact_id,
    owner_kind,owner_id,name,description,value_minor,currency,expected_close_date,source,priority,
    created_by_kind,created_by_id,task_mode)
  VALUES(p_tenant,(p_opportunity->>'organization_id')::uuid,(p_opportunity->>'stage_id')::uuid,
    nullif(p_opportunity->>'loss_reason_id','')::uuid,nullif(p_opportunity->>'primary_contact_id','')::uuid,
    p_opportunity->>'owner_kind',(p_opportunity->>'owner_id')::uuid,p_opportunity->>'name',
    p_opportunity->>'description',(p_opportunity->>'value_minor')::bigint,
    coalesce(p_opportunity->>'currency','GBP'),nullif(p_opportunity->>'expected_close_date','')::date,
    p_opportunity->>'source',coalesce(p_opportunity->>'priority','medium'),
    p_kind,p_actor,'project')
  RETURNING * INTO o;
  v_board:=public.sales_project_attach_board(p_tenant,o.id,o.name,p_kind,p_actor,p_identity,p_action,p_board);
  INSERT INTO public.opportunity_activity(tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES(p_tenant,o.id,o.organization_id,p_kind,p_actor,'project.'||p_action,
      CASE p_action WHEN 'create' THEN 'Project board created' ELSE 'Project board linked' END,
      jsonb_build_object('taskMode','project','boardId',v_board));
  RETURN to_jsonb(o)||jsonb_build_object('project_board_id',v_board);
END $$;

REVOKE ALL ON FUNCTION public.sales_project_attach_board(uuid,uuid,text,text,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_sales_opportunity_with_project(uuid,text,uuid,uuid,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_project_attach_board(uuid,uuid,text,text,uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_sales_opportunity_with_project(uuid,text,uuid,uuid,jsonb,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
