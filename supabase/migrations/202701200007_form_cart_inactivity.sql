-- Deploy the matching checkout activity client/server before applying.
BEGIN;
ALTER TABLE public.form_cart_receipt ADD COLUMN cleanup_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.guard_form_cart_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cart evidence cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','release_evidence','finalized_at','next_check_at','last_error','cleanup_started_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','release_evidence','finalized_at','next_check_at','last_error','cleanup_started_at'])
    OR OLD.state<>'held' THEN
    RAISE EXCEPTION 'Cart receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.start_form_cart_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.form_submission s WHERE s.id=NEW.submission_id
    AND s.tenant_id=NEW.tenant_id AND s.payment_provider='stripe') THEN
    NEW.next_check_at := now()+interval '5 minutes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_cart_activity_start BEFORE INSERT ON public.form_cart_receipt
FOR EACH ROW EXECUTE FUNCTION public.start_form_cart_activity();

CREATE FUNCTION public.check_failed_form_cart() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.payment_provider='stripe' AND NEW.payment_status='failed'
    AND OLD.payment_status IS DISTINCT FROM 'failed' THEN
    UPDATE public.form_cart_receipt SET next_check_at=now()
      WHERE tenant_id=NEW.tenant_id AND submission_id=NEW.id AND state='held';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_failed_form_cart AFTER UPDATE ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.check_failed_form_cart();

-- Lock order matches finalization: submission, then receipt.
CREATE FUNCTION public.touch_form_cart_activity(p_tenant_id uuid,p_submission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.form_submission; changed uuid;
BEGIN
  SELECT * INTO s FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  IF NOT FOUND OR s.payment_provider IS DISTINCT FROM 'stripe'
    OR s.payment_status='paid' THEN RETURN false; END IF;
  UPDATE public.form_cart_receipt SET next_check_at=now()+interval '5 minutes'
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held'
      AND cleanup_started_at IS NULL AND next_check_at>now() RETURNING id INTO changed;
  RETURN changed IS NOT NULL;
END;
$$;
CREATE FUNCTION public.claim_form_cart_cleanup(p_tenant_id uuid,p_submission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE changed uuid;
BEGIN
  PERFORM 1 FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  UPDATE public.form_cart_receipt SET cleanup_started_at=now(),next_check_at=now()+interval '1 minute'
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held'
      AND next_check_at<=now() RETURNING id INTO changed;
  RETURN changed IS NOT NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.defer_form_cart_check(p_tenant_id uuid,p_submission_id uuid,p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.form_cart_receipt SET next_check_at=now()+interval '1 minute',last_error=left(p_error,500)
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held';
END;
$$;
-- Existing unfinished Stripe orders get a fresh grace window at rollout.
UPDATE public.form_cart_receipt r SET next_check_at=now()+interval '5 minutes'
FROM public.form_submission s WHERE s.id=r.submission_id AND s.tenant_id=r.tenant_id
  AND r.state='held' AND s.payment_provider='stripe' AND s.payment_status IS DISTINCT FROM 'paid';
REVOKE ALL ON FUNCTION public.check_failed_form_cart(),public.start_form_cart_activity(),public.touch_form_cart_activity(uuid,uuid),
  public.claim_form_cart_cleanup(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.touch_form_cart_activity(uuid,uuid),
  public.claim_form_cart_cleanup(uuid,uuid) TO service_role;
COMMIT;
