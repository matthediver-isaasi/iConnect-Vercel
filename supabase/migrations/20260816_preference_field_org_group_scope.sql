-- Allow entity_scope='organization_group' on preference field definitions (Task #3601)
-- Apply to the DEST database (production target).

ALTER TABLE preference_field
  DROP CONSTRAINT IF EXISTS preference_field_entity_scope_check;

ALTER TABLE preference_field
  ADD CONSTRAINT preference_field_entity_scope_check
  CHECK ((entity_scope)::text = ANY (ARRAY[
    'member'::text,
    'organization'::text,
    'organization_group'::text
  ]));
