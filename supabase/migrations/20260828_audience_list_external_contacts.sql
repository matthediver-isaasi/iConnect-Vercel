-- External contacts are deliberately separate from members and email subscribers.
-- The additional audience_list key allows the FK to enforce tenant ownership.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audience_list_id_tenant_id_key'
      AND conrelid = 'audience_list'::regclass
  ) THEN
    ALTER TABLE audience_list
      ADD CONSTRAINT audience_list_id_tenant_id_key UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE TABLE audience_list_external_contact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  audience_list_id UUID NOT NULL,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  addition_source TEXT NOT NULL
    CHECK (addition_source IN ('individual', 'csv_upload', 'pasted_rows')),
  gdpr_acknowledged BOOLEAN NOT NULL CHECK (gdpr_acknowledged IS TRUE),
  gdpr_acknowledged_at TIMESTAMPTZ NOT NULL,
  added_by_tenant_user_id UUID REFERENCES tenant_user(id) ON DELETE SET NULL,
  added_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  added_by_actor_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audience_list_external_contact_list_tenant_fk
    FOREIGN KEY (audience_list_id, tenant_id)
    REFERENCES audience_list(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT audience_list_external_contact_names_nonempty
    CHECK (btrim(first_name) <> '' AND btrim(last_name) <> ''),
  CONSTRAINT audience_list_external_contact_email_normalized
    CHECK (normalized_email = lower(btrim(email))),
  CONSTRAINT audience_list_external_contact_list_email_key
    UNIQUE (audience_list_id, normalized_email)
);

CREATE INDEX audience_list_external_contact_list_created_idx
  ON audience_list_external_contact (tenant_id, audience_list_id, created_at DESC);

ALTER TABLE audience_list_external_contact ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION prevent_external_contact_actor_label_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.added_by_actor_label IS DISTINCT FROM OLD.added_by_actor_label THEN
    RAISE EXCEPTION 'added_by_actor_label is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audience_list_external_contact_actor_label_immutable
BEFORE UPDATE OF added_by_actor_label ON audience_list_external_contact
FOR EACH ROW EXECUTE FUNCTION prevent_external_contact_actor_label_change();