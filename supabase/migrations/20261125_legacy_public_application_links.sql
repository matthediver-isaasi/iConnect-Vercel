-- Deploy before the matching API code. Explicit, reviewed historical cohort
-- only: never infer this weaker access contract for new forms or other tenants.
BEGIN;
ALTER TABLE public.form_submission
  ADD COLUMN IF NOT EXISTS legacy_application_scope jsonb;

CREATE OR REPLACE FUNCTION public.keep_legacy_application_scope_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- current_user is the effective SQL execution role, not a forgeable JWT GUC.
  -- This is deliberately SECURITY INVOKER: SECURITY DEFINER would erase the
  -- untrusted caller identity. Existing INSERT grants/RLS do not confer scope.
  IF TG_OP = 'INSERT' THEN
    IF NEW.legacy_application_scope IS NOT NULL
      AND current_user NOT IN ('service_role', 'postgres') THEN
      RAISE EXCEPTION 'Only trusted application admission may create application link scope'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.legacy_application_scope IS DISTINCT FROM OLD.legacy_application_scope THEN
    RAISE EXCEPTION 'Application link scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS keep_legacy_application_scope_immutable ON public.form_submission;
CREATE TRIGGER keep_legacy_application_scope_immutable
  BEFORE INSERT OR UPDATE ON public.form_submission FOR EACH ROW
  EXECUTE FUNCTION public.keep_legacy_application_scope_immutable();

DO $cohort$
DECLARE updated_count integer;
BEGIN
UPDATE public.form
SET mutation_access_policy = '{"version":1,"mode":"legacy_public_application"}'::jsonb
WHERE tenant_id = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'
  AND id IN (
    'a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b',
    '57b94fc2-359d-434c-acd6-794865797ade',
    '568c559b-90fa-49b9-b7cb-016a75a31660',
    '83658f78-6610-4ece-a06f-5cad86f93d53',
    'a39e6441-d187-4bde-a15a-12c08bd1edbc',
    'c3eea1ef-e933-44c4-96e5-60d4a9368b7b',
    'edef4f0c-7a44-4ee8-b5df-642266298758'
  )
  AND require_authentication IS NOT TRUE
  AND prefill_source IN ('organization', 'member')
  AND (mutation_access_policy IS NULL
    OR mutation_access_policy->>'mode' IN ('applicant_continuation', 'legacy_public_application'));
GET DIAGNOSTICS updated_count = ROW_COUNT;
IF updated_count <> 7 THEN
  RAISE EXCEPTION 'Expected exactly 7 reviewed public prefill forms; found %', updated_count;
END IF;
END;
$cohort$;
COMMIT;