-- Private per-form configuration. It is deliberately not part of Form:
-- public projections, generic entities, copies and survey versions never carry recipients.
CREATE UNIQUE INDEX IF NOT EXISTS form_alert_scope_key ON public.form(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_alert_scope_key ON public.form_submission(tenant_id,form_id,id);

CREATE TABLE IF NOT EXISTS public.form_alert_settings (
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  recipients text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(tenant_id,form_id),
  FOREIGN KEY(tenant_id,form_id) REFERENCES public.form(tenant_id,id) ON DELETE CASCADE,
  CHECK(cardinality(recipients) <= 20),
  CHECK(NOT enabled OR cardinality(recipients) > 0)
);

CREATE TABLE IF NOT EXISTS public.form_alert_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','retry','attention','revoked','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  claim_id uuid,
  claimed_at timestamptz,
  token_hash text UNIQUE CHECK(token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  outcome_code text,
  form_snapshot jsonb NOT NULL DEFAULT '{}',
  -- No answers, participant identities or raw/encrypted bearer links are persisted here.
  UNIQUE(tenant_id,form_id,submission_id,recipient),
  FOREIGN KEY(tenant_id,form_id,submission_id)
    REFERENCES public.form_submission(tenant_id,form_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS form_alert_delivery_pending
  ON public.form_alert_delivery(available_at,id) WHERE status IN ('pending','retry');

CREATE TABLE IF NOT EXISTS public.form_alert_submission_snapshot (
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  submission_id uuid PRIMARY KEY,
  form_snapshot jsonb NOT NULL,
  FOREIGN KEY(tenant_id,form_id,submission_id)
    REFERENCES public.form_submission(tenant_id,form_id,id) ON DELETE CASCADE
);
ALTER TABLE public.form_alert_submission_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_alert_submission_snapshot FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.form_alert_submission_snapshot TO service_role;

ALTER TABLE public.form_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_alert_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_alert_settings, public.form_alert_delivery FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.form_alert_settings, public.form_alert_delivery TO service_role;

CREATE OR REPLACE FUNCTION public.validate_form_alert_settings()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE address text;
BEGIN
  IF cardinality(NEW.recipients) <> (SELECT count(DISTINCT value) FROM unnest(NEW.recipients) AS value) THEN
    RAISE EXCEPTION 'Duplicate alert recipients';
  END IF;
  FOREACH address IN ARRAY NEW.recipients LOOP
    IF address IS NULL OR length(address)>254 OR address<>lower(btrim(address))
      OR address !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' THEN
      RAISE EXCEPTION 'Invalid alert recipient';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_form_alert_settings ON public.form_alert_settings;
CREATE TRIGGER validate_form_alert_settings BEFORE INSERT OR UPDATE ON public.form_alert_settings
FOR EACH ROW EXECUTE FUNCTION public.validate_form_alert_settings();

-- Revocation is serialized against the delivery row claim/publication. Never reveals tokens.
CREATE OR REPLACE FUNCTION public.revoke_form_submission_alerts(
  p_tenant_id uuid,p_form_id uuid,p_submission_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.form_alert_delivery SET revoked_at=now(),token_hash=NULL,status='revoked'
  WHERE tenant_id=p_tenant_id AND form_id=p_form_id AND submission_id=p_submission_id;
END $$;
REVOKE ALL ON FUNCTION public.validate_form_alert_settings() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revoke_form_submission_alerts(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_form_submission_alerts(uuid,uuid,uuid) TO service_role;

-- Capture only accepted work. No historical scan/backfill is performed.
-- Survey inserts run inside their existing acceptance transaction, so rollback
-- also rolls back this queue without joining any named completion record.
CREATE OR REPLACE FUNCTION public.capture_form_submission_alerts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE settings public.form_alert_settings%ROWTYPE; definition jsonb; row_data jsonb; accepted boolean;
BEGIN
  row_data := to_jsonb(NEW);
  IF coalesce(row_data->>'status','new') NOT IN ('new','submitted','actioned','processed') THEN RETURN NEW; END IF;
  IF row_data->>'source' IN ('synthetic_contract_override','synthetic_dd_swap') THEN RETURN NEW; END IF;
  SELECT * INTO settings FROM public.form_alert_settings
    WHERE tenant_id=NEW.tenant_id AND form_id=NEW.form_id AND enabled;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT jsonb_build_object('name',f.name,'fields',f.fields,'pages',to_jsonb(f)->'pages','form_type',to_jsonb(f)->'form_type')
      INTO definition FROM public.form f WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.form_id;
    IF definition IS NULL THEN RAISE EXCEPTION 'Alert form scope unavailable'; END IF;
    INSERT INTO public.form_alert_submission_snapshot(tenant_id,form_id,submission_id,form_snapshot)
      VALUES(NEW.tenant_id,NEW.form_id,NEW.id,definition) ON CONFLICT(submission_id) DO NOTHING;
  ELSE
    SELECT s.form_snapshot INTO definition FROM public.form_alert_submission_snapshot s
      WHERE s.submission_id=NEW.id AND s.tenant_id=NEW.tenant_id AND s.form_id=NEW.form_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
  END IF;
  accepted := CASE WHEN row_data->>'payment_status' IS NOT NULL THEN
    row_data->>'payment_status' IN ('paid','setup_complete') AND (
      row_data#>>'{payment_meta,completion,status}'='done'
      OR row_data#>>'{payment_meta,monthly_card_state,status}'='done'
      OR row_data#>>'{payment_meta,monthly_dd_state,status}'='done'
    )
    ELSE row_data->'submission_email_state' IS NULL
      OR row_data->'submission_email_state'='null'::jsonb
      OR row_data#>>'{submission_email_state,status}'='ready' END;
  IF accepted IS NOT TRUE THEN RETURN NEW; END IF;
  -- Never interpret an edit to an old response as a new completion.
  IF TG_OP='UPDATE' THEN
    IF to_jsonb(OLD)->>'payment_status' IS NULL
      AND coalesce(to_jsonb(OLD)#>>'{submission_email_state,status}','') <> 'pending' THEN RETURN NEW; END IF;
    IF to_jsonb(OLD)#>>'{payment_meta,completion,status}'='done'
      OR to_jsonb(OLD)#>>'{payment_meta,monthly_card_state,status}'='done'
      OR to_jsonb(OLD)#>>'{payment_meta,monthly_dd_state,status}'='done' THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO public.form_alert_delivery(tenant_id,form_id,submission_id,recipient,form_snapshot)
    SELECT NEW.tenant_id,NEW.form_id,NEW.id,address,definition FROM unnest(settings.recipients) address
    ON CONFLICT(tenant_id,form_id,submission_id,recipient) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_form_submission_alerts() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS capture_form_submission_alerts ON public.form_submission;
CREATE TRIGGER capture_form_submission_alerts AFTER INSERT OR UPDATE ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.capture_form_submission_alerts();

-- Legacy one-off finalizers have a separate, recoverable pipeline/membership
-- completion marker. Their early payment_meta.finalized claim is NOT evidence
-- of completion. Observe the terminal marker, without changing that lifecycle.
CREATE OR REPLACE FUNCTION public.capture_legacy_form_submission_alerts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.form_alert_delivery(tenant_id,form_id,submission_id,recipient,form_snapshot)
    SELECT s.tenant_id,s.form_id,s.id,address,snapshot.form_snapshot
      FROM public.form_submission s
      JOIN public.form_alert_submission_snapshot snapshot
        ON snapshot.submission_id=s.id AND snapshot.tenant_id=s.tenant_id AND snapshot.form_id=s.form_id
      JOIN public.form_alert_settings settings
        ON settings.tenant_id=s.tenant_id AND settings.form_id=s.form_id AND settings.enabled
      CROSS JOIN LATERAL unnest(settings.recipients) address
      WHERE s.id=NEW.form_submission_id AND s.tenant_id=NEW.tenant_id AND s.payment_status='paid'
        AND to_jsonb(s)#>'{payment_meta,completion}' IS NULL
    ON CONFLICT(tenant_id,form_id,submission_id,recipient) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_legacy_form_submission_alerts() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS capture_legacy_form_submission_alerts ON public.form_due_diligence_one_off_ready;
CREATE TRIGGER capture_legacy_form_submission_alerts AFTER INSERT ON public.form_due_diligence_one_off_ready
FOR EACH ROW EXECUTE FUNCTION public.capture_legacy_form_submission_alerts();

CREATE OR REPLACE FUNCTION public.claim_form_submission_alert(p_delivery_id uuid,p_claim_id uuid,p_token_hash text)
RETURNS SETOF public.form_alert_delivery LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_claim_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid alert claim';
  END IF;
  RETURN QUERY UPDATE public.form_alert_delivery d SET status='sending',attempts=d.attempts+1,
    claim_id=p_claim_id,claimed_at=now(),token_hash=p_token_hash
  WHERE d.id=p_delivery_id AND d.status IN ('pending','retry') AND d.available_at<=now()
    AND d.expires_at>now() AND d.revoked_at IS NULL AND d.attempts<5
  RETURNING d.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_form_submission_alert(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_submission_alert(uuid,uuid,text) TO service_role;

CREATE TABLE IF NOT EXISTS public.form_alert_read_limit (
  key text PRIMARY KEY CHECK(key ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  requests integer NOT NULL
);
ALTER TABLE public.form_alert_read_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_alert_read_limit FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.form_alert_read_limit TO service_role;
CREATE OR REPLACE FUNCTION public.limit_form_alert_reads(p_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE total integer;
BEGIN
  INSERT INTO public.form_alert_read_limit AS r(key,window_start,requests)
    VALUES(p_key,now(),1)
    ON CONFLICT(key) DO UPDATE SET
      window_start=CASE WHEN r.window_start<now()-interval '1 minute' THEN now() ELSE r.window_start END,
      requests=CASE WHEN r.window_start<now()-interval '1 minute' THEN 1 ELSE r.requests+1 END
    RETURNING requests INTO total;
  RETURN total<=60;
END $$;
REVOKE ALL ON FUNCTION public.limit_form_alert_reads(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.limit_form_alert_reads(text) TO service_role;
