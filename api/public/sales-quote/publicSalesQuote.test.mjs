import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPublicSalesQuoteRateLimits,
  createPublicSalesQuoteHandler,
} from './[...path].js';
import { createSalesQuotesHandler } from '../../sales/quotes/[...path].js';
import { sendQuote } from '../../_lib/salesQuoteDelivery.js';

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}
function query(data) {
  return {
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data, error: null }),
    insert: async () => ({ error: null }),
  };
}
const token = 'a'.repeat(43);
const rows = {
  sales_quote_delivery_token: {
    id: 'token-db-id', tenant_id: 'tenant-db-id', quote_id: 'quote-db-id',
    quote_version_id: 'version-db-id', expires_at: '2099-01-01T00:00:00Z', activated_at: '2026-01-01T00:00:00Z',
  },
  sales_quote: { id: 'quote-db-id', current_version: 2, quote_number: 'Q-2' },
  sales_quote_version: {
    id: 'version-db-id', version_number: 2, status: 'sent', currency: 'GBP',
    organisation_snapshot: { id: 'org-secret', name: 'Buyer' },
    event_snapshot: { eventId: 'event-secret', name: 'Event' },
    sales_quote_line: [{ id: 'line-secret', productId: 'product-secret', description: 'Service' }],
  },
  tenant: { id: 'tenant-db-id', name: 'Seller', logo_url: 'https://cdn.example/logo.png' },
};

test('public view resolves only token hash and recursively scrubs database IDs', async () => {
  clearPublicSalesQuoteRateLimits();
  const calls = [];
  const db = { from(table) { calls.push(table); return query(rows[table]); } };
  const res = response();
  await createPublicSalesQuoteHandler({ db })({
    method: 'GET', query: { path: [token] }, headers: {}, socket: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.quoteNumber, 'Q-2');
  assert.equal(JSON.stringify(res.body).includes('org-secret'), false);
  assert.equal(JSON.stringify(res.body).includes('product-secret'), false);
  assert.equal(JSON.stringify(res.body).includes('customer_contact_snapshot'), false);
  assert.ok(calls.includes('sales_quote_delivery_audit'));
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('public view returns a clear terminal revoked outcome', async () => {
  clearPublicSalesQuoteRateLimits();
  const db = { from(table) {
    return query(table === 'sales_quote_delivery_token'
      ? { ...rows.sales_quote_delivery_token, revoked_at: '2026-01-01T00:00:00Z' } : rows[table]);
  } };
  const res = response();
  await createPublicSalesQuoteHandler({ db })({
    method: 'GET', query: { path: [token] }, headers: {}, socket: {},
  }, res);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, { outcome: 'revoked' });
});

test('public view records an expired link once and returns a terminal outcome', async () => {
  clearPublicSalesQuoteRateLimits();
  const audits = [];
  const db = { from(table) {
    if (table === 'sales_quote_delivery_token') {
      return query({
        ...rows.sales_quote_delivery_token,
        activated_at: '2025-01-01T00:00:00Z',
        expires_at: '2026-01-01T00:00:00Z',
      });
    }
    if (table === 'sales_quote_delivery_audit') {
      return { insert: async (row) => { audits.push(row); return { error: null }; } };
    }
    return query(rows[table]);
  } };
  const res = response();
  await createPublicSalesQuoteHandler({ db })({
    method: 'GET', query: { path: [token] },
    headers: { referer: `https://seller.example/quote/${token}` }, socket: {},
  }, res);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, { outcome: 'expired' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event_type, 'expired');
  assert.equal(JSON.stringify(audits[0]).includes(token), false);
});

test('inactive delivery tokens are indistinguishable from missing tokens', async () => {
  clearPublicSalesQuoteRateLimits();
  const db = { from(table) {
    return query(table === 'sales_quote_delivery_token'
      ? { ...rows.sales_quote_delivery_token, activated_at: null } : rows[table]);
  } };
  const res = response();
  await createPublicSalesQuoteHandler({ db })({
    method: 'GET', query: { path: [token] }, headers: { referer: `/quote/${token}?leak=yes` }, socket: {},
  }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { outcome: 'not_found' });
});

test('accept API requires agreement/idempotency and forwards complete contract', async () => {
  clearPublicSalesQuoteRateLimits();
  let rpc;
  const db = {
    rpc: async (name, args) => { rpc = [name, args]; return { data: { outcome: 'accepted', idempotent: false }, error: null }; },
  };
  const handler = createPublicSalesQuoteHandler({ db });
  const invalid = response();
  await handler({ method: 'POST', query: { path: [token, 'accept'] },
    body: { name: 'Ada', idempotencyKey: 'key' }, headers: {}, socket: {} }, invalid);
  assert.equal(invalid.statusCode, 400);

  const res = response();
  await handler({ method: 'POST', query: { path: [token, 'accept'] }, headers: {}, socket: {},
    body: { name: 'Ada', role: 'Director', agreement: true, idempotencyKey: 'key',
      customerReference: 'REF', purchaseOrderReference: 'PO' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(rpc[0], 'decide_sales_quote_public');
  assert.equal(rpc[1].p_agreement, true);
  assert.equal(rpc[1].p_customer_reference, 'REF');
  assert.equal(rpc[1].p_idempotency_key, 'key');
  assert.equal(Object.hasOwn(rpc[1].p_request_metadata, 'referer'), false);
});

test('public endpoint rate limits repeated requests by token and IP', async () => {
  clearPublicSalesQuoteRateLimits();
  const db = { from: () => query(null) };
  const handler = createPublicSalesQuoteHandler({ db });
  let last;
  for (let index = 0; index < 31; index += 1) {
    last = response();
    await handler({ method: 'GET', query: { path: [token] },
      headers: { 'x-forwarded-for': '192.0.2.10' }, socket: {} }, last);
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.body.outcome, 'rate_limited');
});

test('public endpoint uses a durable limiter without trusting caller-supplied forwarded IP', async () => {
  clearPublicSalesQuoteRateLimits();
  let received;
  const db = { from: () => query(null) };
  const handler = createPublicSalesQuoteHandler({
    db,
    consumeRateLimit: async (_db, digest, clientKey, maximum) => {
      received = { digest, clientKey, maximum };
      return true;
    },
  });
  const res = response();
  await handler({
    method: 'POST',
    query: { path: [token, 'accept'] },
    headers: {
      'x-forwarded-for': '198.51.100.66',
      'x-vercel-forwarded-for': '192.0.2.44',
    },
    socket: { remoteAddress: '127.0.0.1' },
    body: {},
  }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(received.clientKey, '192.0.2.44');
  assert.notEqual(received.clientKey, '198.51.100.66');
  assert.equal(received.maximum, 8);
  assert.equal(received.digest.length, 64);
});

test('authenticated send ignores hostile request origins and uses the canonical tenant host', async () => {
  const audits = [];
  const validUntil = new Date(Date.now() + 2 * 86400000).toISOString();
  let tokenInsert;
  const quote = { id: 'quote-id', tenant_id: 'tenant-id', quote_number: 'Q-9',
    current_version: 1, row_version: 4 };
  const version = { id: 'version-id', quote_id: 'quote-id', version_number: 1,
    status: 'issued', valid_until: validUntil, sales_quote_line: [] };
  const db = {
    from(table) {
      if (table === 'sales_quote') return query(quote);
      if (table === 'sales_quote_version') {
        const builder = query(null);
        builder.order = async () => ({ data: [version], error: null });
        return builder;
      }
      if (table === 'tenant') return query({ name: 'Seller', slug: 'seller' });
      if (table === 'sales_quote_delivery_token') return {
        insert(row) {
          tokenInsert = row;
          assert.equal(row.token_hash.includes('plain'), false);
          return { select() { return this; }, single: async () => ({ data: { id: 'token-id' }, error: null }) };
        },
        update() {
          return { eq() { return this; }, is: async () => ({ error: null }) };
        },
      };
      if (table === 'sales_quote_delivery_audit') return {
        insert: async (row) => { audits.push(row); return { error: null }; },
      };
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async () => ({ data: {}, error: null }),
  };
  const handler = createSalesQuotesHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-id', tenantUserId: 'actor-id' }),
    hasFeatureAccess: async () => true,
    sendEmail: async (message) => {
      assert.match(message.html, /https:\/\/seller\.iconn\.app\/quote\//);
      assert.doesNotMatch(message.html, /attacker\.example/);
      assert.doesNotMatch(message.html, /api\/public/);
      return { success: false, error: 'provider unavailable', domain: 'mail.example' };
    },
  });
  const res = response();
  await handler({
    method: 'POST', query: { path: ['quote-id', 'send'] },
    headers: {
      origin: 'https://attacker.example',
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
    },
    body: { recipient: 'buyer@example.org', expiresInDays: 7, attachPdf: false },
  }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(audits[0].event_type, 'send_attempt');
  assert.equal(audits[1].event_type, 'send_failed');
  assert.equal(audits[1].sender_domain, 'mail.example');
  assert.equal(tokenInsert.expires_at, validUntil);
});

function sendDb({ transitionError = null } = {}) {
  const audits = []; const tokenUpdates = [];
  return {
    audits, tokenUpdates,
    from(table) {
      if (table === 'sales_quote_delivery_token') return {
        insert() { return { select() { return this; }, single: async () => ({ data: { id: 'token-id' }, error: null }) }; },
        update(value) { tokenUpdates.push(value); return { eq() { return this; }, is: async () => ({ error: null }) }; },
      };
      if (table === 'sales_quote_delivery_audit') return { insert: async (value) => { audits.push(value); return { error: null }; } };
      throw new Error(`unexpected ${table}`);
    },
    rpc: async () => ({ data: null, error: transitionError }),
  };
}
const sendInput = {
  quote: { id: 'q', tenant_id: 't', quote_number: 'Q-1', row_version: 1 },
  version: { id: 'v', status: 'issued', valid_until: '2099-01-01T00:00:00Z' },
  tenant: {}, actor: { actorId: 'a', actorType: 'tenant_user' }, recipient: 'x@example.org',
  expiresInDays: 7, baseUrl: 'https://safe.example',
};

test('provider throw leaves the minted token inactive/revoked and writes send failure', async () => {
  const db = sendDb();
  await assert.rejects(sendQuote(db, { ...sendInput, sendEmail: async () => { throw new Error('network down'); } }), /network down/);
  assert.equal(db.audits.at(-1).event_type, 'send_failed');
  assert.ok(db.tokenUpdates.some((update) => update.revoked_at));
  assert.equal(db.tokenUpdates.some((update) => update.activated_at), false);
});

test('status transition failure does not misreport a delivered email or deactivate link', async () => {
  const db = sendDb({ transitionError: { message: 'stale quote' } });
  const result = await sendQuote(db, { ...sendInput, sendEmail: async () => ({
    success: true, domain: 'mail.example', messageId: 'provider-id',
  }) });
  assert.equal(result.sent, true);
  assert.equal(result.transitionFailed, true);
  assert.ok(db.tokenUpdates.some((update) => update.activated_at));
  assert.equal(db.tokenUpdates.some((update) => update.revoked_at), false);
  assert.equal(db.audits.at(-1).event_type, 'send_transition_failed');
});