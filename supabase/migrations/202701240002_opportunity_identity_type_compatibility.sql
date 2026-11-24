-- Forward correction: identity IDs are varchar in the live unified identity
-- schema, whereas opportunity principals are UUIDs. Compare their text forms;
-- never cast arbitrary identity data to UUID or broaden owner eligibility.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.guard_opportunity_tenant_links()'::regprocedure);
  original text;
  replacement text;
  principal_field text;
BEGIN
  FOREACH principal_field IN ARRAY ARRAY['owner_id', 'principal_id'] LOOP
    original := format('WHERE i.id=NEW.%s AND m.tenant_id=NEW.tenant_id', principal_field);
    IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
      RAISE EXCEPTION 'Opportunity identity guard changed or correction already installed; inspect before proceeding';
    END IF;
    replacement := format('WHERE i.id::text=NEW.%s::text AND m.tenant_id=NEW.tenant_id', principal_field);
    definition := replace(definition, original, replacement);
  END LOOP;
  EXECUTE definition;
END
$migration$;
