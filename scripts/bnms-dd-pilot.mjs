#!/usr/bin/env node
// Evidence-only preflight. No apply/resume or provider mutation is implemented.
import { createHash } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MEMBER_ID = '33e5d54d-162e-436d-9bff-ec6676d198f9';
export const CUSTOMER_ID = 'CU00426EF15CE5';
export const MANDATE_ID = 'MD00330XE0B797';
export const SOURCE_ROW = 4;
export const APPROVED_MONTHLY_AMOUNT_MINOR = 1300;
export const WORKBOOK_SHA256 = 'f42f1950e98b48c2d298c8db46cb88f3bd89e7794672f7e56c6fc40eb4f146c2';
export const CUTOVER = '2026-10-01';
// Confirmed by the user for BNMS: Xero invoices drive one-off GC payments.
// This describes the existing arrangement, not permission to take over billing.
export const SCHEDULE_SOURCE = Object.freeze({
  source: 'xero', collectionMechanism: 'one_off_gocardless_payments',
  evidence: 'user_confirmed', subscriptionExpected: false, handoverVerified: false,
});
export const MONTHS = Object.freeze(Array.from({ length: 9 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`));
const HEADERS = ['match_outcome', 'customer_email', 'normalized_email', 'iConnect Email address', 'iConnect UUID', 'gocardless_customer_id', 'gocardless_mandate_id', 'mandate_status', 'matched_member_id', 'error_message'];
class PreflightError extends Error {}
const fail = (message) => { throw new PreflightError(message); };
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export function assertPilot(id) {
  if (id !== MEMBER_ID) fail('Only the immutable approved pilot is authorized');
}

export function validateGrid(grid) {
  if (JSON.stringify(grid[0]) !== JSON.stringify(HEADERS) || grid.length !== 48) fail('Workbook shape drift: expected exact headers and 47 rows');
  const rows = grid.slice(1).map((cells, index) => ({
    sourceRow: index + 2, memberId: String(cells[4] || '').trim(),
    customerId: String(cells[5] || '').trim(), mandateId: String(cells[6] || '').trim(),
    email: String(cells[3] || '').trim().toLowerCase(),
  }));
  const first = rows[SOURCE_ROW - 2];
  assertPilot(first.memberId);
  if (first.customerId !== CUSTOMER_ID || first.mandateId !== MANDATE_ID) fail('Pilot provider identity drift');
  if (rows.filter((r) => r.memberId === MEMBER_ID || r.customerId === CUSTOMER_ID || r.mandateId === MANDATE_ID).length !== 1) fail('Conflicting pilot spreadsheet identities');
  return first;
}

export function readWorkbook(file) {
  const bytes = readFileSync(file);
  if (digest(bytes) !== WORKBOOK_SHA256) fail('Workbook fingerprint mismatch');
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  if (workbook.SheetNames.length !== 1) fail('Workbook sheet drift');
  return validateGrid(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' }));
}

// Bound and exhaust every cursor; missing cursor metadata never means "complete".
export async function readAllProviderPages(get, resource, filter) {
  const rows = []; const cursors = new Set(); const ids = new Set();
  let after = null;
  for (let page = 0; page < 1000; page += 1) {
    const body = await get(resource, { ...filter, limit: '500', ...(after ? { after } : {}) });
    if (!Array.isArray(body?.[resource]) || !Object.hasOwn(body?.meta?.cursors || {}, 'after')) fail(`Incomplete ${resource} pagination`);
    for (const row of body[resource]) {
      if (!row?.id || ids.has(row.id)) fail(`Duplicate or missing ${resource} identity`);
      ids.add(row.id); rows.push(row);
    }
    const next = body.meta.cursors.after;
    if (next === null) return rows;
    if (typeof next !== 'string' || !next.trim() || cursors.has(next) || !body[resource].length) fail(`Invalid ${resource} cursor`);
    cursors.add(next); after = next;
  }
  fail(`Exceeded ${resource} pagination bound`);
}

export function providerReader(credentials, transport = fetch) {
  if (credentials.source !== 'tenant' || credentials.tenantId !== TENANT_ID || credentials.environment !== 'live'
    || !credentials.accessToken || credentials.accessToken.startsWith('sandbox_')) fail('Verified BNMS live tenant credentials required');
  return async (resource, query = {}) => {
    if (!/^(subscriptions|payments|mandates\/[A-Z0-9]+|customers\/[A-Z0-9]+)$/.test(resource)) fail('Provider resource outside read-only allowlist');
    const url = new URL(`https://api.gocardless.com/${resource}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await transport(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'GoCardless-Version': '2015-07-06' },
    });
    if (!response.ok) fail(`GoCardless evidence read failed (HTTP ${response.status})`);
    return response.json();
  };
}

async function readRows(db, table, configure) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await configure(db.from(table).select('*')).order('id').range(offset, offset + 499);
    if (error) fail(`Destination ${table} evidence read failed`);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export function makeManifest({ pilot, member, memberClass, mappings, structures, mandate, customer, subscriptions, payments, existing }) {
  assertPilot(pilot.memberId);
  const blockers = ['PROMOTION_NOT_IMPLEMENTED', 'XERO_INVOICE_EVIDENCE_NOT_RECONCILED',
    'XERO_HANDOVER_NOT_VERIFIED', 'PRICE_AND_TERM_APPROVAL_REQUIRED'];
  if (member?.tenant_id !== TENANT_ID || member?.id !== MEMBER_ID || String(member.email || '').trim().toLowerCase() !== pilot.email
    || member.deleted_at || member.is_deleted === true) blockers.push('MEMBER_IDENTITY_CONFLICT');
  if (mandate?.id !== MANDATE_ID || mandate?.links?.customer !== CUSTOMER_ID || mandate?.status !== 'active'
    || customer?.id !== CUSTOMER_ID) blockers.push('MANDATE_CUSTOMER_CONFLICT');
  const matches = mappings.filter((m) => m.member_class === memberClass);
  const structure = matches.length === 1 ? structures.find((s) => s.id === matches[0].structure_id && s.tenant_id === TENANT_ID
    && s.is_active === true && s.structure_scope_type === 'member'
    && s.structure_match_value === memberClass
    && (!s.effective_from || s.effective_from <= CUTOVER)
    && (!s.effective_to || s.effective_to >= CUTOVER)) : null;
  if (!memberClass || !structure) blockers.push('CLASS_MAPPING_UNRESOLVED');
  const active = subscriptions.filter((s) => s.status === 'active');
  // An empty subscription list is expected for invoice-driven one-off payments.
  // Any discovered subscription is additional schedule evidence, never ignored.
  if (subscriptions.length) {
    blockers.push('EXISTING_SUBSCRIPTIONS_REQUIRE_RECONCILIATION');
    if (active.length !== 1) blockers.push('SUBSCRIPTION_AMBIGUOUS');
    if (subscriptions.some((s) => s.links?.mandate !== MANDATE_ID)) blockers.push('SUBSCRIPTION_MANDATE_CONFLICT');
  }
  const subscription = active.length === 1 ? active[0] : null;
  if (subscription && (subscription.interval_unit !== 'monthly' || Number(subscription.interval) !== 1
    || Number(subscription.day_of_month) !== 1 || subscription.currency !== 'GBP')) blockers.push('COLLECTION_SCHEDULE_CONFLICT');
  if (existing.agreements.length || existing.history.length || existing.plans.length) blockers.push('EXISTING_MEMBERSHIP_REQUIRES_RECONCILIATION');
  if (payments.some((p) => p.links?.mandate !== MANDATE_ID)) blockers.push('PAYMENT_MANDATE_CONFLICT');
  const history = MONTHS.map((period) => {
    const evidence = payments.filter((p) => p.charge_date?.slice(0, 7) === period.slice(0, 7));
    const issues = [];
    if (evidence.length !== 1) issues.push('PAYMENT_MISSING_OR_AMBIGUOUS');
    if (evidence.some((p) => !['confirmed', 'paid_out'].includes(p.status))) issues.push('PAYMENT_NOT_SETTLED');
    if (evidence.some((p) => !Number.isInteger(p.amount) || p.amount <= 0 || p.currency !== 'GBP')) issues.push('AMOUNT_OR_CURRENCY_UNRESOLVED');
    if (subscription && evidence.some((p) => p.links?.subscription !== subscription.id)) issues.push('PAYMENT_SUBSCRIPTION_CONFLICT');
    issues.push('MEMBERSHIP_PERIOD_AND_XERO_INVOICE_UNVERIFIED');
    return { period, status: 'needs_review', payments: evidence, issues };
  });
  return {
    version: 2, mode: 'evidence_only', readyToApply: false, writesPerformed: 0,
    existingSchedule: { ...SCHEDULE_SOURCE },
    tenantId: TENANT_ID, memberId: MEMBER_ID, customerId: CUSTOMER_ID, mandateId: MANDATE_ID,
    workbookSha256: WORKBOOK_SHA256, sourceRow: SOURCE_ROW, cutover: CUTOVER, nominatedDay: 1,
    approvedMonthlyAmountMinor: APPROVED_MONTHLY_AMOUNT_MINOR,
    memberClass, structureId: structure?.id || null, blockers, history,
    mandate, subscription, subscriptions, customer: { id: customer?.id },
    octoberPaymentEvidence: payments.filter((p) => p.charge_date?.slice(0, 7) === '2026-10'),
    existing,
  };
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workbook', '--class-map', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) fail('Usage: --workbook PATH --class-map PATH --out /tmp/PRIVATE-NEW-FILE.json; apply/resume are deliberately unavailable');
    options[args[i]] = args[i + 1];
  }
  if (!options['--workbook'] || !options['--class-map'] || !options['--out']) fail('workbook, explicit class-map and private output path are required');
  const out = resolve(options['--out']);
  if (!out.startsWith('/tmp/')) fail('Audit output must be outside the repository under /tmp');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  const pilot = readWorkbook(opts['--workbook']);
  const mappings = JSON.parse(readFileSync(opts['--class-map'], 'utf8'));
  if (!Array.isArray(mappings) || mappings.some((m) => typeof m.member_class !== 'string' || typeof m.structure_id !== 'string')) fail('class-map must be an array of { member_class, structure_id }; use [] for unresolved review');
  if (process.env.DEST_SUPABASE_URL !== 'https://lvmzliemqnieeoruhkik.supabase.co' || !process.env.DEST_SUPABASE_KEY) fail('Pinned destination credentials required');
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const tenant = await readRows(db, 'tenant', (q) => q.eq('id', TENANT_ID));
  if (tenant.length !== 1 || !/\bbnms\b|british nuclear medicine society/i.test(tenant[0].name)) fail('BNMS destination verification failed');
  const members = await readRows(db, 'member', (q) => q.eq('tenant_id', TENANT_ID).eq('id', MEMBER_ID));
  if (members.length !== 1) fail('Pinned pilot member missing');
  const fields = await readRows(db, 'preference_field', (q) => q.eq('tenant_id', TENANT_ID).eq('name', 'member_class').eq('entity_scope', 'member').eq('is_active', true));
  if (fields.length !== 1) fail('Member class field ambiguous');
  const values = await readRows(db, 'member_preference_value', (q) => q.eq('member_id', MEMBER_ID).eq('field_id', fields[0].id));
  const structures = await readRows(db, 'membership_tier_config', (q) => q.eq('tenant_id', TENANT_ID));
  const agreements = await readRows(db, 'membership_billing_agreements', (q) => q.eq('tenant_id', TENANT_ID).eq('member_id', MEMBER_ID));
  const history = await readRows(db, 'member_membership_history', (q) => q.eq('tenant_id', TENANT_ID).eq('member_id', MEMBER_ID));
  const plans = await readRows(db, 'membership_payment_plans', (q) => q.eq('tenant_id', TENANT_ID).eq('member_id', MEMBER_ID));
  const credentials = await getTenantGocardlessCredentials(TENANT_ID, { db });
  const get = providerReader(credentials);
  const mandate = (await get(`mandates/${MANDATE_ID}`)).mandates;
  const customer = (await get(`customers/${CUSTOMER_ID}`)).customers;
  const subscriptions = await readAllProviderPages(get, 'subscriptions', { mandate: MANDATE_ID });
  const payments = await readAllProviderPages(get, 'payments', { mandate: MANDATE_ID });
  const manifest = makeManifest({ pilot, member: members[0], memberClass: values.length === 1 ? values[0].value : null,
    mappings, structures, mandate, customer, subscriptions, payments, existing: { agreements, history, plans } });
  const content = JSON.stringify(manifest, null, 2);
  const fd = openSync(resolve(opts['--out']), 'wx', 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
  console.log(JSON.stringify({ mode: manifest.mode, writesPerformed: 0, readyToApply: false, blockerCount: manifest.blockers.length, manifestSha256: digest(content) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof PreflightError ? error.message : 'BNMS pilot preflight failed while reading evidence or writing the private report; check file access and destination/provider availability. No promotion or provider mutation was attempted.');
    process.exitCode = 1;
  });
}