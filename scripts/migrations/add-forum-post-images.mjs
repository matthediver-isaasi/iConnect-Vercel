import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;

if (!databaseUrl) {
  console.error('DEST_DATABASE_URL not set');
  process.exit(1);
}

async function migrate() {
  console.log('Adding image_urls column to forum_post table...');

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'forum_post' AND column_name = 'image_urls'
        ) THEN
          ALTER TABLE forum_post ADD COLUMN image_urls JSONB DEFAULT NULL;
        END IF;
      END $$;
    `);
    console.log('Migration complete: image_urls column added to forum_post');

    await client.query("NOTIFY pgrst, 'reload schema';");
    console.log('PostgREST schema cache reloaded');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
