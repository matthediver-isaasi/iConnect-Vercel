-- Additive only: no task/source changes or historical actor reconstruction.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.opportunity_task
  ADD COLUMN IF NOT EXISTS completed_by_kind text,
  ADD COLUMN IF NOT EXISTS completed_by_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.opportunity_task'::regclass
      AND conname='opportunity_task_completion_actor_check') THEN
    ALTER TABLE public.opportunity_task ADD CONSTRAINT opportunity_task_completion_actor_check CHECK (
      (completed_by_kind IS NULL AND completed_by_id IS NULL)
      OR (completed_by_kind IS NOT NULL AND completed_by_kind IN ('member','tenant_user') AND completed_by_id IS NOT NULL)
    );
  END IF;
END $$;

-- Only the authenticated API can call this function. Its opportunity edit
-- authority is checked by loadOpportunityAccess, including admin/collaborator.
-- Lock the task so repeated complete requests cannot replace original evidence.
CREATE OR REPLACE FUNCTION public.set_sales_task_completion(
  p_tenant uuid, p_opportunity uuid, p_task uuid, p_kind text, p_actor uuid,
  p_complete boolean, p_patch jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.opportunity_task%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_complete IS NULL THEN
    RAISE EXCEPTION 'Authenticated completion actor required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM public.opportunity_task
    WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND id=p_task FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE='P0002'; END IF;
  UPDATE public.opportunity_task SET
    title=CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE title END,
    description=CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    due_at=CASE WHEN p_patch ? 'due_at' THEN (p_patch->>'due_at')::timestamptz ELSE due_at END,
    completed_at=CASE WHEN NOT p_complete THEN NULL WHEN t.completed_at IS NULL THEN now() ELSE t.completed_at END,
    completed_by_kind=CASE WHEN NOT p_complete THEN NULL WHEN t.completed_at IS NULL THEN p_kind ELSE t.completed_by_kind END,
    completed_by_id=CASE WHEN NOT p_complete THEN NULL WHEN t.completed_at IS NULL THEN p_actor ELSE t.completed_by_id END,
    updated_at=now()
  WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND id=p_task RETURNING * INTO t;
  RETURN to_jsonb(t);
END $$;

CREATE INDEX IF NOT EXISTS opportunity_task_progress_idx
  ON public.opportunity_task(tenant_id,opportunity_id,completed_at DESC,id);

-- All permission arguments come from the authenticated server, never query JSON.
-- Invoker security and service-only grants are intentional (no RLS bypass RPC).
CREATE OR REPLACE FUNCTION public.sales_opportunity_task_progress(
  p_tenant uuid,p_kind text,p_actor uuid,p_admin boolean,p_identity uuid,
  p_projects boolean,p_page integer DEFAULT 1,p_size integer DEFAULT 10
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
WITH cohort AS MATERIALIZED (
  SELECT o.id,o.name,o.task_mode
  FROM public.opportunity o
  JOIN public.opportunity_stage s ON s.id=o.stage_id AND s.tenant_id=o.tenant_id
  WHERE o.tenant_id=p_tenant AND o.archived_at IS NULL
    AND s.is_won IS NOT TRUE AND s.is_lost IS NOT TRUE
    AND (p_admin IS TRUE OR (o.owner_kind=p_kind AND o.owner_id=p_actor) OR EXISTS (
      SELECT 1 FROM public.opportunity_collaborator c
      WHERE c.tenant_id=p_tenant AND c.opportunity_id=o.id
        AND c.principal_kind=p_kind AND c.principal_id=p_actor))
), sources AS MATERIALIZED (
  SELECT o.*,b.id AS board_id,
    CASE WHEN o.task_mode='standard' THEN 'available'
      WHEN p_projects IS NOT TRUE OR p_identity IS NULL THEN 'restricted'
      WHEN b.id IS NULL OR b.is_archived IS TRUE THEN 'unavailable'
      WHEN NOT EXISTS (SELECT 1 FROM public.project_board_member m
        WHERE m.board_id=b.id AND m.identity_id=p_identity) THEN 'restricted'
      ELSE 'available' END AS status
  FROM cohort o
  LEFT JOIN public.sales_opportunity_project link ON o.task_mode='project'
    AND link.tenant_id=p_tenant AND link.opportunity_id=o.id
  LEFT JOIN public.project_board b ON b.id=link.board_id AND b.tenant_id=p_tenant
), tasks AS (
  SELECT o.id AS opportunity_id,t.id,t.completed_at IS NOT NULL AS complete,
    t.due_at,t.completed_at,t.completed_by_kind AS actor_kind,t.completed_by_id AS actor_id
  FROM sources o JOIN public.opportunity_task t
    ON t.tenant_id=p_tenant AND t.opportunity_id=o.id
  WHERE o.task_mode='standard' AND o.status='available'
  UNION ALL
  SELECT o.id,c.id,c.is_complete IS TRUE,c.due_date AT TIME ZONE 'UTC',
    CASE WHEN c.is_complete IS TRUE THEN c.completed_at AT TIME ZONE 'UTC' END,
    'identity',c.completed_by
  FROM sources o
  JOIN public.project_card c ON c.board_id=o.board_id AND c.is_archived IS NOT TRUE
  JOIN public.project_list l ON l.id=c.list_id AND l.board_id=o.board_id AND l.is_archived IS NOT TRUE
  WHERE o.task_mode='project' AND o.status='available'
), counts AS (
  SELECT opportunity_id,count(*) AS total,count(*) FILTER(WHERE NOT complete) AS open,
    count(*) FILTER(WHERE complete) AS completed,
    count(*) FILTER(WHERE NOT complete AND due_at<now()) AS overdue
  FROM tasks GROUP BY opportunity_id
), latest AS (
  SELECT DISTINCT ON (opportunity_id) opportunity_id,completed_at,actor_kind,actor_id
  FROM tasks WHERE complete AND completed_at IS NOT NULL
  ORDER BY opportunity_id,completed_at DESC,id ASC
), progress AS MATERIALIZED (
  SELECT o.*,coalesce(c.total,0) AS total,coalesce(c.open,0) AS open,
    coalesce(c.completed,0) AS completed,coalesce(c.overdue,0) AS overdue
  FROM sources o LEFT JOIN counts c ON c.opportunity_id=o.id
), paged AS (
  SELECT * FROM progress ORDER BY lower(name),id
  OFFSET (greatest(1,p_page)::bigint-1)*least(100,greatest(1,p_size))
  LIMIT least(100,greatest(1,p_size))
), rows AS (
  SELECT p.id,p.name,p.task_mode AS "taskMode",p.status,
    CASE WHEN p.status='available' THEN p.total END AS "totalTasks",
    CASE WHEN p.status='available' THEN p.open END AS "openTasks",
    CASE WHEN p.status='available' THEN p.completed END AS "completedTasks",
    CASE WHEN p.status='available' THEN p.overdue END AS "overdueTasks",
    CASE WHEN p.status='available' AND p.total>0
      THEN round(100.0*p.completed/p.total,1) END AS "completionPercent",
    CASE WHEN latest.completed_at IS NOT NULL THEN jsonb_build_object(
      'at',latest.completed_at,'actorName',coalesce(
        nullif(trim(concat_ws(' ',mem.first_name,mem.last_name)),''),
        nullif(trim(concat_ws(' ',tu.first_name,tu.last_name)),''),
        nullif(trim(concat_ws(' ',ident.first_name,ident.last_name)),'')
      )) END AS "latestCompletion"
  FROM paged p LEFT JOIN latest ON latest.opportunity_id=p.id
  LEFT JOIN public.member mem ON latest.actor_kind='member' AND mem.id=latest.actor_id AND mem.tenant_id=p_tenant
  LEFT JOIN public.tenant_user tu ON latest.actor_kind='tenant_user' AND tu.id=latest.actor_id AND tu.tenant_id=p_tenant
  LEFT JOIN public.tenant_identity ident ON ident.id=latest.actor_id::text
    AND (latest.actor_kind='identity' OR (latest.actor_kind='tenant_user' AND tu.id IS NULL
      AND EXISTS (SELECT 1 FROM public.tenant_membership tm
        WHERE tm.identity_id=ident.id AND tm.tenant_id=p_tenant)))
), summary AS (
  SELECT count(*) AS opportunities,
    count(*) FILTER(WHERE status='available') AS available,
    count(*) FILTER(WHERE status='restricted') AS restricted,
    count(*) FILTER(WHERE status='unavailable') AS unavailable,
    coalesce(sum(total),0) AS total,coalesce(sum(open),0) AS open,
    coalesce(sum(completed),0) AS completed,coalesce(sum(overdue),0) AS overdue
  FROM progress
)
SELECT jsonb_build_object(
  'items',coalesce((SELECT jsonb_agg(rows ORDER BY lower(name),id) FROM rows),'[]'::jsonb),
  'total',s.opportunities,'page',greatest(1,p_page),'pageSize',least(100,greatest(1,p_size)),
  'pages',greatest(1,ceil(s.opportunities::numeric/least(100,greatest(1,p_size)))),
  'summary',jsonb_build_object('opportunityCount',s.opportunities,'availableOpportunities',s.available,
    'restrictedOpportunities',s.restricted,'unavailableOpportunities',s.unavailable,
    'totalTasks',s.total,'openTasks',s.open,'overdueTasks',s.overdue,'completedTasks',s.completed,
    'completionPercent',CASE WHEN s.total>0 THEN round(100.0*s.completed/s.total,1) END,
    'partial',s.restricted+s.unavailable>0)
) FROM summary s;
$$;

REVOKE ALL ON FUNCTION public.set_sales_task_completion(uuid,uuid,uuid,text,uuid,boolean,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sales_opportunity_task_progress(uuid,text,uuid,boolean,uuid,boolean,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_task_completion(uuid,uuid,uuid,text,uuid,boolean,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_opportunity_task_progress(uuid,text,uuid,boolean,uuid,boolean,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
