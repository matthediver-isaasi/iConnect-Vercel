-- Admin resend claims for the event email delivery ledger.
--
-- PREPARED ONLY. Apply to DEST with the pinned migration runner after owner
-- approval. Prerequisite: 202702010001_event_email_delivery. Additive.
--
-- One claim row per logical send identity (scheduled row, else booking, else
-- recipient) per email setting. A request must hold an unexpired lease before
-- it prepares or sends a resend, and eligibility (the selected row failed and
-- no later send for the same identity is in flight, accepted or delivered) is
-- re-checked while the claim row is locked, so overlapping admin requests can
-- never both resend the same email to the same attendee.
--
-- Rollback:
--   DROP FUNCTION public.release_event_email_resend_claim(uuid);
--   DROP FUNCTION public.claim_event_email_resend(uuid,uuid,uuid,uuid,integer);
--   DROP TABLE public.event_email_resend_claim;
BEGIN;

CREATE TABLE IF NOT EXISTS public.event_email_resend_claim (
  tenant_id uuid NOT NULL,
  event_email_id uuid NOT NULL,
  identity_key text NOT NULL,
  claim_token uuid,
  source_delivery_id uuid,
  claimed_at timestamptz,
  claimed_until timestamptz NOT NULL DEFAULT '-infinity',
  PRIMARY KEY (tenant_id, event_email_id, identity_key)
);
ALTER TABLE public.event_email_resend_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_email_resend_claim FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.event_email_resend_identity(r public.event_email_delivery)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN r.scheduled_email_id IS NOT NULL THEN 's:' || r.scheduled_email_id
    WHEN r.booking_id IS NOT NULL THEN 'b:' || r.booking_id
    ELSE 'e:' || lower(btrim(r.recipient_email)) END;
$$;

-- Returns {claimed:true, token, identity} or {claimed:false, reason} where
-- reason is not_found | not_failed | in_progress | already_resent.
CREATE OR REPLACE FUNCTION public.claim_event_email_resend(
  p_tenant_id uuid, p_event_id uuid, p_event_email_id uuid, p_delivery_id uuid, p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.event_email_delivery%ROWTYPE;
  k text;
  c public.event_email_resend_claim%ROWTYPE;
  tok uuid;
BEGIN
  SELECT * INTO r FROM public.event_email_delivery
  WHERE id = p_delivery_id AND tenant_id = p_tenant_id AND event_id = p_event_id AND event_email_id = p_event_email_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_found'); END IF;
  k := public.event_email_resend_identity(r);
  INSERT INTO public.event_email_resend_claim(tenant_id, event_email_id, identity_key)
  VALUES (p_tenant_id, p_event_email_id, k) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM public.event_email_resend_claim
  WHERE tenant_id = p_tenant_id AND event_email_id = p_event_email_id AND identity_key = k FOR UPDATE;
  -- Re-read under the identity lock: provider evidence may have arrived.
  SELECT * INTO r FROM public.event_email_delivery WHERE id = p_delivery_id;
  IF r.status <> 'failed' THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_failed'); END IF;
  IF c.claimed_until > now() THEN RETURN jsonb_build_object('claimed', false, 'reason', 'in_progress'); END IF;
  IF EXISTS (
    SELECT 1 FROM public.event_email_delivery d
    WHERE d.tenant_id = r.tenant_id AND d.event_id = r.event_id AND d.event_email_id = r.event_email_id
      AND d.id <> r.id AND d.created_at > r.created_at
      AND d.status IN ('sending', 'accepted', 'delivered')
      AND public.event_email_resend_identity(d) = k
  ) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_resent');
  END IF;
  tok := gen_random_uuid();
  UPDATE public.event_email_resend_claim SET claim_token = tok, source_delivery_id = r.id,
    claimed_at = now(), claimed_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60))
  WHERE tenant_id = p_tenant_id AND event_email_id = p_event_email_id AND identity_key = k;
  RETURN jsonb_build_object('claimed', true, 'token', tok, 'identity', k);
END $$;

-- Ends a lease early. Called only when the attempt ended without provider
-- acceptance (skipped, or recorded as failed in the ledger); a lease whose
-- resend was accepted or handed to the scheduler is left to expire.
CREATE OR REPLACE FUNCTION public.release_event_email_resend_claim(p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.event_email_resend_claim SET claimed_until = now()
  WHERE claim_token = p_token AND claimed_until > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

REVOKE ALL ON FUNCTION public.event_email_resend_identity(public.event_email_delivery),
  public.claim_event_email_resend(uuid,uuid,uuid,uuid,integer),
  public.release_event_email_resend_claim(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_event_email_resend(uuid,uuid,uuid,uuid,integer),
  public.release_event_email_resend_claim(uuid)
  TO service_role;

COMMIT;
