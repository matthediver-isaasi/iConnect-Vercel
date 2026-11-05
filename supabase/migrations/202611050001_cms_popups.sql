-- Popup documents and preferences are service-only. API authorization is mandatory.
BEGIN;
CREATE TABLE public.cms_popup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  microsite_id uuid REFERENCES public.microsite(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  design jsonb NOT NULL CHECK (jsonb_typeof(design) = 'object'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  dismissal_generation integer NOT NULL DEFAULT 1 CHECK (dismissal_generation > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);
CREATE INDEX cms_popup_delivery ON public.cms_popup(tenant_id,microsite_id,status,id);
CREATE TABLE public.cms_popup_page (
  tenant_id uuid NOT NULL,
  popup_id uuid NOT NULL,
  page_id uuid NOT NULL REFERENCES public.i_edit_page(id) ON DELETE CASCADE,
  PRIMARY KEY (popup_id,page_id),
  FOREIGN KEY (tenant_id,popup_id) REFERENCES public.cms_popup(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX cms_popup_page_lookup ON public.cms_popup_page(tenant_id,page_id,popup_id);
CREATE TABLE public.cms_popup_member_state (
  tenant_id uuid NOT NULL,
  popup_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  permanently_dismissed boolean NOT NULL DEFAULT false,
  last_shown_at timestamptz,
  PRIMARY KEY (tenant_id,popup_id,member_id,generation),
  FOREIGN KEY (tenant_id,popup_id) REFERENCES public.cms_popup(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX cms_popup_member_lookup ON public.cms_popup_member_state(tenant_id,member_id,popup_id);

CREATE FUNCTION public.cms_popup_ownership_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p public.cms_popup;
BEGIN
  IF TG_TABLE_NAME = 'cms_popup' THEN
    IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.microsite_id IS DISTINCT FROM OLD.microsite_id) THEN
      RAISE EXCEPTION 'Popup ownership and site scope are immutable';
    END IF;
    IF NEW.microsite_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.microsite m WHERE m.id = NEW.microsite_id AND m.tenant_id::text = NEW.tenant_id::text
    ) THEN RAISE EXCEPTION 'Invalid popup site'; END IF;
  ELSE
    SELECT * INTO STRICT p FROM public.cms_popup WHERE id = NEW.popup_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF TG_TABLE_NAME = 'cms_popup_page' THEN
      IF NOT EXISTS (SELECT 1 FROM public.i_edit_page pg WHERE pg.id = NEW.page_id
        AND pg.tenant_id::text = NEW.tenant_id::text AND pg.microsite_id IS NOT DISTINCT FROM p.microsite_id)
      THEN RAISE EXCEPTION 'Invalid popup page'; END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.member m WHERE m.id = NEW.member_id AND m.tenant_id::text = NEW.tenant_id::text)
        OR NEW.generation <> p.dismissal_generation THEN RAISE EXCEPTION 'Invalid popup member or generation'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.permanently_dismissed AND NOT NEW.permanently_dismissed
        THEN RAISE EXCEPTION 'Permanent choices cannot be undone'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cms_popup_owner BEFORE INSERT OR UPDATE ON public.cms_popup FOR EACH ROW EXECUTE FUNCTION public.cms_popup_ownership_guard();
CREATE TRIGGER cms_popup_page_owner BEFORE INSERT OR UPDATE ON public.cms_popup_page FOR EACH ROW EXECUTE FUNCTION public.cms_popup_ownership_guard();
CREATE TRIGGER cms_popup_member_owner BEFORE INSERT OR UPDATE ON public.cms_popup_member_state FOR EACH ROW EXECUTE FUNCTION public.cms_popup_ownership_guard();

-- One transaction replaces configuration and assignments. The expected revision
-- prevents lost updates and serializes reset/delete with preference writes.
CREATE FUNCTION public.cms_popup_save(p_tenant uuid,p_id uuid,p_revision integer,p_document jsonb,p_action text DEFAULT 'save')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE current_row public.cms_popup; result public.cms_popup; target uuid;
BEGIN
  IF p_action = 'create' THEN
    INSERT INTO public.cms_popup(tenant_id,microsite_id,name,design,config)
    VALUES(p_tenant,nullif(p_document->>'microsite_id','')::uuid,p_document->>'name',p_document->'design',p_document->'config')
    RETURNING * INTO result;
    RETURN to_jsonb(result);
  END IF;
  SELECT * INTO current_row FROM public.cms_popup WHERE id=p_id AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Popup not found' USING ERRCODE='P0002'; END IF;
  IF current_row.revision <> p_revision THEN RAISE EXCEPTION 'Popup changed; reload before saving' USING ERRCODE='40001'; END IF;
  IF p_action = 'delete' THEN
    DELETE FROM public.cms_popup WHERE id=p_id;
    RETURN jsonb_build_object('deleted',true);
  ELSIF p_action = 'duplicate' THEN
    INSERT INTO public.cms_popup(tenant_id,microsite_id,name,design,config,starts_at,ends_at)
    VALUES(p_tenant,current_row.microsite_id,left(current_row.name,113)||' (copy)',current_row.design,current_row.config,current_row.starts_at,current_row.ends_at)
    RETURNING * INTO result;
    INSERT INTO public.cms_popup_page SELECT tenant_id,result.id,page_id FROM public.cms_popup_page WHERE popup_id=p_id;
    RETURN to_jsonb(result);
  ELSIF p_action = 'reset-dismissals' THEN
    UPDATE public.cms_popup SET dismissal_generation=dismissal_generation+1,revision=revision+1,updated_at=now()
    WHERE id=p_id RETURNING * INTO result;
    RETURN to_jsonb(result);
  ELSIF p_action <> 'save' THEN RAISE EXCEPTION 'Unknown action';
  END IF;
  UPDATE public.cms_popup SET name=p_document->>'name',design=p_document->'design',
    config=p_document->'config',status=p_document->>'status',
    starts_at=(p_document->>'starts_at')::timestamptz,ends_at=(p_document->>'ends_at')::timestamptz,
    revision=revision+1,updated_at=now()
  WHERE id=p_id RETURNING * INTO result;
  DELETE FROM public.cms_popup_page WHERE popup_id=p_id;
  FOR target IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(p_document->'config'->'page_ids') LOOP
    INSERT INTO public.cms_popup_page VALUES(p_tenant,p_id,target);
  END LOOP;
  RETURN to_jsonb(result);
END $$;

CREATE FUNCTION public.cms_popup_preference(p_tenant uuid,p_popup uuid,p_member uuid,p_generation integer,p_revision integer,p_action text,p_shown_at timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.cms_popup;
BEGIN
  SELECT * INTO p FROM public.cms_popup WHERE tenant_id=p_tenant AND id=p_popup FOR UPDATE;
  IF NOT FOUND OR p.dismissal_generation<>p_generation OR p.revision<>p_revision
    THEN RAISE EXCEPTION 'Popup changed' USING ERRCODE='40001'; END IF;
  IF p_action NOT IN ('shown','permanent') THEN RAISE EXCEPTION 'Invalid preference'; END IF;
  IF p_action='shown' AND (p_shown_at IS NULL OR p_shown_at > now()+interval '30 seconds'
    OR p_shown_at < now()-interval '1 day') THEN RAISE EXCEPTION 'Invalid shown time'; END IF;
  IF p_action='permanent' AND p.config->>'allow_permanent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Preference unavailable'; END IF;
  INSERT INTO public.cms_popup_member_state(tenant_id,popup_id,member_id,generation,permanently_dismissed,last_shown_at)
  VALUES(p_tenant,p_popup,p_member,p_generation,p_action='permanent',CASE WHEN p_action='shown' THEN p_shown_at END)
  ON CONFLICT(tenant_id,popup_id,member_id,generation) DO UPDATE
  SET permanently_dismissed=cms_popup_member_state.permanently_dismissed OR excluded.permanently_dismissed,
      last_shown_at=CASE WHEN p_action='shown' THEN
        greatest(cms_popup_member_state.last_shown_at,excluded.last_shown_at)
        ELSE cms_popup_member_state.last_shown_at END;
  RETURN true;
END $$;
ALTER TABLE public.cms_popup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_popup_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_popup_member_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_popup,public.cms_popup_page,public.cms_popup_member_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cms_popup,public.cms_popup_page,public.cms_popup_member_state TO service_role;
REVOKE ALL ON FUNCTION public.cms_popup_ownership_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cms_popup_save(uuid,uuid,integer,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cms_popup_preference(uuid,uuid,uuid,integer,integer,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cms_popup_save(uuid,uuid,integer,jsonb,text),
  public.cms_popup_preference(uuid,uuid,uuid,integer,integer,text,timestamptz) TO service_role;
COMMIT;
