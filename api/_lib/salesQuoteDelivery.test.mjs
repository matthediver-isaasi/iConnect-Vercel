import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQuoteBaseUrl, hashQuoteToken, quotePublicUrl } from './salesQuoteDelivery.js';
import { buildSalesQuotePdf, buildBrandedSalesQuotePdf } from './salesQuotePdf.js';

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

test('draft PDF includes the legal footer, full address and draft marking', () => {
  const pdf = buildSalesQuotePdf({
    tenant: { name: 'Example', footer_config: { address: { name: 'Registered Example Ltd', lines: ['Registered address'] }, legalText: 'Company number 12345. VAT GB12345.' } },
    quote: { quote_number: 'Q-DRAFT' },
    version: { status: 'draft', version_number: 1, currency: 'GBP', address_snapshot: { postalCode: 'W1 1AA', country: 'United Kingdom' }, sales_quote_line: [] },
  }).toString('latin1');
  assert.match(pdf, /DRAFT/);
  assert.match(pdf, /not issued/);
  assert.match(pdf, /Registered Example Ltd/);
  assert.match(pdf, /Company number 12345/);
  assert.match(pdf, /W1 1AA/);
});

test('PDF logo download only allows public uploaded assets and embeds converted PNG', async () => {
  const input = { quote: {}, version: { version_number: 1, currency: 'GBP' }, tenant: {} };
  for (const logo of ['http://127.0.0.1/image.png', 'https://example.com/image.png', 'https://abc.supabase.co/storage/v1/object/sign/image.png']) {
    await assert.rejects(buildBrandedSalesQuotePdf({ ...input, tenant: { logo_url: logo } }), /public tenant-uploaded/);
  }
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(bytes);
  };
  try {
    const pdf = await buildBrandedSalesQuotePdf({ ...input, tenant: { logo_url: 'https://test.supabase.co/storage/v1/object/public/logos/test.png' } });
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
  } finally { globalThis.fetch = original; }
});