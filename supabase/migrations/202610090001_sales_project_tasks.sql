-- Additive, replay-safe. Existing Sales tasks and boards are never migrated.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE public.opportunity ADD COLUMN IF NOT EXISTS task_mode text NOT NULL DEFAULT 'standard';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.opportunity'::regclass
    AND conname='opportunity_task_mode_check') THEN
    ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_task_mode_check CHECK(task_mode IN ('standard','project'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS project_board_tenant_id_unique ON public.project_board(tenant_id,id);
CREATE TABLE IF NOT EXISTS public.sales_opportunity_project (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  opportunity_id uuid PRIMARY KEY,
  board_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,opportunity_id) REFERENCES public.opportunity(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,board_id) REFERENCES public.project_board(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sales_opportunity_project_tenant ON public.sales_opportunity_project(tenant_id);
ALTER TABLE public.sales_opportunity_project ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_opportunity_project FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sales_opportunity_project TO service_role;

CREATE OR REPLACE FUNCTION public.sales_project_opportunity_visible(
  p_tenant uuid,p_opportunity uuid,p_kind text,p_actor uuid,p_admin boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.opportunity o WHERE o.tenant_id=p_tenant AND o.id=p_opportunity
    AND (p_admin IS TRUE OR (o.owner_kind=p_kind AND o.owner_id=p_actor) OR EXISTS(
      SELECT 1 FROM public.opportunity_collaborator c WHERE c.tenant_id=p_tenant
        AND c.opportunity_id=o.id AND c.principal_kind=p_kind AND c.principal_id=p_actor)));
$$;

-- Permission inputs are derived by the authenticated server, never request JSON.
-- Locking the opportunity plus unique constraints makes link/create retry-safe.
CREATE OR REPLACE FUNCTION public.change_sales_project(
  p_tenant uuid,p_opportunity uuid,p_kind text,p_actor uuid,p_admin boolean,
  p_identity uuid,p_expected_version integer,p_action text,p_mode text DEFAULT NULL,p_board uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o public.opportunity%ROWTYPE; b public.project_board%ROWTYPE;
  v_board uuid; v_role text; v_identity text;
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
  IF p_action='mode' THEN
    IF p_mode IS NULL OR p_mode NOT IN ('standard','project') THEN
      RAISE EXCEPTION 'Invalid task mode' USING ERRCODE='22023';
    END IF;
  ELSIF p_action='unlink' THEN
    DELETE FROM public.sales_opportunity_project WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity;
  ELSE
    IF p_kind='member' THEN
      SELECT identity_id INTO v_identity FROM public.member WHERE tenant_id=p_tenant AND id=p_actor;
    ELSIF p_kind='tenant_user' THEN
      SELECT identity_id INTO v_identity FROM public.tenant_user WHERE tenant_id=p_tenant AND id=p_actor;
    END IF;
    IF p_identity IS NULL OR v_identity IS DISTINCT FROM p_identity::text THEN
      RAISE EXCEPTION 'Project identity not available' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM public.sales_opportunity_project WHERE opportunity_id=p_opportunity) THEN
      RAISE EXCEPTION 'Unlink the existing board first' USING ERRCODE='23505';
    END IF;
    IF p_action='create' THEN
      INSERT INTO public.project_board(tenant_id,name,color,visibility,created_by)
        VALUES(p_tenant,o.name,'#6366f1','private',p_identity) RETURNING id INTO v_board;
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
      v_board:=b.id;
    END IF;
    INSERT INTO public.sales_opportunity_project(tenant_id,opportunity_id,board_id)
      VALUES(p_tenant,p_opportunity,v_board);
    p_mode:='project';
  END IF;
  UPDATE public.opportunity SET task_mode=COALESCE(p_mode,task_mode),version=version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_opportunity;
  INSERT INTO public.opportunity_activity(tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES(p_tenant,p_opportunity,o.organization_id,p_kind,p_actor,'project.'||p_action,
      CASE p_action WHEN 'mode' THEN 'Task management mode changed' WHEN 'create' THEN 'Project board created'
        WHEN 'link' THEN 'Project board linked' ELSE 'Project board unlinked' END,
      jsonb_build_object('taskMode',p_mode,'boardId',v_board));
  RETURN jsonb_build_object('success',true);
END $$;

CREATE OR REPLACE FUNCTION public.list_sales_project_boards(
  p_tenant uuid,p_identity uuid,p_search text,p_page integer,p_size integer
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH eligible AS MATERIALIZED (
    SELECT b.id,b.name FROM public.project_board b
    JOIN public.project_board_member m ON m.board_id=b.id AND m.identity_id=p_identity
    WHERE b.tenant_id=p_tenant AND b.is_archived IS NOT TRUE AND m.role IN ('owner','admin')
      AND NOT EXISTS(SELECT 1 FROM public.sales_opportunity_project l WHERE l.board_id=b.id)
      AND (coalesce(p_search,'')='' OR position(lower(p_search) in lower(b.name))>0)
  ), page AS (
    SELECT * FROM eligible ORDER BY name,id OFFSET greatest(0,p_page-1)*least(100,greatest(1,p_size))
      LIMIT least(100,greatest(1,p_size))
  )
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(page) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM eligible),'page',p_page,'pageSize',p_size);
$$;

CREATE OR REPLACE FUNCTION public.list_sales_project_tasks(
  p_tenant uuid,p_kind text,p_actor uuid,p_admin boolean,p_identity uuid,p_options jsonb
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
WITH options AS (
  SELECT coalesce(p_options->>'source','project') AS source,
    nullif(p_options->>'opportunityId','')::uuid AS opportunity_id,
    coalesce(p_options->>'scope','my') AS scope,
    coalesce(p_options->>'status','all') AS status,
    coalesce((p_options->>'overdue')::boolean,false) AS overdue,
    nullif(p_options->>'dueFrom','')::date AS due_from,
    nullif(p_options->>'dueTo','')::date AS due_to,
    nullif(p_options->>'listName','') AS list_name,
    coalesce(p_options->>'sort','due') AS sort,
    greatest(1,coalesce((p_options->>'page')::integer,1)) AS page,
    least(100,greatest(1,coalesce((p_options->>'pageSize')::integer,25))) AS size
), eligible AS (
  SELECT o.id,o.name,o.task_mode,org.name AS organization_name
  FROM public.opportunity o LEFT JOIN public.organization org ON org.id=o.organization_id AND org.tenant_id=o.tenant_id
  CROSS JOIN options x
  WHERE o.tenant_id=p_tenant AND o.task_mode=x.source AND (x.opportunity_id IS NULL OR o.id=x.opportunity_id)
    AND (p_admin IS TRUE OR (o.owner_kind=p_kind AND o.owner_id=p_actor) OR EXISTS(
      SELECT 1 FROM public.opportunity_collaborator c WHERE c.tenant_id=p_tenant AND c.opportunity_id=o.id
        AND c.principal_kind=p_kind AND c.principal_id=p_actor))
), tasks AS (
  SELECT c.id,c.title,b.id AS board_id,b.name AS board_name,l.id AS list_id,l.name AS status,
    c.due_date AT TIME ZONE 'UTC' AS due_at,c.priority,c.is_complete,
    e.id AS opportunity_id,e.name AS opportunity_name,e.organization_name,
    m.role<>'viewer' AS can_edit,
    EXISTS(SELECT 1 FROM public.project_card_assignee a WHERE a.card_id=c.id AND a.identity_id=p_identity) AS mine,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.identity_id,
      'name',coalesce(nullif(trim(concat_ws(' ',i.first_name,i.last_name)),''),i.email,'Unknown assignee')))
      FROM public.project_card_assignee a LEFT JOIN public.tenant_identity i ON i.id=a.identity_id::text
      WHERE a.card_id=c.id),'[]'::jsonb) AS assignees
  FROM eligible e
  JOIN public.sales_opportunity_project link ON link.opportunity_id=e.id AND link.tenant_id=p_tenant
  JOIN public.project_board b ON b.id=link.board_id AND b.tenant_id=p_tenant AND b.is_archived IS NOT TRUE
  JOIN public.project_board_member m ON m.board_id=b.id AND m.identity_id=p_identity
  JOIN public.project_card c ON c.board_id=b.id AND c.is_archived IS NOT TRUE
  JOIN public.project_list l ON l.id=c.list_id AND l.board_id=b.id AND l.is_archived IS NOT TRUE
  WHERE e.task_mode='project'
  UNION ALL
  SELECT t.id,t.title,NULL::uuid,NULL::text,NULL::uuid,
    CASE WHEN t.completed_at IS NULL THEN 'Outstanding' ELSE 'Completed' END,
    t.due_at,'none',t.completed_at IS NOT NULL,e.id,e.name,e.organization_name,true,
    t.assignee_kind=p_kind AND t.assignee_id=p_actor,
    CASE WHEN t.assignee_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id',t.assignee_id,
      'name',coalesce(nullif(trim(concat_ws(' ',mem.first_name,mem.last_name)),''),
        nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),mem.email,u.email,'Unknown assignee'))) END
  FROM eligible e JOIN public.opportunity_task t ON t.opportunity_id=e.id AND t.tenant_id=p_tenant
  LEFT JOIN public.member mem ON t.assignee_kind='member' AND mem.id=t.assignee_id AND mem.tenant_id=p_tenant
  LEFT JOIN public.tenant_user u ON t.assignee_kind='tenant_user' AND u.id=t.assignee_id AND u.tenant_id=p_tenant
  WHERE e.task_mode='standard'
), filtered AS MATERIALIZED (
  SELECT t.*, (t.is_complete IS NOT TRUE AND t.due_at<now()) AS overdue FROM tasks t CROSS JOIN options x
  WHERE (x.scope='all' OR t.mine IS TRUE)
    AND (x.status='all' OR (x.status='completed' AND t.is_complete IS TRUE)
      OR (x.status='outstanding' AND t.is_complete IS NOT TRUE))
    AND (x.list_name IS NULL OR t.status=x.list_name)
    AND (NOT x.overdue OR (t.is_complete IS NOT TRUE AND t.due_at<now()))
    AND (x.due_from IS NULL OR t.due_at>=x.due_from::timestamptz)
    AND (x.due_to IS NULL OR t.due_at<(x.due_to+1)::timestamptz)
), paged AS (
  SELECT t.*,row_number() OVER (ORDER BY
    CASE WHEN x.sort='opportunity' THEN t.opportunity_name END,
    CASE WHEN x.sort='priority' THEN CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END END,
    t.due_at ASC NULLS LAST,t.id) AS ordinal
  FROM filtered t CROSS JOIN options x
  ORDER BY ordinal OFFSET (SELECT (page-1)*size FROM options) LIMIT (SELECT size FROM options)
)
SELECT jsonb_build_object(
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'title',title,'boardId',board_id,'boardName',board_name,
    'listId',list_id,'status',status,'dueAt',due_at,'priority',priority,'isComplete',is_complete,'overdue',overdue,
    'opportunityId',opportunity_id,'opportunityName',opportunity_name,'organizationName',organization_name,
    'canEdit',can_edit,'assignees',assignees) ORDER BY ordinal) FROM paged),'[]'::jsonb),
  'total',(SELECT count(*) FROM filtered),'page',x.page,'pageSize',x.size,
  'summary',(SELECT jsonb_build_object('total',count(*),'outstanding',count(*) FILTER(WHERE is_complete IS NOT TRUE),
    'completed',count(*) FILTER(WHERE is_complete IS TRUE),'overdue',count(*) FILTER(WHERE overdue IS TRUE)) FROM filtered))
FROM options x;
$$;

REVOKE ALL ON FUNCTION public.sales_project_opportunity_visible(uuid,uuid,text,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_sales_project_boards(uuid,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_sales_project_tasks(uuid,text,uuid,boolean,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_project_opportunity_visible(uuid,uuid,text,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_sales_project_boards(uuid,uuid,text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_sales_project_tasks(uuid,text,uuid,boolean,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
