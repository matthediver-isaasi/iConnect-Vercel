BEGIN;

CREATE TABLE IF NOT EXISTS public.accounting_membership_notification_delivery (
  request_id uuid NOT NULL REFERENCES public.accounting_request_queue(id),
  recipient text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sending','delivered','review')),
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  provider_message_id text,
  PRIMARY KEY(request_id,recipient)
);
CREATE TABLE IF NOT EXISTS public.accounting_membership_notification_note (
  request_id uuid PRIMARY KEY REFERENCES public.accounting_request_queue(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.accounting_membership_notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_membership_notification_note ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_membership_notification_delivery,
  public.accounting_membership_notification_note FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.accounting_membership_notification_delivery,
  public.accounting_membership_notification_note TO service_role;

-- Reuse the queue's active-worker fence. Notification calls cannot run for a
-- different operation/source or before the financial stages have completed.
CREATE OR REPLACE FUNCTION public.accounting_membership_notification_authority(
  p_request_id uuid,p_lease_token uuid
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q accounting_request_queue;
BEGIN
  SELECT * INTO q FROM accounting_request_queue WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND OR NOT accounting_request_guard(p_request_id,p_lease_token,NULL)
    OR q.source_type NOT IN ('member_membership_history','organisation_membership_history')
    OR q.operation <> 'invoice' OR q.invoice_status <> 'done' OR q.payment_status <> 'skipped'
    OR q.link_status <> 'writing'
    OR q.snapshot->'notification'->>'version' IS DISTINCT FROM '1'
    OR jsonb_typeof(q.snapshot->'notification'->'recipients') IS DISTINCT FROM 'array'
    OR jsonb_array_length(q.snapshot->'notification'->'recipients') NOT BETWEEN 1 AND 100
    OR nullif(q.snapshot->'notification'->>'note','') IS NULL
  THEN RAISE EXCEPTION 'Membership notification authority unavailable'; END IF;
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_membership_notification_claim(
  p_request_id uuid,p_lease_token uuid,p_recipient text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q accounting_request_queue; d accounting_membership_notification_delivery;
BEGIN
  q := accounting_membership_notification_authority(p_request_id,p_lease_token);
  IF p_recipient IS NULL OR NOT (q.snapshot->'notification'->'recipients' ? p_recipient)
    THEN RAISE EXCEPTION 'Recipient outside accepted notification'; END IF;
  INSERT INTO accounting_membership_notification_delivery(request_id,recipient,status)
    VALUES(p_request_id,p_recipient,'pending') ON CONFLICT DO NOTHING;
  SELECT * INTO d FROM accounting_membership_notification_delivery
    WHERE request_id=p_request_id AND recipient=p_recipient FOR UPDATE;
  IF d.status <> 'pending' THEN
    -- "sending" means an earlier process may have delivered it. A lease timeout
    -- is not evidence that the email was rejected. Never automatically resend.
    RETURN jsonb_build_object('claimed',false,'status',d.status);
  END IF;
  UPDATE accounting_membership_notification_delivery
    SET status='sending',token=gen_random_uuid(),updated_at=now()
    WHERE request_id=p_request_id AND recipient=p_recipient RETURNING * INTO d;
  RETURN jsonb_build_object('claimed',true,'status',d.status,'token',d.token);
END $$;

CREATE OR REPLACE FUNCTION public.accounting_membership_notification_receipts(
  p_request_id uuid,p_lease_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM accounting_membership_notification_authority(p_request_id,p_lease_token);
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('recipient',d.recipient,'status',d.status)),'[]'::jsonb)
    FROM accounting_membership_notification_delivery d WHERE d.request_id=p_request_id);
END $$;

CREATE OR REPLACE FUNCTION public.accounting_membership_notification_finish(
  p_request_id uuid,p_recipient text,p_token uuid,p_status text,p_message_id text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('pending','delivered','review') OR p_token IS NULL
    OR (p_status='delivered' AND nullif(p_message_id,'') IS NULL)
    THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
  -- Accept the original sender's confirmed outcome even after its queue lease
  -- expires, but only for this exact send token. No other sender can take over.
  UPDATE accounting_membership_notification_delivery
    SET status=p_status,updated_at=now(),
      delivered_at=CASE WHEN p_status='delivered' THEN now() ELSE NULL END,
      provider_message_id=CASE WHEN p_status='delivered' THEN p_message_id ELSE NULL END
    WHERE request_id=p_request_id AND recipient=p_recipient AND token=p_token AND status='sending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery claim lost'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_membership_notification_note(
  p_request_id uuid,p_lease_token uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q accounting_request_queue; n jsonb; content_text text; actor uuid; owner_id uuid;
BEGIN
  q := accounting_membership_notification_authority(p_request_id,p_lease_token);
  n := q.snapshot->'notification';
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(n->'recipients') r(email)
    WHERE NOT EXISTS (SELECT 1 FROM accounting_membership_notification_delivery d
      WHERE d.request_id=q.id AND d.recipient=r.email AND d.status='delivered')
  ) THEN RAISE EXCEPTION 'Membership notification delivery incomplete'; END IF;
  INSERT INTO accounting_membership_notification_note(request_id) VALUES(q.id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN true; END IF;
  owner_id := (q.snapshot->'linkage'->>'ownerId')::uuid;
  actor := nullif(n->>'createdBy','')::uuid;
  content_text := (n->>'note') || ' ' ||
    CASE WHEN q.provider='quickbooks' THEN 'QuickBooks' ELSE 'Xero' END ||
    ' invoice ' || coalesce(nullif(q.invoice_result->>'invoiceNumber',''),
      nullif(q.invoice_result->>'invoice_number',''),'(no invoice number)') ||
    ' created. Invoice notification sent to ' ||
    (SELECT string_agg(r.email,', ') FROM jsonb_array_elements_text(n->'recipients') r(email)) || '.';
  IF q.source_type='member_membership_history' THEN
    INSERT INTO member_note(target_member_id,author_member_id,content) VALUES(owner_id,actor,content_text);
  ELSE
    INSERT INTO organization_note(organization_id,member_id,content,attachments)
      VALUES(owner_id,actor,content_text,'[]'::jsonb);
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.accounting_membership_notification_authority(uuid,uuid),
  public.accounting_membership_notification_receipts(uuid,uuid),
  public.accounting_membership_notification_claim(uuid,uuid,text),
  public.accounting_membership_notification_finish(uuid,text,uuid,text,text),
  public.accounting_membership_notification_note(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_membership_notification_claim(uuid,uuid,text),
  public.accounting_membership_notification_receipts(uuid,uuid),
  public.accounting_membership_notification_finish(uuid,text,uuid,text,text),
  public.accounting_membership_notification_note(uuid,uuid) TO service_role;
COMMIT;
