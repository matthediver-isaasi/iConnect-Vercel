import { readFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';

// Pinned destination only; schema DDL, no backfill or workflow dispatch.
const db = await connectDestination();
try {
  await db.query('BEGIN');
  await db.query(await readFile(new URL('../supabase/migrations/20261218_annual_expiry_role_events.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/20261219_annual_expiry_role_discovery.sql', import.meta.url), 'utf8'));
  await db.query('COMMIT');
  console.log('Applied 20261218_annual_expiry_role_events.sql and 20261219_annual_expiry_role_discovery.sql to authoritative DEST (lvmzliemqnieeoruhkik). No member data changes or workflow dispatch.');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
