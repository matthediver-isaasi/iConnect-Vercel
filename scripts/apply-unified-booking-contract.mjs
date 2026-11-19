#!/usr/bin/env node
// Approved schema-only rollout. Never activates or invokes booking/provider writers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const project = 'lvmzliemqnieeoruhkik';
const migration = 'supabase/migrations/202701220001_unified_booking_contract.sql';
const reviewed = '6ef29240623d9f8f84fc73e95dbc2a400858f3cd23460290d840f9300ee3529a';
const sql = await readFile(migration, 'utf8');
assert.equal(createHash('sha256').update(sql).digest('hex'), reviewed, 'Migration differs from reviewed file');
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every(a => ['--rehearse', '--apply', '--verify'].includes(a)), 'Invalid mode');
if (!args.length) {
  console.log(JSON.stringify({ project, migration, sha256: reviewed, offline: true }));
  process.exit(0);
}
const target = destinationTarget(process.env);
const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
  { signal: AbortSignal.timeout(15000) });
assert.ok(caResponse.ok, 'Trusted provider CA unavailable');
const ca = await caResponse.text();
assert.match(ca, /BEGIN CERTIFICATE/);
const db = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 15000,
  ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
const body = sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const tables = ['unified_booking_rollout', 'unified_booking_contract', 'unified_booking_invoice'];
async function verify() {
  const readiness = (await db.query('SELECT public.unified_booking_readiness() AS value')).rows[0].value;
  assert.deepEqual(readiness, { version: 2, enabled: false });
  const rollout = (await db.query('SELECT enabled,reader_version,worker_version FROM public.unified_booking_rollout')).rows;
  assert.deepEqual(rollout, [{ enabled: false, reader_version: 0, worker_version: 0 }]);
  const acl = (await db.query(`SELECT c.relname,c.relrowsecurity,
    has_table_privilege('anon',c.oid,'SELECT') anon_read,
    has_table_privilege('authenticated',c.oid,'SELECT') auth_read,
    has_table_privilege('service_role',c.oid,'SELECT') service_read
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1)`, [tables])).rows;
  assert.equal(acl.length, 3);
  for (const row of acl) assert.ok(row.relrowsecurity && !row.anon_read && !row.auth_read && row.service_read);
  const functions = (await db.query(`SELECT p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') auth_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'unified_booking_%'`)).rows;
  assert.ok(functions.length >= 12);
  for (const f of functions) {
    assert.ok(!f.anon_execute && !f.auth_execute, `Public function grant: ${f.proname}`);
    assert.equal(f.service_execute, !/_core$|_immutable$/.test(f.proname), `Service grant: ${f.proname}`);
  }
  for (const table of tables.slice(1)) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n, 0);
  }
  return { readiness, tables: acl.length, functions: functions.length, serviceOnly: true };
}
async function transaction(apply) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='90s'");
    assert.equal((await db.query("SELECT to_regclass('public.unified_booking_rollout') AS existing")).rows[0].existing, null,
      'Migration already/partially installed; do not replay');
    // Prevent concurrent changes while comparing the two altered legacy tables.
    await db.query('LOCK TABLE public.booking_credit_attempt, public.public_invoice_po_billing IN ACCESS EXCLUSIVE MODE');
    const snapshot = async () => (await db.query(`SELECT
      (SELECT md5(coalesce(string_agg((to_jsonb(a)-'unified_contract_id')::text,'' ORDER BY tenant_id,purchase_key),'')) FROM public.booking_credit_attempt a) attempts,
      (SELECT md5(coalesce(string_agg((to_jsonb(b)-'unified_contract_id')::text,'' ORDER BY id),'')) FROM public.public_invoice_po_billing b) billing,
      pg_get_functiondef('public.booking_credit_finalize(uuid,text,uuid,uuid,jsonb,jsonb)'::regprocedure) legacy_finalize`)).rows[0];
    const before = await snapshot();
    await db.query(body);
    const result = await verify();
    assert.deepEqual(await snapshot(), before, 'Legacy rows or finalizer changed');
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    if (apply) {
      await db.query("NOTIFY pgrst, 'reload schema'");
      console.log('Verification passed; committing approved schema migration.');
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    return { ...result, legacyRowsUnchanged: true, applied: apply, rehearsed: !apply };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
try {
  await db.connect();
  assert.ok(db.connection.stream.encrypted && db.connection.stream.authorized, 'Verified TLS required');
  const identity = (await db.query(`SELECT current_database()='postgres' db,
    EXISTS(SELECT 1 FROM public.tenant WHERE id='fd82da65-aab7-4a5c-85b8-b2febeb2003d' AND slug='gfi') tenant`)).rows[0];
  assert.ok(identity.db && identity.tenant, 'Destination identity failed');
  if (args[0] === '--verify') {
    await db.query('BEGIN READ ONLY');
    console.log(JSON.stringify({ project, sha256: reviewed, ...(await verify()) }));
    await db.query('ROLLBACK');
  } else {
    console.log(JSON.stringify({ project, sha256: reviewed, ...(await transaction(false)) }));
    if (args[0] === '--apply') console.log(JSON.stringify({ project, sha256: reviewed, ...(await transaction(true)) }));
  }
} catch (err) {
  // Do not emit connection strings, credentials or customer rows.
  console.error(JSON.stringify({ failed: true, code: err.code, message: err.message,
    guidance: 'Inspect installation state before any retry; a disconnected COMMIT can have succeeded.' }));
  process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
