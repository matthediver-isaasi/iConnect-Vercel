BEGIN;
-- Signature blobs are deliberately small and transactional. No public bucket,
-- browser table grants, caller paths, or remotely fetched images are involved.
CREATE TABLE public.cpd_certificate_image (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  content_base64 text NOT NULL CHECK (octet_length(content_base64) <= 2796204),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (width::bigint * height <= 16777216),
  UNIQUE (tenant_id,id)
);
-- Bindings intentionally survive template deletion: immutable issued/pending
-- snapshots can still prove ownership. Published assets are retained evidence,
-- not garbage collected by a designer removing a field.
CREATE TABLE public.cpd_certificate_image_binding (
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,template_id,asset_id),
  FOREIGN KEY (tenant_id,asset_id) REFERENCES public.cpd_certificate_image(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE public.cpd_certificate_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpd_certificate_image_binding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cpd_certificate_image, public.cpd_certificate_image_binding FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.cpd_certificate_image, public.cpd_certificate_image_binding TO service_role;

ALTER TABLE public.cpd_certificate_placeholder
  DROP CONSTRAINT cpd_certificate_placeholder_field_type_check,
  ADD CONSTRAINT cpd_certificate_placeholder_field_type_check CHECK (field_type IN ('text','date','number','image')),
  ADD COLUMN image_asset_id uuid,
  ADD COLUMN image_sha256 text,
  ADD CONSTRAINT cpd_certificate_image_contract CHECK (
    (field_type = 'image' AND image_asset_id IS NOT NULL AND image_sha256 IS NOT NULL AND image_sha256 ~ '^[0-9a-f]{64}$' AND text_template IS NULL)
    OR (field_type <> 'image' AND image_asset_id IS NULL AND image_sha256 IS NULL)
  );

CREATE FUNCTION public.guard_cpd_certificate_image() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.field_type = 'image' THEN
    PERFORM 1 FROM public.cpd_certificate_image_binding b
      JOIN public.cpd_certificate_image a ON a.id=b.asset_id AND a.tenant_id=b.tenant_id
      WHERE b.tenant_id=NEW.tenant_id AND b.template_id=NEW.template_id
        AND b.asset_id=NEW.image_asset_id AND a.sha256=NEW.image_sha256
      FOR UPDATE OF a;
    IF NOT FOUND THEN RAISE EXCEPTION 'Signature does not belong to template'; END IF;
    UPDATE public.cpd_certificate_image SET published_at=COALESCE(published_at,now()) WHERE id=NEW.image_asset_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cpd_certificate_image_guard BEFORE INSERT OR UPDATE ON public.cpd_certificate_placeholder
  FOR EACH ROW EXECUTE FUNCTION public.guard_cpd_certificate_image();

CREATE FUNCTION public.upload_cpd_certificate_image(
  p_tenant_id uuid,p_template_id uuid,p_expected_version integer,p_sha256 text,
  p_mime_type text,p_width integer,p_height integer,p_content_base64 text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE asset uuid;
BEGIN
  PERFORM 1 FROM public.cpd_certificate_template WHERE id=p_template_id AND tenant_id=p_tenant_id
    AND version=p_expected_version AND status<>'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cpd_template_conflict' USING ERRCODE='40001'; END IF;
  -- Abandoned uploads have no successful reference. Cleanup is transactional,
  -- restricted to this template, and never touches published/snapshotted bytes.
  DELETE FROM public.cpd_certificate_image a USING public.cpd_certificate_image_binding b
    WHERE a.id=b.asset_id AND b.tenant_id=p_tenant_id AND b.template_id=p_template_id
      AND a.published_at IS NULL AND a.created_at < now()-interval '24 hours';
  IF (SELECT count(*) FROM public.cpd_certificate_image a
    JOIN public.cpd_certificate_image_binding b ON b.asset_id=a.id
    WHERE b.tenant_id=p_tenant_id AND b.template_id=p_template_id AND a.published_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'Too many unsaved signature uploads. Save your template or retry after 24 hours.';
  END IF;
  INSERT INTO public.cpd_certificate_image(tenant_id,sha256,mime_type,width,height,content_base64)
    VALUES(p_tenant_id,p_sha256,p_mime_type,p_width,p_height,p_content_base64) RETURNING id INTO asset;
  INSERT INTO public.cpd_certificate_image_binding VALUES(p_tenant_id,p_template_id,asset);
  RETURN asset;
END $$;

CREATE FUNCTION public.copy_cpd_certificate_images(p_tenant_id uuid,p_source uuid,p_target uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM public.cpd_certificate_template WHERE id=p_target AND tenant_id=p_tenant_id
    AND status='draft' FOR UPDATE;
  IF NOT FOUND OR p_source=p_target THEN RAISE EXCEPTION 'Invalid signature copy target'; END IF;
  PERFORM 1 FROM public.cpd_certificate_template WHERE id=p_source AND tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid signature copy source'; END IF;
  INSERT INTO public.cpd_certificate_image_binding(tenant_id,template_id,asset_id)
    SELECT DISTINCT p_tenant_id,p_target,p.image_asset_id FROM public.cpd_certificate_placeholder p
      JOIN public.cpd_certificate_image_binding b ON b.tenant_id=p.tenant_id
        AND b.template_id=p.template_id AND b.asset_id=p.image_asset_id
      WHERE p.tenant_id=p_tenant_id AND p.template_id=p_source AND p.field_type='image'
    ON CONFLICT DO NOTHING;
END $$;

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure) INTO definition;
  IF position('field.text_template' IN definition)=0 OR position('text_template TEXT,' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected certificate save function; authored-text migration is required';
  END IF;
  definition:=replace(definition,'text_template, sample_value','image_asset_id, image_sha256, text_template, sample_value');
  definition:=replace(definition,'field.text_template, field.sample_value','field.image_asset_id, field.image_sha256, field.text_template, field.sample_value');
  definition:=replace(definition,'text_template TEXT,','image_asset_id UUID, image_sha256 TEXT, text_template TEXT,');
  EXECUTE definition;
END $migration$;

CREATE FUNCTION public.save_cpd_certificate_template_images_checked(
  p_template_id uuid,p_tenant_id uuid,p_expected_version integer,p_name text,
  p_description text,p_placeholders jsonb,p_actor text
) RETURNS public.cpd_certificate_template LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE saved public.cpd_certificate_template;
BEGIN
  saved:=public.save_cpd_certificate_template_checked(p_template_id,p_tenant_id,p_expected_version,
    p_name,p_description,p_placeholders,p_actor);
  IF EXISTS (
    WITH expected AS (
      SELECT f->>'placeholder_key' k,f->>'field_type' t,f->>'image_asset_id' a,f->>'image_sha256' h,
        (f->>'page_number')::integer p,(f->>'x')::numeric x,(f->>'y')::numeric y,
        (f->>'width')::numeric w,(f->>'height')::numeric height FROM jsonb_array_elements(p_placeholders) f
    ), actual AS (
      SELECT placeholder_key,field_type,image_asset_id::text,image_sha256,page_number,x,y,width,height
        FROM public.cpd_certificate_placeholder WHERE tenant_id=p_tenant_id AND template_id=p_template_id
    )
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) THEN RAISE EXCEPTION 'cpd_image_schema_incompatible'; END IF;
  RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.guard_cpd_certificate_image() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.upload_cpd_certificate_image(uuid,uuid,integer,text,text,integer,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.copy_cpd_certificate_images(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_cpd_certificate_template_images_checked(uuid,uuid,integer,text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upload_cpd_certificate_image(uuid,uuid,integer,text,text,integer,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.copy_cpd_certificate_images(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_cpd_certificate_template_images_checked(uuid,uuid,integer,text,text,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
