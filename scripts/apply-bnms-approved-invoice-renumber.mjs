#!/usr/bin/env node
// Explicit user-approved exact numbers; never allocates or infers a sequence.
// Separate from the historical preparation-only script and its obsolete totals.
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';
import { TENANT, XERO_TENANT, TARGETS, hash, invariantView } from './prepare-bnms-paid-invoice-renumber.mjs';

export const APPROVED = TARGETS.map((t, n) => Object.freeze({ ...t,
  assigned: ['INV-8956', 'INV-8958'][n],
  group: ['OOE-1790198684011-DC5F1', 'OOE-1790198918339-82WJL'][n] }));
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
export function checkInvoice(invoice, target, number = target.number) {
  requireThat(invoice?.InvoiceID === target.id && invoice.InvoiceNumber === number
    && invoice.Type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(invoice.Status)
    && invoice.CurrencyCode === 'GBP' && invoice.Contact?.ContactID
    && invoice.LineItems?.length && invoice.Payments?.length
    && ['Total', 'SubTotal', 'TotalTax', 'AmountPaid', 'AmountDue'].every(k =>
      typeof invoice[k] === 'number' && Number.isFinite(invoice[k])),
  'invoice_identity_or_financial_evidence_invalid');
}
export function checkResult(before, after, target) {
  checkInvoice(before, target);
  checkInvoice(after, target, target.assigned);
  requireThat(hash(invariantView(before)) === hash(invariantView(after)), 'non_number_provider_drift');
}
export function checkUnused(body, number) {
  requireThat(Array.isArray(body.Invoices)
    && body.Invoices.every(i => i.InvoiceNumber === number), 'duplicate_lookup_invalid');
  requireThat(body.Invoices.length === 0, 'approved_number_already_used');
}
export async function main(args = process.argv.slice(2)) {
  requireThat(args.length === 2 && ['--preflight', '--apply-approved'].includes(args[0])
    && /^\/tmp\/bnms-exact-renumber-[a-zA-Z0-9-]+\.jsonl$/.test(args[1]), 'invalid_arguments');
  const apply = args[0] === '--apply-approved';
  const audit = await open(args[1], 'wx', 0o600);
  const record = async value => { await audit.writeFile(`${JSON.stringify(value)}\n`); await audit.sync(); };
  let c, attempts = 0;
  try {
    await record({ phase: 'start', at: new Date().toISOString(), apply,
      implementationSha256: hash(await readFile(new URL(import.meta.url), 'utf8')),
      tenant: TENANT, xeroTenant: XERO_TENANT, approved: APPROVED });
    c = await connectDestination();
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    requireThat((await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',
      ['bnms-exact-approved-renumber'])).rows[0].ok, 'operation_already_running');
    const tenants = (await c.query('SELECT name FROM tenant WHERE id=$1', [TENANT])).rows;
    requireThat(tenants.length === 1 && /bnms|british nuclear medicine society/i.test(tenants[0].name), 'tenant_pin_failed');
    const tokens = (await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    requireThat(tokens.length === 1 && tokens[0].tenant_id === XERO_TENANT
      && Date.parse(tokens[0].expires_at) > Date.now() + 180000, 'existing_application_auth_required');
    const request = async (path, method = 'GET', body) => {
      await new Promise(r => setTimeout(r, 1250));
      const response = await fetch(`https://api.xero.com${path}`, { method, redirect: 'error',
        signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${tokens[0].access_token}`,
          'xero-tenant-id': XERO_TENANT, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      requireThat(response.ok, `provider_http_${response.status}_no_retry`);
      return response.json();
    };
    const exact = async target => {
      const body = await request(`/api.xro/2.0/Invoices/${target.id}`);
      requireThat(body.Invoices?.length === 1, 'invoice_cardinality_failed');
      return body.Invoices[0];
    };
    const unused = async target => {
      const query = new URLSearchParams({ where: `InvoiceNumber=="${target.assigned}"` });
      checkUnused(await request(`/api.xro/2.0/Invoices?${query}`), target.assigned);
    };
    const connections = await request('/connections');
    requireThat(Array.isArray(connections) && connections.some(v => v.tenantId === XERO_TENANT), 'provider_tenant_pin_failed');
    const before = [], bindings = [];
    for (const target of APPROVED) {
      const local = [];
      for (const source of ['booking', 'complex_event_booking']) {
        const rows = (await c.query(`SELECT to_jsonb(b) row FROM public.${source} b
          WHERE tenant_id=$1 AND (xero_invoice_id=$2 OR booking_group_reference=$3) FOR UPDATE`,
        [TENANT, target.id, target.group])).rows;
        local.push(...rows.map(v => ({ source, row: v.row })));
      }
      const jobs = (await c.query(`SELECT to_jsonb(r) row FROM event_invoice_recovery r
        WHERE tenant_id=$1 AND (invoice_id=$2 OR booking_group_reference=$3) FOR UPDATE`,
      [TENANT, target.id, target.group])).rows;
      requireThat(local.length === 1 && jobs.length === 1, 'local_cardinality_failed');
      const b = local[0].row, r = jobs[0].row;
      requireThat(b.xero_invoice_id === target.id && b.xero_invoice_number === target.number
        && b.booking_group_reference === target.group && b.invoice_recovery_status === 'complete'
        && r.invoice_id === target.id && r.invoice_number === target.number && r.status === 'complete'
        && r.xero_tenant_id === XERO_TENANT && r.source === local[0].source
        && r.booking_group_reference === target.group && !r.lease_token && !r.lease_expires_at
        && b.stripe_payment_intent_id === r.settlement_payment_intent_id, 'local_binding_failed');
      const invoice = await exact(target);
      checkInvoice(invoice, target);
      requireThat(invoice.Status === 'PAID' && invoice.Total === 166.67
        && invoice.AmountPaid === 166.67 && invoice.AmountDue === 0,
      'newly_approved_paid_state_changed');
      requireThat(invoice.Payments.some(p => p.PaymentID === r.payment_id), 'payment_binding_failed');
      await unused(target);
      before.push(invoice);
      bindings.push({ booking: local[0], recovery: r });
    }
    // Live booking triggers unconditionally increment survey revisions and delete
    // attendee confirmations on ANY update. No supported number-only exception
    // exists. Do not disable triggers or rewrite snapshots; leave all mirrors.
    await record({ phase: 'preflight', before, bindings,
      localMirrors: 'not_modified_survey_trigger_side_effects_require_separate_review' });
    const results = [];
    if (apply) for (const [n, target] of APPROVED.entries()) {
      const fresh = await exact(target);
      requireThat(hash(fresh) === hash(before[n]), 'provider_changed_since_preflight');
      await unused(target); // Explicit exact check immediately before each write.
      const body = { Invoices: [{ InvoiceID: target.id, InvoiceNumber: target.assigned }] };
      await record({ phase: 'write_intent', invoiceId: target.id, body });
      attempts++;
      const response = await request(`/api.xro/2.0/Invoices/${target.id}`, 'POST', body);
      await record({ phase: 'write_response', invoiceId: target.id, response });
      const after = await exact(target);
      await record({ phase: 'verification', invoiceId: target.id, after });
      checkResult(before[n], after, target);
      results.push({ invoiceId: target.id, number: after.InvoiceNumber, status: after.Status,
        total: after.Total, paid: after.AmountPaid, due: after.AmountDue, nonNumberFieldsUnchanged: true });
    }
    await c.query('ROLLBACK'); // Locks only: no SQL mutations.
    const summary = { phase: 'complete', apply, providerWriteAttempts: attempts, sqlWrites: 0,
      results: apply ? results : before.map(i => ({ id: i.InvoiceID, status: i.Status,
        total: i.Total, paid: i.AmountPaid, due: i.AmountDue })),
      localMirrors: 'unchanged_due_to_survey_trigger_side_effects', migrations: 0 };
    await record(summary);
    console.log(JSON.stringify(summary));
  } catch (error) {
    await c?.query('ROLLBACK').catch(() => {});
    const code = /^[a-z0-9_]+$/.test(error?.message || '') ? error.message : 'operation_failed_review_private_audit_no_retry';
    await record({ phase: 'stopped', code, providerWriteAttempts: attempts, sqlWrites: 0 });
    console.log(JSON.stringify({ stopped: true, code, providerWriteAttempts: attempts, sqlWrites: 0 }));
    process.exitCode = 1;
  } finally { await c?.end(); await audit.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Invalid invocation or private audit unavailable; no retry.'); process.exitCode = 1; });