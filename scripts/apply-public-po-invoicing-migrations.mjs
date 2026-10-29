// Explicitly authorised DEST-only schema change. Never generates an invoice.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';

const paths = [
  'supabase/migrations/202612090003_public_invoice_po_billing.sql',
  'supabase/migrations/202612090004_public_invoice_booker_member.sql',
];
const files = await Promise.all(paths.map(async path => ({ path, sql: await readFile(path, 'utf8') })));
const digest = createHash('sha256').update(files.map(f => `${f.path}\n${f.sql}`).join('\n')).digest('hex');
const args = process.argv.slice(2);
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ destination: PROJECT, migrations: paths, digest, writesPerformed: false }));
  process.exit(0);
}
assert.deepEqual(args.sort(), ['--apply', `--review-sha256=${digest}`].sort(), 'Exact reviewed migration digest required');
const db = await connectDestination();
let committed = false;
const signatures = [
  'public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb)',
  'public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)',
];
async function expectDenied(sql) {
  await db.query('SAVEPOINT access_check');
  let code;
  try { await db.query(sql); } catch (e) { code = e.code; }
  await db.query('ROLLBACK TO SAVEPOINT access_check');
  assert.equal(code, '42501', 'Expected database permission denial');
}
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('public-po-invoicing-migration',0))");
  const preflight = (await db.query(`SELECT current_database()='postgres' AS database_ok,
    to_regclass('public.public_invoice_po_billing') IS NULL AS billing_absent,
    to_regprocedure($1) IS NULL AS approval_absent,
    to_regprocedure($2) IS NULL AS booker_absent,
    to_regprocedure('public.accounting_event_capture(uuid,text,text,text,text,jsonb)') IS NOT NULL AS qbo_present,
    to_regprocedure('public.event_invoice_recovery_enqueue(uuid,text,text,jsonb,boolean)') IS NOT NULL AS xero_present,
    to_regprocedure('public.create_member_from_event_registration(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)') IS NOT NULL AS member_creation_present`,
  signatures)).rows[0];
  assert.ok(Object.values(preflight).every(v => v === true), 'Preflight failed; no schema change committed');
  for (const { sql } of files) {
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    // One transaction for both files; inner COMMIT must not escape verification.
    await db.query(sql.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, ''));
  }
  const protection = (await db.query(`SELECT relrowsecurity AS rls,
    NOT has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous_denied,
    NOT has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_denied,
    has_table_privilege('service_role',oid,'SELECT') AS service_read,
    NOT has_table_privilege('service_role',oid,'INSERT,DELETE') AS service_direct_creation_denied,
    NOT has_column_privilege('service_role',oid,'original_records','UPDATE') AS evidence_immutable,
    NOT has_column_privilege('service_role',oid,'amount','UPDATE') AS amount_immutable,
    NOT has_column_privilege('service_role',oid,'member_id','UPDATE') AS owner_immutable,
    has_column_privilege('service_role',oid,'payment_status','UPDATE') AS service_status_update
    FROM pg_class WHERE oid='public.public_invoice_po_billing'::regclass`)).rows[0];
  assert.ok(Object.values(protection).every(v => v === true), 'Table protection verification failed');
  for (const signature of signatures) {
    const check = (await db.query(`SELECT p.prosecdef AS definer,
      p.proconfig @> ARRAY['search_path=public, pg_temp'] AS pinned_search_path,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      NOT has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_denied,
      NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AS browser_denied
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
    assert.ok(Object.values(check).every(v => v === true), 'Function protection verification failed');
  }
  for (const role of ['anon', 'authenticated']) {
    await db.query(`SET LOCAL ROLE ${role}`);
    await expectDenied('SELECT id FROM public.public_invoice_po_billing LIMIT 0');
    await expectDenied('SELECT public.public_invoice_po_bill(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)');
    await expectDenied('SELECT public.create_public_invoice_booker(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)');
    await db.query('RESET ROLE');
  }
  await db.query('SET LOCAL ROLE service_role');
  await expectDenied('UPDATE public.public_invoice_po_billing SET amount=0 WHERE false');
  await expectDenied('DELETE FROM public.public_invoice_po_billing WHERE false');
  await db.query('SELECT id FROM public.public_invoice_po_billing LIMIT 0');
  await db.query('UPDATE public.public_invoice_po_billing SET checked_at=now() WHERE false');
  await db.query('RESET ROLE');
  const checks = (await db.query(`SELECT
    (SELECT count(*)=0 FROM public.public_invoice_po_billing) AS no_invoices_created,
    (SELECT count(*)=2 FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('booking','complex_event_booking')
      AND column_name='public_invoice_po_billing_id') AS booking_links_present,
    position('public.public_invoice_po_billing' in pg_get_functiondef(
      'public.accounting_event_capture(uuid,text,text,text,text,jsonb)'::regprocedure))>0 AS approval_guard_present`)).rows[0];
  assert.ok(Object.values(checks).every(v => v === true), 'Post-migration contract verification failed');
  await db.query("NOTIFY pgrst,'reload schema'");
  await db.query('COMMIT');
  committed = true;
  console.log(JSON.stringify({ applied: true, destination: PROJECT, digest, migrations: paths,
    protections: protection, checks, actualRoleDenialsVerified: true, businessOperationsPerformed: false }, null, 2));
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ applied: committed, error: e.message, code: e.code || null }));
  process.exitCode = 1;
} finally { await db.end(); }
