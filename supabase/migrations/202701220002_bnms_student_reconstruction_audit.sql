BEGIN;
-- Exact, owner-reviewed corrections only. Runtime service credentials cannot
-- authorise a repair by inserting or editing audit evidence.
CREATE TABLE IF NOT EXISTS public.bnms_student_term_reconstruction_audit (
  history_id uuid PRIMARY KEY REFERENCES public.member_membership_history(id),
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL,
  before_record jsonb NOT NULL,
  after_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(before_record->>'term_key' IS NULL AND before_record->>'renewal_policy_snapshot' IS NULL),
  CHECK(after_record#>>'{term_source_snapshot,type}'='member_date_field'),
  CHECK(after_record->>'tenant_id'=tenant_id::text AND after_record->>'member_id'=member_id::text),
  CHECK(before_record->>'tenant_id'=tenant_id::text AND before_record->>'member_id'=member_id::text),
  CHECK(before_record->>'id'=history_id::text AND after_record->>'id'=history_id::text),
  CHECK((after_record->>'annual_cost')::numeric=0 AND (after_record->>'final_cost')::numeric=0
    AND (after_record->>'total_with_vat')::numeric=0)
);
ALTER TABLE public.bnms_student_term_reconstruction_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_student_term_reconstruction_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bnms_student_term_reconstruction_audit TO service_role;
DO $$
DECLARE definition text; needle text := 'RAISE EXCEPTION ''Purchased renewal policy is immutable'';';
BEGIN
  definition := pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure);
  IF position('-- bnms_student_exact_reconstruction_v1' in definition)=0 THEN
    IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
      RAISE EXCEPTION 'Unexpected renewal policy guard';
    END IF;
    definition := replace(definition,needle,'
      -- bnms_student_exact_reconstruction_v1
      IF NOT (TG_TABLE_NAME=''member_membership_history'' AND EXISTS(
        SELECT 1 FROM public.bnms_student_term_reconstruction_audit a
        WHERE a.history_id=OLD.id AND a.tenant_id=OLD.tenant_id
          AND a.member_id=(r->>''member_id'')::uuid
          AND a.before_record=to_jsonb(OLD) AND a.after_record=r
      )) THEN ' || needle || ' END IF;');
    EXECUTE definition;
  END IF;
END $$;
COMMIT;
