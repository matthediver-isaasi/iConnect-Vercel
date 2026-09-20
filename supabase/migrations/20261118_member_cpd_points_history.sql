-- Member-facing CPD balance and immutable award history.
CREATE OR REPLACE FUNCTION public.get_member_cpd_points_history(
  p_tenant_id uuid,
  p_member_id uuid,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_page integer:=GREATEST(COALESCE(p_page,1),1);
  v_page_size integer:=LEAST(GREATEST(COALESCE(p_page_size,20),1),100);
  v_total bigint;
  v_balance numeric(20,6);
  v_items jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.member
    WHERE id=p_member_id AND tenant_id=p_tenant_id
  ) THEN
    RETURN NULL;
  END IF;

  SELECT count(*),COALESCE(sum(points_value),0)
    INTO v_total,v_balance
  FROM public.member_cpd_points_ledger
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(history_row) ORDER BY history_row.sort_date DESC,history_row.id DESC),'[]'::jsonb)
    INTO v_items
  FROM (
    SELECT
      ledger.id,
      ledger.entry_kind,
      ledger.points_value,
      ledger.ticket_name_snapshot,
      ledger.award_trigger,
      ledger.evidence_type,
      ledger.reason,
      ledger.reversal_of,
      ledger.created_at,
      ledger.activity_date,
      ledger.activity_title,
      ledger.activity_description,
      COALESCE(
        ledger.activity_title,
        CASE ledger.booking_type
          WHEN 'booking' THEN (
            SELECT booking.event_name FROM public.booking
            WHERE booking.id=ledger.booking_id AND booking.tenant_id=ledger.tenant_id
          )
          WHEN 'complex_event_booking' THEN (
            SELECT complex_event_booking.event_name FROM public.complex_event_booking
            WHERE complex_event_booking.id=ledger.booking_id
              AND complex_event_booking.tenant_id=ledger.tenant_id
          )
        END,
        'Event'
      ) AS event_name,
      COALESCE(
        ledger.activity_date::timestamptz,
        CASE
          WHEN ledger.award_trigger='attendance' THEN
            COALESCE(
              NULLIF(ledger.evidence_snapshot->>'checkedInAt','')::timestamptz,
              NULLIF(ledger.evidence_snapshot->>'evidenceAt','')::timestamptz,
              NULLIF(ledger.evidence_snapshot->>'recordedAt','')::timestamptz
            )
        END,
        ledger.created_at
      ) AS evidence_date,
      COALESCE(ledger.activity_date::timestamptz,ledger.created_at) AS sort_date,
      EXISTS (
        SELECT 1 FROM public.member_cpd_points_ledger reversal
        WHERE reversal.reversal_of=ledger.id
          AND reversal.tenant_id=ledger.tenant_id
          AND reversal.member_id=ledger.member_id
      ) AS is_reversed
    FROM public.member_cpd_points_ledger ledger
    WHERE ledger.tenant_id=p_tenant_id AND ledger.member_id=p_member_id
    ORDER BY COALESCE(ledger.activity_date::timestamptz,ledger.created_at) DESC,ledger.id DESC
    OFFSET (v_page-1)*v_page_size
    LIMIT v_page_size
  ) history_row;

  RETURN jsonb_build_object(
    'balance',v_balance,
    'items',v_items,
    'page',v_page,
    'pageSize',v_page_size,
    'total',v_total
  );
END $$;

REVOKE ALL ON FUNCTION public.get_member_cpd_points_history(uuid,uuid,integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_member_cpd_points_history(uuid,uuid,integer,integer)
  TO service_role;