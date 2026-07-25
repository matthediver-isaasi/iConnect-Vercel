#!/usr/bin/env node
/**
 * Applies supabase/migrations/20260727_support_realtime_publication.sql against
 * DEST_DATABASE_URL (Supabase pooler). Idempotent — safe to re-run.
 *
 * Usage: node scripts/apply-support-realtime-publication.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260727_support_realtime_publication.sql');
const sql = readFileSync(sqlPath, 'utf8');

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    `SELECT tablename FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND tablename IN ('support_ticket','support_ticket_response')`
  );
  console.log('Published tables:', rows.map(r => r.tablename).join(', ') || '(none)');
  if (rows.length !== 2) {
    console.error('Expected both support_ticket and support_ticket_response to be published');
    process.exit(1);
  }
  console.log('Done.');
} finally {
  await client.end();
}
