BEGIN;

ALTER TABLE public.opportunity ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS opportunity_archive_list_idx
  ON public.opportunity(tenant_id, archived_at, updated_at DESC, id);

-- Lifecycle writes and the independent deletion audit commit together. The
-- opportunity row lock also serializes with FK inserts from proposals/sales.
CREATE OR REPLACE FUNCTION public.set_opportunity_archive(
  p_tenant uuid, p_opportunity uuid, p_version integer, p_action text,
  p_actor_kind text, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_row public.opportunity%ROWTYPE;
  new_row public.opportunity%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('archive','restore','delete')
    OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('tenant_user','member')
    OR p_actor_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'Invalid opportunity lifecycle request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO old_row FROM public.opportunity
    WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opportunity not found' USING ERRCODE='P0002';
  END IF;
  IF old_row.version <> p_version THEN
    RAISE EXCEPTION 'Opportunity was updated by another user. Reload and try again.'
      USING ERRCODE='PT409';
  END IF;
  IF p_action='delete' THEN
    IF old_row.archived_at IS NULL THEN
      RAISE EXCEPTION 'Archive the opportunity before permanently deleting it.' USING ERRCODE='PT409';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sales_quote WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity)
      OR EXISTS (SELECT 1 FROM public.sales_commercial_sale WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity) THEN
      RAISE EXCEPTION 'This opportunity has linked proposals or commercial records and cannot be permanently deleted. Keep it archived.'
        USING ERRCODE='PT409';
    END IF;
    -- Do not orphan private blobs or pretend a storage failure is deletion.
    IF EXISTS (SELECT 1 FROM public.opportunity_document WHERE tenant_id=p_tenant AND opportunity_id=p_opportunity) THEN
      RAISE EXCEPTION 'Remove the opportunity documents before permanently deleting it.'
        USING ERRCODE='PT409';
    END IF;
    DELETE FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity;
    INSERT INTO public.sales_audit_event
      (tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data)
      VALUES(p_tenant,p_actor_id::text,p_actor_kind,'opportunity.deleted','opportunity',
        p_opportunity::text,jsonb_build_object('version',old_row.version,'archived_at',old_row.archived_at));
    RETURN jsonb_build_object('deleted',true,'id',p_opportunity);
  END IF;
  IF (p_action='archive' AND old_row.archived_at IS NOT NULL)
    OR (p_action='restore' AND old_row.archived_at IS NULL) THEN
    RAISE EXCEPTION 'Opportunity lifecycle changed. Reload and try again.' USING ERRCODE='PT409';
  END IF;
  UPDATE public.opportunity SET
    archived_at=CASE WHEN p_action='archive' THEN now() ELSE NULL END,
    version=version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_opportunity RETURNING * INTO new_row;
  INSERT INTO public.opportunity_activity
    (tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary)
    VALUES(p_tenant,p_opportunity,old_row.organization_id,p_actor_kind,p_actor_id,
      CASE WHEN p_action='archive' THEN 'opportunity.archived' ELSE 'opportunity.restored' END,
      CASE WHEN p_action='archive' THEN 'Opportunity archived' ELSE 'Opportunity restored' END);
  INSERT INTO public.sales_audit_event
    (tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
    VALUES(p_tenant,p_actor_id::text,p_actor_kind,
      CASE WHEN p_action='archive' THEN 'opportunity.archived' ELSE 'opportunity.restored' END,
      'opportunity',p_opportunity::text,
      jsonb_build_object('version',old_row.version,'archived_at',old_row.archived_at),
      jsonb_build_object('version',new_row.version,'archived_at',new_row.archived_at));
  RETURN to_jsonb(new_row);
END $$;
REVOKE ALL ON FUNCTION public.set_opportunity_archive(uuid,uuid,integer,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_opportunity_archive(uuid,uuid,integer,text,text,uuid)
  TO service_role;

COMMIT;
