-- Report visibility is independent of suppression, resolution and consent.
ALTER TABLE public.email_address_bounce
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by text;
COMMENT ON COLUMN public.email_address_bounce.hidden_at IS
  'Hidden from normal report views only; never changes campaign eligibility.';
CREATE INDEX email_address_bounce_visible_report
  ON public.email_address_bounce(tenant_id,last_bounced_at DESC,id)
  WHERE hidden_at IS NULL;
