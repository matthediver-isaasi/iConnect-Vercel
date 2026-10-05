import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const expected = args.find(arg => arg.startsWith('--expected-contract='))?.split('=')[1];
const expectedMigration = args.find(arg => arg.startsWith('--expected-migration='))?.split('=')[1];
if (args.some(arg => !['--apply', '--verify-dest'].includes(arg)
    && !/^--expected-(contract|migration)=[a-f0-9]{64}$/.test(arg))
    || (apply && args.includes('--verify-dest'))
    || new Set(args.map(arg => arg.split('=')[0])).size !== args.length) {
  throw new Error('Refusing ambiguous migration arguments');
}
const sql = await readFile(new URL('../supabase/migrations/20261207_membership_successor_switch.sql', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const migrationHash = hash(sql);
const tables = ['membership_successor_election', 'membership_successor_payment_attempt',
  'membership_payment_quote', 'membership_billing_agreements',
  'member_membership_history', 'organisation_membership_history',
  'membership_successor_rollout', 'membership_successor_tenant_rollout'];
const modifiedNames = ['reserve_membership_successor', 'enforce_rolling_membership_commitment',
  'enforce_rolling_payment_quote', 'reserve_form_membership_payment_quote'];
const excludedColumns = ['cancelled_for_switch_at', 'provider_work_token', 'switch_state', 'switch_receipts', 'switched_at'];
async function snapshot(db) {
  const result = {};
  for (const table of tables) {
    result[table] = (await db.query(`SELECT count(*)::integer AS count,
      md5(coalesce(string_agg(md5((to_jsonb(t)-$1::text[])::text),'' ORDER BY
        (to_jsonb(t)-$1::text[])::text),'')) AS fingerprint FROM public.${table} t`,
    [excludedColumns])).rows[0];
  }
  return result;
}
let db;
try {
  if (!apply && !args.includes('--verify-dest')) {
    console.log(JSON.stringify({ migrationHash, applied: false }));
  } else {
    if (apply && (!expected || !expectedMigration || expectedMigration !== migrationHash)) {
      throw new Error('Refusing unpinned migration or contract');
    }
    db = await connectDestination();
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    if (apply) await db.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-successor-schema',0))");
    const functions = (await db.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (p.proname=ANY($1) OR p.proname LIKE '%membership_successor%')
      ORDER BY p.proname,p.oid`, [modifiedNames])).rows;
    if (!modifiedNames.every(name => functions.filter(fn => fn.proname === name).length === 1)) {
      throw new Error('Refusing missing or ambiguous installed contracts');
    }
    const indexes = (await db.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname`, [tables])).rows;
    const constraints = (await db.query(`SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname,con.conname`, [tables])).rows;
    const contractHash = hash(JSON.stringify({ functions, indexes, constraints }));
    const installed = functions.some(fn => fn.proname === 'begin_membership_successor_switch');
    if (!apply) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ verifiedTarget: 'DEST', installed, contractHash, migrationHash, applied: false }));
    } else {
      if (installed || contractHash !== expected) throw new Error('Refusing changed or already-installed contracts');
      const before = await snapshot(db);
      await db.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
      if (JSON.stringify(await snapshot(db)) !== JSON.stringify(before)) {
        throw new Error('Refusing financial data or rollout changes during schema installation');
      }
      for (const name of ['begin_membership_successor_switch', 'finish_membership_successor_switch',
        'refuse_membership_successor_switch', 'begin_membership_successor_provider_work',
        'finish_membership_successor_provider_work']) {
        const grants = (await db.query(`SELECT p.prosecdef,has_function_privilege('service_role',p.oid,'EXECUTE') service,
          has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`, [name])).rows;
        if (grants.length !== 1 || !grants[0].prosecdef || !grants[0].service || grants[0].anon || grants[0].authenticated) {
          throw new Error('Refusing unsafe reconciliation grants');
        }
      }
      await db.query("NOTIFY pgrst,'reload schema'");
      await db.query('COMMIT');
      console.log(JSON.stringify({ target: 'DEST', applied: true, migrationHash, financialRowsUnchanged: true, rolloutUnchanged: true }));
    }
  }
} catch (error) {
  await db?.query('ROLLBACK').catch(() => {});
  console.error(error.message?.startsWith('Refusing') ? error.message : 'Destination migration failed; no application success is asserted.');
  process.exitCode = 1;
} finally {
  await db?.end();
}
