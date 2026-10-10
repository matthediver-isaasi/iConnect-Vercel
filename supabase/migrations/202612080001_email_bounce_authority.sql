-- Address-scoped campaign suppression, independent of consent and member identity.
ALTER TABLE public.email_campaign_recipient
  ADD COLUMN IF NOT EXISTS delivery_outcome text,
  ADD COLUMN IF NOT EXISTS delivery_outcome_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_reason text;

CREATE TABLE public.email_address_bounce (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(btrim(email))),
  first_bounced_at timestamptz NOT NULL,
  last_bounced_at timestamptz NOT NULL,
  reason text,
  smtp_code integer,
  campaign_id uuid,
  resolved_at timestamptz,
  resolution_note text,
  UNIQUE(tenant_id,email)
);
CREATE TABLE public.email_bounce_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounce_id uuid NOT NULL REFERENCES public.email_address_bounce(id),
  tenant_id uuid NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  provider_domain text NOT NULL,
  provider_checked_at timestamptz NOT NULL,
  last_bounced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_address_bounce ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_bounce_resolution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_address_bounce,public.email_bounce_resolution FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.email_address_bounce TO service_role;
GRANT SELECT,INSERT ON public.email_bounce_resolution TO service_role;
CREATE INDEX email_address_bounce_report ON public.email_address_bounce(tenant_id,last_bounced_at DESC,id);

CREATE FUNCTION public.classify_email_delivery(p_type text,p_severity text,p_code integer,p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE
 WHEN p_type='delivered' THEN 'delivered'
 WHEN p_type NOT IN ('failed','bounced') THEN NULL
 WHEN p_severity='temporary' THEN 'soft_bounce'
 WHEN p_severity='permanent' AND
   (p_code BETWEEN 400 AND 499 OR lower(coalesce(p_reason,'')) ~ '(expired|retry.*exhaust|too.old)')
   THEN 'delivery_failed'
 WHEN p_severity='permanent' OR p_code BETWEEN 500 AND 599 THEN 'hard_bounce'
 WHEN p_code BETWEEN 400 AND 499 THEN 'soft_bounce'
 ELSE 'delivery_failed' END;
$$;

-- This guard also protects against older deployed webhook/sync code overwriting
-- successful delivery with a stale temporary failure, or clicks clearing a hard bounce.
CREATE FUNCTION public.guard_email_delivery_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status IN ('complained','unsubscribed','cancelled') THEN RETURN NEW; END IF;
 IF OLD.status IN ('complained','unsubscribed') THEN NEW.status:=OLD.status; RETURN NEW; END IF;
 CASE NEW.delivery_outcome
 WHEN 'hard_bounce' THEN NEW.status:='bounced'; NEW.bounced_at:=NEW.delivery_outcome_at; NEW.error_message:=NEW.delivery_reason;
 WHEN 'soft_bounce' THEN NEW.status:='sent'; NEW.bounced_at:=NULL; NEW.error_message:=NEW.delivery_reason;
 WHEN 'delivery_failed' THEN NEW.status:='failed'; NEW.bounced_at:=NULL; NEW.error_message:=NEW.delivery_reason;
 WHEN 'delivered' THEN
   NEW.status:=CASE WHEN NEW.clicked_at IS NOT NULL THEN 'clicked' WHEN NEW.opened_at IS NOT NULL THEN 'opened' ELSE 'delivered' END;
   NEW.delivered_at:=NEW.delivery_outcome_at; NEW.bounced_at:=NULL; NEW.error_message:=NULL;
 ELSE NULL;
 END CASE;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_email_delivery_status BEFORE UPDATE ON public.email_campaign_recipient
FOR EACH ROW EXECUTE FUNCTION public.guard_email_delivery_status();

CREATE FUNCTION public.record_email_delivery_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record; kind text; event_at timestamptz; detail text;
BEGIN
 kind:=public.classify_email_delivery(NEW.event_type,NEW.severity,NEW.delivery_status_code,NEW.reason);
 IF kind IS NULL OR NEW.recipient_id IS NULL OR NEW.mailgun_message_id IS NULL THEN RETURN NEW; END IF;
 -- Never trust the legacy email-only fallback: require the actual provider message.
 SELECT e.id,e.email,e.delivery_outcome_at,e.delivery_outcome,c.tenant_id,e.campaign_id
 INTO r FROM public.email_campaign_recipient e JOIN public.email_campaign c ON c.id=e.campaign_id
 WHERE e.id=NEW.recipient_id AND e.campaign_id=NEW.campaign_id
 AND trim(both '<>' from e.mailgun_message_id)=trim(both '<>' from NEW.mailgun_message_id)
 AND lower(btrim(e.email))=lower(btrim(NEW.email))
 AND c.tenant_id=NEW.tenant_id FOR UPDATE OF e;
 IF NOT FOUND THEN RETURN NEW; END IF;
 event_at:=NEW.event_timestamp;
 IF event_at IS NULL THEN RETURN NEW; END IF;
 detail:=left(coalesce(nullif(NEW.delivery_status_message,''),NEW.reason,'No provider reason supplied'),1000);
 IF kind='hard_bounce' THEN
   INSERT INTO public.email_address_bounce(tenant_id,email,first_bounced_at,last_bounced_at,reason,smtp_code,campaign_id)
   VALUES(r.tenant_id,lower(btrim(r.email)),event_at,event_at,detail,NEW.delivery_status_code,r.campaign_id)
   ON CONFLICT(tenant_id,email) DO UPDATE SET
     first_bounced_at=least(email_address_bounce.first_bounced_at,EXCLUDED.first_bounced_at),
     last_bounced_at=greatest(email_address_bounce.last_bounced_at,EXCLUDED.last_bounced_at),
     reason=CASE WHEN EXCLUDED.last_bounced_at>email_address_bounce.last_bounced_at THEN EXCLUDED.reason ELSE email_address_bounce.reason END,
     smtp_code=CASE WHEN EXCLUDED.last_bounced_at>email_address_bounce.last_bounced_at THEN EXCLUDED.smtp_code ELSE email_address_bounce.smtp_code END,
     campaign_id=CASE WHEN EXCLUDED.last_bounced_at>email_address_bounce.last_bounced_at THEN EXCLUDED.campaign_id ELSE email_address_bounce.campaign_id END,
     resolved_at=CASE WHEN EXCLUDED.last_bounced_at>email_address_bounce.last_bounced_at THEN NULL ELSE email_address_bounce.resolved_at END,
     resolution_note=CASE WHEN EXCLUDED.last_bounced_at>email_address_bounce.last_bounced_at THEN NULL ELSE email_address_bounce.resolution_note END;
 END IF;
 IF r.delivery_outcome_at IS NULL OR event_at>r.delivery_outcome_at OR
   (event_at=r.delivery_outcome_at AND kind='delivered' AND r.delivery_outcome='soft_bounce') THEN
   UPDATE public.email_campaign_recipient SET delivery_outcome=kind,delivery_outcome_at=event_at,delivery_reason=detail WHERE id=r.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_email_delivery_event AFTER INSERT ON public.email_event
FOR EACH ROW EXECUTE FUNCTION public.record_email_delivery_event();

-- Read-only provider check precedes this CAS. New failures during that check
-- invalidate resolution; the audit and state transition commit together.
CREATE FUNCTION public.resolve_email_address_bounce(p_tenant uuid,p_id uuid,p_last timestamptz,p_actor text,p_reason text,p_domain text,p_checked timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public.email_address_bounce;
BEGIN
 IF length(btrim(coalesce(p_reason,'')))<5 OR p_actor IS NULL OR p_domain IS NULL
 OR p_checked IS NULL OR p_checked<now()-interval '2 minutes' OR p_checked>now()+interval '10 seconds' THEN
 RAISE EXCEPTION 'Invalid resolution evidence'; END IF;
 SELECT * INTO b FROM public.email_address_bounce WHERE id=p_id AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR b.resolved_at IS NOT NULL OR b.last_bounced_at<>p_last THEN RETURN false; END IF;
 INSERT INTO public.email_bounce_resolution(bounce_id,tenant_id,actor_id,reason,provider_domain,provider_checked_at,last_bounced_at)
 VALUES(b.id,p_tenant,p_actor,p_reason,p_domain,p_checked,b.last_bounced_at);
 UPDATE public.email_address_bounce SET resolved_at=now(),resolution_note=p_reason WHERE id=b.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.classify_email_delivery(text,text,integer,text),
 public.guard_email_delivery_status(),public.record_email_delivery_event(),
 public.resolve_email_address_bounce(uuid,uuid,timestamptz,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.classify_email_delivery(text,text,integer,text),
 public.resolve_email_address_bounce(uuid,uuid,timestamptz,text,text,text,timestamptz) TO service_role;
