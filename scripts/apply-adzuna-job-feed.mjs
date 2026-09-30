import fs from 'node:fs';
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(fs.readFileSync(new URL('../migrations/add_adzuna_job_feed.sql', import.meta.url), 'utf8'));
  const result = await client.query(`
    SELECT
      to_regclass('public.tenant_job_feed_config') IS NOT NULL AS has_config,
      to_regclass('public.job_feed_sync_cursor') IS NOT NULL AS has_cursor
  `);
  if (!result.rows[0]?.has_config || !result.rows[0]?.has_cursor) {
    throw new Error('Adzuna migration verification failed');
  }
  console.log('Adzuna job feed migration applied and verified.');
} finally {
  await client.end();
}