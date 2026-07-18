// Applies supabase/migrations/20260726_ai_style_reference_analysis.sql
// against the DEST (production) database via the pooler URL.
// Idempotent — safe to re-run.
//
// Usage: node scripts/apply-ai-style-reference-analysis.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(here, '../supabase/migrations/20260726_ai_style_reference_analysis.sql');
const sql = readFileSync(sqlPath, 'utf8');

const url = process.env.DEST_DATABASE_URL;
if (!url) {
  console.error('DEST_DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_style_reference_analysis' ORDER BY ordinal_position",
  );
  console.log('ai_style_reference_analysis columns:', rows.map((r) => r.column_name).join(', '));
  console.log('Migration applied.');
} finally {
  await client.end();
}
