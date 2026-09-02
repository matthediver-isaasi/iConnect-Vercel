-- Reusable Canvas footer documents.
--
-- Footer documents deliberately do not use i_edit_page: they have no slug,
-- publication state, sitemap entry, or public-page URL.

CREATE TABLE IF NOT EXISTS canvas_footer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  design jsonb NOT NULL DEFAULT jsonb_build_object(
    'version', 1,
    'root', jsonb_build_object('background', NULL, 'sections', '[]'::jsonb)
  ),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canvas_footer_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT canvas_footer_design_check CHECK (
    jsonb_typeof(design) = 'object'
    AND jsonb_typeof(design->'root') = 'object'
    AND jsonb_typeof(design->'root'->'sections') = 'array'
  )
);

CREATE INDEX IF NOT EXISTS idx_canvas_footer_tenant_updated
  ON canvas_footer (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS canvas_footer_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  footer_id uuid NOT NULL REFERENCES canvas_footer(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  design jsonb NOT NULL,
  name text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_footer_version_footer_created
  ON canvas_footer_version (footer_id, created_at DESC);

ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS footer_source text NOT NULL DEFAULT 'configured',
  ADD COLUMN IF NOT EXISTS canvas_footer_id uuid;

ALTER TABLE microsite
  ADD COLUMN IF NOT EXISTS footer_source text NOT NULL DEFAULT 'configured',
  ADD COLUMN IF NOT EXISTS canvas_footer_id uuid;

ALTER TABLE tenant
  DROP CONSTRAINT IF EXISTS tenant_footer_source_check;
ALTER TABLE tenant
  ADD CONSTRAINT tenant_footer_source_check
  CHECK (footer_source IN ('configured', 'canvas'));

ALTER TABLE microsite
  DROP CONSTRAINT IF EXISTS microsite_footer_source_check;
ALTER TABLE microsite
  ADD CONSTRAINT microsite_footer_source_check
  CHECK (footer_source IN ('inherit', 'configured', 'canvas'));

-- A plain FK prevents dangling assignments. Tenant ownership is checked by
-- the triggers below because tenant.id is varchar in the legacy schema while
-- microsite.tenant_id is uuid in the microsite migration.
ALTER TABLE tenant
  DROP CONSTRAINT IF EXISTS tenant_canvas_footer_id_fkey;
ALTER TABLE tenant
  ADD CONSTRAINT tenant_canvas_footer_id_fkey
  FOREIGN KEY (canvas_footer_id) REFERENCES canvas_footer(id) ON DELETE RESTRICT;

ALTER TABLE microsite
  DROP CONSTRAINT IF EXISTS microsite_canvas_footer_id_fkey;
ALTER TABLE microsite
  ADD CONSTRAINT microsite_canvas_footer_id_fkey
  FOREIGN KEY (canvas_footer_id) REFERENCES canvas_footer(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION assert_canvas_footer_assignment_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  footer_tenant text;
  owner_tenant text;
BEGIN
  IF TG_TABLE_NAME = 'tenant' THEN
    owner_tenant := NEW.id::text;
  ELSE
    owner_tenant := NEW.tenant_id::text;
  END IF;
  IF NEW.canvas_footer_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT cf.tenant_id INTO footer_tenant
    FROM canvas_footer cf
    WHERE cf.id = NEW.canvas_footer_id;
  IF footer_tenant IS NULL OR footer_tenant <> owner_tenant THEN
    RAISE EXCEPTION 'Canvas footer belongs to a different tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_canvas_footer_tenant_guard ON tenant;
CREATE TRIGGER tenant_canvas_footer_tenant_guard
  BEFORE INSERT OR UPDATE OF id, canvas_footer_id ON tenant
  FOR EACH ROW EXECUTE FUNCTION assert_canvas_footer_assignment_tenant();

DROP TRIGGER IF EXISTS microsite_canvas_footer_tenant_guard ON microsite;
CREATE TRIGGER microsite_canvas_footer_tenant_guard
  BEFORE INSERT OR UPDATE OF tenant_id, canvas_footer_id ON microsite
  FOR EACH ROW EXECUTE FUNCTION assert_canvas_footer_assignment_tenant();

COMMENT ON TABLE canvas_footer IS
  'Tenant-scoped reusable Canvas footer documents; never exposed as public pages.';