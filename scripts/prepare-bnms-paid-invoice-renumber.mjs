#!/usr/bin/env node
// Preparation only. No provider POST/PUT/PATCH/DELETE, OAuth refresh or SQL writes.
// --capture --out /tmp/<new>.json: pinned destination reads and exact Xero GETs.
// --evidence /tmp/<saved>.json --out /tmp/<new>.json: fully offline hash review.
// --apply is intentionally blocked: Xero has no documented atomic next-number
// allocator for EXISTING invoices. Do not infer numbers or test clearing live.
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const XERO_TENANT = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
export const TARGETS = Object.freeze([
  Object.freeze({ id: '97a5a6a1-aec9-42ed-ba44-71d9e7139cf1', number: 'event-9766de7a473fc0f95fc50b061c0734f759377dbbe1891784' }),
  Object.freeze({ id: '114acb56-e37e-4d9b-ade0-9f98255002f3', number: 'event-eb39c9e573217be71789bb1ed1936e69b8ec64bb67798a69' }),
]);
export const BLOCKER = 'xero_existing_invoice_atomic_next_number_not_documented';
export const DOCS = Object.freeze({
  invoices: 'https://developer.xero.com/documentation/api/accounting/invoices#updating-invoices',
  update: 'https://developer.xero.com/documentation/api/accounting/requests-and-responses',
  sequence: 'https://central.xero.com/s/article/Change-numbering-on-invoices-quotes',
  specification: 'https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml',
});
const fail = code => { throw Error(code); };
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const same = (a, b) => hash(a) === hash(b);
const privatePath = v => {
  const p = resolve(v || '');
  if (dirname(p) !== '/tmp') fail('private_tmp_path_required');
  return p;
};
export function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') fail(BLOCKER); // fail before credentials/network/files
    if (a === '--capture' && !o.capture) o.capture = true;
    else if (['--evidence', '--out'].includes(a) && !o[a.slice(2)]
      && args[i + 1] && !args[i + 1].startsWith('--')) o[a.slice(2)] = privatePath(args[++i]);
    else fail('unsupported_or_duplicate_argument');
  }
  if (!o.out || (o.capture ? !!o.evidence : !o.evidence) || o.out === o.evidence) fail('invalid_mode');
  return o;
}
export function assertInvoice(i, target, number = target.number) {
  if (!i || i.InvoiceID !== target.id || i.InvoiceNumber !== number || i.Type !== 'ACCREC'
    || i.Status !== 'PAID' || i.LineAmountTypes !== 'Inclusive' || i.CurrencyCode !== 'GBP'
    || Number(i.Total) !== 166.67 || Number(i.TotalTax) !== 27.78
    || Number(i.SubTotal) !== 138.89 || Number(i.AmountPaid) !== 166.67
    || Number(i.AmountDue) !== 0
    || (i.AmountCredited != null && Number(i.AmountCredited) !== 0)
    || ['CreditNotes', 'Prepayments', 'Overpayments'].some(k => i[k] != null && (!Array.isArray(i[k]) || i[k].length))
    || !i.Contact?.ContactID || !Array.isArray(i.LineItems) || !i.LineItems.length
    || !Array.isArray(i.Payments) || !i.Payments.length
    || i.Payments.some(p => !p.PaymentID || !Number.isFinite(Number(p.Amount)))
    || new Set(i.Payments.map(p => p.PaymentID)).size !== i.Payments.length
    || Math.round(i.Payments.reduce((n, p) => n + Number(p.Amount), 0) * 100) !== 16667)
    fail('invoice_identity_financial_or_payment_invariant_failed');
}
export function invariantView(i) {
  // Compare ALL invoice fields except the number and provider update timestamps.
  const v = structuredClone(i);
  delete v.InvoiceNumber;
  delete v.UpdatedDateUTC;
  delete v.UpdatedDateUTCString;
  return v;
}
export function assertRenumberResult(before, after, target, assignedNumber) {
  if (typeof assignedNumber !== 'string' || !assignedNumber.trim()
    || assignedNumber === target.number || assignedNumber.startsWith('event-'))
    fail('invalid_assigned_number');
  assertInvoice(before, target);
  assertInvoice(after, target, assignedNumber);
  if (!same(invariantView(before), invariantView(after))) fail('non_number_invoice_drift');
}
export function buildPlan(e, implementationSha256 = null) {
  if (implementationSha256 !== null && !/^[a-f0-9]{64}$/.test(implementationSha256)) fail('invalid_implementation_hash');
  if (e.version !== 1 || e.tenantId !== TENANT || e.xeroTenantId !== XERO_TENANT
    || !Number.isFinite(Date.parse(e.observedAt))
    || !e.connections?.some(c => c.tenantId === XERO_TENANT)
    || e.invoices?.length !== 2 || e.bookings?.length !== 2 || e.recovery?.length !== 2
    || !Array.isArray(e.payments)) fail('evidence_scope_invalid');
  const repairs = TARGETS.map(target => {
    const matches = e.invoices.filter(i => i.InvoiceID === target.id);
    if (matches.length !== 1) fail('invoice_cardinality_mismatch');
    const i = matches[0];
    assertInvoice(i, target);
    const bookings = e.bookings.filter(b => b.row.xero_invoice_id === target.id);
    const jobs = e.recovery.filter(r => r.invoice_id === target.id);
    if (bookings.length !== 1 || jobs.length !== 1) fail('local_binding_cardinality_mismatch');
    const { source, row: b } = bookings[0], r = jobs[0];
    if (!['booking', 'complex_event_booking'].includes(source) || !b.id || !r.id
      || b.tenant_id !== TENANT || r.tenant_id !== TENANT || r.xero_tenant_id !== XERO_TENANT
      || r.source !== source || b.booking_group_reference !== r.booking_group_reference
      || b.xero_invoice_number !== target.number || r.invoice_number !== target.number
      || b.invoice_recovery_status !== 'complete' || r.status !== 'complete'
      || r.lease_token || r.lease_expires_at || !r.payment_id
      || !i.Payments.some(p => p.PaymentID === r.payment_id)
      || b.stripe_payment_intent_id !== r.settlement_payment_intent_id
      || (b.accounting_invoice_id && b.accounting_invoice_id !== target.id))
      fail('local_binding_status_or_number_drift');
    for (const payment of i.Payments) {
      const full = e.payments.filter(p => p.PaymentID === payment.PaymentID);
      if (full.length !== 1 || full[0].Invoice?.InvoiceID !== target.id
        || Number(full[0].Amount) !== Number(payment.Amount)
        || full[0].Status !== 'AUTHORISED') fail('provider_payment_binding_drift');
    }
    return { invoiceId: target.id, oldNumber: target.number, newNumber: null,
      invoiceFingerprint: hash(i), financialPaymentFingerprint: hash(invariantView(i)),
      booking: { source, id: b.id, group: b.booking_group_reference, fingerprint: hash(b) },
      recovery: { id: r.id, fingerprint: hash(r), paymentId: r.payment_id },
      // Review contract only, NOT executable SQL or a reservation.
      localCAS: { transaction: 'lock exact booking and recovery rows; compare full to_jsonb snapshots',
        bookingSet: ['xero_invoice_number'], recoverySet: ['invoice_number'],
        predicates: ['tenant', 'id', 'existing invoice ID', 'old number', 'complete status', 'snapshot equality'],
        verify: 'both returned rows equal original rows except number; rollback on any drift',
        preserve: ['snapshot', 'payment_id', 'settlement_payment_intent_id', 'all financial fields'],
        // Non-executable templates: assignment deliberately absent. A future
        // reviewed runner must lock BOTH rows, check cardinality, execute BOTH
        // CASs inside one transaction and compare returned full-row snapshots.
        lockBookingSQL: `SELECT to_jsonb(b) AS row FROM public.${source} b WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        lockRecoverySQL: 'SELECT to_jsonb(r) AS row FROM public.event_invoice_recovery r WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        bookingSQL: `UPDATE public.${source} b SET xero_invoice_number=$3 WHERE tenant_id=$1 AND id=$2 AND xero_invoice_id=$4 AND xero_invoice_number=$5 AND invoice_recovery_status='complete' AND to_jsonb(b)=$6::jsonb RETURNING to_jsonb(b) AS row`,
        recoverySQL: "UPDATE public.event_invoice_recovery r SET invoice_number=$3 WHERE tenant_id=$1 AND id=$2 AND invoice_id=$4 AND invoice_number=$5 AND status='complete' AND lease_token IS NULL AND lease_expires_at IS NULL AND to_jsonb(r)=$6::jsonb RETURNING to_jsonb(r) AS row",
        parameterOrder: ['pinned tenant', 'exact booking/recovery ID', 'provider-reserved new number (UNAVAILABLE)',
          'pinned existing invoice ID', 'old exact number', 'original full row JSON'],
        expectedRowsPerStatement: 1 } };
  });
  if (new Set(repairs.map(r => r.recovery.paymentId)).size !== 2) fail('shared_payment_binding');
  const plan = { version: 1, tenantId: TENANT, xeroTenantId: XERO_TENANT,
    evidenceSha256: hash(e), implementationSha256, status: 'blocked', blockers: [BLOCKER], executable: false,
    providerWrites: 0, sqlWrites: 0, repairs, docs: DOCS,
    findings: [
      'Paid ACCREC InvoiceNumber may be updated; invoices in a locked period cannot be updated.',
      'Missing number auto-generation is documented, but regeneration of an existing number by omission/null/empty is not.',
      'Official accounting OpenAPI has no invoice-number settings, next-number or reservation endpoint.',
      'Xero UI sequence is shared by customer invoices and credit notes; highest invoice plus one is not authoritative.',
      'Local locks and duplicate GET checks cannot reserve the sequence against Xero UI or other integrations.',
    ],
    unblock: 'Obtain a provider-supported atomic existing-invoice sequence allocation contract, or revised explicit approval for accountant-reserved exact numbers with all sequence writers paused. Do not apply this plan.',
    futureUpdateContract: { method: 'POST', path: '/api.xro/2.0/Invoices/{existing pinned InvoiceID}',
      bodyKeysOnly: ['InvoiceID', 'InvoiceNumber'], forbidden: ['create', 'payment write', 'line item write', 'clear number experiment'],
      verification: 'GET exact invoice and all original payment IDs; compare full invariants before local CAS; no automatic retry after ambiguous response' } };
  return { plan, reviewSha256: hash(plan) };
}
export async function capture(env = process.env, transport = fetch) {
  const { destinationConnection } = await import('./run-bnms-dd-pilot-history.mjs');
  const c = await destinationConnection(env);
  const e = { version: 1, tenantId: TENANT, xeroTenantId: XERO_TENANT, observedAt: new Date().toISOString(),
    invoices: [], bookings: [], recovery: [], payments: [] };
  let token;
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15s'");
    const tenants = (await c.query('SELECT id,name FROM tenant WHERE id=$1', [TENANT])).rows;
    if (tenants.length !== 1 || !/bnms|british nuclear medicine society/i.test(tenants[0].name)) fail('tenant_pin_mismatch');
    const tokens = (await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    if (tokens.length !== 1 || tokens[0].tenant_id !== XERO_TENANT) fail('xero_connection_pin_mismatch');
    if (!Number.isFinite(Date.parse(tokens[0].expires_at)) || Date.parse(tokens[0].expires_at) < Date.now() + 120000)
      fail('existing_xero_auth_expired_refresh_separately_with_application_helper');
    token = tokens[0].access_token;
    for (const source of ['booking', 'complex_event_booking']) {
      const rows = (await c.query(`SELECT to_jsonb(b) AS row FROM public.${source} b WHERE tenant_id=$1 AND xero_invoice_id=ANY($2::text[]) ORDER BY id`,
        [TENANT, TARGETS.map(t => t.id)])).rows;
      e.bookings.push(...rows.map(({ row }) => ({ source, row })));
    }
    e.recovery = (await c.query('SELECT to_jsonb(r) AS row FROM public.event_invoice_recovery r WHERE tenant_id=$1 AND invoice_id=ANY($2::text[]) ORDER BY id',
      [TENANT, TARGETS.map(t => t.id)])).rows.map(r => r.row);
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  let requests = 0;
  const get = async path => {
    if (!(path === '/connections' || path === '/api.xro/2.0/Organisation'
      || TARGETS.some(t => path === `/api.xro/2.0/Invoices/${t.id}`)
      || (path.startsWith('/api.xro/2.0/Payments/') && e.invoices.some(i => i.Payments?.some(p => path === `/api.xro/2.0/Payments/${p.PaymentID}`)))))
      fail('forbidden_provider_endpoint');
    if (requests >= 10) fail('request_budget_exceeded');
    if (requests++) await new Promise(r => setTimeout(r, 1500));
    const response = await transport(`https://api.xero.com${path}`, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${token}`,
        'xero-tenant-id': XERO_TENANT, Accept: 'application/json' } });
    if (!response.ok) fail(`xero_get_http_${response.status}_no_retry`);
    return response.json();
  };
  e.connections = await get('/connections');
  if (!Array.isArray(e.connections) || !e.connections.some(c => c.tenantId === XERO_TENANT)) fail('xero_connection_pin_mismatch');
  e.organisations = (await get('/api.xro/2.0/Organisation')).Organisations;
  for (const target of TARGETS) {
    const body = await get(`/api.xro/2.0/Invoices/${target.id}`);
    if (body.Invoices?.length !== 1) fail('invoice_cardinality_mismatch');
    assertInvoice(body.Invoices[0], target);
    e.invoices.push(body.Invoices[0]);
  }
  for (const id of new Set(e.invoices.flatMap(i => i.Payments.map(p => p.PaymentID)))) {
    const body = await get(`/api.xro/2.0/Payments/${id}`);
    if (body.Payments?.length !== 1 || body.Payments[0].PaymentID !== id) fail('payment_cardinality_mismatch');
    e.payments.push(body.Payments[0]);
  }
  e.requests = requests;
  e.completedAt = new Date().toISOString();
  return e;
}
export async function main(args = process.argv.slice(2)) {
  const o = parseArgs(args);
  const output = await open(o.out, 'wx', 0o600);
  let evidence;
  try {
    const saved = o.capture ? null : JSON.parse(await readFile(o.evidence, 'utf8'));
    evidence = o.capture ? await capture() : (saved.evidence || saved);
    const implementationSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
    const result = buildPlan(evidence, implementationSha256);
    await output.writeFile(JSON.stringify(o.capture ? { evidence, ...result } : result, null, 2));
    console.log(JSON.stringify({ status: 'blocked', blocker: BLOCKER, writes: 0,
      reviewSha256: result.reviewSha256, evidenceSha256: result.plan.evidenceSha256, implementationSha256 }));
  } catch (error) {
    // Never emit raw database/provider errors: they may contain credentials/PII.
    const code = /^[a-z0-9_]+$/.test(error?.message || '') ? error.message : 'read_or_evidence_failed';
    await output.writeFile(JSON.stringify({ status: 'blocked', code, writes: 0, ...(evidence ? { evidence } : {}) }, null, 2));
    console.log(JSON.stringify({ status: 'blocked', code, writes: 0 }));
    process.exitCode = 1;
  } finally { await output.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Preparation blocked; no mutation attempted.'); process.exitCode = 1; });
}