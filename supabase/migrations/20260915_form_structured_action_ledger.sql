CREATE TABLE IF NOT EXISTS public.form_submission_structured_action (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.form_submission(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  row_identity text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  -- Reserved before the application write. Create actions use this UUID for
  -- the target row, so a lease takeover after a crash can recover the same
  -- insert instead of creating a duplicate.
  record_id uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, submission_id, action_id, row_identity)
);

DROP FUNCTION IF EXISTS public.claim_form_structured_action(uuid, uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.claim_form_structured_action(
  p_tenant_id uuid, p_submission_id uuid, p_action_id text, p_row_identity text, p_fingerprint text
) RETURNS TABLE(status text, record_id uuid, claimed boolean, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.form_submission_structured_action;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.form_submission
    WHERE id = p_submission_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Structured action submission does not belong to tenant';
  END IF;

  INSERT INTO form_submission_structured_action(tenant_id, submission_id, action_id, row_identity, request_fingerprint)
  VALUES (p_tenant_id, p_submission_id, p_action_id, p_row_identity, p_fingerprint)
  ON CONFLICT (tenant_id, submission_id, action_id, row_identity) DO NOTHING
  RETURNING * INTO v;
  IF FOUND THEN RETURN QUERY SELECT v.status, v.record_id, true, v.claim_token; RETURN; END IF;
  SELECT * INTO v FROM form_submission_structured_action
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND action_id=p_action_id AND row_identity=p_row_identity FOR UPDATE;
  IF v.request_fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'Structured action request fingerprint drift'; END IF;
  IF v.status = 'failed'
     OR (v.status = 'running' AND v.updated_at < now() - interval '15 minutes') THEN
    UPDATE form_submission_structured_action
    SET status='running', claim_token=gen_random_uuid(), updated_at=now()
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND action_id=p_action_id AND row_identity=p_row_identity;
    SELECT * INTO v FROM form_submission_structured_action
      WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND action_id=p_action_id AND row_identity=p_row_identity;
    RETURN QUERY SELECT 'running'::text, v.record_id, true, v.claim_token;
  ELSE
    RETURN QUERY SELECT v.status, v.record_id, false, v.claim_token;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.finalize_form_structured_action(uuid, uuid, text, text, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.finalize_form_structured_action(uuid, uuid, text, text, text, uuid, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.finalize_form_structured_action(
  p_tenant_id uuid, p_submission_id uuid, p_action_id text, p_row_identity text,
  p_status text, p_record_id uuid, p_outcome jsonb, p_claim_token uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid structured action final status';
  END IF;
  UPDATE form_submission_structured_action
  SET status = p_status,
      record_id = COALESCE(p_record_id, record_id),
      outcome = p_outcome,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND submission_id = p_submission_id
    AND action_id = p_action_id
    AND row_identity = p_row_identity
    AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Structured action claim is no longer current';
  END IF;
END
$$;

REVOKE ALL ON TABLE public.form_submission_structured_action FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_form_structured_action(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_form_structured_action(uuid, uuid, text, text, text, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_submission_structured_action TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_form_structured_action(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_form_structured_action(uuid, uuid, text, text, text, uuid, jsonb, uuid) TO service_role;