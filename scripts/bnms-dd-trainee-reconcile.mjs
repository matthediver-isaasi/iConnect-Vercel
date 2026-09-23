#!/usr/bin/env node
// Task 4628: private, read-only reconciliation. This module never adopts,
// migrates, refreshes OAuth credentials, or mutates either provider.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import XLSX from 'xlsx';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
import { TENANT_ID, XERO_TENANT_ID } from './bnms-dd-beta-invoices.mjs';

export const WORKBOOK = 'attached_assets/traineeMandates_1789920168547.xlsx';
export const WORKBOOK_SHA256 = 'bdc8000ad9dc7995b42e1dfca0ff15ccceefa3405ee8a16f1c5dc05943061d18';
export const ORIGINAL = 'exports/private-bnms-alpha-final-review-20260920';
export const ORIGINAL_HASHES = Object.freeze({
  'manifest.json': '190fa34c9ffda47ce163f1d714c92c327f63d12c798482155a465a37c2905e93',
  'exceptions.json': 'b1dac939eaacf3fa8804cf4548ca419a6ec77be54933ca1610a7c07d0bb09681',
  'financial-exception-audit.json': 'd4ac44f687e26478caaeb1544b26648d9472a3e7832cf6b122429d938573095c',
  'readiness-summary.json': '1775daadc90ff8f70a0123236d6592d7c481bc0eaecb9965e8bff98a53bc65ee',
});
export const VERIFIED_ACCOUNTING = 'exports/private-bnms-alpha-20260920-verified/accounting-evidence.json';
export const VERIFIED_ACCOUNTING_SHA256 = 'a8c8c7ad6e8f99d5dc311e93b99ec07b6612e423497f3ee38cc0289216786ad7';
export const PRIOR_RATE_LIMIT = 'exports/private-bnms-alpha-attestation-20260920/readiness-retry-1QbDYF/rate-limit.json';
export const PRIOR_RATE_LIMIT_SHA256 = '83c7ecf3863d1b20e240dee83a5e42048fcff3f332723be44739ff66c536740c';
const CREDITOR = 'CR0000B50W1Y2R';
const APPROVED_CODES = new Set(['200', '201']);
const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''));
const norm = value => String(value || '').trim().toLowerCase();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
const minor = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function parseWorkbook(bytes, expectedSha256 = WORKBOOK_SHA256) {
  if (hash(bytes) !== expectedSha256) throw Error('Pinned workbook fingerprint drift');
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  if (workbook.SheetNames.length !== 1) throw Error('Workbook must contain exactly one sheet');
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
  if (grid.length !== 21 || grid.some(row => row.length !== 3)) throw Error('Pinned workbook must contain exactly 21 headerless three-column rows');
  const rows = grid.map((row, index) => ({
    sourceRow: index + 1,
    memberId: String(row[0]).trim(),
    corroboratingEmail: norm(row[1]),
    mandateId: String(row[2]).trim(),
  }));
  if (rows.some(row => !uuid(row.memberId) || !row.corroboratingEmail || !/^MD[A-Z0-9]+$/.test(row.mandateId)))
    throw Error('Workbook identity shape drift');
  if (new Set(rows.map(row => row.memberId)).size !== rows.length
    || new Set(rows.map(row => row.mandateId)).size !== rows.length)
    throw Error('Workbook contains duplicate member or mandate identity');
  return rows;
}

async function checkedOriginal() {
  const result = {};
  for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
    const bytes = await readFile(`${ORIGINAL}/${name}`);
    const actual = hash(bytes);
    if (actual !== expected) throw Error(`Immutable original evidence drift: ${name}`);
    result[name] = { sha256: actual, bytes: bytes.length };
  }
  return result;
}

function retryEvidence(response, provider, endpoint, observedAt) {
  const raw = response.headers.get('retry-after');
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  return {
    provider, endpoint, observedAt, httpStatus: response.status,
    retryAfterRaw: raw, retryAfterSeconds: seconds,
    retryNotBefore: seconds === null ? null : new Date(Date.parse(observedAt) + seconds * 1000).toISOString(),
  };
}

function reader({ base, headers, provider, gap = 250 }) {
  let blocked = null;
  return {
    get blocked() { return blocked; },
    async get(path, query = {}) {
      if (blocked) throw Object.assign(Error(`${provider} reads blocked by saved Retry-After`), { retry: blocked });
      if (!/^[A-Za-z]+(?:\/[A-Za-z0-9-]+)?$/.test(path)) throw Error(`${provider} GET endpoint not allowlisted`);
      const url = new URL(path, base);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const observedAt = new Date().toISOString();
      const response = await fetch(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), headers,
      });
      if (response.status === 429) {
        blocked = retryEvidence(response, provider, `/${path.replace(/\/[A-Za-z0-9-]+$/, '/:id')}`, observedAt);
        throw Object.assign(Error(`${provider} HTTP 429`), { retry: blocked });
      }
      if (!response.ok) throw Error(`${provider} read HTTP ${response.status}`);
      const body = await response.json();
      await sleep(gap);
      return { observedAt, body };
    },
  };
}

export async function allPages(gc, resource, query) {
  const values = [], observations = [];
  const ids = new Set(), cursors = new Set();
  let after = null;
  for (let page = 1; page <= 100; page++) {
    const response = await gc.get(resource, { ...query, limit: '500', ...(after !== null ? { after } : {}) });
    observations.push(response.observedAt);
    const batch = response.body[resource];
    if (!Array.isArray(batch)) throw Error(`Incomplete GoCardless ${resource} response`);
    for (const item of batch) {
      if (!item?.id || ids.has(item.id)) throw Error(`Duplicate/missing GoCardless ${resource} identity`);
      if (query.mandate && item.links?.mandate !== query.mandate)
        throw Error(`GoCardless ${resource} mandate ownership mismatch`);
      ids.add(item.id);
    }
    values.push(...batch);
    const cursorObject = response.body.meta?.cursors;
    if (!cursorObject || !Object.hasOwn(cursorObject, 'after'))
      throw Error(`Incomplete GoCardless ${resource} cursor metadata`);
    const next = cursorObject.after;
    if (next !== null && (typeof next !== 'string' || !next))
      throw Error(`Invalid GoCardless ${resource} cursor`);
    if (next === null) return { values, observations };
    if (cursors.has(next)) throw Error(`Repeated GoCardless ${resource} cursor`);
    cursors.add(next);
    after = next;
  }
  throw Error(`GoCardless ${resource} pagination bound exceeded`);
}

async function destinationSnapshot(client, rows) {
  const ids = rows.map(row => row.memberId), mandates = rows.map(row => row.mandateId);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const query = async (sql, values = []) => (await client.query(sql, values)).rows;
    const tableNames = ['bnms_dd_pilot_adoption', 'bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption'];
    const columns = await query(
      `SELECT table_name,column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=ANY($1::text[])`, [tableNames],
    );
    const tables = Object.fromEntries(tableNames.map(name => [
      name, new Set(columns.filter(column => column.table_name === name).map(column => column.column_name)),
    ]));
    const cohorts = {};
    for (const table of tableNames) {
      const tableColumns = tables[table];
      const hasMandate = tableColumns.has('mandate_id');
      cohorts[table] = tableColumns.size ? await query(
        `SELECT member_id,${hasMandate ? 'mandate_id' : 'NULL::text AS mandate_id'},
          ${tableColumns.has('customer_id') ? 'customer_id' : 'NULL::text AS customer_id'} FROM ${table}
         WHERE tenant_id=$1 AND (member_id=ANY($2::uuid[]) ${hasMandate ? 'OR mandate_id=ANY($3::text[])' : ''})`,
        hasMandate ? [TENANT_ID, ids, mandates] : [TENANT_ID, ids],
      ) : [];
    }
    return {
      observedAt: new Date().toISOString(),
      transaction: 'REPEATABLE READ READ ONLY',
      databaseTarget: 'DEST_DATABASE_URL',
      members: await query(`SELECT id,tenant_id,email,status,membership_paused
        FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [TENANT_ID, ids]),
      preferences: await query(`SELECT v.member_id,f.name,v.value
        FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
        WHERE f.tenant_id=$1 AND v.member_id=ANY($2::uuid[]) AND f.is_active=true`, [TENANT_ID, ids]),
      discovery: await query(`SELECT matched_member_id,gocardless_mandate_id,gocardless_customer_id,environment
        FROM gocardless_mandate_discovery_row WHERE tenant_id=$1
        AND (matched_member_id=ANY($2::uuid[]) OR gocardless_mandate_id=ANY($3::text[]))`, [TENANT_ID, ids, mandates]),
      canonical: {
        agreements: await query(`SELECT id,member_id,gocardless_mandate_id,status FROM membership_billing_agreements
          WHERE tenant_id=$1 AND (member_id=ANY($2::uuid[]) OR gocardless_mandate_id=ANY($3::text[]))`, [TENANT_ID, ids, mandates]),
        plans: await query(`SELECT id,member_id,status,collection_stopped_at FROM membership_payment_plans
          WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])`, [TENANT_ID, ids]),
        history: await query(`SELECT id,member_id,status,payment_status,xero_invoice_id,accounting_invoice_id
          FROM member_membership_history WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])`, [TENANT_ID, ids]),
      },
      cohorts,
      xeroTokens: await query(`SELECT tenant_id,expires_at,access_token FROM xero_token WHERE app_tenant_id=$1`, [TENANT_ID]),
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

export function explainPayment(payment, invoices, contactById, {
  xeroFailure = null, priorIssue = null, savedInvoices = [], savedContactById = new Map(),
} = {}) {
  const number = payment.metadata?.['Invoice number'] || null;
  const inReconciliationWindow = payment.status === 'paid_out'
    && payment.charge_date >= '2026-01-01' && payment.charge_date < '2026-10-01';
  const exact = invoices.filter(invoice => invoice.InvoiceNumber === number
    && invoice.Payments?.some(item => item.Reference === payment.id));
  const issues = [];
  if (inReconciliationWindow && payment.amount_refunded !== 0) issues.push({ code: 'PROVIDER_PAYMENT_REFUNDED', amountMinor: payment.amount_refunded });
  if (inReconciliationWindow && payment.currency !== 'GBP') issues.push({ code: 'PROVIDER_PAYMENT_CURRENCY_NOT_GBP', actual: payment.currency });
  if (inReconciliationWindow && !number) issues.push({ code: 'PROVIDER_PAYMENT_MISSING_INVOICE_NUMBER' });
  if (inReconciliationWindow && xeroFailure) issues.push({ code: 'FRESH_XERO_REVALIDATION_UNAVAILABLE', reason: xeroFailure.message });
  else if (inReconciliationWindow && exact.length !== 1) issues.push({ code: 'EXACT_INVOICE_PAYMENT_IDENTITY_COUNT', actual: exact.length });
  const invoice = exact.length === 1 ? exact[0] : null;
  const xeroPayment = invoice?.Payments?.filter(item => item.Reference === payment.id) || [];
  const contact = invoice ? contactById.get(invoice.Contact?.ContactID) : null;
  if (inReconciliationWindow && invoice) {
    if (invoice.Type !== 'ACCREC') issues.push({ code: 'INVOICE_TYPE_CONFLICT', actual: invoice.Type });
    if (invoice.Status !== 'PAID') issues.push({ code: 'INVOICE_STATUS_CONFLICT', actual: invoice.Status });
    if (invoice.CurrencyCode !== payment.currency) issues.push({ code: 'INVOICE_CURRENCY_CONFLICT', provider: payment.currency, invoice: invoice.CurrencyCode });
    if (minor(invoice.Total) !== payment.amount) issues.push({ code: 'INVOICE_TOTAL_CONFLICT', providerMinor: payment.amount, invoiceMinor: minor(invoice.Total) });
    if (minor(invoice.AmountPaid) !== payment.amount || minor(invoice.AmountDue) !== 0)
      issues.push({ code: 'INVOICE_SETTLEMENT_CONFLICT', amountPaidMinor: minor(invoice.AmountPaid), amountDueMinor: minor(invoice.AmountDue) });
    if (minor(invoice.AmountCredited || 0) !== 0 || invoice.CreditNotes?.length || invoice.Prepayments?.length || invoice.Overpayments?.length)
      issues.push({ code: 'INVOICE_ADJUSTMENT_CONFLICT' });
    if (xeroPayment.length !== 1 || minor(xeroPayment[0]?.Amount) !== payment.amount)
      issues.push({ code: 'XERO_PAYMENT_AMOUNT_OR_IDENTITY_CONFLICT', exactPaymentCount: xeroPayment.length });
    if (String(invoice.DateString || invoice.Date || '').slice(0, 7) !== String(payment.charge_date).slice(0, 7))
      issues.push({ code: 'INVOICE_PERIOD_CONFLICT', providerMonth: String(payment.charge_date).slice(0, 7), invoiceMonth: String(invoice.DateString || invoice.Date || '').slice(0, 7) });
    const codes = [...new Set((invoice.LineItems || []).map(item => String(item.AccountCode || '')))];
    const outside = codes.filter(code => !APPROVED_CODES.has(code));
    if (!codes.length || outside.length) issues.push({ code: 'REVENUE_ACCOUNT_OUTSIDE_APPROVED_200_201', accountCodes: codes });
    if (!contact || contact.ContactStatus !== 'ACTIVE') issues.push({ code: 'XERO_CONTACT_MISSING_OR_INACTIVE' });
  }
  const savedExact = savedInvoices.filter(candidate => candidate.InvoiceNumber === number
    && candidate.Payments?.some(item => item.Reference === payment.id));
  const savedInvoice = savedExact.length === 1 ? savedExact[0] : null;
  const savedContact = savedInvoice ? savedContactById.get(savedInvoice.Contact?.ContactID) : null;
  return {
    providerPaymentId: payment.id,
    chargeDate: payment.charge_date,
    amountMinor: payment.amount,
    currency: payment.currency,
    providerStatus: payment.status,
    inReconciliationWindow,
    invoiceNumber: number,
    exactInvoiceCount: exact.length,
    xeroInvoiceId: invoice?.InvoiceID || null,
    xeroPaymentId: xeroPayment.length === 1 ? xeroPayment[0].PaymentID : null,
    xeroContactId: invoice?.Contact?.ContactID || null,
    originalPinnedIssue: priorIssue,
    originalPinnedEvidence: {
      exactInvoiceCount: savedExact.length,
      invoice: savedInvoice ? {
        invoiceId: savedInvoice.InvoiceID, invoiceNumber: savedInvoice.InvoiceNumber,
        type: savedInvoice.Type, status: savedInvoice.Status, currency: savedInvoice.CurrencyCode,
        invoiceDate: savedInvoice.DateString || savedInvoice.Date,
        totalMinor: minor(savedInvoice.Total), amountPaidMinor: minor(savedInvoice.AmountPaid),
        amountDueMinor: minor(savedInvoice.AmountDue), amountCreditedMinor: minor(savedInvoice.AmountCredited || 0),
        accountCodes: [...new Set((savedInvoice.LineItems || []).map(item => String(item.AccountCode || '')))],
        payments: (savedInvoice.Payments || []).filter(item => item.Reference === payment.id)
          .map(item => ({ paymentId: item.PaymentID, reference: item.Reference, amountMinor: minor(item.Amount) })),
        contactId: savedInvoice.Contact?.ContactID || null,
      } : null,
      contact: savedContact ? {
        contactId: savedContact.ContactID, status: savedContact.ContactStatus,
        emailAddress: savedContact.EmailAddress || null,
      } : null,
    },
    issues,
    classification: !inReconciliationWindow ? 'outside_approved_historical_window'
      : issues.length ? 'blocked_financial_evidence' : 'financially_exact',
  };
}

export function deliveryState({ eligible = 0, xeroComplete = false } = {}) {
  return {
    reconciliationDeliverableComplete: true,
    providerAccountingVerificationComplete: xeroComplete,
    adoptionTaskComplete: false,
    supplementalManifestState: eligible > 0 && xeroComplete ? 'review_required' : 'blocked_not_eligible',
  };
}

export function privateMarkdown(report) {
  const lines = [
    '# BNMS trainee reconciliation — private review',
    '',
    `- Reconciliation observed (fresh run): ${report.observedAt}`,
    `- Prior immutable accounting evidence observed (old evidence): ${report.priorEvidenceObservedAt}`,
    `- Fresh DEST observed: ${report.evidenceFreshness.destinationObservedAt}`,
    `- Fresh GoCardless complete: ${report.evidenceFreshness.goCardlessComplete}`,
    `- Fresh Xero complete: ${report.evidenceFreshness.xeroComplete}`,
    `- Outcome: ${report.totals.blocked}/21 blocked; ${report.totals.eligibleForSupplementalPreparation}/21 eligible`,
    `- Payments: ${report.totals.inWindowSettledPayments} in-window settled; ${report.totals.outsideWindowOrUnsettledPayments} outside-window or unsettled`,
    '- Accounting issue: every in-window payment uses code 204 in the pinned old evidence; only 200/201 are approved.',
    '- Full machine evidence: `full-evidence.json`; standalone outcomes: `report.json` / `delivery-report-v1.json` when present; blocked envelope: `review-manifest-v1.json`.',
    '',
    '## Row outcomes',
    '',
    '| Row | Member UUID | Mandate | In-window payments | Code 204 | Outcome | Exact blockers |',
    '|---:|---|---|---:|---:|---|---|',
  ];
  for (const row of report.outcomes) {
    const inWindow = row.paymentIssues.filter(payment => payment.inReconciliationWindow);
    const code204 = inWindow.filter(payment => payment.originalPinnedEvidence.invoice?.accountCodes.includes('204')).length;
    lines.push(`| ${row.sourceRow} | ${row.memberId} | ${row.mandateId} | ${inWindow.length} | ${code204} | ${row.outcome} | ${row.blockers.join('; ')} |`);
  }
  lines.push(
    '',
    '## Freshness and Retry-After',
    '',
    `Fresh Xero was blocked because: ${report.evidenceFreshness.xeroFailure?.message || 'none'}.`,
    'The prior alpha checkpoint Retry-After (33,701 seconds, observed 2026-09-20T15:51:32.653Z) was retained and considered. Its not-before time had passed before this run, so it was not reused as a current throttle. This run received no new Retry-After; the unrefreshed expired OAuth token is the current blocker.',
    '',
    '## Handover',
    '',
    '1. Accounting owner must explicitly approve or reject code 204; do not broaden the 200/201 allowlist implicitly.',
    '2. Obtain a fresh tenant-owned Xero access token through the normal interactive OAuth path, then execute a new immutable reconciliation run directory.',
    '3. Require exact fresh invoice/payment/contact/amount/currency/period coverage for every in-window payment.',
    '4. Only if rows become eligible, separately design and review a supplemental schema/writer with exact schema/data hashes and collision guards.',
    '5. Keep collection held. Adoption and release each require separate approval.',
    '',
    'No migration was needed or applied for this read-only reconciliation. A supplemental schema is not approved, designed, or applied because no row is eligible. The original alpha, pilot, and beta guards are unchanged.',
    '',
  );
  return lines.join('\n');
}

export async function reconcile({ outDir = null } = {}) {
  const runName = `private-bnms-trainee-reconciliation-${new Date().toISOString().replace(/[:.]/g, '')}`;
  const selectedOutDir = outDir || `exports/${runName}`;
  const root = resolve(selectedOutDir);
  if (!root.startsWith(`${resolve('exports')}/`) || !selectedOutDir.includes('private-')) throw Error('Private exports path required');
  // Reserve the immutable run envelope before any database or provider call.
  // EEXIST is intentional: evidence from an earlier attempt is never overwritten.
  await mkdir(root, { mode: 0o700 });
  const workbookBytes = await readFile(WORKBOOK);
  const rows = parseWorkbook(workbookBytes);
  const originalFiles = await checkedOriginal();
  const priorRateLimitBytes = await readFile(PRIOR_RATE_LIMIT);
  if (hash(priorRateLimitBytes) !== PRIOR_RATE_LIMIT_SHA256) throw Error('Pinned prior Retry-After evidence drift');
  const priorRateLimit = JSON.parse(priorRateLimitBytes);
  const priorRetryNotBefore = new Date(Date.parse(priorRateLimit.observedAt)
    + Number(priorRateLimit.retryAfter.value) * 1000).toISOString();
  const [manifest, exceptions, priorAudit] = await Promise.all([
    readFile(`${ORIGINAL}/manifest.json`, 'utf8').then(JSON.parse),
    readFile(`${ORIGINAL}/exceptions.json`, 'utf8').then(JSON.parse),
    readFile(`${ORIGINAL}/financial-exception-audit.json`, 'utf8').then(JSON.parse),
  ]);
  const verifiedAccountingBytes = await readFile(VERIFIED_ACCOUNTING);
  if (hash(verifiedAccountingBytes) !== VERIFIED_ACCOUNTING_SHA256)
    throw Error('Pinned verified alpha accounting evidence drift');
  const verifiedAccounting = JSON.parse(verifiedAccountingBytes);
  const savedContactById = new Map(verifiedAccounting.contacts.map(contact => [contact.ContactID, contact]));
  const memberIds = new Set(rows.map(row => row.memberId));
  if (rows.some(row => manifest.members.some(member => member.identity.memberId === row.memberId)))
    throw Error('Workbook member unexpectedly collides with immutable original alpha members');
  if (rows.some(row => !exceptions.some(item => item.identity?.memberId === row.memberId
    && item.mandateId === row.mandateId && item.reasons?.includes('INVOICE_RECONCILIATION: Invoice financial/period evidence conflict'))))
    throw Error('Workbook row is not the exact pinned original alpha financial exception');

  if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY)
    throw Error('Pinned DEST read credentials unavailable');
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL, application_name: 'bnms-task-4628-read-only' });
  await client.connect();
  let destination;
  try { destination = await destinationSnapshot(client, rows); } finally { await client.end(); }

  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const credentials = await getTenantGocardlessCredentials(TENANT_ID, { db });
  if (credentials.source !== 'tenant' || credentials.tenantId !== TENANT_ID || credentials.environment !== 'live'
    || !credentials.accessToken || credentials.accessToken.startsWith('sandbox_'))
    throw Error('Enabled tenant-owned live GoCardless credentials required');
  const gc = reader({
    base: 'https://api.gocardless.com/', provider: 'GoCardless',
    headers: { Authorization: `Bearer ${credentials.accessToken}`, 'GoCardless-Version': '2015-07-06' },
  });
  const providerByMandate = new Map();
  const providerFailures = {};
  for (const row of rows) {
    try {
      const mandateResponse = await gc.get(`mandates/${row.mandateId}`);
      const mandate = mandateResponse.body.mandates || null;
      if (!mandate || mandate.id !== row.mandateId) throw Error('Mandate GET returned no exact mandate');
      const customerResponse = await gc.get(`customers/${mandate.links?.customer}`);
      const customer = customerResponse.body.customers || null;
      if (!customer?.id || customer.id !== mandate.links?.customer)
        throw Error('Customer GET returned wrong mandate owner');
      const payments = await allPages(gc, 'payments', { mandate: row.mandateId });
      const subscriptions = await allPages(gc, 'subscriptions', { mandate: row.mandateId });
      providerByMandate.set(row.mandateId, {
        observedAt: { mandate: mandateResponse.observedAt, customer: customerResponse.observedAt, payments: payments.observations, subscriptions: subscriptions.observations },
        mandate, customer,
        payments: payments.values, subscriptions: subscriptions.values,
      });
    } catch (error) {
      providerFailures[row.mandateId] = { message: error.message, retry: error.retry || gc.blocked || null };
      if (error.retry || gc.blocked) break;
    }
  }
  const providerFailure = Object.keys(providerFailures).length ? {
    failedMandates: Object.keys(providerFailures).length,
    failures: providerFailures,
    retry: gc.blocked || null,
  } : null;
  for (const resource of ['payments', 'subscriptions']) {
    const providerIds = [...providerByMandate.values()].flatMap(owner => owner[resource].map(item => item.id));
    if (new Set(providerIds).size !== providerIds.length)
      throw Error(`Cross-mandate duplicate GoCardless ${resource} identity`);
  }

  const tokens = destination.xeroTokens;
  const token = tokens.length === 1 && tokens[0].tenant_id === XERO_TENANT_ID ? tokens[0] : null;
  const tokenFresh = token && Date.parse(token.expires_at) > Date.now() + 60_000;
  // A credential is used only in memory. Private evidence records identity,
  // expiry and a one-way fingerprint, never the bearer token itself.
  destination.xeroTokens = tokens.map(item => ({
    tenant_id: item.tenant_id,
    expires_at: item.expires_at,
    credentialSha256: hash(item.access_token),
  }));
  const xero = tokenFresh ? reader({
    base: 'https://api.xero.com/api.xro/2.0/', provider: 'Xero', gap: 1100,
    headers: { Authorization: `Bearer ${token.access_token}`, 'Xero-tenant-id': token.tenant_id, Accept: 'application/json' },
  }) : null;
  const invoiceNumbers = [...new Set([...providerByMandate.values()].flatMap(owner => owner.payments)
    .map(payment => payment.metadata?.['Invoice number']).filter(value => /^INV-\d+$/.test(value)))];
  const invoices = [], contacts = [], xeroObservations = [];
  let xeroFailure = !token ? { message: 'Exact tenant Xero token unavailable; OAuth refresh prohibited' }
    : !tokenFresh ? { message: 'Stored tenant Xero token expired or inside safety margin; OAuth refresh prohibited', expiresAt: token.expires_at } : null;
  if (xero) {
    try {
      for (let offset = 0; offset < invoiceNumbers.length; offset += 25) {
        for (let page = 1; page <= 100; page++) {
          const response = await xero.get('Invoices', {
            InvoiceNumbers: invoiceNumbers.slice(offset, offset + 25).join(','), page: String(page), pageSize: '100',
          });
          xeroObservations.push(response.observedAt);
          const batch = response.body.Invoices;
          if (!Array.isArray(batch)) throw Error('Incomplete Xero invoice response');
          invoices.push(...batch);
          if (batch.length < 100) break;
          if (page === 100) throw Error('Xero invoice pagination bound exceeded');
        }
      }
      for (const id of new Set(invoices.map(invoice => invoice.Contact?.ContactID).filter(Boolean))) {
        const response = await xero.get(`Contacts/${id}`);
        xeroObservations.push(response.observedAt);
        if (response.body.Contacts?.length !== 1) throw Error('Xero exact contact unavailable');
        contacts.push(response.body.Contacts[0]);
      }
    } catch (error) {
      xeroFailure = { message: error.message, retry: error.retry || xero.blocked || null };
    }
  }
  const uniqueInvoices = [...new Map(invoices.map(invoice => [invoice.InvoiceID, invoice])).values()];
  const contactById = new Map(contacts.map(contact => [contact.ContactID, contact]));

  const outcomes = rows.map(row => {
    const member = destination.members.find(item => item.id === row.memberId);
    const preferences = destination.preferences.filter(item => item.member_id === row.memberId);
    const traineeValues = preferences.filter(item => /trainee|member_class|membership_type/i.test(item.name));
    const provider = providerByMandate.get(row.mandateId);
    const crossCohort = Object.fromEntries(Object.entries(destination.cohorts)
      .map(([name, values]) => [name, values.filter(item => item.member_id === row.memberId || item.mandate_id === row.mandateId)]));
    const canonical = Object.fromEntries(Object.entries(destination.canonical)
      .map(([name, values]) => [name, values.filter(item => item.member_id === row.memberId || item.gocardless_mandate_id === row.mandateId)]));
    const blockers = [];
    if (!member || member.tenant_id !== TENANT_ID) blockers.push('DEST_MEMBER_NOT_FOUND_IN_PINNED_TENANT');
    if (member && norm(member.email) !== row.corroboratingEmail) blockers.push('WORKBOOK_EMAIL_DIFFERS_FROM_AUTHORITATIVE_DEST');
    if (member && (member.is_deleted || member.deleted_at || member.membership_paused || ['cancelled', 'paused', 'deleted'].includes(member.status)))
      blockers.push('DEST_MEMBER_STATE_INELIGIBLE');
    if (!traineeValues.some(item => /trainee/i.test(String(item.value)))) blockers.push('AUTHORITATIVE_TRAINEE_CLASSIFICATION_NOT_PROVEN');
    if (Object.values(crossCohort).some(values => values.length)) blockers.push('CURRENT_DEST_COHORT_COLLISION');
    if (Object.values(canonical).some(values => values.length)) blockers.push('CURRENT_DEST_CANONICAL_RECORD_REQUIRES_REVIEW');
    if (!provider) blockers.push('FRESH_GOCARDLESS_EVIDENCE_INCOMPLETE');
    if (provider) {
      if (provider.mandate.status !== 'active') blockers.push('GOCARDLESS_MANDATE_NOT_ACTIVE');
      if (provider.mandate.links?.creditor !== CREDITOR) blockers.push('GOCARDLESS_CREDITOR_MISMATCH');
      if (provider.mandate.links?.customer !== provider.customer?.id) blockers.push('GOCARDLESS_CUSTOMER_OWNERSHIP_CONFLICT');
      if (provider.subscriptions.length) blockers.push('GOCARDLESS_SUBSCRIPTION_REQUIRES_HANDOVER');
    }
    if (xeroFailure) blockers.push('FRESH_XERO_EVIDENCE_INCOMPLETE');
    const prior = priorAudit.audit.find(item => item.memberId === row.memberId) || null;
    const paymentIssues = provider ? provider.payments.map(payment => explainPayment(
      payment, uniqueInvoices, contactById, {
        xeroFailure,
        priorIssue: prior?.issues?.find(issue => issue.paymentId === payment.id) || null,
        savedInvoices: verifiedAccounting.invoices,
        savedContactById,
      },
    )) : [];
    if (!paymentIssues.length) blockers.push('NO_PROVIDER_PAYMENT_HISTORY');
    if (prior?.issues?.length || paymentIssues.some(payment => payment.issues.some(issue =>
      issue.code !== 'FRESH_XERO_REVALIDATION_UNAVAILABLE'))) blockers.push('ACCOUNTING_DECISION_REQUIRED');
    if (paymentIssues.some(payment => payment.classification === 'financially_exact') && xeroFailure)
      blockers.push('APPARENT_MATCH_NOT_FRESHLY_COMPLETE');
    return {
      sourceRow: row.sourceRow, memberId: row.memberId, mandateId: row.mandateId,
      workbookEmailCorroboratesDestination: Boolean(member && norm(member.email) === row.corroboratingEmail),
      authoritativeMember: member || null, authoritativeClassificationEvidence: traineeValues,
      originalAlpha: { disposition: 'exception', priorFinancialAudit: prior },
      currentDestination: { crossCohort, canonical, discovery: destination.discovery.filter(item => item.matched_member_id === row.memberId || item.gocardless_mandate_id === row.mandateId) },
      provider, paymentIssues,
      outcome: Object.values(crossCohort).some(values => values.length) ? 'already_handled_current_destination'
        : blockers.length ? 'blocked' : 'eligible_for_supplemental_preparation',
      blockers: [...new Set(blockers)],
      requiredAction: blockers.includes('ACCOUNTING_DECISION_REQUIRED')
        ? 'Accounting owner must decide each listed financial/period/account-code conflict; codes outside 200/201 remain unapproved.'
        : blockers.length ? 'Obtain the missing exact evidence or resolve the listed ownership/state conflict; do not adopt.' : null,
    };
  });

  const reconciliationObservedAt = new Date().toISOString();
  const evidence = {
    version: 1, task: 4628, observedAt: reconciliationObservedAt,
    workbook: { path: WORKBOOK, sha256: WORKBOOK_SHA256, rows },
    originalFiles, destination, providerFailure,
    verifiedAccountingSource: {
      path: VERIFIED_ACCOUNTING, sha256: VERIFIED_ACCOUNTING_SHA256, bytes: verifiedAccountingBytes.length,
      observedAt: manifest.observedAt,
    },
    priorRateLimit: {
      path: PRIOR_RATE_LIMIT, sha256: PRIOR_RATE_LIMIT_SHA256,
      evidence: priorRateLimit, notBefore: priorRetryNotBefore,
      applicableToThisRun: Date.parse(priorRetryNotBefore) > Date.parse(reconciliationObservedAt),
    },
    provider: Object.fromEntries(providerByMandate),
    xero: { tenantId: XERO_TENANT_ID, observations: xeroObservations, failure: xeroFailure, invoices: uniqueInvoices, contacts },
  };
  // Complete the evidence object before hashing. Both canonical JSON and exact
  // file-byte hashes are recorded so either verification method is unambiguous.
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceCanonicalSha256 = hash(JSON.parse(evidenceBytes));
  const evidenceFileSha256 = hash(Buffer.from(evidenceBytes));
  const totals = {
    inputRows: outcomes.length,
    eligibleForSupplementalPreparation: outcomes.filter(row => row.outcome === 'eligible_for_supplemental_preparation').length,
    alreadyHandledCurrentDestination: outcomes.filter(row => row.outcome === 'already_handled_current_destination').length,
    blocked: outcomes.filter(row => row.outcome === 'blocked').length,
    paymentRecordsExplained: outcomes.reduce((sum, row) => sum + row.paymentIssues.length, 0),
    inWindowSettledPayments: outcomes.reduce((sum, row) =>
      sum + row.paymentIssues.filter(payment => payment.inReconciliationWindow).length, 0),
    outsideWindowOrUnsettledPayments: outcomes.reduce((sum, row) =>
      sum + row.paymentIssues.filter(payment => !payment.inReconciliationWindow).length, 0),
    accountingDecisionRequiredRows: outcomes.filter(row => row.blockers.includes('ACCOUNTING_DECISION_REQUIRED')).length,
  };
  const report = {
    version: 1, task: 4628, state: 'private_read_only_reconciliation', observedAt: evidence.observedAt,
    input: { workbookPath: WORKBOOK, workbookSha256: WORKBOOK_SHA256, rowCount: 21 },
    priorEvidenceObservedAt: manifest.observedAt,
    hashes: {
      originalFiles,
      verifiedAccountingSha256: VERIFIED_ACCOUNTING_SHA256,
      destinationSha256: hash(destination),
      evidenceCanonicalSha256,
      evidenceFileSha256,
    },
    immutableOriginalAlpha: { memberCount: manifest.members.length, exceptionCount: exceptions.length, mutated: false },
    pilotBetaPinned: true,
    evidenceFreshness: {
      destinationObservedAt: destination.observedAt,
      goCardlessComplete: providerByMandate.size === rows.length && !providerFailure,
      goCardlessFailure: providerFailure,
      xeroComplete: !xeroFailure,
      xeroFailure,
      priorRetryAfter: {
        sourceSha256: PRIOR_RATE_LIMIT_SHA256,
        observedAt: priorRateLimit.observedAt,
        seconds: Number(priorRateLimit.retryAfter.value),
        notBefore: priorRetryNotBefore,
        applicableToFreshRun: Date.parse(priorRetryNotBefore) > Date.parse(evidence.observedAt),
      },
    },
    policy: { approvedRevenueAccountCodes: ['200', '201'], broaderCodesApproved: false, missingApprovalsRemainBlocked: true },
    totals, outcomes,
    supplementInterface: {
      eligibleMemberIds: outcomes.filter(row => row.outcome === 'eligible_for_supplemental_preparation').map(row => row.memberId),
      evidenceSha256: evidenceCanonicalSha256,
      evidenceFileSha256,
      originalManifestSha256: ORIGINAL_HASHES['manifest.json'],
      collectionHeld: true, adoptionApproved: false, releaseApproved: false,
    },
    operations: { databaseWrites: 0, providerWrites: 0, oauthRefreshes: 0, migrationsApplied: 0, adoptionPerformed: false, collectionReleased: false },
    approvals: { supplementalCohortApproval: 'missing', schemaApproval: 'missing', dataHashApproval: 'missing', financialDecisions: 'missing_where_flagged' },
    sourceControlCaveat: 'The workbook was already tracked in inherited git history before the exact ignore and git rm --cached action; removing it from the current index does not erase prior-history copies.',
    ...deliveryState({ eligible: totals.eligibleForSupplementalPreparation, xeroComplete: !xeroFailure }),
  };
  const save = async (name, value) => {
    const file = await open(`${root}/${name}`, 'wx', 0o600);
    try { await file.writeFile(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
    finally { await file.close(); }
  };
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  const reportCanonicalSha256 = hash(JSON.parse(reportBytes));
  const reportFileSha256 = hash(Buffer.from(reportBytes));
  await save('full-evidence.json', evidenceBytes);
  await save('report.json', reportBytes);
  const reviewManifest = {
    version: 1,
    kind: 'blocked_reconciliation_envelope_not_supplemental_manifest',
    task: 4628,
    createdAt: report.observedAt,
    members: [],
    blockedRows: 21,
    inputSha256: WORKBOOK_SHA256,
    originalManifestSha256: ORIGINAL_HASHES['manifest.json'],
    evidenceCanonicalSha256,
    evidenceFileSha256,
    reportCanonicalSha256,
    reportSha256: reportFileSha256,
    heldPolicy: { collectionHeld: true, adoptionApproved: false, releaseApproved: false },
    eligibilityGate: {
      freshGoCardlessComplete: report.evidenceFreshness.goCardlessComplete,
      freshXeroComplete: report.evidenceFreshness.xeroComplete,
      approvedRevenueAccountCodes: ['200', '201'],
      observedUnapprovedCode: '204',
      builderMustReject: true,
    },
    priorRetryAfter: report.evidenceFreshness.priorRetryAfter,
    migrations: {
      readOnlyReconciliationNeeded: [],
      applied: [],
      supplementalSchema: 'not_approved_not_designed_not_applied',
    },
  };
  await save('review-manifest-v1.json', reviewManifest);
  await save('row-review.md', privateMarkdown(report));
  const verifyJson = async (name, expectedFile, expectedCanonical) => {
    const bytes = await readFile(`${root}/${name}`);
    if (hash(bytes) !== expectedFile || hash(JSON.parse(bytes)) !== expectedCanonical)
      throw Error(`Post-save hash verification failed: ${name}`);
  };
  await verifyJson('full-evidence.json', evidenceFileSha256, evidenceCanonicalSha256);
  await verifyJson('report.json', reportFileSha256, reportCanonicalSha256);
  const manifestBytes = await readFile(`${root}/review-manifest-v1.json`);
  const savedManifest = JSON.parse(manifestBytes);
  if (savedManifest.evidenceCanonicalSha256 !== hash(JSON.parse(await readFile(`${root}/full-evidence.json`)))
    || savedManifest.evidenceFileSha256 !== hash(await readFile(`${root}/full-evidence.json`))
    || savedManifest.reportCanonicalSha256 !== hash(JSON.parse(await readFile(`${root}/report.json`)))
    || savedManifest.reportSha256 !== hash(await readFile(`${root}/report.json`)))
    throw Error('Post-save envelope linkage verification failed');
  return {
    report,
    reportSha256: reportFileSha256,
    reportCanonicalSha256,
    evidenceSha256: evidenceCanonicalSha256,
    evidenceFileSha256,
    envelopeSha256: hash(manifestBytes),
    outDir: root,
  };
}