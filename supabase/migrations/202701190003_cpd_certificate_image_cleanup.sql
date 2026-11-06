BEGIN;
CREATE FUNCTION public.cleanup_deleted_cpd_template_images() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  -- The template row is already locked by DELETE. Published images and their
  -- bindings remain immutable evidence for copies and retained snapshots.
  DELETE FROM public.cpd_certificate_image a
    USING public.cpd_certificate_image_binding b
    WHERE a.id=b.asset_id AND b.tenant_id=OLD.tenant_id
      AND b.template_id=OLD.id AND a.published_at IS NULL;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.cleanup_deleted_cpd_template_images() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER cleanup_deleted_cpd_template_images AFTER DELETE ON public.cpd_certificate_template
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_deleted_cpd_template_images();
COMMIT;
