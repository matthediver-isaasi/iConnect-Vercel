import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const successor = process.argv.includes('--successor');
const path = successor
  ? 'supabase/migrations/202701200002_form_joining_voucher_successor.sql'
  : 'supabase/migrations/202701200001_form_joining_vouchers.sql';
const sql = await readFile(path, 'utf8');
const sha = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ project: PROJECT, migration: path, sha256: sha, applied: false }));
} else {
  if (!process.argv.includes(`--review-sha256=${sha}`)) throw new Error('Exact reviewed migration hash is required');
  const db = await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const existing = (await db.query("SELECT to_regclass('public.form_joining_voucher_checkout') AS name")).rows[0].name;
    if (successor ? !existing : existing) throw new Error('Unexpected first-membership schema state; inspect before applying');
    await db.query(sql.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
    const table = (await db.query(`SELECT relrowsecurity,
      has_table_privilege('anon',oid,'SELECT') AS anon_read,
      has_table_privilege('authenticated',oid,'SELECT') AS auth_read,
      has_table_privilege('service_role',oid,'INSERT') AS service_insert,
      has_table_privilege('service_role',oid,'SELECT') AS service_read
      FROM pg_class WHERE oid='public.form_joining_voucher_checkout'::regclass`)).rows[0];
    if (!table.relrowsecurity || table.anon_read || table.auth_read || table.service_insert || !table.service_read) {
      throw new Error('Unexpected checkout table protections');
    }
    const functions = (await db.query(`SELECT p.proname,p.prosecdef,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname IN ('bind_form_joining_voucher_checkout','release_form_joining_voucher_checkout')`)).rows;
    if (functions.length !== 2 || functions.some(f => !f.prosecdef || f.anon_execute || f.auth_execute || !f.service_execute)) {
      throw new Error('Unexpected checkout function protections');
    }
    const triggers = (await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('guard_form_joining_voucher_quote','guard_form_joining_voucher_agreement') AND tgenabled='O'`)).rows;
    if (triggers.length !== 2) throw new Error('Payment guards not installed');
    const count = (await db.query('SELECT count(*)::int AS n FROM public.form_joining_voucher_checkout')).rows[0].n;
    if (!successor && count !== 0) throw new Error('Migration unexpectedly created checkouts');
    if (successor) {
      const guard = (await db.query("SELECT pg_get_functiondef('public.guard_form_joining_voucher_payment()'::regprocedure) AS body")).rows[0].body;
      if (!guard.includes('JOIN public.membership_successor_election e')) throw new Error('Successor exception not installed');
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ project: PROJECT, migration: path, sha256: sha, applied: true,
      table, functions, triggers, checkoutsCreated: 0, paymentsInitiated: 0, emailsSent: 0 }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
