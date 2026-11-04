import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('./[bookingGroupRef].js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export default async function handler', 'async function handler');
const load = new Function('deps', `const {getSessionMember,getAccountingProvider,getAccountingProviderByName,supabase,getTenantContext,hasAdminAccess}=deps;${code};return handler;`);
const id = '11111111-1111-4111-8111-111111111111';
const booking = { id, tenant_id: 'a', booking_group_reference: 'group', member_id: 'owner', organization_id: 'org',
  xero_credit_note_id: 'cn', xero_credit_note_number: 'CN-123', xero_invoice_number: 'INV-123' };
async function run({ admin = true, session = null, context = { isAuthenticated: true, tenantId: 'a' },
  source = 'booking', rows = [booking], evidence = [], query = {}, errorTable } = {}) {
  const calls = [], providers = [];
  const handler = load({
    getSessionMember: async () => session, getTenantContext: async () => context, hasAdminAccess: async () => admin,
    getAccountingProvider: async () => { throw Error('Must use original provider'); },
    getAccountingProviderByName: name => ({ fetchCreditNotePdf: async (creditId, tenantId) => {
      providers.push({ name, creditId, tenantId }); return Buffer.from('%PDF-1.4 fixture');
    } }),
    supabase: { from(table) {
      const filters = [];
      const q = {
        select() { return q; }, eq(k, v) { filters.push([k, v]); return q; },
        or() { return q; }, contains(k, v) { filters.push([k, v]); return q; }, limit() { return q; },
        maybeSingle() { q.single = true; return q; },
        then(resolve) {
          calls.push({ table, filters });
          let data = table === 'booking_reversal_evidence' ? evidence : table === source ? rows : [];
          data = data.filter(r => filters.every(([k,v]) => Array.isArray(v) ? v.every(x => r[k]?.includes(x)) : r[k] === v));
          return Promise.resolve({ data: q.single ? data[0] || null : data, error: table === errorTable ? Error('Database unavailable') : null }).then(resolve);
        },
      }; return q;
    } },
  });
  const res = { statusCode: 200, headers: {}, status(n) { this.statusCode=n;return this; }, json(v) {this.body=v;return this;},
    send(v){this.body=v;return this;}, setHeader(k,v){this.headers[k]=v;} };
  await handler({ method: 'GET', query: { bookingGroupRef: 'group', bookingId: id, source, ...query } }, res);
  return { ...res, calls, providers };
}

for (const source of ['booking', 'complex_event_booking']) {
  test(`${source}: tenant administrator downloads pinned Xero PDF`, async () => {
    const r = await run({ source });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.providers, [{ name: 'xero', creditId: 'cn', tenantId: 'a' }]);
    assert.equal(r.headers['Cache-Control'], 'private, no-store');
    assert.match(r.headers['Content-Disposition'], /attachment; filename="credit-note-CN-123.pdf"/);
    assert.equal(r.calls[0].table, source);
  });
}
test('owner and existing organisation access remain available', async () => {
  for (const session of [{ id: 'owner', tenant_id: 'a' }, { id: 'colleague', organization_id: 'org', tenant_id: 'a' }]) {
    assert.equal((await run({ admin: false, session, query: { inline: 'true' } })).statusCode, 200);
  }
});
test('unrelated members cannot retrieve PDF or metadata', async () => {
  for (const format of ['json', undefined]) {
    const r = await run({ admin: false, session: { id: 'other', tenant_id: 'a' }, query: { format } });
    assert.equal(r.statusCode, 403); assert.equal(r.providers.length, 0);
  }
});
test('cross-tenant and unauthenticated access fail closed', async () => {
  assert.equal((await run({ session: { id: 'owner', tenant_id: 'b' } })).statusCode, 403);
  assert.equal((await run({ context: { isAuthenticated: true, tenantId: 'b' } })).statusCode, 404);
  assert.equal((await run({ admin: false, context: null })).statusCode, 401);
});
test('exact booking selection cannot return a sibling credit', async () => {
  const r = await run({ query: { bookingId: '22222222-2222-4222-8222-222222222222' } });
  assert.equal(r.statusCode, 404); assert.equal(r.providers.length, 0);
});
test('malformed source and booking identity are rejected', async () => {
  assert.equal((await run({ query: { source: 'member' } })).statusCode, 400);
  assert.equal((await run({ query: { bookingId: 'invalid' } })).statusCode, 400);
});
const evidence = { tenant_id: 'a', booking_source: 'booking', booking_ids: [id], leg: 'credit_note',
  status: 'confirmed', provider_id: 'cn', amount_minor: 20000, currency: 'GBP' };
test('metadata uses confirmed, matching evidence without contacting Xero', async () => {
  const r = await run({ evidence: [evidence, { ...evidence, status: 'pending', amount_minor: 90000 }], query: { format: 'json' } });
  assert.equal(r.body.amount_minor, 20000); assert.equal(r.body.currency, 'GBP'); assert.equal(r.providers.length, 0);
});
test('missing or conflicting amounts are unknown, never inferred from ticket price', async () => {
  for (const items of [[], [evidence, { ...evidence, amount_minor: 10000 }]]) {
    const r = await run({ evidence: items, query: { format: 'json' } });
    assert.equal(r.body.amount_minor, null);
  }
});
test('database failure does not return a misleading successful amount', async () => {
  const r = await run({ errorTable: 'booking_reversal_evidence', query: { format: 'json' } });
  assert.equal(r.statusCode, 500);
});
