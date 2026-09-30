#!/usr/bin/env node
/**
 * Task #2852: apply supabase/migrations/20260722_ai_design_studio_governance.sql
 * against DEST_DATABASE_URL (pooler — the only Postgres host reachable from
 * this workspace). Idempotent; safe to re-run.
 *
 * Usage: node scripts/apply-ai-design-studio-governance.mjs
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.DEST_DATABASE_URL;
if (!url) {
  console.error('[apply-ai-design-studio-governance] DEST_DATABASE_URL is not set.');
  process.exit(1);
}

const sql = readFileSync(new URL('../supabase/migrations/20260722_ai_design_studio_governance.sql', import.meta.url), 'utf8');

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  console.log('[apply-ai-design-studio-governance] Applied successfully.');
} catch (err) {
  console.error('[apply-ai-design-studio-governance] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
