BEGIN;
SET LOCAL lock_timeout='5s';

-- Service-only resolution mirrors the authenticated server's active principal.
-- Identity IDs are varchar in production; never cast arbitrary identity keys.
CREATE OR REPLACE FUNCTION public.sales_project_actor_identity(p_tenant uuid,p_kind text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE resolved text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
 END IF;
 IF p_tenant IS NULL OR p_actor IS NULL THEN RETURN NULL; END IF;
 IF p_kind='member' THEN
  SELECT identity_id INTO resolved FROM public.member WHERE tenant_id=p_tenant AND id=p_actor;
 ELSIF p_kind='tenant_user' THEN
  SELECT identity_id INTO resolved FROM public.tenant_user WHERE tenant_id=p_tenant AND id=p_actor;
  -- Do not reinterpret an existing legacy account with a missing identity.
  IF NOT FOUND THEN
   SELECT i.id INTO resolved FROM public.tenant_identity i
   WHERE i.id=p_actor::text AND EXISTS(
    SELECT 1 FROM public.tenant_membership m
    WHERE m.identity_id=i.id AND m.tenant_id=p_tenant AND m.status='active'
     AND (m.role IN ('owner','admin') OR m.membership_type='owner'));
  END IF;
 END IF;
 IF resolved IS NULL OR resolved !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 RETURN resolved::uuid;
END $$;
REVOKE ALL ON FUNCTION public.sales_project_actor_identity(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_project_actor_identity(uuid,text,uuid) TO service_role;

-- Support both the legacy installation and the atomic creation installation.
-- Patch only identity resolution; all existing board/lifecycle checks remain.
DO $migration$
DECLARE signature text; target regprocedure; definition text; revised text; patched integer:=0;
 pattern constant text := $pattern$IF p_kind='member' THEN[[:space:]]+SELECT identity_id INTO v_identity FROM public.member WHERE tenant_id=p_tenant AND id=p_actor;[[:space:]]+ELSIF p_kind='tenant_user' THEN[[:space:]]+SELECT identity_id INTO v_identity FROM public.tenant_user WHERE tenant_id=p_tenant AND id=p_actor;[[:space:]]+END IF;$pattern$;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid)',
  'public.sales_project_attach_board(uuid,uuid,text,text,uuid,uuid,text,uuid)'
 ] LOOP
  target:=to_regprocedure(signature);
  IF target IS NULL THEN CONTINUE; END IF;
  SELECT pg_get_functiondef(target) INTO definition;
  IF position('public.sales_project_actor_identity(p_tenant,p_kind,p_actor)' IN definition)>0 THEN
   patched:=patched+1; CONTINUE;
  END IF;
  revised:=regexp_replace(definition,pattern,
   'v_identity:=public.sales_project_actor_identity(p_tenant,p_kind,p_actor)::text;');
  IF revised=definition THEN
   -- The newer change routine delegates identity validation to attach_board.
   IF signature LIKE 'public.change_sales_project(%'
      AND position('public.sales_project_attach_board(' IN definition)>0 THEN CONTINUE; END IF;
   RAISE EXCEPTION 'Unknown Sales project identity contract: %',signature;
  END IF;
  EXECUTE revised;
  patched:=patched+1;
 END LOOP;
 IF patched=0 THEN RAISE EXCEPTION 'Sales project identity prerequisite is missing'; END IF;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
