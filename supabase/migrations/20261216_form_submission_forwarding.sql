-- Explicit forwarding is independent of automatic-alert settings and retries.
CREATE TABLE public.form_submission_forward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  member_id uuid NOT NULL,
  recipient_name text NOT NULL,
  recipient_email text NOT NULL,
  actor text NOT NULL,
  idempotency_key uuid NOT NULL,
  message_html text NOT NULL DEFAULT '' CHECK (length(message_html) <= 50000),
  form_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  revoked_at timestamptz,
  revoked_by text,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  provider_id text,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id,form_id,submission_id)
    REFERENCES public.form_submission(tenant_id,form_id,id) ON DELETE CASCADE
);
CREATE INDEX form_submission_forward_history ON public.form_submission_forward(tenant_id,submission_id,created_at DESC,id);
ALTER TABLE public.form_submission_forward ENABLE ROW LEVEL SECURITY;
-- Hosted databases may automatically grant service_role ALL on new tables.
-- Reset those defaults before granting the narrow mutation contract.
REVOKE ALL ON public.form_submission_forward FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.form_submission_forward TO service_role;
GRANT UPDATE(status,sent_at,revoked_at,revoked_by,token_hash,provider_id) ON public.form_submission_forward TO service_role;

CREATE FUNCTION public.guard_form_submission_forward() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.member m WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id
    AND m.status='active' AND lower(trim(m.email))=lower(trim(NEW.recipient_email))) THEN
    RAISE EXCEPTION 'A matching active tenant member is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_form_submission_forward() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER form_submission_forward_member_guard BEFORE INSERT ON public.form_submission_forward
FOR EACH ROW EXECUTE FUNCTION public.guard_form_submission_forward();
NOTIFY pgrst,'reload schema';
