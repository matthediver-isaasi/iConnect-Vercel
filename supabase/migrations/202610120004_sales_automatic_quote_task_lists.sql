BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.sales_settings ADD COLUMN quote_task_list_name text NOT NULL DEFAULT 'Quote tasks'
 CHECK (length(btrim(quote_task_list_name)) BETWEEN 1 AND 100);

CREATE OR REPLACE FUNCTION public.patch_sales_settings(
 p_tenant_id uuid,p_expected_version integer,p_patch jsonb,p_actor_id text,p_actor_type text
) RETURNS SETOF public.sales_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_row public.sales_settings%ROWTYPE; new_row public.sales_settings%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_actor_id='' OR p_actor_type NOT IN ('tenant_user','member','system')
  OR p_actor_type IS NULL OR p_expected_version IS NULL OR p_expected_version<1
  OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' THEN
  RAISE EXCEPTION 'Valid settings patch and server actor required' USING ERRCODE='22023';
 END IF;
 IF p_patch ? 'quoteTaskListName' AND
  (jsonb_typeof(p_patch->'quoteTaskListName')<>'string' OR length(btrim(p_patch->>'quoteTaskListName')) NOT BETWEEN 1 AND 100) THEN
  RAISE EXCEPTION 'Quote task list name must be 1-100 characters' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.sales_settings(tenant_id) VALUES(p_tenant_id) ON CONFLICT(tenant_id) DO NOTHING;
 SELECT * INTO old_row FROM public.sales_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
 IF old_row.version<>p_expected_version THEN RAISE EXCEPTION 'Sales settings version conflict' USING ERRCODE='40001'; END IF;
 UPDATE public.sales_settings SET
  quote_prefix=CASE WHEN p_patch ? 'quotePrefix' THEN p_patch->>'quotePrefix' ELSE quote_prefix END,
  quote_number_padding=CASE WHEN p_patch ? 'quoteNumberPadding' THEN (p_patch->>'quoteNumberPadding')::integer ELSE quote_number_padding END,
  default_currency=CASE WHEN p_patch ? 'defaultCurrency' THEN p_patch->>'defaultCurrency' ELSE default_currency END,
  default_tax_rate_bps=CASE WHEN p_patch ? 'defaultTaxRateBps' THEN (p_patch->>'defaultTaxRateBps')::integer ELSE default_tax_rate_bps END,
  default_terms=CASE WHEN p_patch ? 'defaultTerms' THEN p_patch->>'defaultTerms' ELSE default_terms END,
  module_enabled=CASE WHEN p_patch ? 'moduleEnabled' THEN (p_patch->>'moduleEnabled')::boolean ELSE module_enabled END,
  quote_task_list_name=CASE WHEN p_patch ? 'quoteTaskListName' THEN btrim(p_patch->>'quoteTaskListName') ELSE quote_task_list_name END,
  version=version+1,updated_by=p_actor_id,updated_at=now()
 WHERE tenant_id=p_tenant_id RETURNING * INTO new_row;
 INSERT INTO public.sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
 VALUES(p_tenant_id,p_actor_id,p_actor_type,'settings.updated','sales_settings',p_tenant_id::text,to_jsonb(old_row),to_jsonb(new_row));
 RETURN NEXT new_row;
END $$;

-- Board links are established by the authenticated, dual-authorized Sales/Projects
-- flow. Automation runs as the server, including when the customer accepts.
-- Lock the board before resolving/creating the list; never use a customer identity.
CREATE FUNCTION public.sales_quote_task_destination(p_tenant uuid,p_opportunity uuid,p_expected_board uuid)
 RETURNS TABLE(board_id uuid,list_id uuid,identity_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_board uuid; target_list uuid; creator uuid; list_name text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT b.id INTO target_board FROM public.sales_opportunity_project link
 JOIN public.project_board b ON b.id=link.board_id AND b.tenant_id=link.tenant_id
 WHERE link.tenant_id=p_tenant AND link.opportunity_id=p_opportunity AND b.is_archived IS NOT TRUE
 FOR UPDATE OF b FOR SHARE OF link;
 IF target_board IS NULL THEN RAISE EXCEPTION 'Linked board unavailable' USING ERRCODE='P0002'; END IF;
 IF p_expected_board IS NOT NULL AND target_board<>p_expected_board THEN
  RAISE EXCEPTION 'Accepted board changed' USING ERRCODE='23514';
 END IF;
 -- Current tenant-scoped board managers remain the accountable card identity.
 -- Do not grant board membership or infer identity from a quote recipient.
 SELECT m.identity_id INTO creator FROM public.project_board_member m
 WHERE m.board_id=target_board AND m.role IN ('owner','admin') AND (
  EXISTS(SELECT 1 FROM public.member u WHERE u.tenant_id=p_tenant AND u.identity_id::text=m.identity_id::text)
  OR EXISTS(SELECT 1 FROM public.tenant_user u WHERE u.tenant_id=p_tenant AND u.identity_id::text=m.identity_id::text))
 ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.identity_id LIMIT 1 FOR SHARE OF m;
 IF creator IS NULL THEN RAISE EXCEPTION 'Board manager unavailable' USING ERRCODE='42501'; END IF;
 SELECT s.quote_task_list_name INTO list_name FROM public.sales_settings s WHERE s.tenant_id=p_tenant;
 list_name:=COALESCE(list_name,'Quote tasks');
 SELECT l.id INTO target_list FROM public.project_list l WHERE l.board_id=target_board
  AND l.is_archived IS NOT TRUE AND lower(btrim(l.name))=lower(list_name)
 ORDER BY l.position,l.id LIMIT 1 FOR UPDATE;
 IF target_list IS NULL THEN
  INSERT INTO public.project_list(board_id,name,position)
  SELECT target_board,list_name,COALESCE(max(l.position),-1)+1 FROM public.project_list l WHERE l.board_id=target_board
  RETURNING id INTO target_list;
 END IF;
 RETURN QUERY SELECT target_board,target_list,creator;
END $$;

CREATE OR REPLACE FUNCTION public.process_sales_acceptance_tasks(p_tenant uuid,p_opportunity uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.sales_acceptance_task_request%ROWTYPE; o public.opportunity%ROWTYPE;
 target_board uuid; target_list uuid; target_identity uuid; task uuid; done integer:=0; remaining integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Opportunity unavailable' USING ERRCODE='23514'; END IF;
 FOR r IN SELECT * FROM public.sales_acceptance_task_request
  WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND status='pending'
  ORDER BY created_at,id LIMIT 100 FOR UPDATE LOOP
  BEGIN
   task:=NULL;
   IF r.task_mode='standard' THEN
    INSERT INTO public.opportunity_task(tenant_id,opportunity_id,title,description,created_by_kind,created_by_id)
    VALUES(p_tenant,p_opportunity,r.title,'Automatically created from an accepted quote. Quantity: '||r.quantity::text,
     o.created_by_kind,o.created_by_id) RETURNING id INTO task;
   ELSE
    SELECT d.board_id,d.list_id,d.identity_id INTO STRICT target_board,target_list,target_identity
     FROM public.sales_quote_task_destination(p_tenant,p_opportunity,r.board_id) d;
    INSERT INTO public.project_card(board_id,list_id,title,description,position,created_by)
    SELECT target_board,target_list,r.title,
     'Automatically created from an accepted quote. Quantity: '||r.quantity::text,
     COALESCE(max(c.position),-1)+1,target_identity
    FROM public.project_card c WHERE c.list_id=target_list RETURNING id INTO task;
   END IF;
   UPDATE public.sales_acceptance_task_request SET status='completed',task_id=task,
    board_id=CASE WHEN r.task_mode='project' THEN target_board ELSE NULL END,
    completed_at=now(),last_error=NULL WHERE id=r.id;
   done:=done+1;
  EXCEPTION
   WHEN SQLSTATE 'P0002' THEN
    UPDATE public.sales_acceptance_task_request SET last_error='Link an available project board, then retry pending tasks.' WHERE id=r.id;
   WHEN SQLSTATE '23514' THEN
    UPDATE public.sales_acceptance_task_request SET last_error='Check the original linked board and its task requirements before retrying.' WHERE id=r.id;
   WHEN SQLSTATE '42501' THEN
    UPDATE public.sales_acceptance_task_request SET last_error='A current tenant board owner or administrator is required. Restore board access, then retry.' WHERE id=r.id;
   WHEN OTHERS THEN
    UPDATE public.sales_acceptance_task_request SET last_error='Task creation could not complete ('||SQLSTATE||'). Retry or ask an administrator to investigate.' WHERE id=r.id;
  END;
 END LOOP;
 SELECT count(*) INTO remaining FROM public.sales_acceptance_task_request
  WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND status='pending';
 RETURN jsonb_build_object('completed',done,'pending',remaining);
END $$;
REVOKE ALL ON FUNCTION public.sales_quote_task_destination(uuid,uuid,uuid),
 public.process_sales_acceptance_tasks(uuid,uuid),public.patch_sales_settings(uuid,integer,jsonb,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_quote_task_destination(uuid,uuid,uuid),
 public.process_sales_acceptance_tasks(uuid,uuid),public.patch_sales_settings(uuid,integer,jsonb,text,text)
 TO service_role;
COMMIT;
