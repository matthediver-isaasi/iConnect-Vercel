// Apply supabase/migrations/20260816_organization_groups.sql to DEST.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const dbUrl = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DEST_DATABASE_URL or DATABASE_URL required');
  process.exit(1);
}

const sql = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260816_organization_groups.sql'),
  'utf8'
);

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  const { rows } = await client.query(`
    SELECT
      to_regclass('organization_group') IS NOT NULL AS table_exists,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organization' AND column_name = 'organization_group_id'
      ) AS column_exists
  `);
  console.log('Verification:', rows[0]);
  if (!rows[0].table_exists || !rows[0].column_exists) process.exit(1);
  console.log('organization_group migration applied successfully.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
