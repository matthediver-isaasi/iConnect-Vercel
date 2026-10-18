#!/usr/bin/env node
// Offline review by default; all network operations are explicit DEST-only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202612310005_ticket_selected_member_audience.sql';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export async function verifySchema(client) {
  const columns = (await client.query(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='complex_event_ticket_class'
      AND column_name IN ('audience_mode','selected_member_ids') ORDER BY column_name
  `)).rows;
  if (columns.length !== 2 || columns[0].data_type !== 'text'
    || columns[1].udt_name !== '_uuid'
    || columns.some(column => column.is_nullable !== 'YES' || column.column_default !== null)) {
    throw new Error('Audience column verification failed.');
  }
  const constraints = (await client.query(`
    SELECT conname, convalidated, pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE conrelid='public.complex_event_ticket_class'::regclass
      AND conname='complex_ticket_audience_mode_valid'
  `)).rows;
  if (constraints.length !== 1 || !constraints[0].convalidated
    || !constraints[0].definition.includes('selected_members') || !constraints[0].definition.includes('legacy')) {
    throw new Error('Audience mode constraint verification failed.');
  }
  const triggers = (await client.query(`
    SELECT c.relname table_name, t.tgenabled, p.proname, p.prosecdef,
      pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND c.relname IN ('event','complex_event_ticket_class')
      AND t.tgname='ticket_selected_member_audience_guard' AND NOT t.tgisinternal
    ORDER BY c.relname
  `)).rows;
  if (triggers.length !== 2 || triggers.some(trigger => trigger.tgenabled !== 'O'
    || !trigger.prosecdef || trigger.proname !== 'enforce_ticket_selected_member_audience'
    || !trigger.definition.includes('BEFORE INSERT OR UPDATE')
    || !trigger.definition.includes('FOR EACH ROW'))) {
    throw new Error('Audience storage guard verification failed.');
  }
  const functions = (await client.query(`
    SELECT p.proname, p.proconfig,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('enforce_ticket_selected_member_audience','normalize_ticket_selected_member_audience')
    ORDER BY p.proname
  `)).rows;
  if (functions.length !== 2 || functions.some(fn => fn.public_execute
    || !fn.proconfig?.includes('search_path=pg_catalog, public'))) {
    throw new Error('Audience guard function privilege/search-path verification failed.');
  }
  return { columns, constraints, triggers, functions };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply','--verify'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg === '--verify').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1
    || (args.includes('--apply') && args.includes('--verify'))) {
    throw new Error('Use --apply --review-sha256=<hash>, --verify, or no arguments for offline review.');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const apply = args.includes('--apply');
  if (!apply && !args.includes('--verify')) {
    console.log(JSON.stringify({ migration: MIGRATION, sha256, dryRun: true, writesPerformed: false, rollout: 'PENDING: schema before code' }));
    return;
  }
  if (apply && !args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Exact reviewed migration SHA required; no database was changed.');
  }
  const target = destinationTarget(env); // No DATABASE_URL/SOURCE fallback.
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error('Unable to load destination TLS certificate.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination TLS certificate.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    if (apply) await client.query(sql);
    const evidence = await verifySchema(client);
    if (apply) await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({
      migration: MIGRATION, sha256, destination: 'lvmzliemqnieeoruhkik DEST only',
      applied: apply, verified: true, writesPerformed: apply, evidence,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Ticket audience migration failed (${error.code || 'validation/connection error'}); no credentials logged.`);
    process.exitCode = 1;
  });
}
