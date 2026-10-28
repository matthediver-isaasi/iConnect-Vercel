BEGIN;
CREATE TABLE public.membership_change_form (
 tenant_id uuid NOT NULL, form_id uuid PRIMARY KEY REFERENCES public.form(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false, target_config_ids uuid[] NOT NULL DEFAULT '{}',
 revision integer NOT NULL CHECK(revision>0), actor_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.membership_change_form_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 form_id uuid NOT NULL, revision integer NOT NULL,
 actor_id uuid NOT NULL, settings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(form_id,revision)
);
ALTER TABLE public.membership_change_form ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_change_form_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_change_form,public.membership_change_form_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_change_form,public.membership_change_form_history TO service_role;
CREATE TRIGGER membership_change_form_history_immutable BEFORE UPDATE OR DELETE ON public.membership_change_form_history
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
CREATE FUNCTION public.save_membership_change_form(
 p_tenant_id uuid,p_form_id uuid,p_actor_id uuid,p_revision integer,p_enabled boolean,p_targets uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f public.form; current_config public.membership_change_form; saved public.membership_change_form;
BEGIN
 IF p_actor_id IS NULL OR p_revision IS NULL OR p_revision<0 OR p_enabled IS NULL
  OR p_targets IS NULL OR cardinality(p_targets)>100 OR array_position(p_targets,NULL) IS NOT NULL
  OR cardinality(p_targets)<>(SELECT count(DISTINCT value) FROM unnest(p_targets) value)
 THEN RAISE EXCEPTION 'Invalid membership-change form settings'; END IF;
 SELECT * INTO f FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Form not found in this tenant'; END IF;
 IF p_enabled AND (f.require_authentication IS DISTINCT FROM true OR cardinality(p_targets)=0)
 THEN RAISE EXCEPTION 'Save the form with sign-in required and select at least one membership structure'; END IF;
 IF p_enabled AND EXISTS(SELECT 1 FROM unnest(p_targets) target WHERE NOT EXISTS(
  SELECT 1 FROM public.membership_tier_config t WHERE t.id=target AND t.tenant_id=p_tenant_id
   AND t.is_active=true AND t.structure_scope_type='member'))
 THEN RAISE EXCEPTION 'Target structures must be active member structures in this tenant'; END IF;
 SELECT * INTO current_config FROM public.membership_change_form WHERE form_id=p_form_id;
 IF COALESCE(current_config.revision,0)<>p_revision
  OR (current_config.form_id IS NOT NULL AND current_config.tenant_id<>p_tenant_id)
 THEN RAISE EXCEPTION 'Settings changed. Reload before saving'; END IF;
 INSERT INTO public.membership_change_form(tenant_id,form_id,enabled,target_config_ids,revision,actor_id)
 VALUES(p_tenant_id,p_form_id,p_enabled,p_targets,p_revision+1,p_actor_id)
 ON CONFLICT(form_id) DO UPDATE SET enabled=EXCLUDED.enabled,target_config_ids=EXCLUDED.target_config_ids,
  revision=EXCLUDED.revision,actor_id=EXCLUDED.actor_id,updated_at=now() RETURNING * INTO saved;
 INSERT INTO public.membership_change_form_history(tenant_id,form_id,revision,actor_id,settings)
 VALUES(p_tenant_id,p_form_id,saved.revision,p_actor_id,to_jsonb(saved));
 RETURN to_jsonb(saved);
END $$;
REVOKE ALL ON FUNCTION public.save_membership_change_form(uuid,uuid,uuid,integer,boolean,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_membership_change_form(uuid,uuid,uuid,integer,boolean,uuid[]) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
