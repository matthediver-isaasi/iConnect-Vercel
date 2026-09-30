-- Task #4230: assignment-time badge grants use the existing grant ledger.
-- Make the cancellation state explicit for pending/granted rows removed during
-- reconciliation; historical effects and member_badge audit fields are kept.
ALTER TABLE public.speaker_award_grant
  DROP CONSTRAINT IF EXISTS speaker_award_grant_status_check;

ALTER TABLE public.speaker_award_grant
  ADD CONSTRAINT speaker_award_grant_status_check
  CHECK (status IN ('pending', 'granted', 'cancelled', 'skipped_excluded',
                    'skipped_no_member', 'skipped_no_award'));

-- Locks the first explicit post-save removal decision (keep vs revoke). This
-- prevents a later retry with different UI state from changing a keep decision.
ALTER TABLE public.speaker_award_grant
  ADD COLUMN IF NOT EXISTS removal_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removal_revoke_requested BOOLEAN;

-- Atomically settle one removed speaker.  This is intentionally SECURITY
-- DEFINER because API callers must not receive direct mutation rights to badge
-- provenance/audit fields.  The row lock makes first removal decision win and
-- a failure rolls back both the decision marker and any revocation.
CREATE OR REPLACE FUNCTION public.reconcile_removed_speaker_award_grant(
  p_tenant_id UUID, p_grant_id UUID, p_revoke BOOLEAN,
  p_actor_type TEXT, p_actor_id UUID, p_actor_label TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.speaker_award_grant%ROWTYPE;
  mb public.member_badge%ROWTYPE;
  has_entitlement BOOLEAN;
  did_revoke BOOLEAN := FALSE;
BEGIN
  SELECT * INTO g FROM public.speaker_award_grant
   WHERE id = p_grant_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'speaker award grant not found'; END IF;
  IF g.removal_reconciled_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_processed', 'revoked', FALSE,
      'revoke_requested', g.removal_revoke_requested);
  END IF;

  UPDATE public.speaker_award_grant
     SET status = 'cancelled',
         detail = CASE WHEN detail IS NULL THEN 'Speaker removed after assignment award'
                       ELSE detail || '; Speaker removed after assignment award' END
   WHERE id = g.id;

  IF p_revoke AND g.member_badge_id IS NOT NULL THEN
    SELECT * INTO mb FROM public.member_badge
      WHERE id = g.member_badge_id AND tenant_id = p_tenant_id
        AND revoked_at IS NULL FOR UPDATE;
    IF FOUND AND mb.source = 'speaker_award'
      AND mb.source_ref = g.event_type || ':' || g.event_id::text THEN
      -- Granted entries from another event count. A pending entry only counts
      -- where that event still actually references its speaker.
      SELECT EXISTS (
        SELECT 1 FROM public.speaker_award_grant x
        WHERE x.tenant_id = p_tenant_id AND x.member_id = g.member_id
          AND x.badge_id = g.badge_id AND x.id <> g.id
          AND (
            x.status = 'granted'
            OR (
              x.status = 'pending' AND x.member_badge_id IS NOT NULL
              AND CASE x.event_type
                WHEN 'event' THEN
                  EXISTS (
                    SELECT 1 FROM public.event e,
                      LATERAL jsonb_array_elements_text(COALESCE(e.speaker_ids, '[]'::jsonb)) ids(value)
                    WHERE e.id=x.event_id AND e.tenant_id=p_tenant_id
                      AND ids.value=x.speaker_id::text
                  )
                  OR EXISTS (
                    SELECT 1 FROM public.event_agenda_item a,
                      LATERAL jsonb_array_elements_text(COALESCE(a.speaker_ids, '[]'::jsonb)) ids(value)
                    WHERE a.event_id=x.event_id AND a.tenant_id=p_tenant_id
                      AND ids.value=x.speaker_id::text
                  )
                WHEN 'complex_event' THEN
                  EXISTS (
                    SELECT 1 FROM public.complex_event_session s,
                      LATERAL jsonb_array_elements_text(COALESCE(s.speaker_ids, '[]'::jsonb)) ids(value)
                    WHERE s.complex_event_id=x.event_id AND s.tenant_id=p_tenant_id
                      AND ids.value=x.speaker_id::text
                  )
                ELSE FALSE
              END
            )
          )
      ) INTO has_entitlement;
      IF NOT has_entitlement THEN
        UPDATE public.member_badge SET revoked_at = now(),
          revoked_by_type = COALESCE(p_actor_type, 'system'),
          revoked_by_id = p_actor_id,
          revoked_by_label = COALESCE(p_actor_label, 'Speaker assignment reconciliation')
        WHERE id = mb.id;
        did_revoke := TRUE;
      END IF;
    END IF;
  END IF;

  UPDATE public.speaker_award_grant SET removal_reconciled_at = now(),
    removal_revoke_requested = p_revoke WHERE id = g.id;
  RETURN jsonb_build_object('status', 'processed', 'revoked', did_revoke,
    'revoke_requested', p_revoke);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_removed_speaker_award_grant(UUID, UUID, BOOLEAN, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_removed_speaker_award_grant(UUID, UUID, BOOLEAN, TEXT, UUID, TEXT) TO service_role;

-- The inverse transition is also locked.  It is used when a speaker is added
-- back, and when a previously badge-only grant becomes voucher-eligible at
-- event start.  It may never resurrect an already-issued voucher.
CREATE OR REPLACE FUNCTION public.reactivate_speaker_award_grant(
  p_tenant_id UUID, p_grant_id UUID, p_member_id UUID, p_organization_id UUID,
  p_badge_id UUID, p_voucher_value NUMERIC, p_reset_badge BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.speaker_award_grant%ROWTYPE;
  retained_badge UUID;
BEGIN
  SELECT * INTO g FROM public.speaker_award_grant
   WHERE id=p_grant_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'speaker award grant not found'; END IF;
  IF g.status NOT IN ('cancelled', 'skipped_no_member', 'skipped_no_award', 'skipped_excluded')
     AND NOT (g.status = 'granted' AND g.voucher_id IS NULL AND p_voucher_value IS NOT NULL) THEN
    RETURN to_jsonb(g);
  END IF;

  retained_badge := NULL;
  IF g.member_badge_id IS NOT NULL THEN
    SELECT id INTO retained_badge FROM public.member_badge
     WHERE id=g.member_badge_id AND tenant_id=p_tenant_id AND revoked_at IS NULL
       AND member_id=p_member_id AND badge_id=p_badge_id;
  END IF;

  UPDATE public.speaker_award_grant SET
    status='pending', member_id=p_member_id,
    badge_id=p_badge_id,
    voucher_value=CASE WHEN g.voucher_id IS NOT NULL THEN g.voucher_value ELSE p_voucher_value END,
    organization_id=CASE WHEN g.voucher_id IS NOT NULL THEN g.organization_id ELSE p_organization_id END,
    member_badge_id=retained_badge,
    removal_reconciled_at=NULL, removal_revoke_requested=NULL,
    detail=CASE WHEN status='cancelled' THEN COALESCE(detail || '; ', '') || 'Speaker re-added' ELSE detail END
  WHERE id=g.id
  RETURNING * INTO g;
  RETURN to_jsonb(g);
END;
$$;

REVOKE ALL ON FUNCTION public.reactivate_speaker_award_grant(UUID, UUID, UUID, UUID, UUID, NUMERIC, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reactivate_speaker_award_grant(UUID, UUID, UUID, UUID, UUID, NUMERIC, BOOLEAN) TO service_role;