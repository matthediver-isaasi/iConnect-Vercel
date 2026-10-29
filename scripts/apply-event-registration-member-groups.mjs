#!/usr/bin/env node
// Destination-only schema change; never creates members or modifies bookings.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const project = 'lvmzliemqnieeoruhkik';
const version = '20261029120000';
const name = 'event_registration_member_groups';
const signature = 'public.create_member_from_event_registration(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)';
const oldSignature = signature.replace(',date,uuid)', ',date)');
const expectedHash = '40f351a635912e9d31768d606486c51077d9168f0f4ab261920a1fecd17ae5f6';
let db;
try {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--preflight', '--apply', '--verify'].includes(mode))) throw new Error('Invalid mode');
  const sql = await readFile(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (sha256 !== expectedHash) throw new Error('Reviewed SQL changed');
  if (!mode) {
    console.log(JSON.stringify({ project, version, sha256, offline: true }));
  } else {
    const target = destinationTarget(process.env);
    const ca = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
    if (!ca.ok) throw new Error('Provider CA unavailable');
    db = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 15000,
      ssl: { rejectUnauthorized: true, ca: await ca.text(), servername: target.hostname } });
    await db.connect();
    await db.query(mode === '--apply' ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await db.query('SELECT id,tenant_id FROM public.organization_group LIMIT 0');
    await db.query('SELECT organization_group_id FROM public.member LIMIT 0');
    const funcs = (await db.query(`SELECT oid::regprocedure::text signature, prosrc FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname='create_member_from_event_registration'`)).rows;
    const previous = await readFile(new URL('../supabase/migrations/20261006160000_event_registration_member.sql', import.meta.url), 'utf8');
    const body = text => text.split('AS $$')[1].split('$$;')[0];
    if (funcs.length !== 1 || ![body(previous), body(sql)].includes(funcs[0].prosrc)) throw new Error('Existing function differs from reviewed contracts');
    if (mode === '--apply') {
      await db.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
      await db.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
        VALUES($1,$2,$3) ON CONFLICT(version) DO NOTHING`, [version, name, [sql]]);
    }
    if (mode !== '--preflight') {
      const result = (await db.query(`SELECT p.prosrc, p.prosecdef,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') service,
        to_regprocedure($2) IS NULL old_removed
        FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [signature, oldSignature])).rows[0];
      if (!result || result.prosrc !== body(sql) || !result.prosecdef || result.anon || result.authenticated
        || !result.service || !result.old_removed) throw new Error('Function body or grants verification failed');
    }
    await db.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ project, version, sha256, mode, verified: true, customerDataWrites: false }));
  }
} catch (error) {
  await db?.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ error: error instanceof pg.DatabaseError ? 'Database verification failed' : error.message, code: error.code || null }));
  process.exitCode = 1;
} finally {
  await db?.end();
}
