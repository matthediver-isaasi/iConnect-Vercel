import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormSubmissionInvoiceHandler } from './[submissionId].js';
import { formSubmissionInvoice } from '../../shared/formSubmissionInvoice.js';
import { __setRoleAccessOverlayForTests } from '../_lib/roleVisibility.js';

__setRoleAccessOverlayForTests([]);

const pdf = Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF');
const submission = {
  id: 'submission', tenant_id: 'tenant', payment_provider: 'invoice',
  payment_meta: { invoice_order: { provider: 'xero', companyId: 'company', connectionId: 'connection' },
    invoice_result: { id: 'invoice', invoiceNumber: 'INV/001"\r\n' } },
};
function fixture(options = {}) {
  const calls = [];
  const context = { isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin', ...options.context };
  const tables = {
    form_submission: [options.submission || submission],
    role: [{ id: 'role', tenant_id: 'tenant', excluded_features: options.excluded || [] }],
    xero_token: [{ id: 'connection', app_tenant_id: 'tenant', tenant_id: options.company || 'company' }],
  };
  const db = { from(table) {
    const filters = [];
    return {
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      async maybeSingle() {
        calls.push({ table });
        if (options.dbError && table === 'form_submission') return { error: new Error('private database details') };
        return { data: tables[table]?.find(row => filters.every(filter => filter(row))) || null };
      },
      single() { return this.maybeSingle(); },
    };
  } };
  const handler = createFormSubmissionInvoiceHandler({
    db, getContext: async () => context,
    getProvider: name => {
      calls.push({ provider: name });
      return { async fetchInvoicePdf(...args) {
        calls.push({ args });
        if (options.providerError) throw new Error('private provider credentials');
        return options.pdf ?? pdf;
      } };
    },
  });
  const res = {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  return { calls, res, run: (query = {}, method = 'GET') => handler({ method, query: { submissionId: 'submission', ...query } }, res) };
}

for (const inline of [true, false]) test(`serves same PDF with ${inline ? 'inline' : 'attachment'} headers`, async () => {
  const f = fixture();
  await f.run({ inline: String(inline), invoiceId: 'guessed', provider: 'quickbooks' });
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.res.body, pdf);
  assert.equal(f.res.headers['Content-Type'], 'application/pdf');
  assert.equal(f.res.headers['Content-Length'], pdf.length);
  assert.equal(f.res.headers['Content-Disposition'], `${inline ? 'inline' : 'attachment'}; filename="invoice-INV_001_.pdf"`);
  assert.equal(f.res.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.res.headers['CDN-Cache-Control'], 'no-store');
  assert.equal(f.res.headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.equal(f.res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(f.calls.filter(c => c.provider || c.args), [
    { provider: 'xero' }, { args: ['invoice', 'tenant', { companyId: 'company' }] },
  ]);
});

for (const result of [
  { invoiceId: 'historical', invoiceNumber: 'H-1', provider: 'quickbooks' },
  { invoice_id: 'historical', invoice_number: 'H-1', accounting_provider: 'xero' },
  { accounting_invoice_id: 'historical', accounting_invoice_number: 'H-1', accounting_provider: 'quickbooks' },
  { xero_invoice_id: 'historical', xero_invoice_number: 'H-1' },
]) test(`uses persisted historical linkage ${JSON.stringify(result)}`, async () => {
  const f = fixture({ submission: { ...submission, payment_meta: { invoice_result: result } } });
  await f.run();
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.calls.find(c => c.provider).provider, result.provider || result.accounting_provider || 'xero');
  assert.deepEqual(f.calls.find(c => c.args).args, ['historical', 'tenant', undefined]);
});

for (const [name, meta] of [
  ['absent', null], ['pending', { invoice_order: { provider: 'xero' } }],
  ['number only', { invoice_result: { invoiceNumber: 'INV-1' } }],
  ['unknown provider', { invoice_result: { id: 'invoice', provider: 'unknown' } }],
  ['unproven provider', { invoice_result: { id: 'invoice' } }],
  ['conflicting ids', { invoice_result: { id: 'first', invoiceId: 'second', provider: 'xero' } }],
  ['conflicting providers', { invoice_order: { provider: 'xero' }, invoice_result: { id: 'invoice', provider: 'quickbooks' } }],
]) test(`no document for ${name} metadata`, async () => {
  const f = fixture({ submission: { ...submission, payment_meta: meta } });
  await f.run();
  assert.equal(f.res.statusCode, 404);
  assert.equal(f.calls.some(c => c.provider), false);
});

for (const [name, options, status] of [
  ['anonymous', { context: { isAuthenticated: false } }, 401],
  ['no tenant', { context: { tenantId: null } }, 401],
  ['stale tenant', { context: { tenantMismatch: true } }, 409],
  ['no role', { context: { tenantUserId: null } }, 403],
  ['role exclusion', { context: { tenantUserId: null, roleId: 'role' }, excluded: ['forms.submissions'] }, 403],
  ['member exclusion', { context: { tenantUserId: null, roleId: 'role', memberExcludedFeatures: ['page_FormSubmissions'] } }, 403],
  ['cross tenant', { submission: { ...submission, tenant_id: 'other' } }, 404],
  ['original company changed', { company: 'different' }, 409],
  ['database failure', { dbError: true }, 503],
  ['provider failure', { providerError: true }, 502],
  ['HTML returned as PDF', { pdf: Buffer.from('<html>Failure</html>') }, 502],
  ['empty response', { pdf: Buffer.alloc(0) }, 502],
  ['non-invoice payment', { submission: { ...submission, payment_provider: 'stripe' } }, 404],
]) test(`fails safely: ${name}`, async () => {
  const f = fixture(options);
  await f.run();
  assert.equal(f.res.statusCode, status);
  assert.equal(f.res.headers['Content-Type'], undefined);
  assert.equal(f.res.headers['Content-Disposition'], undefined);
  assert.equal(typeof f.res.body.error, 'string');
  assert.doesNotMatch(JSON.stringify(f.res.body), /private|credentials/);
  if (status !== 502) assert.equal(f.calls.some(c => c.provider), false);
});

test('permitted member reuses submission management access', async () => {
  const f = fixture({ context: { tenantUserId: null, roleId: 'role' } });
  await f.run();
  assert.equal(f.res.statusCode, 200);
});
test('rejects writes and malformed submission identifiers', async () => {
  for (const [id, method, status] of [[['submission'], 'GET', 400], ['', 'GET', 400], ['submission', 'POST', 405]]) {
    const f = fixture();
    await f.run({ submissionId: id }, method);
    assert.equal(f.res.statusCode, status);
    assert.equal(f.calls.some(c => c.provider), false);
  }
});
test('presentation requires linkage but preserves a number-only historical display', () => {
  const result = formSubmissionInvoice({ ...submission, payment_meta: { invoice_result: { invoice_number: 'INV-1' } } });
  assert.equal(result.number, 'INV-1');
  assert.equal(result.linked, false);
});
