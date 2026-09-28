-- Member AI public/anonymous budgets, global emergency control, and concurrent
-- request limits. This extends the member allowance schema additively.

ALTER TABLE member_ai_settings
  ADD COLUMN IF NOT EXISTS public_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS per_ip_hourly_limit integer NOT NULL DEFAULT 10
    CHECK (per_ip_hourly_limit BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS max_concurrent_requests integer NOT NULL DEFAULT 4
    CHECK (max_concurrent_requests BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS allowed_content_types text[] NOT NULL DEFAULT
    ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page'];

-- Reservations are leases, not permanent in-flight counters. A crashed worker
-- must not pin a tenant's concurrency cap forever. Token columns retain only
-- provider metering, never question text or answer content.
ALTER TABLE member_ai_usage_event
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_request_id text;

CREATE TABLE IF NOT EXISTS member_ai_platform_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT true,
  monthly_limit integer NOT NULL DEFAULT 1000000 CHECK (monthly_limit BETWEEN 1 AND 100000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO member_ai_platform_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS member_ai_public_usage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ip_hash text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE member_ai_public_usage_event
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_request_id text;
CREATE INDEX IF NOT EXISTS member_ai_public_usage_ip_hour_idx
  ON member_ai_public_usage_event (tenant_id, ip_hash, created_at DESC)
  WHERE status IN ('reserved', 'succeeded');
CREATE INDEX IF NOT EXISTS member_ai_public_usage_tenant_month_idx
  ON member_ai_public_usage_event (tenant_id, created_at DESC)
  WHERE status IN ('reserved', 'succeeded');

CREATE OR REPLACE FUNCTION claim_member_ai_usage(
  p_tenant_id uuid, p_member_id uuid, p_request_hash text
) RETURNS TABLE (allowed boolean, usage_id uuid, code text, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE settings member_ai_settings%ROWTYPE; platform member_ai_platform_settings%ROWTYPE;
  event_id uuid; member_used integer; tenant_used integer; platform_used integer; active_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('member-ai-platform', 8417));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 8417));
  UPDATE member_ai_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  UPDATE member_ai_public_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  SELECT * INTO platform FROM member_ai_platform_settings WHERE singleton FOR UPDATE;
  IF NOT platform.enabled THEN
    RETURN QUERY SELECT false, NULL::uuid, 'MEMBER_AI_PLATFORM_DISABLED', 'The AI assistant is temporarily unavailable.'; RETURN;
  END IF;
  INSERT INTO member_ai_settings (tenant_id) VALUES (p_tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO settings FROM member_ai_settings WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT settings.enabled THEN
    RETURN QUERY SELECT false, NULL::uuid, 'MEMBER_AI_DISABLED', 'The AI assistant is disabled for this organisation.'; RETURN;
  END IF;
  SELECT count(*) INTO member_used FROM member_ai_usage_event
    WHERE tenant_id = p_tenant_id AND member_id = p_member_id AND status IN ('reserved','succeeded')
    AND created_at >= now() - interval '1 hour';
  IF member_used >= settings.per_member_hourly_limit THEN
    INSERT INTO member_ai_usage_event(tenant_id,member_id,request_hash,status) VALUES(p_tenant_id,p_member_id,p_request_hash,'blocked');
    RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_RATE_LIMITED','You have reached your hourly AI request limit. Please try again later.'; RETURN;
  END IF;
  SELECT count(*) INTO active_count FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  SELECT active_count + count(*) INTO active_count FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  IF active_count >= settings.max_concurrent_requests THEN
    RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_BUSY','The AI assistant is busy. Please try again shortly.'; RETURN;
  END IF;
  SELECT count(*) INTO tenant_used FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT tenant_used + count(*) INTO tenant_used FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF tenant_used >= settings.tenant_monthly_limit THEN
    RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_MONTHLY_LIMIT','This organisation has reached its monthly AI request limit.'; RETURN;
  END IF;
  SELECT count(*) INTO platform_used FROM member_ai_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT platform_used + count(*) INTO platform_used FROM member_ai_public_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF platform_used >= platform.monthly_limit THEN
    RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PLATFORM_LIMIT','The AI assistant is temporarily unavailable.'; RETURN;
  END IF;
  INSERT INTO member_ai_usage_event(tenant_id,member_id,request_hash,status,lease_expires_at)
    VALUES(p_tenant_id,p_member_id,p_request_hash,'reserved',now()+interval '2 minutes') RETURNING id INTO event_id;
  RETURN QUERY SELECT true,event_id,NULL::text,NULL::text;
END; $$;

CREATE OR REPLACE FUNCTION claim_public_member_ai_usage(
  p_tenant_id uuid, p_ip_hash text, p_request_hash text
) RETURNS TABLE (allowed boolean, usage_id uuid, code text, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE settings member_ai_settings%ROWTYPE; platform member_ai_platform_settings%ROWTYPE;
  event_id uuid; ip_used integer; tenant_used integer; platform_used integer; active_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('member-ai-platform', 8417));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 8417));
  UPDATE member_ai_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  UPDATE member_ai_public_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  SELECT * INTO platform FROM member_ai_platform_settings WHERE singleton FOR UPDATE;
  IF NOT platform.enabled THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PLATFORM_DISABLED','The AI assistant is temporarily unavailable.'; RETURN; END IF;
  INSERT INTO member_ai_settings (tenant_id) VALUES (p_tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO settings FROM member_ai_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF NOT settings.enabled THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_DISABLED','The AI assistant is disabled for this organisation.'; RETURN; END IF;
  IF NOT settings.public_enabled THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PUBLIC_DISABLED','The public AI assistant is not available for this organisation.'; RETURN; END IF;
  SELECT count(*) INTO ip_used FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND ip_hash=p_ip_hash AND status IN ('reserved','succeeded') AND created_at >= now()-interval '1 hour';
  IF ip_used >= settings.per_ip_hourly_limit THEN
    INSERT INTO member_ai_public_usage_event(tenant_id,ip_hash,request_hash,status) VALUES(p_tenant_id,p_ip_hash,p_request_hash,'blocked');
    RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_IP_RATE_LIMITED','Too many requests. Please try again later.'; RETURN;
  END IF;
  SELECT count(*) INTO active_count FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  SELECT active_count + count(*) INTO active_count FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  IF active_count >= settings.max_concurrent_requests THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_BUSY','The AI assistant is busy. Please try again shortly.'; RETURN; END IF;
  SELECT count(*) INTO tenant_used FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT tenant_used + count(*) INTO tenant_used FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF tenant_used >= settings.tenant_monthly_limit THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_MONTHLY_LIMIT','This organisation has reached its monthly AI request limit.'; RETURN; END IF;
  SELECT count(*) INTO platform_used FROM member_ai_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT platform_used + count(*) INTO platform_used FROM member_ai_public_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF platform_used >= platform.monthly_limit THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PLATFORM_LIMIT','The AI assistant is temporarily unavailable.'; RETURN; END IF;
  INSERT INTO member_ai_public_usage_event(tenant_id,ip_hash,request_hash,status,lease_expires_at)
    VALUES(p_tenant_id,p_ip_hash,p_request_hash,'reserved',now()+interval '2 minutes') RETURNING id INTO event_id;
  RETURN QUERY SELECT true,event_id,NULL::text,NULL::text;
END; $$;

-- Admin previews have no member id, but are still charged to the same tenant
-- and platform monthly/concurrency budgets. The route has already verified the
-- active tenant-user session; the actor hash is only an audit/rate bucket.
CREATE OR REPLACE FUNCTION claim_admin_member_ai_usage(
  p_tenant_id uuid, p_actor_hash text, p_request_hash text
) RETURNS TABLE (allowed boolean, usage_id uuid, code text, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE settings member_ai_settings%ROWTYPE; platform member_ai_platform_settings%ROWTYPE;
  event_id uuid; tenant_used integer; platform_used integer; active_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('member-ai-platform', 8417));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 8417));
  UPDATE member_ai_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  UPDATE member_ai_public_usage_event SET status='failed', completed_at=now()
    WHERE tenant_id=p_tenant_id AND status='reserved'
      AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND created_at < now() - interval '2 minutes'));
  SELECT * INTO platform FROM member_ai_platform_settings WHERE singleton FOR UPDATE;
  IF NOT platform.enabled THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PLATFORM_DISABLED','The AI assistant is temporarily unavailable.'; RETURN; END IF;
  INSERT INTO member_ai_settings (tenant_id) VALUES (p_tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO settings FROM member_ai_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF NOT settings.enabled THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_DISABLED','The AI assistant is disabled for this organisation.'; RETURN; END IF;
  SELECT count(*) INTO active_count FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  SELECT active_count + count(*) INTO active_count FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status='reserved';
  IF active_count >= settings.max_concurrent_requests THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_BUSY','The AI assistant is busy. Please try again shortly.'; RETURN; END IF;
  SELECT count(*) INTO tenant_used FROM member_ai_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT tenant_used + count(*) INTO tenant_used FROM member_ai_public_usage_event WHERE tenant_id=p_tenant_id AND status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF tenant_used >= settings.tenant_monthly_limit THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_MONTHLY_LIMIT','This organisation has reached its monthly AI request limit.'; RETURN; END IF;
  SELECT count(*) INTO platform_used FROM member_ai_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  SELECT platform_used + count(*) INTO platform_used FROM member_ai_public_usage_event WHERE status IN ('reserved','succeeded') AND created_at >= date_trunc('month',now());
  IF platform_used >= platform.monthly_limit THEN RETURN QUERY SELECT false,NULL::uuid,'MEMBER_AI_PLATFORM_LIMIT','The AI assistant is temporarily unavailable.'; RETURN; END IF;
  INSERT INTO member_ai_public_usage_event(tenant_id,ip_hash,request_hash,status,lease_expires_at)
    VALUES(p_tenant_id,concat('admin:',left(p_actor_hash,96)),p_request_hash,'reserved',now()+interval '2 minutes') RETURNING id INTO event_id;
  RETURN QUERY SELECT true,event_id,NULL::text,NULL::text;
END; $$;

REVOKE ALL ON FUNCTION claim_member_ai_usage(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_public_member_ai_usage(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_admin_member_ai_usage(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_member_ai_usage(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION claim_public_member_ai_usage(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION claim_admin_member_ai_usage(uuid,text,text) TO service_role;