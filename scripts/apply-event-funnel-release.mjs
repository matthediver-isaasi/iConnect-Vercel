// Explicit, hash-pinned DEST-only schema installation; never activates purchasing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { inspectManifest, deploymentManifest } from './event-funnel-recovery-readiness.mjs';

export function transactionBody(sql) {
  assert.equal((sql.match(/^BEGIN;[ \t]*$/gm) || []).length, 1, 'Expected one outer BEGIN');
  assert.equal((sql.match(/^COMMIT;[ \t]*$/gm) || []).length, 1, 'Expected one outer COMMIT');
  const body = sql.replace(/^BEGIN;[ \t]*$/m, '').replace(/^COMMIT;[ \t]*$/m, '');
  assert.ok(!/^(?:ROLLBACK|COMMIT|BEGIN)\s*;/im.test(body), 'Unexpected transaction boundary');
  return body;
}

export async function releaseFiles() {
  const entries = deploymentManifest(await inspectManifest());
  assert.equal(entries.length, 45);
  const files = [];
  for (const entry of entries) {
    const sql = await readFile(new URL(`../supabase/migrations/${entry.file}`, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'), entry.sha256);
    files.push({ ...entry, sql, body: transactionBody(sql) });
  }
  const hash = createHash('sha256').update(JSON.stringify(files.map(f =>
    [f.file, f.deploymentVersion, f.sha256]))).digest('hex');
  return { files, hash };
}

// The managed integration does not expose a client session. Keep every DDL
// statement in one DO statement; a deliberate final exception rolls back a
// rehearsal, including any migration-history work performed by the provider.
export function managedReleaseQuery(files, { rehearse = true } = {}) {
  assert.equal(files.length, 45);
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const steps = files.map(f => `
    stage := ${literal(f.file)};
    EXECUTE ${literal(f.body)};
    INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
      VALUES(${literal(f.deploymentVersion)},${literal(f.file.replace(/^\d+_|\.sql$/g, ''))},ARRAY[${literal(f.sql)}]);`).join('\n');
  return `DO $funnel_release$
DECLARE stage text := 'identity'; ready jsonb;
BEGIN
  PERFORM set_config('lock_timeout','1s',true);
  PERFORM set_config('statement_timeout','60000',true);
  IF current_database()<>'postgres' OR NOT EXISTS(
    SELECT 1 FROM public.tenant WHERE id='fd82da65-aab7-4a5c-85b8-b2febeb2003d')
    THEN RAISE EXCEPTION 'Destination identity failed'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('event-funnel-schema-release',0))
    THEN RAISE EXCEPTION 'Another funnel installer is running'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname LIKE 'event_funnel_%')
    THEN RAISE EXCEPTION 'Existing funnel schema: no replay'; END IF;
  IF EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version IN (${files.map(f => literal(f.deploymentVersion)).join(',')}))
    THEN RAISE EXCEPTION 'Deployment versions already used'; END IF;
  ${steps}
  stage := 'verification';
  SELECT public.event_funnel_readiness() INTO ready;
  IF ready->>'authoring' IS DISTINCT FROM 'true' OR ready->>'purchasing' IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'Readiness verification failed'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'event_funnel_%'
    AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
    THEN RAISE EXCEPTION 'Funnel routines exposed'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'event_funnel_%' AND NOT c.relrowsecurity)
    THEN RAISE EXCEPTION 'Funnel tables missing RLS'; END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  ${rehearse ? "RAISE EXCEPTION 'FUNNEL_REHEARSAL_PASSED_ROLLED_BACK' USING ERRCODE='P0001';" : "NOTIFY pgrst, 'reload schema';"}
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Funnel stage %: % (%)',stage,SQLERRM,SQLSTATE;
END
$funnel_release$;`;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  assert.ok(args.every(a => ['--rehearse', '--apply'].includes(a) || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Unknown argument');
  assert.ok(!(args.includes('--apply') && args.includes('--rehearse')), 'Choose one operation');
  const { files, hash } = await releaseFiles();
  if (!args.includes('--apply') && !args.includes('--rehearse')) {
    console.log(JSON.stringify({ offline: true, migrations: files.length, sha256: hash }));
    return;
  }
  assert.ok(args.includes(`--review-sha256=${hash}`), 'Exact reviewed SHA required');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
    { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'CA unavailable');
  const ca = await response.text();
  assert.ok(ca.includes('BEGIN CERTIFICATE'));
  const db = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname }, connectionTimeoutMillis: 15000 });
  let current = 'identity', commitAttempted = false, committed = false;
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='15s'");
    const identity = (await db.query(`SELECT current_database()='postgres' AND current_user='postgres'
      AND EXISTS(SELECT 1 FROM public.tenant WHERE id='fd82da65-aab7-4a5c-85b8-b2febeb2003d') ok`)).rows[0];
    assert.equal(identity.ok, true, 'Independent destination identity failed');
    const lock = (await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('event-funnel-schema-release',0)) ok")).rows[0];
    assert.equal(lock.ok, true, 'Another funnel installer is running');
    const installed = await db.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'event_funnel_%'`);
    assert.equal(installed.rowCount, 0, 'Existing funnel schema requires reconciliation; no replay');
    const history = await db.query('SELECT version FROM supabase_migrations.schema_migrations WHERE version=ANY($1::text[])',
      [files.map(f => f.deploymentVersion)]);
    assert.equal(history.rowCount, 0, 'Deployment versions already used');
    const started = Date.now();
    for (const file of files) {
      current = file.file;
      assert.ok(Date.now() - started < 45000, 'Migration transaction budget exceeded');
      await db.query(file.body);
      await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',
        [file.deploymentVersion, file.file.replace(/^\d+_|\.sql$/g, ''), [file.sql]]);
    }
    current = 'verification';
    const ready = (await db.query('SELECT public.event_funnel_readiness() r')).rows[0].r;
    assert.equal(ready.authoring, true);
    assert.equal(ready.purchasing, false, 'Installation must not activate purchasing');
    const exposed = await db.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'event_funnel_%'
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))`);
    assert.equal(exposed.rowCount, 0, 'Funnel routines must remain service-only');
    const tables = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'event_funnel_%' AND NOT c.relrowsecurity`);
    assert.equal(tables.rowCount, 0, 'Funnel tables require RLS');
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query("NOTIFY pgrst, 'reload schema'");
    commitAttempted = args.includes('--apply');
    await db.query(commitAttempted ? 'COMMIT' : 'ROLLBACK');
    committed = commitAttempted;
    console.log(JSON.stringify({ success: true, applied: committed, rehearsed: !committed, migrations: files.length,
      sha256: hash, purchasing: false, verifiedTls: true }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    // Do not emit database contexts, query text, connection values or row data.
    console.error(JSON.stringify({ success: false, applied: commitAttempted && !committed ? 'unknown' : committed,
      stage: current, code: error.code, check: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Database operation failed' }));
    throw new Error('Funnel installation stopped; do not blindly retry');
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
