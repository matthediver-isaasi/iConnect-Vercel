-- Picker scope validates relationship topology, not metadata stored on an
-- otherwise unchanged edge. Keep the deferred guard for inserts and every
-- scope-relevant structural change, while allowing relationship field values
-- and other edge metadata to be updated independently.
DROP TRIGGER IF EXISTS custom_object_picker_scope_v2_guard_trigger
  ON public.custom_object_relationship;
DROP TRIGGER IF EXISTS custom_object_picker_scope_v2_update_guard_trigger
  ON public.custom_object_relationship;

CREATE CONSTRAINT TRIGGER custom_object_picker_scope_v2_guard_trigger
AFTER INSERT ON public.custom_object_relationship
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.guard_custom_object_picker_scope_v2();

CREATE CONSTRAINT TRIGGER custom_object_picker_scope_v2_update_guard_trigger
AFTER UPDATE ON public.custom_object_relationship
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.id IS DISTINCT FROM NEW.id
  OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
  OR OLD.relationship_definition_id IS DISTINCT FROM NEW.relationship_definition_id
  OR OLD.source_record_id IS DISTINCT FROM NEW.source_record_id
  OR OLD.target_record_id IS DISTINCT FROM NEW.target_record_id
  OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
)
EXECUTE FUNCTION public.guard_custom_object_picker_scope_v2();