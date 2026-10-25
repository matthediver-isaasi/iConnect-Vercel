-- Opt-in job alerts. No backfill sends. All state is service-only.
BEGIN;
ALTER TABLE public.communication_category ADD COLUMN IF NOT EXISTS system_key text;
CREATE UNIQUE INDEX IF NOT EXISTS communication_category_system_key
  ON public.communication_category(tenant_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE public.job_alert_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  category_id uuid NOT NULL REFERENCES public.communication_category(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.job_alert_prompt (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  never_ask boolean NOT NULL DEFAULT false,
  ask_after timestamptz,
  PRIMARY KEY(tenant_id,member_id)
);
CREATE TABLE public.job_alert_publication (
  job_id uuid PRIMARY KEY REFERENCES public.job_posting(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
-- Existing jobs must never generate a retroactive alert, including reactivation.
INSERT INTO public.job_alert_publication(job_id,tenant_id)
  SELECT id,tenant_id FROM public.job_posting WHERE tenant_id IS NOT NULL AND status IN ('active','expired','closed');
CREATE TABLE public.job_alert_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.job_posting(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.communication_category(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','claimed','sending','sent','skipped','uncertain','failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE(job_id,member_id)
);
CREATE INDEX job_alert_delivery_pending ON public.job_alert_delivery(available_at,id)
  WHERE status IN ('pending','claimed','sending');
ALTER TABLE public.member_transactional_message ADD COLUMN IF NOT EXISTS job_alert_delivery_id uuid;
CREATE UNIQUE INDEX member_transactional_message_job_alert
  ON public.member_transactional_message(job_alert_delivery_id) WHERE job_alert_delivery_id IS NOT NULL;

CREATE FUNCTION public.configure_job_alerts(p_tenant_id uuid,p_enabled boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cat uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('job-alerts:'||p_tenant_id::text,0));
  PERFORM set_config('app.job_alert_configuration','true',true);
  INSERT INTO communication_category(tenant_id,name,description,is_active,is_public,member_enabled,display_order,system_key)
  VALUES(p_tenant_id,'Job postings','Email alerts for new job postings, including imported vacancies.',p_enabled,false,true,2147483647,'job_postings')
  ON CONFLICT(tenant_id,system_key) WHERE system_key IS NOT NULL
  DO UPDATE SET is_active=excluded.is_active RETURNING id INTO cat;
  INSERT INTO job_alert_settings(tenant_id,enabled,category_id) VALUES(p_tenant_id,p_enabled,cat)
  ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled,updated_at=now();
  IF NOT p_enabled THEN
    UPDATE job_alert_delivery SET status='skipped',last_error='Tenant disabled job alerts'
    WHERE tenant_id=p_tenant_id AND status IN ('pending','claimed');
  END IF;
  RETURN cat;
END $$;

CREATE FUNCTION public.protect_job_alert_category() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.system_key IS NOT NULL AND current_setting('app.job_alert_configuration',true) IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'System categories are managed by tenant settings'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.system_key='job_postings' THEN
    IF TG_OP='DELETE' OR current_setting('app.job_alert_configuration',true) IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'Job postings is a protected category; manage it in tenant settings'; END IF;
  ELSIF TG_OP='UPDATE' AND NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'System category identity cannot be changed';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_job_alert_category BEFORE INSERT OR UPDATE OR DELETE ON public.communication_category
FOR EACH ROW EXECUTE FUNCTION public.protect_job_alert_category();

CREATE FUNCTION public.guard_job_alert_subscription() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m jsonb; r jsonb; blocked boolean;
BEGIN
  IF NEW.is_subscribed IS DISTINCT FROM true OR NOT EXISTS(
    SELECT 1 FROM communication_category WHERE id=NEW.category_id AND system_key='job_postings'
  ) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM job_alert_settings WHERE tenant_id=NEW.tenant_id AND category_id=NEW.category_id AND enabled)
  THEN RAISE EXCEPTION 'Job alerts are disabled'; END IF;
  SELECT to_jsonb(member) INTO m FROM member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id;
  SELECT to_jsonb(role) INTO r FROM role WHERE id::text=m->>'role_id' AND tenant_id=NEW.tenant_id;
  IF m IS NULL OR r IS NULL OR m->>'login_enabled'='false' OR m->>'communications_opted_out_all'='true'
    OR m->>'membership_paused'='true'
  THEN RAISE EXCEPTION 'Member cannot subscribe to job alerts'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(r->'excluded_features')='array' THEN r->'excluded_features' ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof(m->'excluded_features')='array' THEN m->'excluded_features' ELSE '[]'::jsonb END
    ) f WHERE f IN ('jobs','jobs.job-board','page_JobBoard')
  ) INTO blocked;
  IF blocked THEN RAISE EXCEPTION 'Member has no Job Board access'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_job_alert_subscription BEFORE INSERT OR UPDATE ON public.member_communication_preference
FOR EACH ROW EXECUTE FUNCTION public.guard_job_alert_subscription();

CREATE FUNCTION public.protect_job_alert_roles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM communication_category WHERE id=NEW.category_id AND system_key='job_postings'))
    OR (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM communication_category WHERE id=OLD.category_id AND system_key='job_postings'))
  THEN RAISE EXCEPTION 'Job postings uses Job Board access, not category role overrides'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_job_alert_roles BEFORE INSERT OR UPDATE OR DELETE ON public.communication_category_role
FOR EACH ROW EXECUTE FUNCTION public.protect_job_alert_roles();

CREATE FUNCTION public.queue_job_alert_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cat uuid; inserted uuid;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.status IS DISTINCT FROM 'active' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='active' THEN RETURN NEW; END IF;
  INSERT INTO job_alert_publication(job_id,tenant_id) VALUES(NEW.id,NEW.tenant_id)
    ON CONFLICT DO NOTHING RETURNING job_id INTO inserted;
  IF inserted IS NULL THEN RETURN NEW; END IF;
  SELECT category_id INTO cat FROM job_alert_settings WHERE tenant_id=NEW.tenant_id AND enabled;
  IF cat IS NULL THEN RETURN NEW; END IF;
  INSERT INTO job_alert_delivery(tenant_id,job_id,member_id,category_id)
  SELECT NEW.tenant_id,NEW.id,m.id,cat
  FROM member_communication_preference p JOIN member m ON m.id=p.member_id AND m.tenant_id=p.tenant_id
  WHERE p.tenant_id=NEW.tenant_id AND p.category_id=cat AND p.is_subscribed=true
    AND m.communications_opted_out_all IS DISTINCT FROM true AND m.login_enabled IS DISTINCT FROM false
  ON CONFLICT(job_id,member_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_job_alert_publication AFTER INSERT OR UPDATE OF status ON public.job_posting
FOR EACH ROW EXECUTE FUNCTION public.queue_job_alert_publication();

CREATE FUNCTION public.claim_job_alert_delivery() RETURNS SETOF public.job_alert_delivery
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- An expired send can have reached Mailgun. Never automatically resend it.
  UPDATE job_alert_delivery SET status='uncertain',last_error='Delivery interrupted; reconcile provider evidence before retry'
    WHERE status='sending' AND lease_until<now();
  RETURN QUERY WITH candidate AS (
    SELECT id FROM job_alert_delivery
    WHERE (status='pending' AND available_at<=now()) OR (status='claimed' AND lease_until<now())
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE job_alert_delivery d SET status='claimed',lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    FROM candidate c WHERE d.id=c.id RETURNING d.*;
END $$;

CREATE FUNCTION public.finish_job_alert_delivery(p_id uuid,p_lease uuid,p_message_id text,p_email text,p_subject text,p_html text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d job_alert_delivery;
BEGIN
  SELECT * INTO d FROM job_alert_delivery WHERE id=p_id AND lease_id=p_lease FOR UPDATE;
  IF d.status='sent' THEN RETURN; END IF;
  IF d.id IS NULL OR d.status NOT IN ('sending','uncertain') THEN RAISE EXCEPTION 'Delivery lease is no longer valid'; END IF;
  INSERT INTO member_transactional_message(tenant_id,member_id,recipient_email,subject,body_html,communication_category_id,label_key,sent_at,job_alert_delivery_id)
  VALUES(d.tenant_id,d.member_id,p_email,p_subject,p_html,d.category_id,'jobs',now(),d.id)
  ON CONFLICT(job_alert_delivery_id) WHERE job_alert_delivery_id IS NOT NULL DO NOTHING;
  UPDATE job_alert_delivery SET status='sent',sent_at=now(),message_id=p_message_id,last_error=NULL WHERE id=d.id;
END $$;

ALTER TABLE public.job_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_alert_prompt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_alert_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_alert_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_alert_settings,public.job_alert_prompt,public.job_alert_publication,public.job_alert_delivery FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.job_alert_settings,public.job_alert_prompt,public.job_alert_publication,public.job_alert_delivery TO service_role;
REVOKE ALL ON FUNCTION public.configure_job_alerts(uuid,boolean),public.claim_job_alert_delivery(),public.finish_job_alert_delivery(uuid,uuid,text,text,text,text),public.queue_job_alert_publication(),public.protect_job_alert_category() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.guard_job_alert_subscription(),public.protect_job_alert_roles() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_job_alerts(uuid,boolean),public.claim_job_alert_delivery(),public.finish_job_alert_delivery(uuid,uuid,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
