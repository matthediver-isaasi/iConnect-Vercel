-- Preparatory storage only. Does not enable lifecycle processing or mutate members.
BEGIN;
-- One-time guarded capability seeding: replay must not overwrite later role grants.
CREATE TABLE IF NOT EXISTS public.member_lifecycle_installation (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_lifecycle_installation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_installation FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.member_lifecycle_installation TO service_role;
DO $$
DECLARE parent uuid; page uuid; entry record;
BEGIN
  SELECT id INTO parent FROM public.role_access_item WHERE item_key='crm' LIMIT 1;
  IF parent IS NULL THEN RAISE EXCEPTION 'CRM permission catalogue is required'; END IF;
  INSERT INTO public.role_access_item(item_type,item_key,label,parent_id,display_order,is_active)
    VALUES('page','crm.member-lifecycle','Member Lifecycle / Auto Archive',parent,90,true)
    ON CONFLICT(item_key) DO NOTHING;
  SELECT id INTO page FROM public.role_access_item WHERE item_key='crm.member-lifecycle';
  FOR entry IN SELECT * FROM (VALUES
    ('view','View Archive Review'),('configure','Configure Automation'),('review','Manage Review Decisions'),
    ('archive','Archive and Restore'),('minimise','Minimise Personal Data'),('delete','Permanently Delete')
  ) labels(key,label) LOOP
    INSERT INTO public.role_access_item(item_type,item_key,label,parent_id,display_order,is_active)
      VALUES('feature','crm.member-lifecycle.'||entry.key,entry.label,page,10,true)
      ON CONFLICT(item_key) DO NOTHING;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.member_lifecycle_installation WHERE version=1) THEN
    UPDATE public.role SET excluded_features=ARRAY(
      SELECT DISTINCT key FROM unnest(coalesce(excluded_features,ARRAY[]::text[])||ARRAY[
        'crm.member-lifecycle.view','crm.member-lifecycle.configure','crm.member-lifecycle.review',
        'crm.member-lifecycle.archive','crm.member-lifecycle.minimise','crm.member-lifecycle.delete'
      ]) key ORDER BY key);
    INSERT INTO public.member_lifecycle_installation(version) VALUES(1);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_default_role_exclusions()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  NEW.excluded_features:=ARRAY(SELECT DISTINCT key FROM unnest(
    coalesce(NEW.excluded_features,ARRAY[]::text[])||ARRAY[
      'crm.member-lifecycle.view','crm.member-lifecycle.configure','crm.member-lifecycle.review',
      'crm.member-lifecycle.archive','crm.member-lifecycle.minimise','crm.member-lifecycle.delete'
    ]) key ORDER BY key);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_lifecycle_role_defaults ON public.role;
CREATE TRIGGER member_lifecycle_role_defaults BEFORE INSERT ON public.role
  FOR EACH ROW EXECUTE FUNCTION public.member_lifecycle_default_role_exclusions();
REVOKE ALL ON FUNCTION public.member_lifecycle_default_role_exclusions() FROM PUBLIC,anon,authenticated;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_policy (
  tenant_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled=false),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_policy_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL,
  policy jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,revision)
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_revision bigint NOT NULL,
  created_by text NOT NULL,
  cursor uuid,
  complete boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_preview_item (
  preview_id uuid NOT NULL REFERENCES public.member_lifecycle_preview(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  PRIMARY KEY(preview_id,member_id)
);
CREATE INDEX IF NOT EXISTS member_lifecycle_preview_tenant
  ON public.member_lifecycle_preview(tenant_id,created_at DESC);

ALTER TABLE public.member_lifecycle_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_policy_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_preview_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_policy,public.member_lifecycle_policy_audit,
  public.member_lifecycle_preview,public.member_lifecycle_preview_item FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.member_lifecycle_policy,public.member_lifecycle_policy_audit,
  public.member_lifecycle_preview,public.member_lifecycle_preview_item TO service_role;

CREATE OR REPLACE FUNCTION public.save_member_lifecycle_policy(
  p_tenant_id uuid,p_expected_revision bigint,p_policy jsonb,p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_revision bigint; next_revision bigint; role_id_text text;
BEGIN
  IF p_tenant_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0
    OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object'
    OR octet_length(p_policy::text)>20000 THEN
    RAISE EXCEPTION 'Invalid lifecycle policy request' USING ERRCODE='22023';
  END IF;
  -- Covers concurrent first saves as well as existing policy revisions.
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-policy:'||p_tenant_id::text,0));
  SELECT revision INTO current_revision FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id FOR UPDATE;
  current_revision:=coalesce(current_revision,0);
  IF current_revision<>p_expected_revision THEN
    RAISE EXCEPTION 'Lifecycle settings changed; reload before saving' USING ERRCODE='PT409';
  END IF;
  IF p_policy ? 'enabled' OR p_policy ? 'executionReady' THEN
    RAISE EXCEPTION 'Saving configuration cannot enable execution' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_policy->'guestRoleIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_policy->'eventOnlyRoleIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid role mapping' USING ERRCODE='22023';
  END IF;
  FOR role_id_text IN
    SELECT value FROM jsonb_array_elements_text(
      jsonb_build_array(p_policy->'formerRoleId',p_policy->'guestRoleId')
      ||(p_policy->'guestRoleIds')||(p_policy->'eventOnlyRoleIds')
    ) r(value) WHERE value IS NOT NULL
  LOOP
    IF NOT EXISTS(SELECT 1 FROM public.role r WHERE r.id=role_id_text::uuid AND r.tenant_id=p_tenant_id
      AND coalesce(to_jsonb(r)->>'is_active','true')='true'
      AND coalesce(to_jsonb(r)->>'is_tenant_admin','false')<>'true') THEN
      RAISE EXCEPTION 'Role mapping is unavailable for this tenant' USING ERRCODE='22023';
    END IF;
  END LOOP;
  next_revision:=current_revision+1;
  INSERT INTO public.member_lifecycle_policy(tenant_id,revision,policy,updated_by)
    VALUES(p_tenant_id,next_revision,p_policy,p_actor)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,
      enabled=false,updated_at=now(),updated_by=excluded.updated_by;
  INSERT INTO public.member_lifecycle_policy_audit(tenant_id,revision,policy,actor)
    VALUES(p_tenant_id,next_revision,p_policy,p_actor);
  -- Existing previews retain audit evidence, but cannot continue against a new revision.
  RETURN jsonb_build_object('revision',next_revision,'policy',p_policy,'enabled',false);
END $$;

CREATE OR REPLACE FUNCTION public.member_lifecycle_preview_page(
  p_tenant_id uuid,p_actor text,p_revision bigint,p_preview_id uuid,p_cursor uuid,
  p_items jsonb,p_next_cursor uuid,p_complete boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_preview public.member_lifecycle_preview; item jsonb; v_revision bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_complete IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_items)>50 THEN
    RAISE EXCEPTION 'Invalid lifecycle preview page' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-policy:'||p_tenant_id::text,0));
  SELECT revision INTO v_revision FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id;
  IF v_revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'Save and reload policy before previewing' USING ERRCODE='PT409';
  END IF;
  IF p_preview_id IS NULL THEN
    IF p_cursor IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial cursor' USING ERRCODE='22023'; END IF;
    INSERT INTO public.member_lifecycle_preview(tenant_id,policy_revision,created_by)
      VALUES(p_tenant_id,p_revision,p_actor) RETURNING * INTO v_preview;
  ELSE
    SELECT * INTO v_preview FROM public.member_lifecycle_preview
      WHERE id=p_preview_id AND tenant_id=p_tenant_id AND created_by=p_actor FOR UPDATE;
    IF NOT FOUND OR v_preview.policy_revision<>p_revision OR v_preview.expires_at<=now()
      OR v_preview.complete OR v_preview.cursor IS DISTINCT FROM p_cursor THEN
      RAISE EXCEPTION 'Preview expired or changed; start again' USING ERRCODE='PT409';
    END IF;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.member m WHERE m.id=(item->>'memberId')::uuid AND m.tenant_id=p_tenant_id)
      OR item->>'action' NOT IN ('none','former','guest','archive','evidence_review','deletion_review')
      OR item->>'action' IS NULL OR jsonb_typeof(item->'reason') IS DISTINCT FROM 'string'
      OR octet_length(item::text)>4000 THEN
      RAISE EXCEPTION 'Invalid preview member proposal' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.member_lifecycle_preview_item(preview_id,tenant_id,member_id,proposal)
      VALUES(v_preview.id,p_tenant_id,(item->>'memberId')::uuid,item);
  END LOOP;
  UPDATE public.member_lifecycle_preview SET cursor=p_next_cursor,complete=p_complete
    WHERE id=v_preview.id;
  RETURN jsonb_build_object('previewId',v_preview.id,'revision',p_revision,'complete',p_complete,
    'nextCursor',CASE WHEN p_complete THEN NULL ELSE p_next_cursor END,
    'counts',(SELECT coalesce(jsonb_object_agg(action,n),'{}') FROM (
      SELECT proposal->>'action' AS action,count(*) AS n FROM public.member_lifecycle_preview_item
        WHERE preview_id=v_preview.id GROUP BY proposal->>'action') counts));
END $$;
REVOKE ALL ON FUNCTION public.save_member_lifecycle_policy(uuid,bigint,jsonb,text),
  public.member_lifecycle_preview_page(uuid,text,bigint,uuid,uuid,jsonb,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_member_lifecycle_policy(uuid,bigint,jsonb,text),
  public.member_lifecycle_preview_page(uuid,text,bigint,uuid,uuid,jsonb,uuid,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
