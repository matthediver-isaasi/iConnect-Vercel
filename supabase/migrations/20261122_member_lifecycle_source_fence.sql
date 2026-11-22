-- Prepared, not live. Source writes remain authoritative. Execution refuses
-- busy sources rather than waiting behind financial/provider transactions.
BEGIN;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_source (
  table_name text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.member_lifecycle_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_source FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_source TO service_role;
DROP POLICY IF EXISTS lifecycle_source_service_read ON public.member_lifecycle_source;
CREATE POLICY lifecycle_source_service_read ON public.member_lifecycle_source FOR SELECT TO service_role USING(true);
CREATE OR REPLACE FUNCTION public.member_lifecycle_source_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.member_lifecycle_source SET generation=generation+1 WHERE table_name=TG_TABLE_NAME;
  RETURN NULL;
END $$;
DO $$
DECLARE source text; relation regclass;
BEGIN
  FOREACH source IN ARRAY ARRAY[
    'member','organization','role','member_preference_value','preference_field','member_credentials','tenant_membership',
    'member_membership_history','organisation_membership_history',
    'membership_successor_election','membership_billing_agreements','membership_payment_plans',
    'member_membership_amendment','member_membership_amendment_application','member_membership_amendment_settlement',
    'member_cpd_points_ledger','member_cpd_ownership','member_cpd_merge',
    'member_lifecycle_login_evidence','member_lifecycle_record','member_lifecycle_policy',
    'historical_member_invoice','public_invoice_po_billing','booking_credit_attempt','unified_booking_invoice',
    'form_submission','form_cart_receipt','voucher','voucher_transaction',
    'booking','complex_event_booking','event','complex_event','complex_event_session',
    'complex_event_session_checkin','attendance_current_outcome','attendance_outcome_revision',
    'attendance_target','attendance_participant_match','attendance_participant_interval'
  ] LOOP
    relation:=to_regclass('public.'||quote_ident(source));
    IF relation IS NULL THEN RAISE EXCEPTION 'Lifecycle prerequisite table missing: %',source; END IF;
    INSERT INTO public.member_lifecycle_source(table_name) VALUES(source) ON CONFLICT DO NOTHING;
    EXECUTE format('DROP TRIGGER IF EXISTS member_lifecycle_source_changed ON %s',relation);
    EXECUTE format('CREATE TRIGGER member_lifecycle_source_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION public.member_lifecycle_source_changed()',relation);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_source_stamp()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT md5(
    (SELECT string_agg(table_name||':'||generation::text,',' ORDER BY table_name) FROM public.member_lifecycle_source)
    || ':' || (SELECT string_agg(s.table_name||':'||a.attname||':'||a.atttypid::text||':'||a.attnotnull::text,',' ORDER BY s.table_name,a.attnum)
      FROM public.member_lifecycle_source s
      JOIN pg_class c ON c.oid=to_regclass('public.'||quote_ident(s.table_name))
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))
$$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_lock_sources(p_stamp text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source record;
BEGIN
  -- READ COMMITTED is intentional: after all relation locks have been obtained,
  -- the next command sees every committed source writer. NOWAIT avoids blocking
  -- provider traffic and aborts this entire transition if any writer is active.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Lifecycle execution requires read committed source fencing' USING ERRCODE='PT409';
  END IF;
  FOR source IN SELECT table_name FROM public.member_lifecycle_source ORDER BY table_name LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE NOWAIT',source.table_name);
  END LOOP;
  IF p_stamp IS NULL OR public.member_lifecycle_source_stamp() IS DISTINCT FROM p_stamp THEN
    RAISE EXCEPTION 'Member evidence changed; reload before acting' USING ERRCODE='PT409';
  END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'Member evidence is being updated; retry after processing finishes' USING ERRCODE='PT409';
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_source_changed(),public.member_lifecycle_lock_sources(text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.member_lifecycle_source_stamp() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_source_stamp() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
