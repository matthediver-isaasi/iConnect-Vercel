-- Opt-in, forward-only product fulfilment. No historical acceptance backfill.
ALTER TABLE public.sales_catalogue_product
 ADD COLUMN IF NOT EXISTS create_task_on_acceptance boolean NOT NULL DEFAULT false;

CREATE TABLE public.sales_task_automation_config (
 tenant_id uuid NOT NULL,
 opportunity_id uuid PRIMARY KEY,
 board_id uuid NOT NULL,
 list_id uuid NOT NULL,
 authorized_identity uuid NOT NULL,
 authorized_kind text NOT NULL CHECK (authorized_kind IN ('member','tenant_user')),
 authorized_actor uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,opportunity_id) REFERENCES public.opportunity(tenant_id,id) ON DELETE CASCADE
);
-- Deliberately no cascading references to board/list/task: keep recoverable evidence
-- if a destination is deleted. A completed request never recreates a deleted task.
CREATE TABLE public.sales_acceptance_task_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 opportunity_id uuid NOT NULL,
 quote_version_id uuid NOT NULL,
 source_id uuid NOT NULL,
 title varchar(240) NOT NULL,
 quantity numeric(24,6) NOT NULL CHECK (quantity>0),
 task_mode text NOT NULL CHECK (task_mode IN ('standard','project')),
 board_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
 task_id uuid,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE (quote_version_id,source_id),
 FOREIGN KEY (tenant_id,opportunity_id) REFERENCES public.opportunity(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id),
 CHECK ((status='completed')=(task_id IS NOT NULL))
);
CREATE INDEX sales_acceptance_task_pending ON public.sales_acceptance_task_request
 (tenant_id,opportunity_id,created_at,id) WHERE status='pending';

ALTER TABLE public.sales_task_automation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_acceptance_task_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_task_automation_config,public.sales_acceptance_task_request FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sales_task_automation_config,public.sales_acceptance_task_request TO service_role;
CREATE POLICY sales_task_config_service_read ON public.sales_task_automation_config FOR SELECT TO service_role USING(true);
CREATE POLICY sales_task_request_service_read ON public.sales_acceptance_task_request FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.configure_sales_task_automation(
 p_tenant uuid,p_opportunity uuid,p_list uuid,p_identity uuid,p_kind text,p_actor uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b uuid; actual_identity text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Opportunity unavailable' USING ERRCODE='23514'; END IF;
 IF p_list IS NULL THEN
   DELETE FROM public.sales_task_automation_config WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity;
   RETURN;
 END IF;
 IF p_kind='member' THEN
   SELECT identity_id::text INTO actual_identity FROM public.member WHERE tenant_id=p_tenant AND id=p_actor;
 ELSIF p_kind='tenant_user' THEN
   SELECT identity_id::text INTO actual_identity FROM public.tenant_user WHERE tenant_id=p_tenant AND id=p_actor;
 END IF;
 IF actual_identity IS NULL OR actual_identity IS DISTINCT FROM p_identity::text THEN
   RAISE EXCEPTION 'Board authorization identity unavailable' USING ERRCODE='42501';
 END IF;
 SELECT link.board_id INTO b FROM public.sales_opportunity_project link
 JOIN public.project_board board ON board.id=link.board_id AND board.tenant_id=p_tenant
 WHERE link.tenant_id=p_tenant AND link.opportunity_id=p_opportunity AND board.is_archived IS NOT TRUE
 FOR SHARE OF link,board;
 IF b IS NULL THEN RAISE EXCEPTION 'Link an available project board first' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.project_board_member WHERE board_id=b AND identity_id=p_identity
 AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Board owner or administrator required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.project_list WHERE id=p_list AND board_id=b AND is_archived IS NOT TRUE FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose an available list on the linked board' USING ERRCODE='23514'; END IF;
 INSERT INTO public.sales_task_automation_config(tenant_id,opportunity_id,board_id,list_id,
 authorized_identity,authorized_kind,authorized_actor)
 VALUES(p_tenant,p_opportunity,b,p_list,p_identity,p_kind,p_actor)
 ON CONFLICT(opportunity_id) DO UPDATE SET board_id=excluded.board_id,list_id=excluded.list_id,
 authorized_identity=excluded.authorized_identity,authorized_kind=excluded.authorized_kind,
 authorized_actor=excluded.authorized_actor,updated_at=now();
END $$;

CREATE FUNCTION public.process_sales_acceptance_tasks(p_tenant uuid,p_opportunity uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.sales_acceptance_task_request%ROWTYPE;
DECLARE c public.sales_task_automation_config%ROWTYPE;
DECLARE o public.opportunity%ROWTYPE; task uuid; done integer:=0; remaining integer;
DECLARE actual_identity text; explanation text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 -- All config/acceptance/retry operations lock the opportunity before requests.
 SELECT * INTO o FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Opportunity unavailable' USING ERRCODE='23514'; END IF;
 FOR r IN SELECT * FROM public.sales_acceptance_task_request
 WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND status='pending'
 ORDER BY created_at,id LIMIT 100 FOR UPDATE LOOP
   BEGIN
     task:=NULL; explanation:=NULL;
     IF r.task_mode='standard' THEN
       INSERT INTO public.opportunity_task(tenant_id,opportunity_id,title,description,created_by_kind,created_by_id)
       VALUES(p_tenant,p_opportunity,r.title,
         'Automatically created from an accepted quote. Quantity: '||r.quantity::text,
         o.created_by_kind,o.created_by_id) RETURNING id INTO task;
     ELSE
       SELECT * INTO c FROM public.sales_task_automation_config
        WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity FOR SHARE;
       IF NOT FOUND THEN
         explanation:='Choose and save a destination list on the opportunity Tasks tab.';
       ELSIF r.board_id IS NOT NULL AND r.board_id<>c.board_id THEN
         explanation:='The accepted quote belongs to a different board. Restore its board link and destination to retry.';
       ELSE
         actual_identity:=NULL;
         IF c.authorized_kind='member' THEN
           SELECT identity_id::text INTO actual_identity FROM public.member
            WHERE tenant_id=p_tenant AND id=c.authorized_actor;
         ELSE
           SELECT identity_id::text INTO actual_identity FROM public.tenant_user
            WHERE tenant_id=p_tenant AND id=c.authorized_actor;
         END IF;
         IF actual_identity IS DISTINCT FROM c.authorized_identity::text THEN
           explanation:='The board authorization is no longer valid. A board administrator must save the destination again.';
         ELSE
           PERFORM 1 FROM public.project_board b
            JOIN public.sales_opportunity_project link ON link.board_id=b.id AND link.tenant_id=p_tenant
            JOIN public.project_list l ON l.board_id=b.id AND l.id=c.list_id
            JOIN public.project_board_member m ON m.board_id=b.id AND m.identity_id=c.authorized_identity
            WHERE b.id=c.board_id AND b.tenant_id=p_tenant AND b.is_archived IS NOT TRUE
             AND l.is_archived IS NOT TRUE AND m.role IN ('owner','admin') AND link.opportunity_id=p_opportunity
            FOR SHARE OF b,link,m FOR UPDATE OF l;
           IF NOT FOUND THEN
             explanation:='The board, list or authorizing board administrator is unavailable. Save a valid destination and retry.';
           ELSE
             -- Only operational product name/quantity reach the board, never quote
             -- prices, billing addresses, bearer links or customer details.
             INSERT INTO public.project_card(board_id,list_id,title,description,position,created_by)
             SELECT c.board_id,c.list_id,r.title,
               'Automatically created from an accepted quote. Quantity: '||r.quantity::text,
               COALESCE(max(position),-1)+1,c.authorized_identity
             FROM public.project_card WHERE list_id=c.list_id RETURNING id INTO task;
           END IF;
         END IF;
       END IF;
     END IF;
     IF task IS NOT NULL THEN
       UPDATE public.sales_acceptance_task_request SET status='completed',task_id=task,
        board_id=CASE WHEN r.task_mode='project' THEN c.board_id ELSE NULL END,
        completed_at=now(),last_error=NULL WHERE id=r.id;
       done:=done+1;
     ELSE
       UPDATE public.sales_acceptance_task_request SET last_error=explanation WHERE id=r.id;
     END IF;
   EXCEPTION WHEN OTHERS THEN
     -- The subtransaction rolls back any partial card/task insert. Never persist
     -- SQLERRM, which may contain customer data. Acceptance remains successful.
     UPDATE public.sales_acceptance_task_request
      SET last_error='Task creation could not complete ('||SQLSTATE||'). Retry or ask an administrator to investigate.'
      WHERE id=r.id;
   END;
 END LOOP;
 SELECT count(*) INTO remaining FROM public.sales_acceptance_task_request
 WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity AND status='pending';
 RETURN jsonb_build_object('completed',done,'pending',remaining);
END $$;

CREATE FUNCTION public.queue_sales_acceptance_tasks()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; o public.opportunity%ROWTYPE; b uuid; eligible boolean;
BEGIN
 -- Issued snapshots are immutable. Older snapshots without the flag remain off.
 IF NEW.status NOT IN ('issued','accepted') OR NEW.status=OLD.status THEN RETURN NEW; END IF;
 SELECT EXISTS(
   SELECT 1 FROM public.sales_quote_line l WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id
    AND l.catalogue_kind='product' AND l.catalogue_snapshot->'create_task_on_acceptance'='true'::jsonb
   UNION ALL
   SELECT 1 FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
    ON c.quote_line_id=l.id AND c.tenant_id=l.tenant_id
   WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id
    AND c.product_snapshot->'create_task_on_acceptance'='true'::jsonb
 ) INTO eligible;
 IF NOT eligible THEN RETURN NEW; END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_id;
 IF q.opportunity_id IS NULL THEN
   RAISE EXCEPTION 'Link an opportunity before issuing a quote with automatic product tasks' USING ERRCODE='23514';
 END IF;
 IF NEW.status<>'accepted' THEN RETURN NEW; END IF;
 SELECT * INTO o FROM public.opportunity WHERE tenant_id=NEW.tenant_id AND id=q.opportunity_id FOR UPDATE;
 SELECT board_id INTO b FROM public.sales_opportunity_project
  WHERE tenant_id=NEW.tenant_id AND opportunity_id=o.id;
 INSERT INTO public.sales_acceptance_task_request(tenant_id,opportunity_id,quote_version_id,source_id,title,quantity,task_mode,board_id)
 SELECT NEW.tenant_id,o.id,NEW.id,x.source_id,left(COALESCE(NULLIF(x.name,''),'Product fulfilment'),240),
  x.quantity,o.task_mode,CASE WHEN o.task_mode='project' THEN b ELSE NULL END
 FROM (
   SELECT l.id source_id,l.catalogue_snapshot->>'name' name,l.quantity
   FROM public.sales_quote_line l WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id
    AND l.catalogue_kind='product' AND l.catalogue_snapshot->'create_task_on_acceptance'='true'::jsonb
   UNION ALL
   SELECT c.id,c.product_snapshot->>'name',l.quantity*c.quantity
   FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
    ON c.quote_line_id=l.id AND c.tenant_id=l.tenant_id
   WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id
    AND c.product_snapshot->'create_task_on_acceptance'='true'::jsonb
 ) x ON CONFLICT(quote_version_id,source_id) DO NOTHING;
 PERFORM public.process_sales_acceptance_tasks(NEW.tenant_id,o.id);
 RETURN NEW;
END $$;
CREATE TRIGGER sales_quote_acceptance_tasks AFTER UPDATE OF status ON public.sales_quote_version
 FOR EACH ROW EXECUTE FUNCTION public.queue_sales_acceptance_tasks();

REVOKE ALL ON FUNCTION public.configure_sales_task_automation(uuid,uuid,uuid,uuid,text,uuid),
 public.process_sales_acceptance_tasks(uuid,uuid),public.queue_sales_acceptance_tasks() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_sales_task_automation(uuid,uuid,uuid,uuid,text,uuid),
 public.process_sales_acceptance_tasks(uuid,uuid) TO service_role;
