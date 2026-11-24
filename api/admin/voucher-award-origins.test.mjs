import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoucherAwardOriginsHandler } from './voucher-award-origins.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), otherTenant = id(2), org = id(3);
const voucher = (n, extra = {}) => ({ id: id(n), tenant_id: tenant, organization_id: org, member_id: null, ...extra });
const grant = (n, extra = {}) => ({
  id: id(n + 100), tenant_id: tenant, voucher_id: id(n), speaker_id: id(50),
  speaker_name: 'Recorded Speaker', event_type: 'event', event_id: id(60), ...extra,
});

function setup({ tables = {}, fail, context = { isAuthenticated: true, tenantId: tenant }, admin = true } = {}) {
  const calls = [];
  const db = { from(table) {
    const filters = [];
    let range;
    const query = {
      select(fields) { calls.push({ table, fields, filters }); return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      in(key, values) { filters.push([key, values]); return this; },
      order() { return this; },
      range(from, to) { range = [from, to]; return this; },
      then(resolve, reject) {
        let rows = (tables[table] || []).filter(row => filters.every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : value === row[key]));
        rows = rows.sort((a, b) => a.id.localeCompare(b.id));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(table === fail ? { data: null, error: { message: 'Database failure' } } : { data: rows, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const handler = createVoucherAwardOriginsHandler({ db, tenantContext: async () => context, adminAccess: async () => admin });
  const run = async (body = { voucher_ids: [id(10)] }, method = 'POST') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body }, res);
    return res;
  };
  return { run, calls };
}

test('existing linked vouchers resolve simple, complex and agenda parent events without writes', async () => {
  const { run, calls } = setup({ tables: {
    voucher: [voucher(10), voucher(11), voucher(12)],
    speaker_award_grant: [
      grant(10), grant(11, { event_type: 'complex_event' }),
      grant(12, { speaker_name: null, agenda_snapshot: { event_title: 'Original parent training', description: 'NOT THE EVENT' } }),
    ],
    speaker: [{ id: id(50), tenant_id: tenant, full_name: 'Source Speaker' }],
    event: [{ id: id(60), tenant_id: tenant, title: 'Simple Event', internal_reference: 'S-123' }],
    complex_event: [{ id: id(60), tenant_id: tenant, title: 'Complex Event', internal_reference: 'C-456' }],
  } });
  const response = await run({ voucher_ids: [id(10), id(11), id(12), id(10)] });
  assert.equal(response.code, 200);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(response.body.origins, {
    [id(10)]: [{ speaker: 'Recorded Speaker', event: 'Simple Event', event_internal_reference: 'S-123' }],
    [id(11)]: [{ speaker: 'Recorded Speaker', event: 'Complex Event', event_internal_reference: 'C-456' }],
    [id(12)]: [{ speaker: 'Source Speaker', event: 'Original parent training', event_internal_reference: 'S-123' }],
  });
  assert.ok(calls.every(call => call.filters.some(([key, value]) => key === 'tenant_id' && value === tenant)));
  assert.ok(calls.every(call => !call.fields.includes('email')));
});

test('missing sources retain only trustworthy snapshots and never substitute agenda descriptions', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10), voucher(11)],
    speaker_award_grant: [grant(10, { agenda_snapshot: { event_title: 'Preserved Event' } }),
      grant(11, { speaker_name: ' ', agenda_snapshot: { description: 'Agenda description' } })],
  } });
  const { body } = await run({ voucher_ids: [id(10), id(11)] });
  assert.deepEqual(body.origins[id(10)], [{ speaker: 'Recorded Speaker', event: 'Preserved Event', event_internal_reference: null }]);
  assert.deepEqual(body.origins[id(11)], [{ speaker: null, event: null, event_internal_reference: null }]);
});

test('unrelated and individual vouchers do not acquire provenance from their code or description', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10, { code: 'SPK-LEGACY', description: 'Speaker award — Fake' }),
      voucher(11, { organization_id: null, member_id: id(70) }), voucher(12, { member_id: id(70) })],
    speaker_award_grant: [grant(11), grant(12)],
  } });
  assert.deepEqual((await run({ voucher_ids: [id(10), id(11), id(12)] })).body, { origins: {} });
});

test('tenant isolation applies to voucher, ledger, speaker and both event sources', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10), voucher(11, { tenant_id: otherTenant }), voucher(12), voucher(13)],
    speaker_award_grant: [grant(10, { tenant_id: otherTenant }), grant(11),
      grant(12, { speaker_name: null }), grant(13, { speaker_name: null, event_type: 'complex_event' })],
    speaker: [{ id: id(50), tenant_id: otherTenant, full_name: 'SECRET' }],
    event: [{ id: id(60), tenant_id: otherTenant, title: 'SECRET', internal_reference: 'SECRET' }],
    complex_event: [{ id: id(60), tenant_id: otherTenant, title: 'SECRET', internal_reference: 'SECRET' }],
  } });
  const res = await run({ voucher_ids: [id(10), id(11), id(12), id(13)] });
  assert.equal(res.code, 200);
  assert.deepEqual(Object.keys(res.body.origins), [id(12), id(13)]);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
});

for (const body of [null, {}, { voucher_ids: [] }, { voucher_ids: 'x' }, { voucher_ids: [null] },
  { voucher_ids: ['not-a-uuid'] }, { voucher_ids: Array(101).fill(id(10)) }]) {
  test(`invalid batch is rejected before querying: ${JSON.stringify(body)}`, async () => {
    const { run, calls } = setup();
    assert.equal((await run(body)).code, 400);
    assert.equal(calls.length, 0);
  });
}

for (const [context, admin, expected] of [
  [null, true, 403], [{ tenantId: tenant, isAuthenticated: false }, true, 403],
  [{ isAuthenticated: true }, true, 403], [{ tenantId: tenant, isAuthenticated: true }, false, 403],
  [{ tenantMismatch: true }, true, 409],
]) {
  test(`unauthorised context is denied: ${JSON.stringify(context)} ${admin}`, async () => {
    const { run, calls } = setup({ context, admin });
    assert.equal((await run()).code, expected);
    assert.equal(calls.length, 0);
  });
}

test('read-only metadata rejects unsupported methods', async () => {
  assert.equal((await setup().run({}, 'GET')).code, 405);
});

for (const fail of ['voucher', 'speaker_award_grant', 'speaker', 'event', 'complex_event']) {
  test(`failure in ${fail} is recoverable, not confirmed absence`, async () => {
    const { run } = setup({ fail, tables: {
      voucher: [voucher(10), voucher(11)],
      speaker_award_grant: [grant(10, { speaker_name: null }), grant(11, { event_type: 'complex_event' })],
    } });
    const res = await run({ voucher_ids: [id(10), id(11)] });
    assert.equal(res.code, 503);
    assert.equal(res.body.origins, undefined);
  });
}

test('multiple ledger pages and actual multiple links are preserved', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10)],
    speaker_award_grant: Array.from({ length: 201 }, (_, n) => grant(10, { id: id(1000 + n) })),
  } });
  assert.equal((await run()).body.origins[id(10)].length, 201);
});
