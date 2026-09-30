#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202609200001_event_speaker_sponsor_display_modes.sql';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
    throw new Error('Supported arguments: --apply --review-sha256=<sha256>');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Migration hash does not match reviewed SQL; no database was changed.');
  }

  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error('Unable to obtain destination TLS certificate.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination TLS certificate.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const statements = sql.replace(/^\s*BEGIN\s*;/i, '').replace(/COMMIT\s*;\s*$/i, '');
    await client.query(statements);
    const { rows } = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('event', 'complex_event')
        AND column_name IN ('speaker_display_mode', 'sponsor_display_mode')
    `);
    for (const table of ['event', 'complex_event']) {
      for (const column of ['speaker_display_mode', 'sponsor_display_mode']) {
        const row = rows.find(candidate => (
          candidate.table_name === table && candidate.column_name === column
        ));
        if (!row || row.data_type !== 'text' || row.is_nullable !== 'NO'
          || row.column_default !== "'expanded'::text") {
          throw new Error(`Display-mode verification failed for ${table}.${column}`);
        }
      }
    }
    const constraints = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN ('public.event'::regclass, 'public.complex_event'::regclass)
        AND conname IN (
          'event_speaker_display_mode_check',
          'event_sponsor_display_mode_check',
          'complex_event_speaker_display_mode_check',
          'complex_event_sponsor_display_mode_check'
        )
    `);
    if (constraints.rowCount !== 4 || constraints.rows.some(row => (
      !row.definition.includes('hidden')
      || !row.definition.includes('collapsed')
      || !row.definition.includes('expanded')
    ))) {
      throw new Error('Display-mode constraint verification failed.');
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({
      applied: true,
      migration: MIGRATION,
      target: 'verified DEST Supabase',
      sha256,
      columnsVerified: rows.length,
      constraintsVerified: constraints.rowCount,
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
    console.error('Migration failed; no success confirmed. Check reviewed SQL, destination pins and verified TLS.');
    process.exitCode = 1;
  });
}