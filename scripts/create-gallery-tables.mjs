import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const SQL = `
CREATE TABLE IF NOT EXISTS gallery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  is_public boolean NOT NULL DEFAULT false,
  cover_photo_id uuid,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gallery_tenant_id ON gallery(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gallery_tenant_public ON gallery(tenant_id, is_public);

ALTER TABLE gallery ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "gallery_all" ON gallery FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS gallery_photo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gallery_id uuid NOT NULL REFERENCES gallery(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  bucket varchar(64) NOT NULL,
  file_url text NOT NULL,
  caption text,
  alt_text text,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill / migration for installs created before tenant_id was added.
-- gallery_photo.tenant_id is denormalized from gallery so the generic
-- tenant-scoped entity API can filter without a join.
ALTER TABLE gallery_photo ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE gallery_photo gp
   SET tenant_id = g.tenant_id
  FROM gallery g
 WHERE gp.gallery_id = g.id
   AND gp.tenant_id IS NULL;
ALTER TABLE gallery_photo ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gallery_photo_gallery_id ON gallery_photo(gallery_id);
CREATE INDEX IF NOT EXISTS idx_gallery_photo_tenant_id ON gallery_photo(tenant_id);

ALTER TABLE gallery_photo ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "gallery_photo_all" ON gallery_photo FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

async function run() {
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    console.log('Creating gallery and gallery_photo tables...');
    await client.query(SQL);
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('gallery','gallery_photo') ORDER BY table_name"
    );
    console.log('Verified tables:', rows.map((r) => r.table_name).join(', '));
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
