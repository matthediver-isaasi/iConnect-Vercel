import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQuoteBaseUrl, hashQuoteToken, quotePublicUrl } from './salesQuoteDelivery.js';
import { buildSalesQuotePdf } from './salesQuotePdf.js';

test('quote tokens are one-way hashed and URL encoded', () => {
  const token = 'secret/token+which must never be stored';
  const digest = hashQuoteToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes(token));
  assert.equal(hashQuoteToken(token), digest);
  assert.equal(quotePublicUrl(token, 'https://acme.example.org/'),
    'https://acme.example.org/quote/secret%2Ftoken%2Bwhich%20must%20never%20be%20stored');
});

test('quote delivery origins are canonical tenant hosts only', () => {
  assert.equal(canonicalQuoteBaseUrl({ slug: 'seller', domain: 'quotes.seller.example' }),
    'https://quotes.seller.example');
  assert.equal(canonicalQuoteBaseUrl({ slug: 'seller', domain: 'https://attacker.example/path' }),
    'https://seller.iconn.app');
  assert.throws(() => canonicalQuoteBaseUrl({ slug: 'seller/path' }), /safe public quote domain/);
  assert.throws(() => quotePublicUrl('token-value', 'https://safe.example/path'), /safe tenant base URL/);
  assert.throws(() => quotePublicUrl('token-value', 'https://safe.example@attacker.example'), /safe tenant base URL/);
});

test('quote PDF renders immutable snapshot lines totals bundles and terms', () => {
  const pdf = buildSalesQuotePdf({
    tenant: { name: 'Acme Limited', primary_color: '#123456', settings: {
      business_details: { companyNumber: '12345', vatNumber: 'GB123' },
    } },
    quote: { quote_number: 'Q-0042' },
    version: {
      version_number: 3, status: 'issued', currency: 'GBP', issue_date: '2026-09-11',
      valid_until: '2026-10-11T00:00:00Z', organisation_snapshot: { name: 'Customer Ltd' },
      terms_snapshot: { text: 'Payment due in 30 days.' },
      net_minor: 10000, tax_minor: 2000, gross_minor: 12000,
      sales_quote_line: [{
        description: 'Immutable service', quantity: 1, net_minor: 10000, gross_minor: 12000,
        sales_quote_bundle_component: [{ quantity: 2, product_snapshot: { name: 'Included item' } }],
      }],
    },
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 1000);
});