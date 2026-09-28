-- Durable Member AI operator controls and atomic allowance reservation.
CREATE TABLE IF NOT EXISTS member_ai_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  per_member_hourly_limit integer NOT NULL DEFAULT 20
    CHECK (per_member_hourly_limit BETWEEN 1 AND 500),
  tenant_monthly_limit integer NOT NULL DEFAULT 2000
    CHECK (tenant_monthly_limit BETWEEN 1 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_ai_usage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  lease_expires_at timestamptz,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  provider_request_id text
);
CREATE INDEX IF NOT EXISTS member_ai_usage_member_hour_idx
  ON member_ai_usage_event (tenant_id, member_id, created_at DESC)
  WHERE status IN ('reserved', 'succeeded');
CREATE INDEX IF NOT EXISTS member_ai_usage_tenant_month_idx
  ON member_ai_usage_event (tenant_id, created_at DESC)
  WHERE status IN ('reserved', 'succeeded');

CREATE OR REPLACE FUNCTION claim_member_ai_usage(
  p_tenant_id uuid,
  p_member_id uuid,
  p_request_hash text
) RETURNS TABLE (allowed boolean, usage_id uuid, code text, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  settings member_ai_settings%ROWTYPE;
  event_id uuid;
  member_used integer;
  tenant_used integer;
BEGIN
  -- Serialize claims per tenant. This prevents two simultaneous requests from
  -- both passing COUNT then exceeding a cap, while preserving tenant fairness.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 8417));
  UPDATE member_ai_usage_event SET status='failed', completed_at=now()
  WHERE tenant_id=p_tenant_id AND status='reserved'
    AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  INSERT INTO member_ai_settings (tenant_id) VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO settings FROM member_ai_settings
  WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT settings.enabled THEN
    RETURN QUERY SELECT false, NULL::uuid, 'MEMBER_AI_DISABLED',
      'The AI assistant is disabled for this organisation.';
    RETURN;
  END IF;
  SELECT count(*) INTO member_used FROM member_ai_usage_event
  WHERE tenant_id = p_tenant_id AND member_id = p_member_id
    AND status IN ('reserved', 'succeeded')
    AND created_at >= now() - interval '1 hour';
  IF member_used >= settings.per_member_hourly_limit THEN
    INSERT INTO member_ai_usage_event(tenant_id, member_id, request_hash, status)
    VALUES(p_tenant_id, p_member_id, p_request_hash, 'blocked');
    RETURN QUERY SELECT false, NULL::uuid, 'MEMBER_AI_RATE_LIMITED',
      'You have reached your hourly AI request limit. Please try again later.';
    RETURN;
  END IF;
  SELECT count(*) INTO tenant_used FROM member_ai_usage_event
  WHERE tenant_id = p_tenant_id AND status IN ('reserved', 'succeeded')
    AND created_at >= date_trunc('month', now());
  IF tenant_used >= settings.tenant_monthly_limit THEN
    INSERT INTO member_ai_usage_event(tenant_id, member_id, request_hash, status)
    VALUES(p_tenant_id, p_member_id, p_request_hash, 'blocked');
    RETURN QUERY SELECT false, NULL::uuid, 'MEMBER_AI_MONTHLY_LIMIT',
      'This organisation has reached its monthly AI request limit.';
    RETURN;
  END IF;
  INSERT INTO member_ai_usage_event(tenant_id, member_id, request_hash, status, lease_expires_at)
  VALUES(p_tenant_id, p_member_id, p_request_hash, 'reserved', now() + interval '2 minutes') RETURNING id INTO event_id;
  RETURN QUERY SELECT true, event_id, NULL::text, NULL::text;
END;
$$;
REVOKE ALL ON FUNCTION claim_member_ai_usage(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_member_ai_usage(uuid, uuid, text) TO service_role;