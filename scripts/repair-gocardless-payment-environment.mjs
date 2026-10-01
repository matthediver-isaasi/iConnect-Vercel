#!/usr/bin/env node
// Offline review by default. --preflight is SELECT-only. --apply is a separate,
// explicit approval of the runner + additive migration + pinned audit evidence.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261124_gocardless_payment_environment.sql';
export const EVIDENCE_SHA256 = '791923c13ee2c8dadbd990fca31908c8b12cc0a61e4e2087b97e2df18c6cf9ea';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const hash = value => createHash('sha256').update(value).digest('hex');
const tables = ['membership_payment_plans', 'membership_billing_agreements',
  'gocardless_collection_reservations', 'gocardless_payments'];
const fail = message => { throw new Error(message); };

// Reviewed SELECT-only introspection: exactly the four existing BEFORE guards.
// Reject new triggers/rules before DML, including any external side effects that
// a transaction rollback could not undo. Never disable existing protections.
export async function verifyPaymentGuards(client) {
  const { rows } = await client.query(`SELECT t.tgname,t.tgenabled,t.tgtype,
    pg_get_triggerdef(t.oid) definition,p.proname,md5(p.prosrc) body_md5,
    p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.gocardless_payments'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`);
  if (hash(JSON.stringify(rows)) !== '018bc1eef82dec1757f5f6e5a352b77b039f32480ad08dbbfbe1798a6338d430') {
    fail('Payment trigger contract drift; no repair permitted');
  }
  const rules = await client.query("SELECT count(*)::integer count FROM pg_rewrite WHERE ev_class='public.gocardless_payments'::regclass");
  if (rules.rows[0].count !== 0) fail('Unexpected payment rules; no repair permitted');
}

export function validateArgs(args) {
  if (args.some(arg => !['--apply', '--preflight'].includes(arg)
    && !/^--review-sha256=[a-f0-9]{64}$/.test(arg) && !/^--evidence=.+$/.test(arg))
    || new Set(args.map(arg => arg.split('=')[0])).size !== args.length
    || (args.includes('--apply') && args.includes('--preflight'))) fail('Invalid or conflicting repair arguments');
  const options = { apply: args.includes('--apply'), preflight: args.includes('--preflight'),
    evidence: args.find(arg => arg.startsWith('--evidence='))?.slice(11),
    review: args.find(arg => arg.startsWith('--review-sha256='))?.slice(16) };
  if ((options.apply || options.preflight) && !options.evidence) fail('Pinned evidence file required');
  return options;
}

export function validateEvidence(bytes) {
  if (hash(bytes) !== EVIDENCE_SHA256) fail('Audit evidence SHA-256 mismatch');
  const evidence = JSON.parse(bytes);
  const { summary, matched, plans } = evidence;
  if (summary.destination !== 'lvmzliemqnieeoruhkik' || summary.tenantId !== TENANT
    || summary.problems.length || matched.length !== 355 || plans.length !== 355
    || summary.safeEnvironmentRepairCount !== 355 || summary.providerConfirmedCount !== 355
    || summary.databaseWrites !== 0 || summary.providerWrites !== 0) fail('Audit cohort is not fully verified');
  for (const key of ['canonicalPaymentRowId', 'providerPaymentId', 'planId', 'reservationId']) {
    if (new Set(matched.map(row => row[key])).size !== 355) fail('Duplicate audit identity');
  }
  if (matched.reduce((n, row) => n + row.amountMinor, 0) !== 403646
    || matched.filter(row => row.cohort === 'Beta').length !== 10
    || matched.filter(row => row.cohort === 'main').length !== 345) fail('Audit totals mismatch');
  for (const row of matched) {
    if (row.tenantId !== TENANT || row.providerEnvironment !== 'live' || row.planEnvironment !== 'live'
      || row.canonicalEnvironment !== 'sandbox' || !row.safeEnvironmentRepairCandidate
      || Object.values(row.checks).some(value => value !== true)
      || row.currency !== 'GBP' || row.chargeDate !== '2026-10-06'
      || row.canonicalStatus !== 'pending_submission' || row.reservationStatus !== 'submitted'
      || summary.extras.some(extra => extra.providerPaymentId === row.providerPaymentId)) fail('Unverified or excluded audit row');
  }
  return evidence;
}

// Compare the captured audit, not a mandate-wide or date-wide inference.
export async function verifyExpectedBefore(client, evidence) {
  const ids = evidence.matched.map(row => row.canonicalPaymentRowId);
  const { rows } = await client.query(`SELECT to_jsonb(c) payment,to_jsonb(p) plan,
    to_jsonb(a) agreement,to_jsonb(r) reservation
    FROM public.gocardless_payments c
    JOIN public.membership_payment_plans p ON p.id=c.plan_id AND p.tenant_id=c.tenant_id
    JOIN public.membership_billing_agreements a ON a.id=p.billing_agreement_id AND a.tenant_id=p.tenant_id
    JOIN public.gocardless_collection_reservations r ON r.plan_id=p.id AND r.tenant_id=p.tenant_id
      AND r.gocardless_payment_id=c.gocardless_payment_id
    WHERE c.id=ANY($1::uuid[]) AND c.tenant_id=$2`, [ids, TENANT]);
  if (rows.length !== 355 || new Set(rows.map(row => row.payment.id)).size !== 355) fail('Expected-before cohort missing or ambiguous');
  const byId = new Map(rows.map(row => [row.payment.id, row]));
  for (const expected of evidence.matched) {
    const { payment: c, plan: p, agreement: a, reservation: r } = byId.get(expected.canonicalPaymentRowId) || {};
    const same = (actual, wanted) => actual === wanted;
    const checks = [
      [c?.tenant_id, expected.tenantId], [c?.plan_id, expected.planId],
      [c?.gocardless_payment_id, expected.providerPaymentId], [c?.environment, expected.canonicalEnvironment],
      [c?.gocardless_mandate_id, expected.providerMandateId], [c?.amount_minor, expected.amountMinor],
      [c?.currency, expected.currency], [c?.charge_date, expected.chargeDate], [c?.status, expected.canonicalStatus],
      // Audit JSON timestamps have millisecond precision; compare the same precision.
      [Date.parse(c?.updated_at), Date.parse(expected.canonicalUpdatedAt)],
      [p?.billing_agreement_id, expected.billingAgreementId], [p?.environment, 'live'],
      [p?.provider, 'gocardless'], [p?.gocardless_mandate_id, expected.providerMandateId],
      [a?.id, expected.billingAgreementId], [a?.environment, 'live'], [a?.provider, 'gocardless'],
      [a?.gocardless_mandate_id, expected.providerMandateId],
      [r?.id, expected.reservationId], [r?.billing_agreement_id, expected.billingAgreementId],
      [r?.amount_minor, expected.amountMinor], [r?.currency, expected.currency],
      [r?.due_date, expected.dueDate], [r?.requested_charge_date, expected.requestedChargeDate],
      [r?.status, expected.reservationStatus],
    ];
    if (checks.some(([actual, wanted]) => !same(actual, wanted))) fail('Expected-before identity, value, timestamp or environment drift; re-audit required');
  }
  return ids;
}

// Exact rows (including metadata/updated_at/status/consent/holds) must remain
// unchanged. Only environment on the 355 approved payment row IDs is excluded.
export async function snapshot(client, ids) {
  const result = {};
  for (const table of tables) {
    const expression = table === 'gocardless_payments'
      ? "CASE WHEN t.id=ANY($1::uuid[]) THEN to_jsonb(t)-'environment' ELSE to_jsonb(t) END"
      : 'to_jsonb(t)';
    result[table] = (await client.query(`SELECT count(*)::integer count,
      md5(coalesce(string_agg(md5((${expression})::text),'' ORDER BY t.id),'')) digest
      FROM public.${table} t`, table === 'gocardless_payments' ? [ids] : [])).rows[0];
  }
  return result;
}

export async function applyRepair(client, sql, evidence) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='60s'");
    await client.query(`LOCK TABLE ${tables.map(table => `public.${table}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    await verifyPaymentGuards(client);
    const ids = await verifyExpectedBefore(client, evidence);
    const before = await snapshot(client, ids);
    await client.query(sql);
    // Never invoke attach/reserve/authorize, lifecycle RPCs, provider APIs or cron.
    // Existing guards remain enabled; no updated_at/metadata or other column SET.
    const updated = await client.query(`UPDATE public.gocardless_payments SET environment='live'
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND environment='sandbox'
      RETURNING id,environment`, [TENANT, ids]);
    if (updated.rowCount !== 355 || updated.rows.some(row => row.environment !== 'live')) fail('Exact label update count mismatch');
    const after = await snapshot(client, ids);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('Non-environment financial state changed; rolling back');
    const verified = await client.query(`SELECT count(*)::integer count FROM public.gocardless_payments
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND environment='live'`, [TENANT, ids]);
    if (verified.rows[0].count !== 355) fail('Environment postcondition failed');
    await client.query('COMMIT');
    return { updatedPayments: 355, main: 345, beta: 10, nonEnvironmentFinancialStateUnchanged: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = validateArgs(args);
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const runner = await readFile(new URL(import.meta.url));
  const reviewSha256 = hash(Buffer.concat([runner, Buffer.from('\n'), Buffer.from(sql)]));
  const review = { migration: MIGRATION, migrationSha256: hash(sql), reviewSha256,
    evidenceSha256: EVIDENCE_SHA256, writesPerformed: false };
  if (!options.apply && !options.preflight) return console.log(JSON.stringify(review));
  if (options.apply && options.review !== reviewSha256) fail('Reviewed runner/migration SHA-256 mismatch');
  const evidence = validateEvidence(await readFile(options.evidence));
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) fail('Unable to fetch destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) fail('Invalid destination CA');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname }, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    if (options.preflight) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='60s'");
      await verifyPaymentGuards(client);
      await verifyExpectedBefore(client, evidence);
      const functions = (await client.query(`SELECT proname,md5(prosrc) body_md5 FROM pg_proc
        WHERE oid IN (to_regprocedure('public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb)'),
          to_regprocedure('public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb)'))`)).rows;
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ...review, expectedBeforeVerified: 355, functions }));
    } else {
      console.log(JSON.stringify({ ...review, ...await applyRepair(client, sql, evidence), writesPerformed: true }));
    }
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never print credentials, connection URLs, provider payloads or financial rows.
    console.error(JSON.stringify({ success: false, code: error.code || 'VALIDATION_FAILED',
      message: error.code ? 'Database operation failed; no success confirmed. Review before retrying.' : error.message }));
    process.exitCode = 1;
  });
}