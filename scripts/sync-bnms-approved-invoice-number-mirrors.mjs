#!/usr/bin/env node
// User-approved, exact two-invoice local repair. Xero transport is GET-only.
// Applies the reviewed survey exception and all four mirror edits atomically.
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';
import { TENANT, XERO_TENANT, hash } from './prepare-bnms-paid-invoice-renumber.mjs';
import { APPROVED, checkInvoice } from './apply-bnms-approved-invoice-renumber.mjs';

export const MIGRATION = '202612030001_survey_invoice_number_only.sql';
export const PINS = APPROVED.map((t, n) => ({ ...t,
  bookingId: ['01e349e2-9ae5-49e6-9ec8-95a47a1b3b9f', 'b09afeb8-0955-4c3d-9636-35aa543a9f5a'][n],
  recoveryId: ['b23264a0-7859-4912-86a6-19dc96c4aab6', '8126f3a8-fd0d-4b6d-95ee-adda6af98ad9'][n] }));
const ensure = (value, code) => { if (!value) throw Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
export function assertOnlyNumberChanged(before, after, key, expected) {
  ensure(after?.[key] === expected, 'mirror_number_verification_failed');
  const b = { ...before }, a = { ...after };
  delete b[key]; delete a[key];
  ensure(hash(a) === hash(b), 'non_number_local_field_changed');
}
const functionNames = ['bump_survey_invitation_revision', 'invalidate_survey_invitation_attendee'];
const functionBody = (sql, name) => {
  const section = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`));
  return section.slice(section.indexOf('AS $$') + 5, section.indexOf('$$;')).trim();
};
export async function main(args = process.argv.slice(2)) {
  const migration = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const migrationSha256 = digest(migration);
  if (!args.length) {
    console.log(JSON.stringify({ dryRun: true, project: PROJECT, migration: MIGRATION, migrationSha256 }));
    return;
  }
  ensure(args.length === 3 && args[0] === '--apply'
    && args[1] === `--review-sha256=${migrationSha256}`
    && /^\/tmp\/bnms-mirror-sync-[a-zA-Z0-9-]+\.jsonl$/.test(args[2]), 'reviewed_hash_and_private_audit_required');
  const audit = await open(args[2], 'wx', 0o600);
  const record = async value => { await audit.writeFile(`${JSON.stringify(value)}\n`); await audit.sync(); };
  let c, committed = false;
  try {
    await record({ phase: 'start', at: new Date().toISOString(), project: PROJECT, tenant: TENANT,
      migration: MIGRATION, migrationSha256, implementationSha256: digest(await readFile(new URL(import.meta.url))),
      regressionSha256: digest(await readFile(new URL('./survey-invoice-number-only.postgres.test.mjs', import.meta.url))),
      providerWrites: 0, pins: PINS });
    c = await connectDestination();
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    ensure((await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',
      ['bnms-approved-invoice-number-mirror-sync'])).rows[0].ok, 'repair_already_running');
    const tenant = (await c.query('SELECT name FROM tenant WHERE id=$1', [TENANT])).rows;
    ensure(tenant.length === 1 && /bnms|british nuclear medicine society/i.test(tenant[0].name), 'tenant_pin_failed');
    const tokens = (await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    ensure(tokens.length === 1 && tokens[0].tenant_id === XERO_TENANT
      && Date.parse(tokens[0].expires_at) > Date.now() + 120000, 'normal_application_auth_required');
    const get = async path => {
      ensure(path === '/connections' || PINS.some(t => path === `/api.xro/2.0/Invoices/${t.id}`), 'forbidden_provider_path');
      await new Promise(resolve => setTimeout(resolve, 1250));
      const res = await fetch(`https://api.xero.com${path}`, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${tokens[0].access_token}`,
          'xero-tenant-id': XERO_TENANT, Accept: 'application/json' } });
      ensure(res.ok, `provider_get_http_${res.status}`);
      return res.json();
    };
    const connections = await get('/connections');
    ensure(Array.isArray(connections) && connections.some(c => c.tenantId === XERO_TENANT), 'provider_connection_pin_failed');
    const provider = async t => {
      const body = await get(`/api.xro/2.0/Invoices/${t.id}`);
      ensure(body.Invoices?.length === 1, 'provider_cardinality_failed');
      const i = body.Invoices[0];
      checkInvoice(i, t, t.assigned);
      ensure(i.Status === 'PAID' && i.Total === 166.67 && i.AmountPaid === 166.67 && i.AmountDue === 0,
        'provider_financial_state_changed');
      return i;
    };
    const functions = async () => (await c.query(`SELECT proname,prosrc,prosecdef,proconfig,proacl::text
      FROM pg_proc WHERE oid IN ('public.bump_survey_invitation_revision()'::regprocedure,
        'public.invalidate_survey_invitation_attendee()'::regprocedure) ORDER BY proname`)).rows;
    const functionBefore = await functions();
    const original = await readFile(new URL('../supabase/migrations/20261125_survey_invitation_attendee.sql', import.meta.url), 'utf8');
    ensure(functionBefore.length === 2 && functionBefore.every(f => functionNames.includes(f.proname)
      && f.prosrc.trim() === functionBody(original, f.proname)), 'survey_functions_changed_since_review');
    const triggers = async () => (await c.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,
      pg_get_functiondef(t.tgfoid) function_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('booking','complex_event_booking','event_invoice_recovery',
        'member','certificate_survey_entitlement') AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
    const triggerBefore = await triggers();
    const readBooking = async (t, lock = false) => {
      const rows = (await c.query(`SELECT to_jsonb(b) row FROM booking b WHERE tenant_id=$1
        AND (id=$2 OR xero_invoice_id=$3 OR booking_group_reference=$4) ${lock ? 'FOR UPDATE' : ''}`,
      [TENANT, t.bookingId, t.id, t.group])).rows;
      ensure(rows.length === 1, 'booking_cardinality_failed');
      return rows[0].row;
    };
    const readRecovery = async (t, lock = false) => {
      const rows = (await c.query(`SELECT to_jsonb(r) row FROM event_invoice_recovery r WHERE tenant_id=$1
        AND (id=$2 OR invoice_id=$3 OR booking_group_reference=$4) ${lock ? 'FOR UPDATE' : ''}`,
      [TENANT, t.recoveryId, t.id, t.group])).rows;
      ensure(rows.length === 1, 'recovery_cardinality_failed');
      return rows[0].row;
    };
    const before = [];
    for (const t of PINS) {
      const b = await readBooking(t, true), r = await readRecovery(t, true), i = await provider(t);
      ensure(b.id === t.bookingId && b.xero_invoice_id === t.id && b.xero_invoice_number === t.number
        && b.booking_group_reference === t.group && b.invoice_recovery_status === 'complete'
        && b.accounting_invoice_id === null && b.accounting_invoice_number === null && b.accounting_provider === null
        && r.id === t.recoveryId && r.invoice_id === t.id && r.invoice_number === t.number
        && r.booking_group_reference === t.group && r.source === 'booking' && r.status === 'complete'
        && r.xero_tenant_id === XERO_TENANT && !r.lease_token && !r.lease_expires_at
        && b.stripe_payment_intent_id === r.settlement_payment_intent_id
        && b.invoice_recovery_next_attempt_at === r.next_attempt_at
        && i.Payments.some(p => p.PaymentID === r.payment_id), 'exact_binding_or_mirror_state_changed');
      ensure((await c.query(`SELECT id FROM complex_event_booking WHERE tenant_id=$1
        AND (xero_invoice_id=$2 OR booking_group_reference=$3)`, [TENANT, t.id, t.group])).rowCount === 0,
      'cross_source_binding_conflict');
      before.push({ booking: b, recovery: r, provider: i });
    }
    const surveys = async (lock = false) => {
      const entitlements = (await c.query(`SELECT to_jsonb(e) row FROM certificate_survey_entitlement e
        WHERE tenant_id=$1 AND booking_source='standard' AND booking_id=ANY($2::uuid[])
        ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [TENANT, PINS.map(t => t.bookingId)])).rows.map(r => r.row);
      const confirmations = (await c.query(`SELECT to_jsonb(a) row FROM survey_invitation_attendee a
        WHERE entitlement_id=ANY($1::uuid[]) ORDER BY entitlement_id ${lock ? 'FOR UPDATE' : ''}`,
      [entitlements.map(e => e.id)])).rows.map(r => r.row);
      return { entitlements, confirmations };
    };
    const surveyBefore = await surveys(true);
    await record({ phase: 'preflight', before, surveyBefore, functionBefore, triggerBefore });
    await c.query(migration);
    const functionAfter = await functions();
    ensure(functionAfter.length === 2 && functionAfter.every((f, n) =>
      f.prosrc.trim() === functionBody(migration, f.proname)
      && hash({ ...f, prosrc: '' }) === hash({ ...functionBefore[n], prosrc: '' })),
    'migration_function_or_privilege_verification_failed');
    const triggerAfter = await triggers();
    ensure(hash(triggerBefore.map(t => ({ ...t, function_definition:
      functionNames.some(n => t.function_definition.includes(`FUNCTION public.${n}()`)) ? '' : t.function_definition })))
      === hash(triggerAfter.map(t => ({ ...t, function_definition:
        functionNames.some(n => t.function_definition.includes(`FUNCTION public.${n}()`)) ? '' : t.function_definition }))),
    'unrelated_trigger_changed');
    const after = [];
    for (const [n, t] of PINS.entries()) {
      const b = before[n].booking, r = before[n].recovery;
      const updatedB = (await c.query(`UPDATE booking b SET xero_invoice_number=$1
        WHERE tenant_id=$2 AND id=$3 AND booking_group_reference=$4 AND xero_invoice_id=$5
        AND xero_invoice_number=$6 AND invoice_recovery_status='complete' AND to_jsonb(b)=$7::jsonb
        RETURNING to_jsonb(b) row`, [t.assigned, TENANT, t.bookingId, t.group, t.id, t.number, JSON.stringify(b)])).rows;
      ensure(updatedB.length === 1, 'booking_cas_failed');
      assertOnlyNumberChanged(b, updatedB[0].row, 'xero_invoice_number', t.assigned);
      const updatedR = (await c.query(`UPDATE event_invoice_recovery r SET invoice_number=$1
        WHERE tenant_id=$2 AND id=$3 AND booking_group_reference=$4 AND invoice_id=$5
        AND invoice_number=$6 AND status='complete' AND lease_token IS NULL AND lease_expires_at IS NULL
        AND to_jsonb(r)=$7::jsonb RETURNING to_jsonb(r) row`,
      [t.assigned, TENANT, t.recoveryId, t.group, t.id, t.number, JSON.stringify(r)])).rows;
      ensure(updatedR.length === 1, 'recovery_cas_failed');
      assertOnlyNumberChanged(r, updatedR[0].row, 'invoice_number', t.assigned);
      // Re-read after AFTER triggers, not just RETURNING from the UPDATE.
      const finalB = await readBooking(t), finalR = await readRecovery(t);
      assertOnlyNumberChanged(b, finalB, 'xero_invoice_number', t.assigned);
      assertOnlyNumberChanged(r, finalR, 'invoice_number', t.assigned);
      const finalProvider = await provider(t);
      ensure(hash(finalProvider) === hash(before[n].provider), 'provider_changed_during_local_sync');
      after.push({ booking: finalB, recovery: finalR, provider: finalProvider });
    }
    const surveyAfter = await surveys();
    ensure(hash(surveyBefore) === hash(surveyAfter), 'survey_confirmation_or_entitlement_changed');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await record({ phase: 'verified_before_commit', after, surveyAfter, functionAfter,
      migrationSha256, sqlMirrorRows: 4, providerWrites: 0 });
    await c.query('COMMIT');
    committed = true;
    for (const [n, t] of PINS.entries()) {
      ensure(hash(await readBooking(t)) === hash(after[n].booking)
        && hash(await readRecovery(t)) === hash(after[n].recovery), 'post_commit_local_verification_failed');
    }
    ensure(hash(await surveys()) === hash(surveyBefore), 'post_commit_survey_verification_failed');
    const summary = { phase: 'complete', project: PROJECT, migration: MIGRATION, migrationSha256,
      sqlMirrorRows: 4, providerWrites: 0, surveyEntitlements: surveyBefore.entitlements.length,
      surveyConfirmations: surveyBefore.confirmations.length, surveyAndAllNonNumberFieldsUnchanged: true,
      mappings: PINS.map((t, n) => ({ invoiceId: t.id, bookingId: t.bookingId, recoveryId: t.recoveryId,
        providerNumber: t.assigned, bookingNumber: t.assigned, recoveryNumber: t.assigned,
        surveyRevision: after[n].booking.survey_invitation_revision,
        status: after[n].provider.Status, total: after[n].provider.Total, paid: after[n].provider.AmountPaid,
        due: after[n].provider.AmountDue })) };
    await record(summary);
    console.log(JSON.stringify(summary));
  } catch (error) {
    if (!committed) await c?.query('ROLLBACK').catch(() => {});
    const code = /^[a-z0-9_]+$/.test(error?.message || '') ? error.message : 'operation_failed_private_audit_required';
    await record({ phase: 'stopped', code, committed, providerWrites: 0 });
    console.log(JSON.stringify({ stopped: true, code, committed, providerWrites: 0 }));
    process.exitCode = 1;
  } finally { await c?.end(); await audit.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Reviewed arguments or audit unavailable; no operation attempted.'); process.exitCode = 1; });