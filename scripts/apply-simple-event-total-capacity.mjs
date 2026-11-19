#!/usr/bin/env node
// Schema-only DEST rollout. Never calls a booking, sale, invitation or payment writer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {
  migrationPath, reviewedHash, project, migrationBody, functions, state,
  expectedPatches, snapshot, preservation, verifySchema, sha,
} from './lib/simpleEventCapacityRollout.mjs';

async function rest(env, path) {
  assert.ok(env.DEST_SUPABASE_KEY, 'Destination service key unavailable');
  const response = await fetch(`https://${project}.supabase.co/rest/v1/${path}`, {
    headers: { apikey:env.DEST_SUPABASE_KEY, Authorization:`Bearer ${env.DEST_SUPABASE_KEY}` },
    signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `Read-only DEST REST check failed: HTTP ${response.status}`);
  return response.json();
}

async function identity(db, env) {
  const row = (await db.query(`SELECT current_database()='postgres' database_ok,current_user='postgres' user_ok,
    EXISTS(SELECT 1 FROM public.tenant WHERE id='fd82da65-aab7-4a5c-85b8-b2febeb2003d') destination_tenant`)).rows[0];
  assert.ok(Object.values(row).every(Boolean), 'Independent SQL destination identity check failed');
  // Compare independently authenticated REST and SQL event identity/capacity data.
  const sqlRows = (await db.query(`SELECT to_jsonb(e) row FROM (
    SELECT id,tenant_id,available_seats,is_unlimited_registration
    FROM public.event ORDER BY id LIMIT 3) e`)).rows.map(r => r.row);
  const restRows = await rest(env, 'event?select=id,tenant_id,available_seats,is_unlimited_registration&order=id&limit=3');
  assert.ok(sqlRows.length === 3);
  assert.deepEqual(restRows, sqlRows, 'SQL/REST destination identity mismatch');
}

async function appRead(db, env) {
  const schema = await rest(env, '');
  assert.ok(schema.definitions?.event?.properties?.capacity_mode, 'REST column discovery not reloaded');
  assert.ok(schema.definitions?.event?.properties?.total_capacity, 'REST column discovery not reloaded');
  assert.ok(schema.paths?.['/rpc/simple_event_capacity'], 'REST capacity RPC discovery not reloaded');
  assert.ok(schema.paths?.['/rpc/insert_simple_total_booking_batch'], 'REST batch RPC discovery not reloaded');
  const rows = await rest(env, 'event?select=id,capacity_mode,total_capacity,available_seats,is_unlimited_registration&order=id&limit=1');
  assert.equal(rows.length, 1);
  const sql = (await db.query(`SELECT to_jsonb(e) row FROM (
    SELECT id,capacity_mode,total_capacity,available_seats,is_unlimited_registration
    FROM public.event WHERE id=$1) e`, [rows[0].id])).rows[0].row;
  assert.deepEqual(rows[0], sql);
  // GET calls only the aggregate reader; never the batch RPC.
  const capacity = await rest(env, `rpc/simple_event_capacity?p_event_id=${encodeURIComponent(rows[0].id)}`);
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL ROLE service_role");
    const expected = (await db.query('SELECT public.simple_event_capacity($1) capacity', [rows[0].id])).rows[0].capacity;
    assert.deepEqual(capacity, expected, 'Application-facing capacity result differs');
    assert.ok(['total','confirmed','commercial_unused','used','remaining'].every(k => Object.hasOwn(capacity,k)));
    await db.query('ROLLBACK');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  return { openapi:true, eventSelect:true, readOnlyCapacityRpc:true };
}

export async function runTransaction(db, mode, sql) {
  await db.query(mode === '--verify' || mode === '--preflight' ? 'BEGIN READ ONLY' : 'BEGIN');
  let commitAttempted = false;
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='90s'");
    const initial = await state(db);
    if (initial === 'present') {
      await verifySchema(db, sql);
      await db.query('ROLLBACK');
      return { alreadyPresent:true, applied:false };
    }
    const original = await functions(db);
    const expected = expectedPatches(sql, original);
    if (mode === '--verify') throw new Error('Capacity migration is absent');
    if (mode === '--preflight') {
      const rows = await snapshot(db);
      await db.query('ROLLBACK');
      return { state:initial, prerequisiteFunctions:expected.length, events:rows.length, writesPerformed:false };
    }
    // Lock before the snapshot. It is the same lock required by ALTER TABLE;
    // settings cannot drift between preservation evidence and commit.
    await db.query('LOCK TABLE public.event IN ACCESS EXCLUSIVE MODE');
    assert.equal(await state(db), 'absent', 'Migration state changed while acquiring event lock');
    const before = await snapshot(db);
    await db.query(migrationBody(sql));
    await verifySchema(db, sql, expected);
    const evidence = preservation(before, await snapshot(db), true);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    commitAttempted = mode === '--apply';
    await db.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
    return { applied:mode === '--apply', rehearsed:mode === '--rehearse', preservation:evidence };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    // A disconnected COMMIT can have succeeded at the server. Never describe
    // that as definitely unapplied or invite a blind replay.
    if (commitAttempted) error.commitOutcomeUnknown = true;
    throw error;
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const modes = args.filter(a => ['--preflight','--rehearse','--apply','--verify'].includes(a));
  assert.ok(modes.length <= 1 && new Set(args).size === args.length &&
    args.every(a => modes.includes(a) || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Invalid arguments');
  const sql = await readFile(migrationPath, 'utf8');
  migrationBody(sql);
  const report = { project,migrationPath,sha256:sha(sql) };
  if (!modes.length) { console.log(JSON.stringify({ ...report,offline:true,writesPerformed:false })); return; }
  const mode = modes[0];
  if (['--apply','--rehearse'].includes(mode)) assert.ok(args.includes(`--review-sha256=${reviewedHash}`), 'Reviewed migration SHA-256 required');
  const target = destinationTarget(env);
  const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
    { signal:AbortSignal.timeout(15000) });
  assert.ok(caResponse.ok, 'Provider CA unavailable');
  const ca = await caResponse.text();
  assert.match(ca, /BEGIN CERTIFICATE/);
  const db = new pg.Client({ connectionString:target.toString(),connectionTimeoutMillis:15000,
    ssl:{ rejectUnauthorized:true,ca,servername:target.hostname } });
  let result;
  try {
    await db.connect();
    // Pooler -> PostgreSQL may be plaintext internally; verify our actual TLS
    // socket, not pg_stat_ssl on the pooler's separate backend connection.
    assert.ok(db.connection.stream.encrypted && db.connection.stream.authorized, 'Verified SQL TLS required');
    await db.query("SET statement_timeout='60s'");
    await identity(db, env);
    if (mode === '--apply') {
      const rehearsal = await runTransaction(db, '--rehearse', sql);
      if (!rehearsal.alreadyPresent) assert.equal(await state(db), 'absent', 'Rollback rehearsal escaped');
    }
    result = await runTransaction(db, mode, sql);
    if (mode === '--rehearse' && !result.alreadyPresent) assert.equal(await state(db), 'absent', 'Rollback rehearsal escaped');
    if (mode === '--apply' || mode === '--verify') {
      await db.query('BEGIN READ ONLY');
      await verifySchema(db, sql);
      await db.query('ROLLBACK');
      // NOTIFY in the exact migration is delivered only at COMMIT.
      // A bounded retry handles the asynchronous PostgREST cache reload.
      let checked;
      for (let attempt=0; attempt<5; attempt++) {
        try { checked = await appRead(db,env); break; }
        catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve,1000)); }
      }
      result.applicationSchema = checked;
    }
    console.log(JSON.stringify({ ...report,...result,verifiedTls:true,independentTargetChecks:true }));
  } catch (error) {
    // Never print provider details, query contexts, customer rows or credentials.
    console.error(JSON.stringify({ ...report,applied:result?.applied ?? (error.commitOutcomeUnknown ? 'unknown' : false),
      success:false,check:error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Destination operation failed',
      code:error.code }));
    throw new Error('Capacity rollout did not complete; inspect the named check before any retry');
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}
