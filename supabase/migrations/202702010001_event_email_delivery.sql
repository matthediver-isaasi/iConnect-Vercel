-- Event email delivery ledger (confirmation, reminder and follow-up sends).
--
-- PREPARED ONLY. Apply to DEST with the pinned migration runner after owner
-- approval. Additive: no existing table, queue row or campaign rule changes.
--
-- One row per send attempt. Mailgun webhooks and the event sync recovery job
-- match rows by the dedicated custom variable iconn_event_email_delivery (the
-- row id), the normalized Mailgun message ID and the ledger recipient (so CC
-- copies never change the attendee's outcome), never by email address alone.
--
-- Rollback:
--   DROP FUNCTION public.event_email_delivery_stats(uuid,uuid);
--   DROP FUNCTION public.apply_event_email_delivery_event(uuid,text,text,text,timestamptz,text,text,text);
--   DROP FUNCTION public.record_event_email_send_result(uuid,boolean,text,text,text,timestamptz);
--   DROP TABLE public.event_email_delivery_event;
--   DROP TABLE public.event_email_delivery;
--   DROP TABLE public.event_email_delivery_tracking;
BEGIN;

-- Singleton recording when tracking began, so the UI can say emails sent
-- earlier are not counted instead of showing misleading zeros.
CREATE TABLE IF NOT EXISTS public.event_email_delivery_tracking (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.event_email_delivery_tracking(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.event_email_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_email_id uuid,
  email_type text NOT NULL CHECK (email_type IN ('confirmation','booking_confirmation','reminder','follow_up')),
  booking_id uuid,
  recipient_email text NOT NULL,
  scheduled_email_id uuid,
  send_source text,
  mailgun_message_id text,
  mailgun_domain text,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','accepted','delivered','failed')),
  failure_source text CHECK (failure_source IS NULL OR failure_source IN ('send','provider')),
  sent_at timestamptz,
  delivered_at timestamptz,
  first_opened_at timestamptz,
  failed_at timestamptz,
  open_count integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  failure_reason text,
  temporary_failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'failed') = (failure_source IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS event_email_delivery_event_idx
  ON public.event_email_delivery(tenant_id, event_id, event_email_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_email_delivery_message_idx
  ON public.event_email_delivery(mailgun_message_id) WHERE mailgun_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_email_delivery_recovery_idx
  ON public.event_email_delivery(created_at) WHERE mailgun_message_id IS NOT NULL;

-- Provider evidence already applied, so webhook retries and sync recovery
-- never double-count opens or reapply the same event.
CREATE TABLE IF NOT EXISTS public.event_email_delivery_event (
  delivery_id uuid NOT NULL REFERENCES public.event_email_delivery(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, provider_event_id)
);

ALTER TABLE public.event_email_delivery_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_email_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_email_delivery_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_email_delivery_tracking, public.event_email_delivery, public.event_email_delivery_event
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.event_email_delivery_tracking, public.event_email_delivery, public.event_email_delivery_event
  FROM service_role;
GRANT SELECT ON public.event_email_delivery_tracking TO service_role;
-- Status changes go through the functions below; the service role may only
-- create the initial attempt row and read the ledger.
GRANT SELECT, INSERT ON public.event_email_delivery TO service_role;
GRANT SELECT ON public.event_email_delivery_event TO service_role;

-- Result of the local send call. Provider evidence that arrived first wins.
CREATE OR REPLACE FUNCTION public.record_event_email_send_result(
  p_delivery_id uuid, p_accepted boolean, p_message_id text, p_domain text, p_reason text, p_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  msg text := nullif(btrim(coalesce(p_message_id, ''), '<> '), '');
  n integer;
BEGIN
  IF p_accepted THEN
    UPDATE public.event_email_delivery SET
      mailgun_message_id = coalesce(mailgun_message_id, msg),
      mailgun_domain = coalesce(mailgun_domain, p_domain),
      sent_at = coalesce(sent_at, p_at),
      status = CASE WHEN status = 'sending' OR (status = 'failed' AND failure_source = 'send') THEN 'accepted' ELSE status END,
      failure_source = CASE WHEN status = 'failed' AND failure_source = 'send' THEN NULL ELSE failure_source END,
      failure_reason = CASE WHEN status = 'failed' AND failure_source = 'send' THEN NULL ELSE failure_reason END,
      failed_at = CASE WHEN status = 'failed' AND failure_source = 'send' THEN NULL ELSE failed_at END,
      updated_at = now()
    WHERE id = p_delivery_id AND (mailgun_message_id IS NULL OR msg IS NULL OR mailgun_message_id = msg);
  ELSE
    UPDATE public.event_email_delivery SET
      status = 'failed', failure_source = 'send', failed_at = p_at,
      failure_reason = left(coalesce(nullif(p_reason, ''), 'Send failed'), 1000), updated_at = now()
    WHERE id = p_delivery_id AND status = 'sending';
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

-- Apply one Mailgun event. p_kind is the shared delivery classification:
-- delivered | opened | soft_bounce | hard_bounce | delivery_failed.
CREATE OR REPLACE FUNCTION public.apply_event_email_delivery_event(
  p_delivery_id uuid, p_message_id text, p_kind text, p_event_type text,
  p_event_at timestamptz, p_reason text, p_provider_event_id text, p_recipient text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.event_email_delivery%ROWTYPE;
  msg text := nullif(btrim(coalesce(p_message_id, ''), '<> '), '');
  inserted integer;
BEGIN
  SELECT * INTO r FROM public.event_email_delivery WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('matched', false); END IF;
  IF r.mailgun_message_id IS NOT NULL AND msg IS NOT NULL AND r.mailgun_message_id <> msg THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'message_mismatch');
  END IF;
  -- CC/BCC copies share the message and ledger variable; only the ledger
  -- recipient's own events may change its outcome. Fail closed when absent.
  IF lower(btrim(coalesce(p_recipient, ''))) <> lower(btrim(r.recipient_email)) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'recipient_mismatch', 'tenant_id', r.tenant_id);
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('delivered','opened','soft_bounce','hard_bounce','delivery_failed') THEN
    RETURN jsonb_build_object('matched', true, 'applied', false, 'tenant_id', r.tenant_id);
  END IF;
  IF nullif(p_provider_event_id, '') IS NOT NULL THEN
    INSERT INTO public.event_email_delivery_event(delivery_id, provider_event_id, event_type, event_at)
    VALUES (r.id, p_provider_event_id, coalesce(p_event_type, p_kind), p_event_at)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted = 0 THEN
      RETURN jsonb_build_object('matched', true, 'applied', false, 'duplicate', true, 'tenant_id', r.tenant_id);
    END IF;
  END IF;

  r.mailgun_message_id := coalesce(r.mailgun_message_id, msg);
  -- Any provider event proves Mailgun accepted the message.
  r.sent_at := coalesce(r.sent_at, p_event_at);
  IF r.status = 'failed' AND r.failure_source = 'send' THEN
    -- A local timeout/error is ambiguous; provider evidence supersedes it.
    r.status := 'accepted'; r.failure_source := NULL; r.failure_reason := NULL; r.failed_at := NULL;
  ELSIF r.status = 'sending' THEN
    r.status := 'accepted';
  END IF;

  IF p_kind IN ('delivered','opened') THEN
    -- An open is tracking evidence of delivery.
    r.delivered_at := LEAST(coalesce(r.delivered_at, p_event_at), p_event_at);
    IF r.status = 'accepted' THEN r.status := 'delivered'; r.temporary_failure_reason := NULL; END IF;
    IF p_kind = 'opened' THEN
      r.open_count := r.open_count + 1;
      r.first_opened_at := LEAST(coalesce(r.first_opened_at, p_event_at), p_event_at);
    END IF;
  ELSIF p_kind = 'soft_bounce' THEN
    -- Temporary failures never overwrite a delivery or a permanent outcome.
    IF r.status = 'accepted' THEN
      r.temporary_failure_reason := left(coalesce(nullif(p_reason, ''), 'Temporary delivery failure'), 1000);
    END IF;
  ELSE
    IF r.status <> 'failed' THEN
      r.status := 'failed'; r.failure_source := 'provider'; r.failed_at := p_event_at;
      r.failure_reason := left(coalesce(nullif(p_reason, ''),
        CASE WHEN p_kind = 'hard_bounce' THEN 'Bounced' ELSE 'Delivery failed' END), 1000);
    END IF;
  END IF;

  UPDATE public.event_email_delivery SET
    mailgun_message_id = r.mailgun_message_id, sent_at = r.sent_at, status = r.status,
    failure_source = r.failure_source, failure_reason = r.failure_reason, failed_at = r.failed_at,
    delivered_at = r.delivered_at, first_opened_at = r.first_opened_at, open_count = r.open_count,
    temporary_failure_reason = r.temporary_failure_reason, updated_at = now()
  WHERE id = r.id;
  RETURN jsonb_build_object('matched', true, 'applied', true, 'tenant_id', r.tenant_id, 'status', r.status);
END $$;

-- Per-email-setting counts for one tenant-owned event.
CREATE OR REPLACE FUNCTION public.event_email_delivery_stats(p_tenant_id uuid, p_event_id uuid)
RETURNS TABLE(event_email_id uuid, total bigint, sent bigint, delivered bigint, awaiting bigint,
  opened bigint, failed bigint, sending bigint, first_tracked_at timestamptz, last_sent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.event_email_id,
    count(*),
    count(*) FILTER (WHERE d.status IN ('accepted','delivered') OR d.failure_source = 'provider'),
    count(*) FILTER (WHERE d.status = 'delivered'),
    count(*) FILTER (WHERE d.status = 'accepted'),
    count(*) FILTER (WHERE d.open_count > 0),
    count(*) FILTER (WHERE d.status = 'failed'),
    count(*) FILTER (WHERE d.status = 'sending'),
    min(d.created_at), max(d.sent_at)
  FROM public.event_email_delivery d
  WHERE d.tenant_id = p_tenant_id AND d.event_id = p_event_id AND d.event_email_id IS NOT NULL
  GROUP BY d.event_email_id;
$$;

REVOKE ALL ON FUNCTION public.record_event_email_send_result(uuid,boolean,text,text,text,timestamptz),
  public.apply_event_email_delivery_event(uuid,text,text,text,timestamptz,text,text,text),
  public.event_email_delivery_stats(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_event_email_send_result(uuid,boolean,text,text,text,timestamptz),
  public.apply_event_email_delivery_event(uuid,text,text,text,timestamptz,text,text,text),
  public.event_email_delivery_stats(uuid,uuid)
  TO service_role;

COMMIT;
