-- Default-off, creation-time pin. Existing campaigns retain individual sending.
BEGIN;
ALTER TABLE public.email_campaign
  ADD COLUMN IF NOT EXISTS delivery_transport text NOT NULL DEFAULT 'individual';
ALTER TABLE public.email_campaign
  ADD CONSTRAINT email_campaign_delivery_transport_check
  CHECK (delivery_transport IN ('individual', 'mailgun_batch_v1'));
CREATE OR REPLACE FUNCTION public.prevent_campaign_transport_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.delivery_transport IS DISTINCT FROM OLD.delivery_transport THEN
    RAISE EXCEPTION 'Campaign delivery transport is fixed at creation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.prevent_campaign_transport_change() FROM PUBLIC;
CREATE TRIGGER email_campaign_transport_immutable
BEFORE UPDATE OF delivery_transport ON public.email_campaign
FOR EACH ROW EXECUTE FUNCTION public.prevent_campaign_transport_change();
COMMIT;
