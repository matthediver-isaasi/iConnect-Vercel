// Explicitly approved schema-only rollout. Never invokes booking/provisioning.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';

const path = 'supabase/migrations/202612090013_ticket_guest_accounts.sql';
const expectedHash = '8e927a6ffadc3180a01ef71c6ddc8a18336c1f15d5a4f3f5df155fcd30b85332';
const sql = await readFile(path, 'utf8');
assert.equal(createHash('sha256').update(sql).digest('hex'), expectedHash, 'Reviewed migration changed');
const args = process.argv.slice(2);
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ destination: PROJECT, path, sha256: expectedHash, writesPerformed: false }));
  process.exit(0);
}
assert.deepEqual(args.sort(), ['--apply', `--review-sha256=${expectedHash}`].sort());

const signatures = [
  'public.provision_public_ticket_members(uuid)',
  'public.insert_public_ticket_booking_batch(uuid,jsonb)',
];
const db = await connectDestination();
let committed = false;
const fingerprints = async () => (await db.query(`
  SELECT
    (SELECT md5(coalesce(string_agg((to_jsonb(t)-'auto_create_guest_accounts')::text,'|' ORDER BY id),'')) FROM public.complex_event_ticket_class t) AS tickets,
    (SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'|' ORDER BY id),'')) FROM public.public_ticket_member_purchase p) AS purchases,
    (SELECT count(*) FROM public.member) AS members,
    (SELECT count(*) FROM public.booking) AS bookings,
    (SELECT count(*) FROM public.complex_event_booking) AS complex_bookings
`)).rows[0];
const metadata = async () => (await db.query(`
  SELECT oid::text,proacl::text,prosecdef,proconfig FROM pg_proc
  WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid
`, signatures)).rows;
try {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('ticket-guest-accounts-schema',0))");
  const preflight = (await db.query(`SELECT current_database()='postgres' AS database_ok,
    to_regprocedure('public.ticket_guest_accounts_ready()') IS NULL AS unapplied,
    NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='complex_event_ticket_class' AND column_name='auto_create_guest_accounts') AS column_absent`)).rows[0];
  assert.ok(Object.values(preflight).every(Boolean), 'Unexpected destination or migration state');
  const before = await fingerprints();
  const originalMetadata = await metadata();
  const originals = [];
  for (const signature of signatures) {
    originals.push((await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [signature])).rows[0].definition);
  }
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  await db.query(sql.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, ''));
  assert.deepEqual(await metadata(), originalMetadata, 'Existing execution context or grants changed');
  for (let index = 0; index < signatures.length; index++) {
    let expected = originals[index].replace(
      "purchase.snapshot->>'association_role_id' IS NOT NULL",
      "(purchase.snapshot->>'association_role_id' IS NOT NULL OR coalesce(purchase.snapshot->>'guest_accounts'='true',false))",
    );
    if (index === 0) expected = expected.replace(
      "public.assert_registration_account_association(purchase.tenant_id,person->'association')",
      "(public.assert_registration_account_association(purchase.tenant_id,person->'association')\n    OR coalesce((purchase.snapshot->>'guest_accounts'='true' AND person->>'guest_account'='true'),false))",
    );
    const actual = (await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [signatures[index]])).rows[0].definition;
    assert.equal(actual, expected, 'Unexpected function changes');
  }
  for (const signature of [...signatures, 'public.ticket_guest_accounts_ready()']) {
    const privileges = (await db.query(`SELECT
      NOT has_function_privilege('anon',$1,'EXECUTE') AS anonymous_denied,
      NOT has_function_privilege('authenticated',$1,'EXECUTE') AS browser_denied,
      has_function_privilege('service_role',$1,'EXECUTE') AS server_allowed`, [signature])).rows[0];
    assert.ok(Object.values(privileges).every(Boolean), `Permission check failed: ${signature}`);
  }
  const checks = (await db.query(`SELECT
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='complex_event_ticket_class' AND column_name='auto_create_guest_accounts'
      AND data_type='boolean' AND is_nullable='NO' AND column_default='false') AS default_off,
    NOT EXISTS(SELECT 1 FROM public.complex_event_ticket_class WHERE auto_create_guest_accounts IS DISTINCT FROM false) AS all_tickets_off,
    (SELECT relrowsecurity FROM pg_class WHERE oid='public.public_ticket_member_purchase'::regclass) AS purchase_rls,
    NOT has_table_privilege('anon','public.public_ticket_member_purchase','INSERT,UPDATE,DELETE') AS anonymous_purchase_denied,
    NOT has_table_privilege('authenticated','public.public_ticket_member_purchase','INSERT,UPDATE,DELETE') AS browser_purchase_denied
  `)).rows[0];
  assert.ok(Object.values(checks).every(Boolean), 'Default or purchase protections failed');
  await db.query('SET LOCAL ROLE service_role');
  assert.equal((await db.query('SELECT public.ticket_guest_accounts_ready() AS ready')).rows[0].ready, true);
  await db.query('RESET ROLE');
  assert.deepEqual(await fingerprints(), before, 'Existing records changed');
  await db.query('COMMIT');
  committed = true;
  await db.query('BEGIN READ ONLY');
  assert.equal((await db.query('SELECT public.ticket_guest_accounts_ready() AS ready')).rows[0].ready, true);
  await db.query('COMMIT');
  console.log(JSON.stringify({
    destination: PROJECT, path, sha256: expectedHash, committed,
    existingRecordsUnchanged: true, defaultOff: true, serviceOnly: true,
    historicalPurchasesUnchanged: true, provisioningInvoked: false,
  }));
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ committed, error: error.message, code: error.code }));
  process.exitCode = 1;
} finally {
  await db.end();
}
