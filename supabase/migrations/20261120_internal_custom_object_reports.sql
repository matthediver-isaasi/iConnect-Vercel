BEGIN;
-- Explicit role grants default to none, independently of the exclusion-based
-- Data Studio builder permission. Internal and external grants never substitute.
ALTER TABLE public.custom_object_report_share
  ADD COLUMN IF NOT EXISTS internal_revision bigint NOT NULL DEFAULT 1 CHECK(internal_revision>0);
ALTER TABLE public.custom_object_report_share_grant
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'external' CHECK(channel IN ('external','internal')),
  ADD COLUMN IF NOT EXISTS actor_key text,
  ADD COLUMN IF NOT EXISTS role_id uuid,
  ADD COLUMN IF NOT EXISTS permission_revision bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.custom_object_report_share_grant'::regclass
    AND conname='custom_object_report_internal_grant_identity') THEN
    ALTER TABLE public.custom_object_report_share_grant ADD CONSTRAINT custom_object_report_internal_grant_identity
    CHECK ((channel='external' AND actor_key IS NULL AND role_id IS NULL AND permission_revision IS NULL)
      OR (channel='internal' AND actor_key IS NOT NULL AND length(actor_key)>0
        AND permission_revision IS NOT NULL AND permission_revision>=0
        AND (actor_key NOT LIKE 'member:%' OR role_id IS NOT NULL)));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.custom_object_report_role_access (
  tenant_id uuid NOT NULL,
  share_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES public.role(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_download boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY(tenant_id,share_id,role_id),
  FOREIGN KEY(tenant_id,share_id) REFERENCES public.custom_object_report_share(tenant_id,id) ON DELETE CASCADE,
  CHECK(NOT can_download OR can_view)
);
CREATE INDEX IF NOT EXISTS custom_object_report_role_catalog ON public.custom_object_report_role_access(tenant_id,role_id,can_view);
ALTER TABLE public.custom_object_report_role_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_object_report_role_access FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.custom_object_report_role_access TO service_role;
CREATE OR REPLACE FUNCTION public.set_internal_report_role_access(
  p_tenant_id uuid,p_role_id uuid,p_changes jsonb,p_actor text
) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item jsonb; previous bigint; n integer;
BEGIN
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>100
    OR nullif(p_actor,'') IS NULL THEN RAISE EXCEPTION 'Invalid report permissions'; END IF;
  -- Same role row serializes concurrent edits, including the first grant.
  PERFORM 1 FROM public.role WHERE id=p_role_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role unavailable'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    IF jsonb_typeof(item->'can_view') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'can_download') IS DISTINCT FROM 'boolean'
      OR ((item->>'can_download')::boolean AND NOT (item->>'can_view')::boolean)
      THEN RAISE EXCEPTION 'Invalid report permissions'; END IF;
    PERFORM 1 FROM public.custom_object_report_share WHERE id=(item->>'share_id')::uuid AND tenant_id=p_tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report unavailable'; END IF;
    SELECT revision INTO previous FROM public.custom_object_report_role_access
      WHERE tenant_id=p_tenant_id AND share_id=(item->>'share_id')::uuid AND role_id=p_role_id;
    IF coalesce(previous,0) IS DISTINCT FROM (item->>'expected_revision')::bigint
      OR NOT (item ? 'expected_revision') THEN RAISE EXCEPTION 'Report permissions changed' USING ERRCODE='PT409'; END IF;
    INSERT INTO public.custom_object_report_role_access(tenant_id,share_id,role_id,can_view,can_download,updated_by)
      VALUES(p_tenant_id,(item->>'share_id')::uuid,p_role_id,(item->>'can_view')::boolean,(item->>'can_download')::boolean,p_actor)
    ON CONFLICT(tenant_id,share_id,role_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_download=EXCLUDED.can_download,
      revision=custom_object_report_role_access.revision+1,updated_at=now(),updated_by=EXCLUDED.updated_by;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.set_internal_report_role_access(uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_internal_report_role_access(uuid,uuid,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
