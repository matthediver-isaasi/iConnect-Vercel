import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQuoteEmail, previewQuoteEmail, validateQuoteEmail } from './salesQuoteDelivery.js';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';

const quote = { id: 'quote-1', tenant_id: 'tenant-server', quote_number: 'Q-1', current_version: 2 };
const version = { id: 'version-2', version_number: 2, status: 'issued', valid_until: '2099-01-01T00:00:00Z' };
const input = { quote, version, recipient: 'customer@example.org', expiresInDays: 7, personalMessage: 'Hello <Customer> & team,\nPlease see our proposal.' };

test('personal quote message is plain text with escaped HTML and preserved line breaks', () => {
  const result = renderQuoteEmail({ ...input, url: 'https://example.org/quote/token' });
  assert.match(result.html, /Hello &lt;Customer&gt; &amp; team,<br>Please see our proposal/);
  assert.ok(result.text.startsWith(input.personalMessage));
  assert.doesNotMatch(renderQuoteEmail({ ...input, personalMessage: '<script>alert(1)</script>', url: '#' }).html, /<script>/);
  assert.throws(() => validateQuoteEmail({ ...input, personalMessage: 'a'.repeat(5001) }), /5000/);
  assert.throws(() => validateQuoteEmail({ ...input, personalMessage: {} }), /must be text/);
  assert.throws(() => validateQuoteEmail({ ...input, version: { ...version, status: 'draft' } }), /issued/);
  assert.throws(() => validateQuoteEmail({ ...input, expiresInDays: 91 }), /between 1 and 90/);
  assert.throws(() => validateQuoteEmail({ ...input, recipient: 'invalid' }), /valid recipient/);
});

test('preview uses delivery template plus the tenant footer, with no active quote link', async () => {
  const result = await previewQuoteEmail(input, { getEmailFooterForPreview: async tenantId => {
    assert.equal(tenantId, quote.tenant_id);
    return '<p>Tenant footer</p>';
  } });
  assert.ok(result.html.startsWith(renderQuoteEmail({ ...input, url: '#quote-preview' }).html));
  assert.match(result.html, /Tenant footer/);
  assert.doesNotMatch(result.html, /\/quote\//);
  assert.equal(result.subject, 'Quote Q-1');
  assert.equal(result.version, 2);
  assert.equal(result.recipient, input.recipient);
  assert.equal(result.attachPdf, true);
  assert.equal((await previewQuoteEmail({ ...input, attachPdf: false }, { getEmailFooterForPreview: async () => null })).attachPdf, false);
});

function response() {
  return { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
test('preview endpoint is tenant-scoped, read-only and requires authenticated quote-management access', async () => {
  const reads = [];
  let authorized = true;
  const db = { from(table) {
    assert.ok(['sales_quote', 'sales_quote_version'].includes(table), `Unexpected table: ${table}`);
    const filters = {};
    reads.push({ table, filters });
    return { select() { return this; }, eq(key, value) { filters[key] = value; return this; },
      maybeSingle: async () => ({ data: quote, error: null }),
      order: async () => ({ data: [version], error: null }),
    };
  } };
  const handler = createSalesQuotesHandler({
    db, getTenantContext: async () => authorized ? { isAuthenticated: true, tenantId: 'tenant-server', tenantUserId: 'actor' } : { isAuthenticated: false },
    getEmailFooterForPreview: async tenantId => { assert.equal(tenantId, 'tenant-server'); return null; },
    sendEmail: async () => { assert.fail('Preview must never send'); },
  });
  const req = { method: 'POST', url: '/api/sales/quotes/quote-1?action=preview-email',
    query: { action: 'preview-email' }, body: { ...input, version: 2, tenantId: 'attacker' } };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(reads.every(read => read.filters.tenant_id === 'tenant-server'));
  assert.equal(res.body.version, 2);
  const missing = response();
  await handler({ ...req, body: { ...req.body, version: 999 } }, missing);
  assert.equal(missing.statusCode, 404);
  authorized = false;
  const denied = response();
  await handler(req, denied);
  assert.ok([401, 403].includes(denied.statusCode));
});
