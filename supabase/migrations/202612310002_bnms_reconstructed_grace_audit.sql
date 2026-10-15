BEGIN;
CREATE TABLE IF NOT EXISTS public.bnms_reconstructed_grace_audit (
 history_id uuid PRIMARY KEY REFERENCES public.member_membership_history(id),
 before_record jsonb NOT NULL,
 after_record jsonb NOT NULL,
 authority text NOT NULL CHECK(length(authority)>20),
 applied_at timestamptz NOT NULL DEFAULT now(),
 CHECK(before_record->>'id'=history_id::text),
 CHECK(after_record->>'id'=history_id::text),
 CHECK(before_record->>'tenant_id'='ff2df806-b321-4254-b651-3af11fccf1db'),
 CHECK(before_record#>>'{commitment_snapshot,config,renewal_grace_days}'='0'),
 CHECK(after_record=jsonb_set(before_record,'{commitment_snapshot,config,renewal_grace_days}','90'::jsonb,false))
);
ALTER TABLE public.bnms_reconstructed_grace_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_reconstructed_grace_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bnms_reconstructed_grace_audit TO service_role;
CREATE OR REPLACE FUNCTION public.bnms_reconstructed_grace_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Approved grace repair evidence is immutable'; END $$;
DROP TRIGGER IF EXISTS bnms_reconstructed_grace_append_only ON public.bnms_reconstructed_grace_audit;
CREATE TRIGGER bnms_reconstructed_grace_append_only BEFORE UPDATE OR DELETE
ON public.bnms_reconstructed_grace_audit FOR EACH ROW EXECUTE FUNCTION public.bnms_reconstructed_grace_append_only();
REVOKE ALL ON FUNCTION public.bnms_reconstructed_grace_append_only() FROM PUBLIC,anon,authenticated,service_role;
-- Financial/term guard remains unchanged except this owner-approved, exact-row,
-- zero-to-90 reconstruction correction. No browser/service role can approve it.
DO $$
DECLARE definition text; marker text := E'BEGIN\n  c := CASE';
 injection text := $patch$BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='member_membership_history'
    AND to_jsonb(OLD)->>'tenant_id'='ff2df806-b321-4254-b651-3af11fccf1db'
    AND to_jsonb(OLD)->>'payment_method'='upfront'
    AND to_jsonb(OLD)->>'payment_status'='paid'
    AND to_jsonb(OLD)->>'billing_agreement_id' IS NULL
    AND to_jsonb(OLD)->>'membership_payment_quote_id' IS NULL
    AND to_jsonb(OLD)->>'membership_successor_election_id' IS NULL
    AND to_jsonb(OLD)->>'renewal_policy_snapshot' IS NULL
    AND to_jsonb(OLD)#>>'{commitment_snapshot,config,renewal_grace_days}'='0'
    AND to_jsonb(NEW)=jsonb_set(to_jsonb(OLD),'{commitment_snapshot,config,renewal_grace_days}','90'::jsonb,false)
  THEN
    IF EXISTS(SELECT 1 FROM public.bnms_reconstructed_grace_audit a
      WHERE a.history_id=(to_jsonb(OLD)->>'id')::uuid
      AND a.before_record=to_jsonb(OLD) AND a.after_record=to_jsonb(NEW))
    THEN RETURN NEW; END IF;
  END IF;
  c := CASE$patch$;
BEGIN
 SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO definition;
 IF position('public.bnms_reconstructed_grace_audit' IN definition)>0 THEN RETURN; END IF;
 IF position(marker IN definition)=0 OR
    length(definition)-length(replace(definition,marker,''))<>length(marker)
 THEN RAISE EXCEPTION 'Unexpected rolling guard layout; review before changing'; END IF;
 EXECUTE replace(definition,marker,injection);
END $$;
COMMIT;
