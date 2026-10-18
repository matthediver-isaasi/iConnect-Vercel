-- Opt-in only: no historical agreement/quote backfill or mutation.
BEGIN;
CREATE TABLE public.sales_agreement_envelope (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 quote_id uuid NOT NULL,
 quote_version_id uuid NOT NULL UNIQUE,
 sender_actor_id text NOT NULL,
 sender_actor_type text NOT NULL CHECK (sender_actor_type IN ('member','tenant_user')),
 sender jsonb NOT NULL,
 contact jsonb NOT NULL,
 sender_consent boolean NOT NULL CHECK (sender_consent IS TRUE),
 sender_evidence jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
 customer jsonb,
 customer_evidence jsonb,
 finalization_status text NOT NULL DEFAULT 'pending' CHECK (finalization_status IN ('pending','failed','complete')),
 finalization_error text,
 final_pdf_path text,
 final_pdf_hash text,
 finalized_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE RESTRICT,
 CHECK (jsonb_typeof(sender)='object' AND jsonb_typeof(contact)='object' AND jsonb_typeof(snapshot)='object'),
 CHECK (finalization_status <> 'complete' OR (customer IS NOT NULL AND final_pdf_path IS NOT NULL AND final_pdf_hash ~ '^[0-9a-f]{64}$' AND finalized_at IS NOT NULL))
);
CREATE TABLE public.sales_agreement_verification (
 token_id uuid PRIMARY KEY REFERENCES public.sales_quote_delivery_token(id) ON DELETE RESTRICT,
 code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 window_started_at timestamptz NOT NULL DEFAULT now(),
 sends integer NOT NULL DEFAULT 1,
 attempts integer NOT NULL DEFAULT 0,
 verified_at timestamptz,
 proof_hash text CHECK (proof_hash IS NULL OR proof_hash ~ '^[0-9a-f]{64}$'),
 CHECK (sends BETWEEN 1 AND 5 AND attempts BETWEEN 0 AND 5)
);
ALTER TABLE public.sales_agreement_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_agreement_verification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_agreement_envelope,public.sales_agreement_verification FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_agreement_envelope,public.sales_agreement_verification TO service_role;
CREATE POLICY sales_agreement_envelope_service ON public.sales_agreement_envelope TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_agreement_verification_service ON public.sales_agreement_verification TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.sales_agreement_signing_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 quote_id uuid NOT NULL,
 quote_version_id uuid NOT NULL,
 requester_actor_id text NOT NULL,
 requester_actor_type text NOT NULL CHECK (requester_actor_type IN ('member','tenant_user')),
 sender_actor_id text NOT NULL,
 sender_actor_type text NOT NULL CHECK (sender_actor_type IN ('member','tenant_user')),
 sender_name text NOT NULL,
 sender_email text NOT NULL,
 draft jsonb NOT NULL CHECK (jsonb_typeof(draft)='object'),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
 notification_status text NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending','sent','failed')),
 notified_at timestamptz,
 signed_at timestamptz,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX sales_agreement_request_version ON public.sales_agreement_signing_request(quote_version_id,created_at DESC);
ALTER TABLE public.sales_agreement_signing_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_agreement_signing_request FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_agreement_signing_request TO service_role;
CREATE POLICY sales_agreement_request_service ON public.sales_agreement_signing_request TO service_role USING(true) WITH CHECK(true);

CREATE TABLE public.sales_agreement_completion_notice (
 envelope_id uuid NOT NULL REFERENCES public.sales_agreement_envelope(id) ON DELETE RESTRICT,
 party text NOT NULL CHECK (party IN ('sender','customer')),
 recipient_email text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz,
 sent_at timestamptz,
 last_error text,
 PRIMARY KEY(envelope_id,party)
);
ALTER TABLE public.sales_agreement_completion_notice ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_agreement_completion_notice FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_agreement_completion_notice TO service_role;
CREATE POLICY sales_agreement_completion_service ON public.sales_agreement_completion_notice TO service_role USING(true) WITH CHECK(true);
CREATE FUNCTION public.claim_sales_agreement_completion_notice(p_envelope_id uuid,p_party text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.sales_agreement_envelope%ROWTYPE; n public.sales_agreement_completion_notice%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_party IS NULL OR p_party NOT IN ('sender','customer') THEN RAISE EXCEPTION 'Invalid party' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM public.sales_agreement_envelope WHERE id=p_envelope_id;
 IF e.id IS NULL OR e.finalization_status<>'complete' THEN RETURN NULL; END IF;
 INSERT INTO public.sales_agreement_completion_notice(envelope_id,party,recipient_email)
 VALUES(e.id,p_party,CASE WHEN p_party='sender' THEN e.sender->>'email' ELSE e.customer->>'email' END)
 ON CONFLICT(envelope_id,party) DO NOTHING;
 SELECT * INTO n FROM public.sales_agreement_completion_notice WHERE envelope_id=e.id AND party=p_party FOR UPDATE;
 IF n.status='sent' OR n.lease_until>now() THEN RETURN NULL; END IF;
 UPDATE public.sales_agreement_completion_notice SET status='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes',last_error=NULL
 WHERE envelope_id=e.id AND party=p_party RETURNING * INTO n;
 RETURN to_jsonb(n);
END $$;
REVOKE ALL ON FUNCTION public.claim_sales_agreement_completion_notice(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_agreement_completion_notice(uuid,text) TO service_role;

CREATE FUNCTION public.request_sales_agreement_signature(p_tenant_id uuid,p_quote_id uuid,p_version_id uuid,
 p_requester_id text,p_requester_type text,p_sender_id text,p_sender_type text,p_sender_name text,p_sender_email text,p_draft jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.sales_quote_version%ROWTYPE; r public.sales_agreement_signing_request%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant_id AND quote_id=p_quote_id AND id=p_version_id FOR UPDATE;
 IF v.id IS NULL OR v.status NOT IN ('issued','sent') OR v.valid_until<=now()
  OR length(btrim(COALESCE(v.terms_snapshot->>'legalHtml','')))=0
  OR NOT EXISTS(SELECT 1 FROM public.sales_quote WHERE id=p_quote_id AND current_version=v.version_number)
  OR EXISTS(SELECT 1 FROM public.sales_agreement_envelope WHERE quote_version_id=p_version_id)
  OR p_sender_id=p_requester_id AND p_sender_type=p_requester_type
 THEN RAISE EXCEPTION 'Current unsigned agreement and a colleague are required' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.sales_agreement_signing_request WHERE quote_version_id=v.id AND created_at>now()-interval '1 minute')
  OR (SELECT count(*) FROM public.sales_agreement_signing_request WHERE quote_version_id=v.id AND created_at>now()-interval '1 hour')>=5
 THEN RAISE EXCEPTION 'Signing request rate limit reached' USING ERRCODE='54000'; END IF;
 INSERT INTO public.sales_agreement_signing_request(tenant_id,quote_id,quote_version_id,requester_actor_id,requester_actor_type,
  sender_actor_id,sender_actor_type,sender_name,sender_email,draft,expires_at)
 VALUES(p_tenant_id,p_quote_id,p_version_id,p_requester_id,p_requester_type,p_sender_id,p_sender_type,p_sender_name,p_sender_email,p_draft,
  LEAST(now()+interval '7 days',COALESCE(v.valid_until,now()+interval '7 days'))) RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.mark_sales_agreement_requests_signed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.sales_agreement_signing_request SET status='signed',signed_at=now()
 WHERE quote_version_id=NEW.quote_version_id AND tenant_id=NEW.tenant_id
  AND sender_actor_id=NEW.sender_actor_id AND sender_actor_type=NEW.sender_actor_type AND status='pending';
 RETURN NEW;
END $$;
CREATE TRIGGER sales_agreement_requests_signed AFTER INSERT ON public.sales_agreement_envelope
 FOR EACH ROW EXECUTE FUNCTION public.mark_sales_agreement_requests_signed();
REVOKE ALL ON FUNCTION public.request_sales_agreement_signature(uuid,uuid,uuid,text,text,text,text,text,text,jsonb),
 public.mark_sales_agreement_requests_signed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_sales_agreement_signature(uuid,uuid,uuid,text,text,text,text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.guard_sales_agreement_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v public.sales_quote_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agreement evidence cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id FOR UPDATE;
   IF v.id IS NULL OR v.quote_id<>NEW.quote_id OR v.status NOT IN ('issued','sent')
     OR length(btrim(COALESCE(v.terms_snapshot->>'legalHtml','')))=0
     OR NOT EXISTS (SELECT 1 FROM public.sales_quote q WHERE q.id=v.quote_id AND q.current_version=v.version_number)
     OR NEW.snapshot->'version'->>'id' IS DISTINCT FROM v.id::text
     OR NEW.snapshot->'version'->'terms_snapshot' IS DISTINCT FROM v.terms_snapshot
   THEN RAISE EXCEPTION 'Agreement requires the current immutable issued quote' USING ERRCODE='23514'; END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['customer','customer_evidence','finalization_status','finalization_error','final_pdf_path','final_pdf_hash','finalized_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['customer','customer_evidence','finalization_status','finalization_error','final_pdf_path','final_pdf_hash','finalized_at']) THEN
   RAISE EXCEPTION 'Signed agreement snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.customer IS NOT NULL
    AND (NEW.customer IS DISTINCT FROM OLD.customer OR NEW.customer_evidence IS DISTINCT FROM OLD.customer_evidence) THEN
   RAISE EXCEPTION 'Customer signature evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.finalization_status='complete' AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Final agreement artifact is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_agreement_envelope_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.sales_agreement_envelope
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_agreement_envelope();

CREATE FUNCTION public.sales_agreement_otp(p_token_id uuid,p_action text,p_hash text,p_proof_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.sales_quote_delivery_token%ROWTYPE; o public.sales_agreement_verification%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_action IS NULL OR p_action NOT IN ('send','verify') THEN
   RAISE EXCEPTION 'invalid verification request' USING ERRCODE='22023';
 END IF;
 IF p_action='verify' AND (p_proof_hash IS NULL OR p_proof_hash !~ '^[0-9a-f]{64}$') THEN
   RAISE EXCEPTION 'verification session proof required' USING ERRCODE='22023';
 END IF;
 SELECT * INTO t FROM public.sales_quote_delivery_token WHERE id=p_token_id FOR UPDATE;
 IF t.id IS NULL OR t.activated_at IS NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=now()
 OR NOT EXISTS (SELECT 1 FROM public.sales_agreement_envelope e JOIN public.sales_quote_version v ON v.id=e.quote_version_id
   JOIN public.sales_quote q ON q.id=v.quote_id WHERE e.quote_version_id=t.quote_version_id
   AND e.tenant_id=t.tenant_id AND e.customer IS NULL AND v.status IN ('issued','sent')
   AND q.current_version=v.version_number AND lower(e.contact->>'email')=lower(t.recipient_email))
 THEN RETURN jsonb_build_object('ok',false,'error','Signing link is unavailable'); END IF;
 SELECT * INTO o FROM public.sales_agreement_verification WHERE token_id=t.id FOR UPDATE;
 IF p_action='send' THEN
   IF o.token_id IS NOT NULL AND (o.sent_at>now()-interval '1 minute'
     OR (o.window_started_at>now()-interval '1 hour' AND o.sends>=5)) THEN
     RETURN jsonb_build_object('ok',false,'error','Please wait before requesting another code');
   END IF;
   INSERT INTO public.sales_agreement_verification(token_id,code_hash,expires_at)
    VALUES(t.id,p_hash,now()+interval '10 minutes')
    ON CONFLICT (token_id) DO UPDATE SET code_hash=p_hash,expires_at=now()+interval '10 minutes',
     sent_at=now(),verified_at=NULL,proof_hash=NULL,attempts=0,
     sends=CASE WHEN sales_agreement_verification.window_started_at<=now()-interval '1 hour' THEN 1 ELSE sales_agreement_verification.sends+1 END,
     window_started_at=CASE WHEN sales_agreement_verification.window_started_at<=now()-interval '1 hour' THEN now() ELSE sales_agreement_verification.window_started_at END;
   RETURN jsonb_build_object('ok',true);
 END IF;
 IF o.token_id IS NULL OR o.expires_at<=now() OR o.attempts>=5 THEN
   RETURN jsonb_build_object('ok',false,'error','Code expired or attempt limit reached; request a new code');
 END IF;
 UPDATE public.sales_agreement_verification SET attempts=attempts+1,
   verified_at=CASE WHEN code_hash=p_hash THEN now() ELSE NULL END,
   proof_hash=CASE WHEN code_hash=p_hash THEN p_proof_hash ELSE NULL END WHERE token_id=t.id;
 RETURN jsonb_build_object('ok',o.code_hash=p_hash,'error',CASE WHEN o.code_hash<>p_hash THEN 'Incorrect verification code' END);
END $$;

-- Runs inside the existing exactly-once decision/sale transaction, before any
-- accepted status or allocation is committed. Legacy decisions are untouched.
CREATE FUNCTION public.capture_sales_agreement_customer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.sales_agreement_envelope%ROWTYPE; t public.sales_quote_delivery_token%ROWTYPE;
DECLARE evidence jsonb; signature jsonb;
BEGIN
 IF NEW.decision<>'accepted' OR NOT EXISTS (SELECT 1 FROM public.sales_quote_version v
   WHERE v.id=NEW.quote_version_id AND length(btrim(COALESCE(v.terms_snapshot->>'legalHtml','')))>0) THEN RETURN NEW; END IF;
 SELECT * INTO e FROM public.sales_agreement_envelope WHERE quote_version_id=NEW.quote_version_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 SELECT * INTO t FROM public.sales_quote_delivery_token WHERE id=NEW.token_id AND tenant_id=NEW.tenant_id;
 evidence:=NEW.request_metadata->'agreementEvidence'; signature:=evidence->'signature';
 IF e.id IS NULL OR e.customer IS NOT NULL OR t.id IS NULL OR lower(t.recipient_email) IS DISTINCT FROM lower(e.contact->>'email')
   OR evidence->'consent' IS DISTINCT FROM 'true'::jsonb OR NEW.agreement IS NOT TRUE
   OR signature->>'mode' IS NULL OR signature->>'mode' NOT IN ('typed','drawn','uploaded')
   OR signature->>'data' IS NULL OR length(signature->>'data')>700000
   OR signature->>'data' !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$'
   OR (signature->>'mode'='typed' AND length(btrim(COALESCE(signature->>'typedName',''))) NOT BETWEEN 1 AND 200)
   OR NOT EXISTS (SELECT 1 FROM public.sales_agreement_verification o WHERE o.token_id=t.id
     AND o.verified_at IS NOT NULL AND o.expires_at>now() AND o.attempts<=5
     AND o.proof_hash IS NOT NULL AND o.proof_hash=evidence->>'verificationProofHash')
 THEN RAISE EXCEPTION 'Verified recipient, signature and explicit consent are required' USING ERRCODE='22023'; END IF;
 UPDATE public.sales_agreement_envelope SET customer=jsonb_build_object(
   'name',NEW.customer_name,'role',NEW.customer_role,'email',t.recipient_email,
   'organization',COALESCE(snapshot->'version'->'organisation_snapshot'->>'name',''),
   'signature',signature,'signedAt',now()),
   customer_evidence=jsonb_build_object('tokenId',t.id,'consent',true,
     'consentText','I agree to this quotation and agreement and consent to sign electronically.',
     'documentHash',document_hash,'verifiedAt',(SELECT verified_at FROM public.sales_agreement_verification WHERE token_id=t.id),
     'signedAt',now(),'ip',NEW.request_metadata->>'ip','userAgent',NEW.request_metadata->>'userAgent')
 WHERE id=e.id;
 -- Keep the decision metadata small; signatures remain service-only.
 NEW.request_metadata:=NEW.request_metadata-'agreementEvidence';
 RETURN NEW;
END $$;
CREATE TRIGGER sales_agreement_capture_customer BEFORE INSERT ON public.sales_quote_customer_decision
 FOR EACH ROW EXECUTE FUNCTION public.capture_sales_agreement_customer();

CREATE FUNCTION public.guard_sales_agreement_acceptance() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status IN ('accepted','converted') AND NEW.status IS DISTINCT FROM OLD.status
 AND length(btrim(COALESCE(NEW.terms_snapshot->>'legalHtml','')))>0
 AND NOT EXISTS (SELECT 1 FROM public.sales_agreement_envelope WHERE quote_version_id=NEW.id AND customer IS NOT NULL)
 THEN RAISE EXCEPTION 'Agreement must be signed by the verified customer' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_agreement_acceptance_guard BEFORE UPDATE ON public.sales_quote_version
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_agreement_acceptance();
REVOKE ALL ON FUNCTION public.sales_agreement_otp(uuid,text,text,text),
 public.capture_sales_agreement_customer(),public.guard_sales_agreement_acceptance(),public.guard_sales_agreement_envelope()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_agreement_otp(uuid,text,text,text) TO service_role;

-- Private retained artifacts. No public/authenticated object policy is created.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('sales-agreements','sales-agreements',false,20971520,ARRAY['application/pdf'])
ON CONFLICT(id) DO NOTHING;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM storage.buckets WHERE id='sales-agreements' AND public IS TRUE) THEN
   RAISE EXCEPTION 'sales-agreements bucket already exists and is public; refusing unsafe rollout';
 END IF;
END $$;
-- Restrictive policy blocks broad pre-existing authenticated storage policies.
CREATE POLICY sales_agreements_private ON storage.objects AS RESTRICTIVE FOR ALL TO public
 USING (bucket_id <> 'sales-agreements' OR auth.role()='service_role')
 WITH CHECK (bucket_id <> 'sales-agreements' OR auth.role()='service_role');
COMMIT;
