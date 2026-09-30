-- Additive, definition-driven values stored on relationship edges.
ALTER TABLE public.custom_object_relationship
  ADD COLUMN IF NOT EXISTS field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.custom_object_relationship
  DROP CONSTRAINT IF EXISTS custom_object_relationship_field_values_object;

ALTER TABLE public.custom_object_relationship
  ADD CONSTRAINT custom_object_relationship_field_values_object
  CHECK (jsonb_typeof(field_values) = 'object');

-- Apply configured defaults for every generic edge creation path, including
-- atomic record creation and trusted form-processing paths that insert edges
-- directly rather than calling the interactive relationship service.
CREATE OR REPLACE FUNCTION public.apply_custom_object_relationship_field_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  configured_fields jsonb := '[]'::jsonb;
  configured_field jsonb;
  field_key text;
  field_type text;
  field_required boolean;
BEGIN
  SELECT COALESCE(
    definition.configuration->'relationship_fields',
    definition.configuration->'relationshipFields',
    '[]'::jsonb
  )
  INTO configured_fields
  FROM public.custom_object_relationship_definition definition
  WHERE definition.tenant_id = NEW.tenant_id
    AND definition.id = NEW.relationship_definition_id;

  NEW.field_values := COALESCE(NEW.field_values, '{}'::jsonb);
  IF jsonb_typeof(configured_fields) <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR configured_field IN SELECT value FROM jsonb_array_elements(configured_fields)
  LOOP
    field_key := configured_field->>'key';
    field_type := COALESCE(configured_field->>'type', configured_field->>'field_type');
    field_required := COALESCE(
      (configured_field->>'required')::boolean,
      (configured_field->>'is_required')::boolean,
      false
    );
    IF COALESCE(field_key, '') <> ''
       AND (
         configured_field ? 'default_value'
         OR configured_field ? 'defaultValue'
         OR configured_field ? 'default'
       )
       AND NOT NEW.field_values ? field_key THEN
      NEW.field_values := jsonb_set(
        NEW.field_values,
        ARRAY[field_key],
        COALESCE(
          configured_field->'default_value',
          configured_field->'defaultValue',
          configured_field->'default'
        ),
        true
      );
    END IF;
    IF COALESCE(field_key, '') <> ''
       AND field_required
       AND (
         NOT NEW.field_values ? field_key
         OR NEW.field_values->field_key = 'null'::jsonb
       ) THEN
      RAISE EXCEPTION 'Required relationship field % must have a value', field_key
        USING ERRCODE = '23514',
          CONSTRAINT = 'custom_object_relationship_field_required';
    END IF;
    IF COALESCE(field_key, '') <> ''
       AND field_type = 'boolean'
       AND NEW.field_values ? field_key
       AND jsonb_typeof(NEW.field_values->field_key) <> 'boolean' THEN
      RAISE EXCEPTION 'Relationship field % must be a boolean', field_key
        USING ERRCODE = '23514',
          CONSTRAINT = 'custom_object_relationship_field_type';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_relationship_field_defaults
  ON public.custom_object_relationship;
CREATE TRIGGER custom_object_relationship_field_defaults
BEFORE INSERT OR UPDATE OF field_values, relationship_definition_id, tenant_id
ON public.custom_object_relationship
FOR EACH ROW
EXECUTE FUNCTION public.apply_custom_object_relationship_field_defaults();