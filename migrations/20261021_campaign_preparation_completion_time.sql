BEGIN;
-- No historical backfill: updated_at is a lease/checkpoint time, not completion.
ALTER TABLE public.campaign_preparation ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE OR REPLACE FUNCTION public.stamp_campaign_preparation_completion()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.phase='complete' AND OLD.phase IS DISTINCT FROM 'complete' THEN
    NEW.completed_at=clock_timestamp();
  ELSE
    NEW.completed_at=OLD.completed_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stamp_campaign_preparation_completion ON public.campaign_preparation;
CREATE TRIGGER stamp_campaign_preparation_completion BEFORE UPDATE
ON public.campaign_preparation FOR EACH ROW
EXECUTE FUNCTION public.stamp_campaign_preparation_completion();
NOTIFY pgrst, 'reload schema';
COMMIT;
