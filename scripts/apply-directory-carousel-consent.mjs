#!/usr/bin/env node
// Default offline review. Never falls back to SOURCE or the workspace DB.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202610190001_directory_carousel_public_consent.sql';
const PROJECT = 'lvmzliemqnieeoruhkik';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply', '--preflight'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || (args.includes('--apply') && args.includes('--preflight'))) {
    throw new Error('Use offline review, --preflight, or --apply --review-sha256=<hash>.');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ migration: MIGRATION, sha256, target: PROJECT, offline: true, writesPerformed: false }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration hash required; no database was changed.');
  }
  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error('Provider CA unavailable');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query(args.includes('--preflight') ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    if (args.includes('--apply')) await client.query(sql);
    const columns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema='public'
      AND table_name='dynamic_directory' AND column_name='public_carousel_enabled'`);
    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public'
      AND indexname='directory_carousel_primary_consent_identity'`);
    const triggers = await client.query(`
      SELECT event_object_table FROM information_schema.triggers
      WHERE trigger_schema='public' AND trigger_name='directory_carousel_consent_guard'
      GROUP BY event_object_table`);
    if (args.includes('--apply') && (columns.rows[0]?.data_type !== 'boolean'
      || columns.rows[0]?.is_nullable !== 'NO' || columns.rows[0]?.column_default !== 'false'
      || indexes.rowCount !== 1 || triggers.rowCount !== 2)) {
      throw new Error('Migration verification failed');
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({
      migration: MIGRATION, sha256, verifiedTarget: PROJECT,
      mode: args.includes('--apply') ? 'applied' : 'read-only-preflight',
      writesPerformed: args.includes('--apply'),
      consentColumnPresent: columns.rowCount === 1,
      singletonIndexPresent: indexes.rowCount === 1,
      guardedTables: triggers.rows.map(row => row.event_object_table),
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Carousel consent migration operation failed; no success confirmed. Check destination pins, reviewed SQL and verified TLS.');
    process.exitCode = 1;
  });
}
