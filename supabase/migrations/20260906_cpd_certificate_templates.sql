-- Tenant-owned CPD certificate PDF templates.
CREATE TABLE IF NOT EXISTS cpd_certificate_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved', 'active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  review_requested_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  review_note TEXT,
  source_bucket TEXT CHECK (source_bucket IS NULL OR source_bucket = 'private-uploads'),
  source_path TEXT,
  source_filename TEXT,
  source_mime_type TEXT,
  source_size_bytes BIGINT CHECK (source_size_bytes IS NULL OR source_size_bytes > 0),
  source_sha256 TEXT,
  source_page_count INTEGER CHECK (source_page_count IS NULL OR source_page_count > 0),
  source_geometry JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  updated_by TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cpd_certificate_template_source_complete CHECK (
    (source_path IS NULL AND source_bucket IS NULL AND source_filename IS NULL
      AND source_mime_type IS NULL AND source_size_bytes IS NULL
      AND source_sha256 IS NULL AND source_page_count IS NULL)
    OR
    (source_path IS NOT NULL AND source_bucket = 'private-uploads'
      AND source_filename IS NOT NULL AND source_mime_type = 'application/pdf'
      AND source_size_bytes IS NOT NULL AND source_sha256 IS NOT NULL
      AND source_page_count IS NOT NULL)
  ),
  CONSTRAINT cpd_certificate_template_active_source CHECK (
    status <> 'active' OR source_path IS NOT NULL
  ),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS cpd_certificate_placeholder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES cpd_certificate_template(id) ON DELETE CASCADE,
  CONSTRAINT cpd_certificate_placeholder_tenant_template_fk
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES cpd_certificate_template(tenant_id, id) ON DELETE CASCADE,
  placeholder_key TEXT NOT NULL,
  label TEXT,
  field_type TEXT NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text', 'date', 'number')),
  sample_value TEXT,
  default_value TEXT,
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  multiline BOOLEAN NOT NULL DEFAULT false,
  shrink_to_fit BOOLEAN NOT NULL DEFAULT true,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  x NUMERIC NOT NULL CHECK (x >= 0),
  y NUMERIC NOT NULL CHECK (y >= 0),
  width NUMERIC NOT NULL CHECK (width > 0),
  height NUMERIC NOT NULL CHECK (height > 0),
  font_family TEXT NOT NULL DEFAULT 'Helvetica'
    CHECK (font_family IN ('Helvetica', 'Times', 'Courier')),
  font_size NUMERIC NOT NULL DEFAULT 12 CHECK (font_size >= 4 AND font_size <= 144),
  font_style TEXT NOT NULL DEFAULT 'normal'
    CHECK (font_style IN ('normal', 'bold', 'italic', 'bolditalic')),
  alignment TEXT NOT NULL DEFAULT 'left'
    CHECK (alignment IN ('left', 'center', 'right')),
  color TEXT NOT NULL DEFAULT '#000000' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  line_height NUMERIC NOT NULL DEFAULT 1.2 CHECK (line_height >= 0.8 AND line_height <= 3),
  minimum_font_size NUMERIC NOT NULL DEFAULT 4 CHECK (minimum_font_size >= 4 AND minimum_font_size <= 144),
  vertical_align TEXT NOT NULL DEFAULT 'middle'
    CHECK (vertical_align IN ('top', 'middle', 'bottom')),
  overflow_policy TEXT NOT NULL DEFAULT 'shrink'
    CHECK (overflow_policy IN ('shrink', 'wrap', 'clip')),
  missing_policy TEXT NOT NULL DEFAULT 'blank'
    CHECK (missing_policy IN ('blank', 'error', 'literal')),
  format TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cpd_certificate_template_tenant_status
  ON cpd_certificate_template(tenant_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cpd_certificate_template_tenant_name_live
  ON cpd_certificate_template(tenant_id, lower(name)) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_cpd_certificate_placeholder_template_page
  ON cpd_certificate_placeholder(tenant_id, template_id, page_number, display_order);
CREATE INDEX IF NOT EXISTS idx_cpd_certificate_placeholder_template_key
  ON cpd_certificate_placeholder(template_id, placeholder_key);

CREATE OR REPLACE FUNCTION enforce_cpd_placeholder_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cpd_certificate_template t
    WHERE t.id = NEW.template_id AND t.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'placeholder tenant does not own template';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cpd_placeholder_tenant ON cpd_certificate_placeholder;
CREATE TRIGGER trg_cpd_placeholder_tenant BEFORE INSERT OR UPDATE
  ON cpd_certificate_placeholder FOR EACH ROW EXECUTE FUNCTION enforce_cpd_placeholder_tenant();

-- Atomically claims the optimistic version and replaces the entire designer
-- layout so renders can never observe a parent update with an empty/partial
-- child set. Authorization remains at the API boundary; this RPC is service-only.
CREATE OR REPLACE FUNCTION save_cpd_certificate_template(
  p_template_id UUID,
  p_tenant_id UUID,
  p_expected_version INTEGER,
  p_name TEXT,
  p_description TEXT,
  p_placeholders JSONB,
  p_actor TEXT
)
RETURNS cpd_certificate_template
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved cpd_certificate_template;
BEGIN
  UPDATE cpd_certificate_template AS template
  SET name = p_name,
      description = p_description,
      status = CASE WHEN template.status IN ('approved', 'in_review') THEN 'draft' ELSE template.status END,
      version = template.version + 1,
      updated_at = now(),
      updated_by = p_actor
  WHERE template.id = p_template_id
    AND template.tenant_id = p_tenant_id
    AND template.version = p_expected_version
    AND template.status <> 'active'
  RETURNING template.* INTO saved;

  IF saved.id IS NULL THEN
    RAISE EXCEPTION 'cpd_template_conflict' USING ERRCODE = '40001';
  END IF;

  DELETE FROM cpd_certificate_placeholder
  WHERE template_id = p_template_id AND tenant_id = p_tenant_id;

  INSERT INTO cpd_certificate_placeholder (
    tenant_id, template_id, placeholder_key, label, field_type,
    sample_value, default_value, display_order, multiline, shrink_to_fit,
    page_number, x, y, width, height, font_family, font_size, font_style,
    alignment, color, line_height, minimum_font_size, vertical_align,
    overflow_policy, missing_policy, format
  )
  SELECT
    p_tenant_id, p_template_id, field.placeholder_key, field.label, field.field_type,
    field.sample_value, field.default_value, field.display_order, field.multiline, field.shrink_to_fit,
    field.page_number, field.x, field.y, field.width, field.height,
    field.font_family, field.font_size, field.font_style, field.alignment,
    field.color, field.line_height, field.minimum_font_size, field.vertical_align,
    field.overflow_policy, field.missing_policy, field.format
  FROM jsonb_to_recordset(COALESCE(p_placeholders, '[]'::jsonb)) AS field(
    placeholder_key TEXT,
    label TEXT,
    field_type TEXT,
    sample_value TEXT,
    default_value TEXT,
    display_order INTEGER,
    multiline BOOLEAN,
    shrink_to_fit BOOLEAN,
    page_number INTEGER,
    x NUMERIC,
    y NUMERIC,
    width NUMERIC,
    height NUMERIC,
    font_family TEXT,
    font_size NUMERIC,
    font_style TEXT,
    alignment TEXT,
    color TEXT,
    line_height NUMERIC,
    minimum_font_size NUMERIC,
    vertical_align TEXT,
    overflow_policy TEXT,
    missing_policy TEXT,
    format TEXT
  );

  RETURN saved;
END;
$$;

REVOKE ALL ON FUNCTION save_cpd_certificate_template(UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION save_cpd_certificate_template(UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION save_cpd_certificate_template(UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT) TO service_role;

ALTER TABLE cpd_certificate_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpd_certificate_placeholder ENABLE ROW LEVEL SECURITY;

-- New capabilities are fail-closed for existing roles. Access is granted
-- explicitly through Role Access configuration rather than inherited from
-- tenant-admin status.
UPDATE role
SET excluded_features = ARRAY(
  SELECT DISTINCT feature
  FROM unnest(
    COALESCE(excluded_features, ARRAY[]::TEXT[])
    || ARRAY['cpd', 'cpd.certificate-templates']::TEXT[]
  ) AS feature
)
WHERE NOT COALESCE(excluded_features, ARRAY[]::TEXT[])
  @> ARRAY['cpd', 'cpd.certificate-templates']::TEXT[];