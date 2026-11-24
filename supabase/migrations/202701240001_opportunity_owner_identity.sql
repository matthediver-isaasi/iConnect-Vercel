-- Forward-only, schema-only patch. Never replay the pipeline migration on a
-- live database. The existing trigger attachments and all other checks remain.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.guard_opportunity_tenant_links()'::regprocedure);
  original text;
  replacement text;
  principal_field text;
BEGIN
  FOREACH principal_field IN ARRAY ARRAY['owner_id', 'principal_id'] LOOP
    original := format(
      '(SELECT 1 FROM tenant_user WHERE id=NEW.%s AND tenant_id=NEW.tenant_id)',
      principal_field);
    IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
      RAISE EXCEPTION 'Opportunity principal guard changed or migration already installed; inspect before proceeding';
    END IF;
    replacement := format(
      '(SELECT 1 FROM tenant_user WHERE id=NEW.%1$s AND tenant_id=NEW.tenant_id
       UNION ALL
       SELECT 1 FROM tenant_identity i JOIN tenant_membership m ON m.identity_id=i.id
       WHERE i.id=NEW.%1$s AND m.tenant_id=NEW.tenant_id AND m.status=''active''
         AND (m.role IN (''owner'',''admin'') OR m.membership_type=''owner''))',
      principal_field);
    definition := replace(definition, original, replacement);
  END LOOP;
  EXECUTE definition;
END
$migration$;
