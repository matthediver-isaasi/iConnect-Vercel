BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.sales_quote ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS sales_quote_archive_list_idx
  ON public.sales_quote(tenant_id, archived_at, updated_at DESC, id);

-- Archive is visibility only. It must not change acceptance, billing, delivery
-- links or inventory. Deletion is a separate, strictly draft-only operation.
CREATE OR REPLACE FUNCTION public.guard_sales_quote_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.archived_at IS NULL THEN
    RAISE EXCEPTION 'Archive the proposal before permanently deleting it.' USING ERRCODE='PT409';
  END IF;
  PERFORM id FROM public.sales_quote_version
    WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.sales_quote_version
      WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id AND (status<>'draft' OR issued_at IS NOT NULL))
    OR EXISTS (SELECT 1 FROM public.sales_quote_status_history
      WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id
        AND (to_status<>'draft' OR (from_status IS NOT NULL AND from_status<>'draft'))) THEN
    RAISE EXCEPTION 'Only never-issued draft proposals can be permanently deleted. Keep this proposal archived.'
      USING ERRCODE='PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_quote_delivery_token WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sales_quote_delivery_audit WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sales_agreement_envelope WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id) THEN
    RAISE EXCEPTION 'This proposal has delivery or signature history and must remain archived.' USING ERRCODE='PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_commercial_sale WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sales_stage_historical_invoice h JOIN public.sales_quote_version v
      ON v.tenant_id=h.tenant_id AND v.id=h.quote_version_id
      WHERE v.tenant_id=OLD.tenant_id AND v.quote_id=OLD.id) THEN
    RAISE EXCEPTION 'This proposal has financial or inventory history and must remain archived.' USING ERRCODE='PT409';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS sales_quote_protected_delete ON public.sales_quote;
CREATE TRIGGER sales_quote_protected_delete BEFORE DELETE ON public.sales_quote
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_quote_delete();

-- Permit only the owned draft cascade after the protected parent has gone.
-- Direct child deletion and all issued-version/history immutability remain.
CREATE OR REPLACE FUNCTION public.guard_issued_quote_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='draft' AND OLD.issued_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.sales_quote WHERE tenant_id=OLD.tenant_id AND id=OLD.quote_id
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Issued quote versions are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'draft' AND
    (to_jsonb(NEW)-'status'-'updated_at')<>(to_jsonb(OLD)-'status'-'updated_at') THEN
    RAISE EXCEPTION 'Issued quote versions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.guard_quote_history_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.to_status='draft'
    AND (OLD.from_status IS NULL OR OLD.from_status='draft') AND NOT EXISTS (
      SELECT 1 FROM public.sales_quote WHERE tenant_id=OLD.tenant_id AND id=OLD.quote_id
    ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Quote status history is append-only' USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION public.set_sales_quote_archive(
  p_tenant uuid,p_quote uuid,p_version integer,p_action text,p_actor text,p_actor_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_row public.sales_quote%ROWTYPE; new_row public.sales_quote%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('archive','restore','delete')
    OR p_version IS NULL OR p_version<1 OR p_actor IS NULL OR btrim(p_actor)=''
    OR p_actor_type IS NULL OR p_actor_type NOT IN ('tenant_user','member') THEN
    RAISE EXCEPTION 'Invalid proposal lifecycle request' USING ERRCODE='22023';
  END IF;
  -- Keep inventory/quote lock ordering consistent with existing terminal RPCs.
  PERFORM public.sales_space_lock(p_tenant);
  SELECT * INTO old_row FROM public.sales_quote
    WHERE tenant_id=p_tenant AND id=p_quote FOR UPDATE;
  IF NOT FOUND OR old_row.exhibition_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE='P0002';
  END IF;
  IF old_row.row_version<>p_version THEN
    RAISE EXCEPTION 'Proposal was updated elsewhere. Reload and try again.' USING ERRCODE='PT409';
  END IF;
  IF p_action='delete' THEN
    DELETE FROM public.sales_quote WHERE tenant_id=p_tenant AND id=p_quote;
    INSERT INTO public.sales_audit_event
      (tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data)
      VALUES(p_tenant,p_actor,p_actor_type,'quote.deleted','sales_quote',p_quote::text,
        jsonb_build_object('row_version',old_row.row_version,'archived_at',old_row.archived_at,
          'opportunity_id',old_row.opportunity_id));
    RETURN jsonb_build_object('deleted',true,'id',p_quote);
  END IF;
  IF (p_action='archive' AND old_row.archived_at IS NOT NULL)
    OR (p_action='restore' AND old_row.archived_at IS NULL) THEN
    RAISE EXCEPTION 'Proposal lifecycle changed. Reload and try again.' USING ERRCODE='PT409';
  END IF;
  UPDATE public.sales_quote SET
    archived_at=CASE WHEN p_action='archive' THEN now() ELSE NULL END,
    row_version=row_version+1,updated_at=now(),updated_by=p_actor
    WHERE tenant_id=p_tenant AND id=p_quote RETURNING * INTO new_row;
  INSERT INTO public.sales_audit_event
    (tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
    VALUES(p_tenant,p_actor,p_actor_type,
      CASE WHEN p_action='archive' THEN 'quote.archived' ELSE 'quote.restored' END,
      'sales_quote',p_quote::text,
      jsonb_build_object('row_version',old_row.row_version,'archived_at',old_row.archived_at),
      jsonb_build_object('row_version',new_row.row_version,'archived_at',new_row.archived_at));
  RETURN to_jsonb(new_row);
EXCEPTION WHEN foreign_key_violation THEN
  RAISE EXCEPTION 'This proposal has linked financial, fulfilment or historical records and must remain archived.'
    USING ERRCODE='PT409';
END $$;
REVOKE ALL ON FUNCTION public.set_sales_quote_archive(uuid,uuid,integer,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_quote_archive(uuid,uuid,integer,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_sales_quote_delete() FROM PUBLIC,anon,authenticated;
COMMIT;
