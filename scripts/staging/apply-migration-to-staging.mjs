#!/usr/bin/env node
// Apply one SQL migration file to iconnect-staging only, inside a transaction.
// Default is a dry run that prints the SHA-256; pass --apply --review-sha256=<sha>.
// Production promotion still uses the feature's own pinned DEST runner.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

export const STAGING_REF = 'skaszwscycbfvfofnifx';
export const PRODUCTION_REF = 'lvmzliemqnieeoruhkik';
const PRODUCTION_SYSTEM_ID = '7581440907192989109';

export function stagingTarget(value) {
  if (!value) throw new Error('STAGING_DATABASE_URL is required; no database was changed.');
  if (value.includes(PRODUCTION_REF)) throw new Error('Refusing: URL names the production project.');
  const url = new URL(value);
  const user = decodeURIComponent(url.username);
  const pooler = url.hostname.endsWith('.pooler.supabase.com') && user === `postgres.${STAGING_REF}`;
  const direct = url.hostname === `db.${STAGING_REF}.supabase.co` && user === 'postgres';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(pooler || direct)
    || url.pathname !== '/postgres' || (url.port && url.port !== '5432')) {
    throw new Error(`Refusing: STAGING_DATABASE_URL must identify Supabase project ${STAGING_REF}.`);
  }
  return url;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) throw new Error('Usage: apply-migration-to-staging.mjs <file.sql> [--apply --review-sha256=<sha>]');
  const sql = await readFile(resolve(file), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ file, sha256, dryRun: true }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('SHA mismatch; no database was changed.');
  const target = stagingTarget(env.STAGING_DATABASE_URL);
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query('select system_identifier::text id from pg_control_system()');
    if (rows[0].id === PRODUCTION_SYSTEM_ID) throw new Error('Refusing: connected to the production cluster.');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='5min'");
    await client.query(sql);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ file, sha256, appliedTo: STAGING_REF }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Staging migration failed and was rolled back: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
