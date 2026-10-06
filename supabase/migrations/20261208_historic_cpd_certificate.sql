-- Separate singleton: ordinary event templates remain unrestricted.
CREATE TABLE IF NOT EXISTS public.historic_cpd_certificate (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  FOREIGN KEY (tenant_id, template_id)
    REFERENCES public.cpd_certificate_template(tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE public.historic_cpd_certificate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historic_cpd_certificate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.historic_cpd_certificate TO service_role;

CREATE OR REPLACE FUNCTION public.set_historic_cpd_certificate(p_tenant_id uuid, p_template_id uuid, p_expected_version integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Lock template first, as lifecycle writes do. Singleton upsert serializes
  -- competing first selections without a check-then-insert race.
  IF p_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.cpd_certificate_template t
      WHERE t.id=p_template_id AND t.tenant_id=p_tenant_id
        AND t.status='active' AND t.version=p_expected_version
        AND t.source_bucket='private-uploads'
        AND starts_with(t.source_path,p_tenant_id::text || '/')
        AND t.source_sha256 ~ '^[a-f0-9]{64}$'
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active template changed or unavailable' USING ERRCODE='40001'; END IF;
    INSERT INTO public.historic_cpd_certificate(tenant_id,template_id)
      VALUES(p_tenant_id,p_template_id)
      ON CONFLICT(tenant_id) DO UPDATE SET template_id=excluded.template_id,revision=gen_random_uuid();
  ELSE
    DELETE FROM public.historic_cpd_certificate WHERE tenant_id=p_tenant_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.set_historic_cpd_certificate(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_historic_cpd_certificate(uuid,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.invalidate_historic_cpd_certificate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    DELETE FROM public.historic_cpd_certificate WHERE tenant_id=NEW.tenant_id AND template_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invalidate_historic_cpd_certificate() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS invalidate_historic_cpd_certificate ON public.cpd_certificate_template;
CREATE TRIGGER invalidate_historic_cpd_certificate AFTER UPDATE ON public.cpd_certificate_template
FOR EACH ROW EXECUTE FUNCTION public.invalidate_historic_cpd_certificate();
