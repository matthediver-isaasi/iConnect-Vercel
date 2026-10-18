BEGIN;

-- NULL means no submission evidence yet. Never derive a delivered recipient's
-- eligibility from the mutable campaign flag at read time.
ALTER TABLE public.email_campaign_recipient
  ADD COLUMN IF NOT EXISTS delivery_is_test boolean;

-- Historical evidence is limited to the flag at migration time. This cannot
-- recover flags edited before rollout. Do not infer mode from names/subjects.
-- Include ambiguous in-flight rows so old-worker reconciliation keeps evidence.
UPDATE public.email_campaign_recipient AS r
SET delivery_is_test = (c.is_test_mode IS TRUE)
FROM public.email_campaign AS c
WHERE c.id = r.campaign_id
  AND r.delivery_is_test IS NULL
  AND (r.sent_at IS NOT NULL OR r.mailgun_message_id IS NOT NULL OR r.status = 'processing');

CREATE OR REPLACE FUNCTION public.guard_campaign_delivery_mode()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.delivery_is_test IS NOT NULL
     AND NEW.delivery_is_test IS DISTINCT FROM OLD.delivery_is_test THEN
    RAISE EXCEPTION 'Campaign recipient delivery mode is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_campaign_delivery_mode() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS campaign_delivery_mode_immutable ON public.email_campaign_recipient;
CREATE TRIGGER campaign_delivery_mode_immutable
BEFORE UPDATE OF delivery_is_test ON public.email_campaign_recipient
FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_delivery_mode();

COMMENT ON COLUMN public.email_campaign_recipient.delivery_is_test IS
  'Immutable submission mode: true=Mailgun dry run, false=live, NULL=not yet recorded. Historical backfill uses campaign flag at migration time, not proven historical provider evidence.';

-- One eligibility relation for all campaign inbox reads, ownership checks and
-- unread aggregation. No NULL fallback: missing provenance fails closed.
-- Selecting r.* preserves PostgREST FK inference to email_campaign.
CREATE OR REPLACE VIEW public.campaign_inbox_recipient
WITH (security_invoker = true) AS
SELECT r.* FROM public.email_campaign_recipient AS r
WHERE r.sent_at IS NOT NULL AND r.delivery_is_test IS FALSE;
REVOKE ALL ON public.campaign_inbox_recipient FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.campaign_inbox_recipient TO service_role;

CREATE INDEX IF NOT EXISTS campaign_inbox_recipient_member_sent
ON public.email_campaign_recipient(member_id, sent_at DESC, id)
WHERE sent_at IS NOT NULL AND delivery_is_test IS FALSE;

-- A scoped anti-join counts stateless unread messages without subtracting
-- orphan, unsent, hidden-test, or other-tenant state rows. Return only one
-- aggregate row, even for members with more than PostgREST's row cap.
CREATE OR REPLACE FUNCTION public.campaign_inbox_unread_summary(p_tenant uuid, p_member uuid)
RETURNS TABLE(unread_count bigint, latest_subject text, latest_recipient_id uuid, latest_sent_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  WITH unread AS MATERIALIZED (
    SELECT r.id, r.sent_at, c.subject
    FROM public.campaign_inbox_recipient r
    JOIN public.email_campaign c ON c.id = r.campaign_id
    WHERE r.member_id = p_member AND c.tenant_id = p_tenant
      AND NOT EXISTS (
        SELECT 1 FROM public.member_inbox_message_state s
        WHERE s.recipient_id = r.id AND s.member_id = p_member AND s.tenant_id = p_tenant
          AND (s.is_read IS TRUE OR s.is_archived IS TRUE)
      )
  )
  SELECT (SELECT count(*) FROM unread), latest.subject, latest.id, latest.sent_at
  FROM (SELECT 1) seed
  LEFT JOIN LATERAL (
    SELECT subject, id, sent_at FROM unread ORDER BY sent_at DESC, id LIMIT 1
  ) latest ON true;
$$;
REVOKE ALL ON FUNCTION public.campaign_inbox_unread_summary(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_inbox_unread_summary(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
