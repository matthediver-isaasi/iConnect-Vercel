#!/usr/bin/env node
// Offline preview by default. Never apply without the separately reviewed hash.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261123_gocardless_manual_collection.sql';
const migrationSource = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const routineBody = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));
  if (!match) throw new Error(`Reviewed source missing: ${name}`);
  return match[1].trim();
};
const originalReserveDate = "((p.metadata->>'dynamic_first_date')::date + make_interval(months => p_collection_number - 1))::date";
const originalAttachDate = "((p.metadata->>'dynamic_first_date')::date + make_interval(months => r.collection_number))::date";
const amendedReserveDate = 'public.gocardless_dynamic_collection_due_date(p.id,p_collection_number)';
const amendedAttachDate = 'public.gocardless_dynamic_collection_due_date(p.id,r.collection_number+1)';
const cohortSources = [
  '20261108_explicit_direct_debit_collection_policy.sql', '20261108_bnms_dd_pilot_history.sql',
  '20261112_bnms_dd_beta_held.sql', '20261113_bnms_dd_alpha_held.sql',
  '20261114_bnms_dd_pilot_processing_start.sql', '20261115_bnms_dd_beta_scheduled_release.sql',
  '20261116_bnms_dd_pilot_reservation_lifecycle.sql', '20261117_bnms_dd_alpha_scheduled_release.sql',
  '20261121_bnms_dd_manual_95.sql',
];
function timingPatched(name, body) {
  let gates;
  if (['bnms_dd_beta_hold_guard', 'bnms_dd_alpha_hold_guard'].includes(name)) gates = [
    'clock_timestamp()<released.processing_not_before', "(NEW.provider_evidence->>'checked_at')::timestamptz<released.processing_not_before"];
  if (name === 'bnms_dd_guard_initial_reservation') gates = [
    "clock_timestamp() < TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'",
    "(NEW.provider_evidence->>'checked_at')::timestamptz < TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'"];
  if (name === 'bnms_manual_reservation_gate') gates = ['clock_timestamp()<r.processing_not_before', 'checked_at<r.processing_not_before'];
  for (const gate of gates || []) body = body.replace(gate, `(${gate} AND NOT public.gocardless_manual_reservation_authorized(NEW,TG_OP='UPDATE'))`);
  if (name === 'bnms_dd_alpha_protect_payment') body = body.replace(
    "clock_timestamp()<TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'",
    "(clock_timestamp()<TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London' AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,a.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))");
  if (name === 'bnms_manual_payment_guard') body = body.replace(
    "clock_timestamp()<'2026-10-01 00:00:00 Europe/London'::timestamptz",
    "(clock_timestamp()<'2026-10-01 00:00:00 Europe/London'::timestamptz AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,NEW.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))");
  return body;
}

// SELECT-only. Full reviewed financial routine bodies, not just a substring
// presence check, select the supported installed cadence contract.
export async function inspectContract(client, manualSql, { requireManual = false, transformSource = value => value } = {}) {
  const bodies = new Map(), bindings = new Map();
  const tables = new Set(['membership_payment_plans', 'membership_billing_agreements',
    'member_membership_history', 'gocardless_collection_reservations', 'gocardless_payments']);
  for (const file of cohortSources) {
    const source = await migrationSource(file);
    for (const match of source.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\)[\s\S]*?END \$\$;/gm)) bodies.set(match[1], routineBody(match[0], match[1]));
    for (const match of source.matchAll(/^CREATE TRIGGER (\w+)[\s\S]*?\bON public\.(\w+)[\s\S]*?EXECUTE FUNCTION public\.(\w+)\(\);/gm)) {
      if (tables.has(match[2])) bindings.set(match[1], { table: match[2], fn: match[3],
        type: 1 + 2 + (/\bINSERT\b/.test(match[0]) ? 4 : 0) + (/\bDELETE\b/.test(match[0]) ? 8 : 0) + (/\bUPDATE\b/.test(match[0]) ? 16 : 0) });
    }
  }
  const original = await migrationSource('20261108_explicit_direct_debit_collection_policy.sql');
  bodies.set('reserve_gocardless_dynamic_collection', routineBody(original, 'reserve_gocardless_dynamic_collection'));
  bodies.set('attach_gocardless_dynamic_payment', routineBody(original, 'attach_gocardless_dynamic_payment'));
  const names = [...new Set([...bindings.values()].map(b => b.fn).concat(
    ['reserve_gocardless_dynamic_collection', 'attach_gocardless_dynamic_payment',
      'attach_gocardless_dynamic_payment_before_schedule_amendments', 'gocardless_dynamic_collection_due_date']))];
  const { rows } = await client.query(`SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1)`, [names]);
  const installed = new Map();
  for (const row of rows) {
    if (installed.has(row.proname)) throw new Error(`Ambiguous installed overload: ${row.proname}`);
    installed.set(row.proname, row);
  }
  const amended = installed.has('gocardless_dynamic_collection_due_date');
  const state = (await client.query(`SELECT
    to_regclass('public.gocardless_manual_collection_authorizations') IS NOT NULL manual_installed,
    to_regclass('public.gocardless_manual_collection_revocations') IS NOT NULL revocations_installed,
    to_regclass('public.gocardless_collection_day_amendments') IS NOT NULL amendments`)).rows[0];
  if (state.manual_installed !== state.revocations_installed || (requireManual && !state.manual_installed)) throw new Error('Partial manual schema');
  if (amended) {
    if (!state.amendments) throw new Error('Canonical amended helper has no amendment table');
    const amendmentSql = await migrationSource('20261109_manage_monthly_collection_days.sql');
    const expected = routineBody(amendmentSql, 'gocardless_dynamic_collection_due_date');
    if (installed.get('gocardless_dynamic_collection_due_date').prosrc.trim() !== transformSource(expected)) throw new Error('Canonical amendment helper source drift');
    bodies.set('reserve_gocardless_dynamic_collection', bodies.get('reserve_gocardless_dynamic_collection').replace(originalReserveDate, amendedReserveDate));
    bodies.set('attach_gocardless_dynamic_payment_before_schedule_amendments', bodies.get('attach_gocardless_dynamic_payment').replace(originalAttachDate, amendedAttachDate));
    bodies.set('attach_gocardless_dynamic_payment', routineBody(amendmentSql, 'attach_gocardless_dynamic_payment'));
  } else {
    if (installed.has('attach_gocardless_dynamic_payment_before_schedule_amendments')) throw new Error('Partial amendment attachment contract');
    const version = await client.query("SELECT EXISTS(SELECT FROM membership_payment_plans WHERE provider='gocardless' AND metadata->>'collection_mode'='dynamic' AND metadata ? 'collection_schedule_version') AS present");
    if (version.rows[0].present) throw new Error('Original cadence has schedule version evidence');
    if (state.amendments && (await client.query('SELECT EXISTS(SELECT FROM gocardless_collection_day_amendments) AS present')).rows[0].present) {
      throw new Error('Original cadence has amendment evidence');
    }
  }
  const replacement = manualSql.match(/'IF FOUND THEN RETURN r; END IF;',\s*'((?:[^']|'')*)'\);/);
  if (!replacement) throw new Error('Reviewed manual reservation patch unavailable');
  const manualReturn = replacement[1].replaceAll("''", "'");
  for (const name of names.filter(name => name !== 'gocardless_dynamic_collection_due_date'
    && (amended || name !== 'attach_gocardless_dynamic_payment_before_schedule_amendments'))) {
    const row = installed.get(name);
    let expected = bodies.get(name);
    if (!row || !expected || row.owner !== 'postgres') throw new Error(`Missing or unexpected routine owner: ${name}`);
    if (state.manual_installed) {
      expected = timingPatched(name, expected);
      if (name === 'reserve_gocardless_dynamic_collection') expected = expected.replace('IF FOUND THEN RETURN r; END IF;', manualReturn);
    }
    if (row.prosrc.trim() !== transformSource(expected)) throw new Error(`Installed routine source drift: ${name}`);
    const isRpc = ['reserve_gocardless_dynamic_collection', 'attach_gocardless_dynamic_payment'].includes(name);
    const inner = name === 'attach_gocardless_dynamic_payment_before_schedule_amendments';
    if (row.prosecdef !== (isRpc || inner) || !row.proconfig?.some(value => /^search_path=public(?:, pg_temp)?$/.test(value))
      || (isRpc && (!row.service_execute || row.anon_execute || row.authenticated_execute))
      || (inner && (row.service_execute || row.anon_execute || row.authenticated_execute))) {
      throw new Error(`Installed routine privilege/search-path drift: ${name}`);
    }
  }
  const actual = (await client.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,p.proname FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND t.tgname=ANY($1)`, [[...bindings.keys()]])).rows;
  for (const [name, binding] of bindings) {
    if (!actual.some(t => t.tgname === name && t.relname === binding.table && t.proname === binding.fn && t.tgenabled === 'O' && t.tgtype === binding.type)) {
      throw new Error(`Installed financial trigger mismatch: ${name}`);
    }
  }
  for (const [table, columns] of Object.entries({
    membership_payment_plans: ['id:uuid', 'tenant_id:uuid', 'metadata:jsonb', 'dynamic_next_collection_date:date'],
    membership_billing_agreements: ['id:uuid', 'tenant_id:uuid', 'metadata:jsonb'],
    gocardless_collection_reservations: ['id:uuid', 'tenant_id:uuid', 'plan_id:uuid', 'amount_minor:integer', 'due_date:date', 'provider_evidence:jsonb'],
  })) {
    const schema = (await client.query('SELECT attname,format_type(atttypid,atttypmod) type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped', [`public.${table}`])).rows;
    if (columns.some(column => !schema.some(c => `${c.attname}:${c.type}` === column))) throw new Error(`Installed financial column mismatch: ${table}`);
  }
  if (state.manual_installed) {
    const newNames = [...manualSql.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map(m => m[1]);
    const newRows = (await client.query(`SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1)`, [newNames])).rows;
    if (newRows.length !== newNames.length) throw new Error('Unexpected manual helper overloads');
    for (const name of newNames) {
      const row = newRows.find(r => r.proname === name);
      const trigger = name.startsWith('guard_');
      if (!row || row.prosrc.trim() !== transformSource(routineBody(manualSql, name)) || row.owner !== 'postgres'
        || row.prosecdef !== !trigger || row.anon_execute || row.authenticated_execute
        || (!trigger && !row.service_execute) || !row.proconfig?.includes('search_path=public, pg_temp')) {
        throw new Error(`Manual helper definition/privilege mismatch: ${name}`);
      }
    }
    for (const table of ['gocardless_manual_collection_authorizations', 'gocardless_manual_collection_revocations']) {
      const contract = (await client.query(`SELECT c.relrowsecurity,
        has_table_privilege('service_role',c.oid,'SELECT') readable,
        has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') mutable,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,
        has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated_access
        FROM pg_class c WHERE c.oid=$1::regclass`, [`public.${table}`])).rows[0];
      if (!contract?.relrowsecurity || !contract.readable || contract.mutable || contract.anon_access || contract.authenticated_access) throw new Error('Manual audit table privileges mismatch');
      if ((await client.query(`SELECT count(*)::integer n FROM public.${table}`)).rows[0].n !== 0) throw new Error('Manual audit rows exist; do not reapply during active use');
    }
    const manualTriggers = (await client.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY($1)`,
      [['guard_gocardless_manual_reservation', 'manual_collection_audit_immutable', 'manual_collection_revocation_immutable']])).rows;
    if (manualTriggers.length !== 3 || manualTriggers.some(t => t.tgenabled !== 'O')) throw new Error('Manual audit trigger contract mismatch');
  }
  return { cadence: amended ? 'amended' : 'original', manualInstalled: state.manual_installed,
    verifiedRoutineBodies: names.length - (amended ? 0 : 2), verifiedFinancialTriggers: bindings.size };
}

export async function financialSnapshot(client) {
  const result = {};
  const scope = `(SELECT plan_id FROM bnms_dd_pilot_adoption UNION SELECT plan_id FROM bnms_dd_beta_adoption
    UNION SELECT plan_id FROM bnms_dd_alpha_adoption UNION SELECT plan_id FROM bnms_dd_manual_adoption)`;
  for (const [table, filter] of [
    ['gocardless_collection_reservations', 'true'],
    ['membership_payment_plans', `r.id IN ${scope}`],
    ['membership_billing_agreements', `r.id IN (SELECT billing_agreement_id FROM membership_payment_plans WHERE id IN ${scope})`],
    ['gocardless_payments', `r.plan_id IN ${scope}`],
  ]) {
    result[table] = (await client.query(`SELECT count(*)::integer count,
      md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.id),'')) digest FROM public.${table} r WHERE ${filter}`)).rows[0];
  }
  const security = (await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl,
    pg_get_userbyid(c.relowner) owner FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname=ANY($1) ORDER BY c.relname`, [
    ['membership_payment_plans', 'membership_billing_agreements', 'member_membership_history',
      'gocardless_collection_reservations', 'gocardless_payments'],
  ])).rows;
  const policies = (await client.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,policyname`, [security.map(row => row.relname)])).rows;
  const serviceRole = (await client.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role'")).rows[0];
  if (!serviceRole?.rolbypassrls) throw new Error('Unexpected service_role RLS contract');
  result.existingSecurity = { tableCount: security.length, policyCount: policies.length,
    sha256: createHash('sha256').update(JSON.stringify({ security, policies, serviceRole })).digest('hex') };
  return result;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || new Set(args).size !== args.length) throw new Error('Expected --apply --review-sha256=<reviewed hash>');
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) return console.log(JSON.stringify({ migration: MIGRATION, sha256, writesPerformed: false }));
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed migration hash mismatch; no writes performed');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to fetch verified destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  let committed = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    const preflight = await inspectContract(client, sql);
    const before = await financialSnapshot(client);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    // Freeze the reviewed financial row set for this short schema transaction.
    // These are locks only: no plan, agreement, reservation or payment writes.
    await client.query(`LOCK TABLE public.membership_payment_plans,public.membership_billing_agreements,
      public.gocardless_collection_reservations,public.gocardless_payments IN SHARE MODE`);
    await inspectContract(client, sql);
    if (JSON.stringify(await financialSnapshot(client)) !== JSON.stringify(before)) throw new Error('Financial rows changed after read-only preflight; review again');
    await client.query(sql);
    const verified = await inspectContract(client, sql, { requireManual: true });
    if (JSON.stringify(await financialSnapshot(client)) !== JSON.stringify(before)) throw new Error('Financial snapshot changed inside schema transaction');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    committed = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    await inspectContract(client, sql, { requireManual: true });
    const after = await financialSnapshot(client);
    await client.query('ROLLBACK');
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Postcommit financial snapshot changed; inspect concurrent activity');
    console.log(JSON.stringify({ migration: MIGRATION, sha256, applied: true, preflight, verified,
      financialSnapshotUnchanged: true, financialSnapshot: after, authorizationRows: 0, revocationRows: 0, schemaReloadNotified: true }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(committed ? 'Schema COMMITTED; subsequent verification failed.' : 'Schema NOT committed; transaction rolled back.', error.message);
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Manual collection migration failed; no success confirmed. Review hash, prerequisite guards and destination pins.'); process.exitCode = 1; });
}